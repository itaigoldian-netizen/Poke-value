import { createClient } from '@supabase/supabase-js';

// Per-company+grade lookup (owner-approved click model, Nov7): one request
// serves exactly one cell. A fresh cached value (<=14 days) is served from
// Supabase; only a stale or missing cell calls the provider. Same ScraperAPI
// eBay-sold integration as api/price.js, restricted here to a single
// grader+grade search instead of the all-graders fanout.
//
//   GET /api/company-price?card=<query>&language=<lang>
//       &grader=PSA|BGS|CGC|EAS|TAG|RAW[&grade=1..10]
//
// RAW means ungraded: the search carries no grader/grade and any title that
// mentions a grading company with a grade is filtered out, so the raw value
// comes from ungraded sales only, never inferred from graded prices.
// Note: the provider's sold listings have no reliable condition field, so
// damaged and clean raw copies cannot yet be separated; the frontend shows
// the raw value without a condition claim.

const GRADERS = ['PSA', 'BGS', 'CGC', 'EAS', 'TAG'];
const LANGUAGES = ['English', 'Japanese', 'Chinese', 'Korean'];
const JUNK_KEYWORDS = /\b(lot|bundle|set of|proxy|custom|reprint|replica|orica|empty slab|slab only|fake)\b/i;
const GRADED_TITLE = /\b(PSA|BGS|CGC|EAS|TAG|SGC|ACE)\s*-?\s*\d/i;
const LANG_PATTERNS = {
  Japanese: /\b(japanese|japan|jpn|jp)\b/i,
  Korean: /\b(korean|korea|kor)\b/i,
  Chinese: /\b(chinese|china|chn|simplified|traditional)\b/i,
};

// Cache validity: 14 days (owner request Nov7, was 24h). Responses carry
// updated_at so the display shows the stored value's age.
const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

// Version-tagged cache key, separate namespace from the EAS estimate rows
// ('s1:'). The grader is part of the key because the shared table's unique
// constraint is (card_key, language, grade). Raw rows use grade 0.
const CACHE_KEY_PREFIX = 'c1:';

function errMsg(err) {
  let m = err && err.message ? err.message : String(err);
  const key = process.env.SCRAPER_API_KEY;
  if (key) m = m.split(key).join('[redacted-key]');
  return m.replace(/https?:\/\/\S+/g, '[url]');
}

