'use strict';

/**
 * Poke Value - /api/price
 *
 * GET /api/price?q=<card search>&language=English|Japanese|Chinese|Korean&grade=1..10
 *
 * Flow:
 *   1. Validate input.
 *   2. Check Supabase price_cache (fresh = updated within 24h). Serve instantly if fresh.
 *   3. Otherwise scrape eBay sold listings (via a scraping proxy) once per grader,
 *      filter junk, apply the 90-day window with a 365-day fallback per grader,
 *      compute the weighted price with proportional weight redistribution,
 *      and upsert the result into price_cache.
 *
 * Required environment variables:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   SCRAPER_API_KEY            (ScraperAPI key)
 * Optional:
 *   SCRAPER_API_BASE           (default https://api.scraperapi.com/)
 */

const cheerio = require('cheerio');
const { createClient } = require('@supabase/supabase-js');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const LANGUAGES = ['English', 'Japanese', 'Chinese', 'Korean'];
const GRADERS = ['PSA', 'BGS', 'CGC', 'EAS', 'TAG'];
const WEIGHTS = { PSA: 0.35, BGS: 0.25, CGC: 0.15, EAS: 0.15, TAG: 0.10 };

const RECENT_DAYS = 90;
const FALLBACK_DAYS = 365;
const MIN_SALES_RECENT = 3;   // fewer than this in 90 days -> extend that grader to 365 days
const MAX_SALES_USED = 10;    // most recent sales used per grader
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const FETCH_TIMEOUT_MS = 22000;
const FETCH_ATTEMPTS = 2;

const RATE_LIMIT_PER_MIN = 60;

const JUNK_WORDS = ['lot', 'lots', 'bundle', 'reprint', 'proxy', 'replica', 'fake'];
const JUNK_RE = new RegExp('\\b(?:' + JUNK_WORDS.join('|') + ')\\b', 'i');

const LANGUAGE_PATTERNS = {
  Japanese: /\b(?:japanese|japan|jpn|jp)\b/i,
  Chinese: /\b(?:chinese|simplified|chn|cn)\b/i,
  Korean: /\b(?:korean|kor)\b/i,
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function send(res, status, body, cacheControl) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', cacheControl || 'no-store');
  res.end(JSON.stringify(body));
}

