import { createClient } from '@supabase/supabase-js';

const GRADERS = ['PSA', 'BGS', 'CGC', 'EAS', 'TAG'];
const BASE_WEIGHTS = { PSA: 0.35, BGS: 0.25, CGC: 0.15, EAS: 0.15, TAG: 0.1 };
const LANGUAGES = ['English', 'Japanese', 'Chinese', 'Korean'];
const JUNK_KEYWORDS = /\b(lot|bundle|set of|proxy|custom|reprint|replica|orica|empty slab|slab only|fake)\b/i;
const LANG_PATTERNS = {
  Japanese: /\b(japanese|japan|jpn|jp)\b/i,
  Korean: /\b(korean|korea|kor)\b/i,
  Chinese: /\b(chinese|china|chn|simplified|traditional)\b/i,
};

// Cache validity: 14 days (owner request Nov7, was 24h). Responses carry
// updated_at so the display shows the stored value's age.
const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

function errMsg(err) {
  let m = err && err.message ? err.message : String(err);
  const key = process.env.SCRAPER_API_KEY;
  if (key) m = m.split(key).join('[redacted-key]');
  return m.replace(/https?:\/\/\S+/g, '[url]');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { card, language, grade } = req.query;
  if (!card || !language || !grade) {
    return res.status(400).json({ error: 'Missing parameters' });
  }

  const parsedGrade = parseInt(grade, 10);
  if (!Number.isInteger(parsedGrade) || parsedGrade < 1 || parsedGrade > 10) {
    return res.status(400).json({ error: 'Invalid grade' });
  }
  if (!LANGUAGES.includes(language)) {
    return res.status(400).json({ error: 'Invalid language' });
  }

  // Paused unless explicitly enabled: set SALES_PROVIDER_ENABLED=true in the
  // Vercel environment only after credit cost and provider support are confirmed.
  if (process.env.SALES_PROVIDER_ENABLED !== 'true') {
    return res.status(503).json({ error: 'Price lookup is paused' });
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.SCRAPER_API_KEY) {
    console.error('price lookup failed: a required environment variable is not set');
    return res.status(500).json({ error: 'Server is not configured' });
  }

  // Version-tagged cache key: rows written by any other pipeline version are
  // never read as this version's verified results. No schema change needed.
  const CACHE_KEY_PREFIX = 's1:';
  const queryKey = card.trim().toLowerCase().replace(/\s+/g, ' ');
  const cacheKey = CACHE_KEY_PREFIX + queryKey;

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    // Column names match the user's actual price_cache table.
    const { data: cachedData, error: cacheReadError } = await supabase
      .from('price_cache')
      .select('*')
      .eq('card_key', cacheKey)
      .eq('language', language)
      .eq('grade', parsedGrade)
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
        query_key: cachedData.card_key,
        card_name: cachedData.card_query,
        language: cachedData.language,
        grade: cachedData.grade,
        poke_value: cachedData.price,
        total_sales: cachedData.sample_count,
        source: 'sold',
        breakdown: cachedData.breakdown,
        updated_at: cachedData.updated_at
      });
    }

    const perGraderResults = {};
    let totalSalesCount = 0;
    let totalFetches = 0;
    let failedFetches = 0;

    for (const grader of GRADERS) {
      let sales = [];
      try {
        totalFetches++;
        sales = await fetchEbaySoldData(queryKey, grader, parsedGrade, language);
      } catch (err) {
        failedFetches++;
        // Message only: never log request URLs, they contain the API key.
        console.error('sales fetch failed for grader ' + grader + ': ' + errMsg(err));
      }

      if (sales.length > 0) {
        const prices = sales.map(s => s.price);
        prices.sort((a, b) => a - b);
        const half = Math.floor(prices.length / 2);
        const median = prices.length % 2 ? prices[half] : (prices[half - 1] + prices[half]) / 2;

        perGraderResults[grader] = { price: median, count: sales.length };
        totalSalesCount += sales.length;
      } else {
        perGraderResults[grader] = { price: null, count: 0 };
      }
    }

    // A partial provider outage must not yield an apparently complete quote
    // reweighted over fewer graders: any failed fetch fails the whole request.
    if (failedFetches > 0) {
      return res.status(502).json({ error: 'Sales data provider unavailable' });
    }

    const activeGraders = GRADERS.filter(g => perGraderResults[g].count > 0);
    if (activeGraders.length === 0) {
      return res.status(404).json({ error: 'No data found' });
    }

    const totalActiveBaseWeight = activeGraders.reduce((sum, g) => sum + BASE_WEIGHTS[g], 0);
    let finalPokeValue = 0;
    const finalBreakdown = {};

    for (const g of GRADERS) {
      if (perGraderResults[g].count > 0) {
        const effectiveWeight = BASE_WEIGHTS[g] / totalActiveBaseWeight;
        finalPokeValue += perGraderResults[g].price * effectiveWeight;
        finalBreakdown[g] = { price: perGraderResults[g].price, count: perGraderResults[g].count };
      }
    }

    finalPokeValue = Math.round(finalPokeValue * 100) / 100;

    const payload = {
      query_key: queryKey,
      card_name: card.trim(),
      language,
      grade: parsedGrade,
      poke_value: finalPokeValue,
      total_sales: totalSalesCount,
      source: 'sold',
      breakdown: finalBreakdown,
      updated_at: new Date().toISOString()
    };

    // Same data, using the actual table's column names.
    const cacheRow = {
      card_key: cacheKey,
      card_query: card.trim(),
      language,
      grade: parsedGrade,
      price: finalPokeValue,
      sample_count: totalSalesCount,
      breakdown: finalBreakdown,
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
    console.error('price lookup failed: ' + errMsg(error));
    return res.status(502).json({ error: 'Server error' });
  }
}

async function fetchEbaySoldData(cardQuery, grader, grade, language) {
  // ScraperAPI's structured eBay Search endpoint returns parsed JSON for sold
  // listings (their officially documented eBay product). eBay's sold view
  // covers roughly the last 90 days; it has no day-range parameter.
  let searchString = `${cardQuery} ${grader} ${grade}`;
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

    const exactGradeRegex = new RegExp(`\\b${grader}\\s*-?\\s*${grade}(?!\\d|\\.\\d)`, 'i');
    if (!exactGradeRegex.test(title)) continue;

    if (p.value > 0) {
      listings.push({ price: p.value });
    }
  }

  return listings.slice(0, 10);
}