function cacheKeyFor(queryKey, grader) {
  return CACHE_KEY_PREFIX + queryKey + '|' + grader.toLowerCase();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { card, language, grader, grade } = req.query;
  if (!card || !language || !grader) {
    return res.status(400).json({ error: 'Missing parameters' });
  }

  const graderKey = String(grader).toUpperCase();
  const isRaw = graderKey === 'RAW';
  if (!isRaw && !GRADERS.includes(graderKey)) {
    return res.status(400).json({ error: 'Invalid grader' });
  }
  if (!LANGUAGES.includes(language)) {
    return res.status(400).json({ error: 'Invalid language' });
  }

  let gradeValue = 0;
  if (!isRaw) {
    const parsedGrade = Number(grade); // '9.5' and 'abc' are not valid integer grades
    if (!Number.isInteger(parsedGrade) || parsedGrade < 1 || parsedGrade > 10) {
      return res.status(400).json({ error: 'Invalid grade' });
    }
    gradeValue = parsedGrade;
  }

  // Paused unless explicitly enabled: set SALES_PROVIDER_ENABLED=true in the
  // Vercel environment only after credit cost and provider support are confirmed.
  if (process.env.SALES_PROVIDER_ENABLED !== 'true') {
    return res.status(503).json({ error: 'Price lookup is paused' });
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.SCRAPER_API_KEY) {
    console.error('company price lookup failed: a required environment variable is not set');
    return res.status(500).json({ error: 'Server is not configured' });
  }

  const queryKey = card.trim().toLowerCase().replace(/\s+/g, ' ');
  const cacheKey = cacheKeyFor(queryKey, graderKey);

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    // Column names match the user's actual price_cache table.
    const { data: cachedData, error: cacheReadError } = await supabase
      .from('price_cache')
      .select('*')
      .eq('card_key', cacheKey)
      .eq('language', language)
      .eq('grade', gradeValue)
      .single();

    // PGRST116 = ordinary empty result (a legitimate cache miss). Anything else
    // (missing table/column, bad key, misconfiguration) must stop here, before
    // a billed provider request that could not be cached.
    if (cacheReadError && cacheReadError.code !== 'PGRST116') {
      console.error('cache read failed: ' + errMsg(cacheReadError));
      return res.status(500).json({ error: 'Server is not configured' });
    }

    if (cachedData && (Date.now() - new Date(cachedData.updated_at).getTime() < CACHE_TTL_MS)) {
      return res.status(200).json({
        card_name: cachedData.card_query,
        language: cachedData.language,
        grader: graderKey,
        grade: gradeValue,
        price: cachedData.price,
        total_sales: cachedData.sample_count,
        source: 'sold',
        cached: true,
        updated_at: cachedData.updated_at
      });
    }

    let sales;
    try {
      sales = await fetchEbaySoldData(queryKey, graderKey, gradeValue, language);
    } catch (err) {
      // Message only: never log request URLs, they contain the API key.
      console.error('sales fetch failed for ' + graderKey + ' ' + gradeValue + ': ' + errMsg(err));
      return res.status(502).json({ error: 'Sales data provider unavailable' });
    }

    if (sales.length === 0) {
      return res.status(404).json({ error: 'No data found' });
    }

    const prices = sales.map(s => s.price);
    prices.sort((a, b) => a - b);
    const half = Math.floor(prices.length / 2);
    const median = prices.length % 2 ? prices[half] : (prices[half - 1] + prices[half]) / 2;
    const finalPrice = Math.round(median * 100) / 100;

    const payload = {
      card_name: card.trim(),
      language,
      grader: graderKey,
      grade: gradeValue,
      price: finalPrice,
      total_sales: sales.length,
      source: 'sold',
      cached: false,
      updated_at: new Date().toISOString()
    };

    const cacheRow = {
      card_key: cacheKey,
      card_query: card.trim(),
      language,
      grade: gradeValue,
      price: finalPrice,
      sample_count: sales.length,
      breakdown: {},
      updated_at: payload.updated_at
    };

    // supabase-js reports ordinary write failures as { error }, not a throw:
    // check both so a failed cache write is always logged.
    try {
      const { error: cacheWriteError } = await supabase
        .from('price_cache')
        .upsert(cacheRow, { onConflict: 'card_key,language,grade' });
      if (cacheWriteError) {
        console.error('cache write failed: ' + errMsg(cacheWriteError));
      }
    } catch (cacheErr) {
      // Cache trouble must not fail a good live result.
      console.error('cache write failed: ' + errMsg(cacheErr));
    }

    return res.status(200).json(payload);

  } catch (error) {
    console.error('company price lookup failed: ' + errMsg(error));
    return res.status(502).json({ error: 'Server error' });
  }
}

async function fetchEbaySoldData(cardQuery, grader, grade, language) {
  // ScraperAPI's structured eBay Search endpoint returns parsed JSON for sold
  // listings (their officially documented eBay product). eBay's sold view
  // covers roughly the last 90 days; it has no day-range parameter.
  const isRaw = grader === 'RAW';
  let searchString = isRaw ? cardQuery : `${cardQuery} ${grader} ${grade}`;
  if (language !== 'English') searchString += ` ${language}`;

  const endpoint = 'https://api.scraperapi.com/structured/ebay/search/v2'
    + '?api_key=' + encodeURIComponent(process.env.SCRAPER_API_KEY)
    + '&query=' + encodeURIComponent(searchString)
    + '&show_only=sold_items';

  // Never log endpoint: it contains the API key.
  const response = await fetch(endpoint);
  if (!response.ok) {
    throw new Error('data provider responded with HTTP ' + response.status);
  }

  let items;
  try {
    items = await response.json();
  } catch (e) {
    throw new Error('unexpected response format from sales provider');
  }
  if (!Array.isArray(items)) {
    throw new Error('unexpected response format from sales provider');
  }

  const listings = [];
  for (const item of items) {
    const title = String(item.product_title || '').trim();
    const p = item.item_price;
    if (!title || !p || JUNK_KEYWORDS.test(title)) continue;
    // A from/to range is not a single sale; only fixed prices count.
    if (typeof p.value !== 'number') continue;
    if (p.currency !== 'USD') continue;        // dollar-denominated prices only

    if (language === 'English') {
      if (Object.values(LANG_PATTERNS).some(regex => regex.test(title))) continue;
    } else {
      if (!LANG_PATTERNS[language].test(title)) continue;
    }

    if (isRaw) {
      // Ungraded only: any graded mention disqualifies the sale from the raw value.
      if (GRADED_TITLE.test(title)) continue;
    } else {
      const exactGradeRegex = new RegExp(`\\b${grader}\\s*-?\\s*${grade}(?!\\d|\\.\\d)`, 'i');
      if (!exactGradeRegex.test(title)) continue;
    }

    if (p.value > 0) {
      listings.push({ price: p.value });
    }
  }

  return listings.slice(0, 10);
}