function normalizeQuery(q) {
  return String(q || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cardKeyOf(q) {
  return q.toLowerCase();
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function cleanText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

// Best-effort per-IP limiter. In-memory, so it resets on cold starts and is
// not shared between instances. It limits casual abuse of your proxy credits only.
const hits = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 60000);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > RATE_LIMIT_PER_MIN;
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

// ---------------------------------------------------------------------------
// Supabase
// ---------------------------------------------------------------------------

let supabaseClient = null;
function getSupabase() {
  if (!supabaseClient) {
    supabaseClient = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
  }
  return supabaseClient;
}

async function readCache(cardKey, language, grade) {
  const { data, error } = await getSupabase()
    .from('price_cache')
    .select('card_query, price, sample_count, breakdown, updated_at')
    .eq('card_key', cardKey)
    .eq('language', language)
    .eq('grade', grade)
    .maybeSingle();
  if (error) throw new Error('Cache read failed: ' + error.message);
  return data || null;
}

async function writeCache(cardKey, cardQuery, language, grade, result) {
  const { error } = await getSupabase()
    .from('price_cache')
    .upsert(
      {
        card_key: cardKey,
        card_query: cardQuery,
        language,
        grade,
        price: result.price,
        sample_count: result.sampleCount,
        breakdown: result.breakdown,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'card_key,language,grade' }
    );
  if (error) throw new Error('Cache write failed: ' + error.message);
}

function payloadFromRow(row, source) {
  return {
    found: true,
    price: Number(row.price),
    sampleCount: row.sample_count,
    breakdown: row.breakdown || {},
    updatedAt: row.updated_at,
    source,
  };
}

// ---------------------------------------------------------------------------
// Scraping proxy + eBay
// ---------------------------------------------------------------------------

function buildEbayUrl(card, grader, grade, language) {
  const terms = [card, grader, String(grade)];
  if (language !== 'English') terms.push(language);
  const params = new URLSearchParams({
    _nkw: terms.join(' '),
    LH_Sold: '1',
    LH_Complete: '1',
    _sop: '13',   // sort: recently ended first
    _ipg: '120',
    rt: 'nc',
  });
  return 'https://www.ebay.com/sch/i.html?' + params.toString();
}

async function fetchViaProxy(targetUrl) {
  const key = process.env.SCRAPER_API_KEY;
  const base = process.env.SCRAPER_API_BASE || 'https://api.scraperapi.com/';
  const proxyUrl =
    base +
    '?api_key=' + encodeURIComponent(key) +
    '&country_code=us' +
    '&url=' + encodeURIComponent(targetUrl);

  let lastError = null;
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const resp = await fetch(proxyUrl, { signal: controller.signal });
      if (!resp.ok) throw new Error('Proxy responded with HTTP ' + resp.status);
      const html = await resp.text();
      if (/Pardon Our Interruption|captcha|Access Denied/i.test(html.slice(0, 4000)) &&
          !/s-item|s-card/.test(html)) {
        throw new Error('eBay returned a bot-check page');
      }
      return html;
    } catch (err) {
      lastError = err.name === 'AbortError' ? new Error('Proxy request timed out') : err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error('Proxy request failed');
}

function parseSoldDate(text) {
  const m = text.match(/Sold\s+([A-Za-z]{3,9})\.?\s+(\d{1,2}),\s+(\d{4})/);
  if (!m) return null;
  const month = m[1].slice(0, 3);
  const ts = Date.parse(month + ' ' + m[2] + ', ' + m[3] + ' 00:00:00 UTC');
  return Number.isNaN(ts) ? null : ts;
}

function parseListings(html) {
  const $ = cheerio.load(html);
  const items = [];
  const seen = new Set();

  $('li.s-item, li.s-card').each((_, el) => {
    const $el = $(el);

    let title = cleanText($el.find('.s-item__title, .s-card__title').first().text());
    title = title
      .replace(/Opens in a new window or tab/gi, '')
      .replace(/^New Listing\s*/i, '')
      .trim();
    if (!title || /^shop on ebay$/i.test(title)) return;

    const priceText = cleanText($el.find('.s-item__price, .s-card__price').first().text());
    if (!priceText || /\bto\b/i.test(priceText)) return;      // skip price ranges
    const pm = priceText.match(/^\$\s?([\d,]+(?:\.\d{1,2})?)/); // USD only
    if (!pm) return;
    const price = parseFloat(pm[1].replace(/,/g, ''));
    if (!Number.isFinite(price) || price <= 0) return;

    const soldAt = parseSoldDate(cleanText($el.text()));
    if (soldAt === null) return;                               // only confirmed sold listings

    const href = $el.find('a[href*="/itm/"]').first().attr('href') || '';
    const idMatch = href.match(/\/itm\/(?:[^/]+\/)?(\d{9,})/);
    const dedupeKey = idMatch ? idMatch[1] : title + '|' + price + '|' + soldAt;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);

    items.push({ title, price, soldAt });
  });

  return items;
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

function gradePattern(grader, grade) {
  // Matches "PSA 9", "PSA-9", "PSA GEM MINT 10", "BGS 9" but not "BGS 9.5" or "PSA 10" for grade 1.
  return new RegExp(
    '\\b' + grader + '\\b' +
    '(?:\\s*[-:#]?\\s*(?:gem|mint|mt|nm|pristine|black|label|authentic)){0,3}' +
    '\\s*[-:#]?\\s*' + grade + '(?!\\d)(?!\\.\\d)',
    'i'
  );
}

function filterListings(items, grader, grade, language) {
  const wanted = gradePattern(grader, grade);
  const others = new RegExp(
    '\\b(?:' + GRADERS.filter((g) => g !== grader).join('|') + ')\\b',
    'i'
  );
  const unwantedLanguages = Object.keys(LANGUAGE_PATTERNS).filter((l) => l !== language);

  return items.filter((item) => {
    const t = item.title;
    if (JUNK_RE.test(t)) return false;
    if (!wanted.test(t)) return false;
    if (others.test(t)) return false;   // ambiguous: mentions another grader too

    if (language === 'English') {
      // English is the default: drop titles that say they are another language.
      return !unwantedLanguages.some((l) => LANGUAGE_PATTERNS[l].test(t));
    }
    return LANGUAGE_PATTERNS[language].test(t);
  });
}

// ---------------------------------------------------------------------------
// Smart date window + calculation
// ---------------------------------------------------------------------------

function selectWindow(sales, now) {
  const byRecent = sales.slice().sort((a, b) => b.soldAt - a.soldAt);
  const ageDays = (s) => (now - s.soldAt) / DAY_MS;

  const recent = byRecent.filter((s) => ageDays(s) <= RECENT_DAYS);
  if (recent.length >= MIN_SALES_RECENT) {
    return { windowDays: RECENT_DAYS, used: recent.slice(0, MAX_SALES_USED) };
  }

  const extended = byRecent.filter((s) => ageDays(s) <= FALLBACK_DAYS);
  return { windowDays: FALLBACK_DAYS, used: extended.slice(0, MAX_SALES_USED) };
}

function summarizeGrader(items, grader, grade, language, now) {
  const sales = filterListings(items, grader, grade, language);
  const { windowDays, used } = selectWindow(sales, now);
  if (used.length === 0) {
    return { count: 0, median: null, windowDays: null, weight: WEIGHTS[grader], effectiveWeight: 0 };
  }
  return {
    count: used.length,
    median: round2(median(used.map((s) => s.price))),
    windowDays,
    weight: WEIGHTS[grader],
    effectiveWeight: 0,
  };
}

function computePokeValue(perGrader) {
  const active = GRADERS.filter((g) => perGrader[g].count > 0);
  if (active.length === 0) return null;

  const totalWeight = active.reduce((sum, g) => sum + WEIGHTS[g], 0);
  let price = 0;
  let sampleCount = 0;

  for (const g of GRADERS) {
    if (perGrader[g].count > 0) {
      const effective = WEIGHTS[g] / totalWeight;
      perGrader[g].effectiveWeight = Math.round(effective * 10000) / 10000;
      price += perGrader[g].median * effective;
      sampleCount += perGrader[g].count;
    } else {
      perGrader[g].effectiveWeight = 0;
    }
  }

  return { price: round2(price), sampleCount, breakdown: perGrader };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return send(res, 405, { found: false, error: 'Method not allowed.' });
  }

  // Input validation
  const query = req.query || {};
  const q = normalizeQuery(Array.isArray(query.q) ? query.q[0] : query.q);
  const language = String((Array.isArray(query.language) ? query.language[0] : query.language) || 'English');
  const grade = Number.parseInt(Array.isArray(query.grade) ? query.grade[0] : query.grade, 10);

  if (q.length < 2 || q.length > 120) {
    return send(res, 400, { found: false, error: 'Enter a card name between 2 and 120 characters.' });
  }
  if (!LANGUAGES.includes(language)) {
    return send(res, 400, { found: false, error: 'Language must be English, Japanese, Chinese, or Korean.' });
  }
  if (!Number.isInteger(grade) || grade < 1 || grade > 10) {
    return send(res, 400, { found: false, error: 'Grade must be a whole number from 1 to 10.' });
  }

  if (isRateLimited(clientIp(req))) {
    return send(res, 429, { found: false, error: 'Too many requests. Wait a minute and try again.' });
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.SCRAPER_API_KEY) {
    console.error('Missing required environment variables.');
    return send(res, 500, { found: false, error: 'Server is not configured.' });
  }

  const cardKey = cardKeyOf(q);

  // 1. Database cache
  let cachedRow = null;
  try {
    cachedRow = await readCache(cardKey, language, grade);
  } catch (err) {
    console.error(err.message);   // cache trouble should not block a live lookup
  }

  if (cachedRow && Date.now() - new Date(cachedRow.updated_at).getTime() < CACHE_TTL_MS) {
    return send(
      res,
      200,
      payloadFromRow(cachedRow, 'cache'),
      'public, s-maxage=300, stale-while-revalidate=600'
    );
  }

  // 2. Dynamic proxy search: one request per grader, in parallel
  const now = Date.now();
  const settled = await Promise.allSettled(
    GRADERS.map(async (grader) => {
      const html = await fetchViaProxy(buildEbayUrl(q, grader, grade, language));
      return summarizeGrader(parseListings(html), grader, grade, language, now);
    })
  );

  const perGrader = {};
  const failures = [];
  settled.forEach((r, i) => {
    const grader = GRADERS[i];
    if (r.status === 'fulfilled') {
      perGrader[grader] = r.value;
    } else {
      failures.push(grader);
      console.error('Fetch failed for ' + grader + ': ' + r.reason.message);
      perGrader[grader] = { count: 0, median: null, windowDays: null, weight: WEIGHTS[grader], effectiveWeight: 0 };
    }
  });

  const result = computePokeValue(perGrader);

  // 3. No data: skip the update, fall back to older cached data if any
  if (!result) {
    if (cachedRow) {
      return send(res, 200, { ...payloadFromRow(cachedRow, 'stale-cache'), partial: failures.length > 0 });
    }
    if (failures.length > 0) {
      return send(res, 502, { found: false, error: 'Could not reach the sales data provider. Try again shortly.' });
    }
    return send(res, 404, { found: false, error: 'No recent sold listings found for this card, language, and grade.' });
  }

  // 4. Upsert only when every grader fetch succeeded, so a partial outage
  //    does not cache a skewed price.
  let cached = false;
  if (failures.length === 0) {
    try {
      await writeCache(cardKey, q, language, grade, result);
      cached = true;
    } catch (err) {
      console.error(err.message);
    }
  }

  return send(res, 200, {
    found: true,
    price: result.price,
    sampleCount: result.sampleCount,
    breakdown: result.breakdown,
    updatedAt: new Date().toISOString(),
    source: 'live',
    cached,
    partial: failures.length > 0,
    failedGraders: failures,
  });
};
