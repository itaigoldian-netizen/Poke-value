import { createClient } from '@supabase/supabase-js';
import { fetchSales, providerKeyConfigured, providerCacheTag } from './_sales-provider.js';

// External eBay lookups cover the four foreign companies only (owner decision
// Nov7 17:39): the site must never search eBay for EAS sales - EAS recorded
// sales come exclusively from this site's approved community deal reports.
// The EAS weight stays reserved so approved local reports can join the
// weighted estimate once that wiring is separately approved (v3, parked);
// until then EAS simply does not participate in the aggregate.
// The sales provider itself is selected by SALES_PROVIDER (see
// _sales-provider.js); the pause gate below applies to every provider.
const GRADERS = ['PSA', 'BGS', 'CGC', 'TAG'];
const BASE_WEIGHTS = { PSA: 0.35, BGS: 0.25, CGC: 0.15, EAS: 0.15, TAG: 0.1 };
const LANGUAGES = ['English', 'Japanese', 'Chinese', 'Korean'];

// Cache validity: 14 days (owner request Nov7, was 24h). Responses carry
// updated_at so the display shows the stored value's age.
const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

function errMsg(err) {
  let m = err && err.message ? err.message : String(err);
  for (const key of [process.env.SCRAPER_API_KEY, process.env.COMPS_API_KEY]) {
    if (key) m = m.split(key).join('[redacted-key]');
  }
  return m.replace(/https?:\/\/\S+/g, '[url]');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { card, language, grade } = req.query;
  if (!card || !language || !grade) {
    return res.status(400).json({ error: 'Missing parameters' });
  }

  const parsedGrade = Number(grade); // '9.5' and 'abc' are not valid integer grades
  if (!Number.isInteger(parsedGrade) || parsedGrade < 1 || parsedGrade > 10) {
    return res.status(400).json({ error: 'Invalid grade' });
  }
  if (!LANGUAGES.includes(language)) {
    return res.status(400).json({ error: 'Invalid language' });
  }

  // Paused unless explicitly enabled. This legacy aggregate endpoint (4
  // provider requests per call, one per foreign grader) has its own second
  // gate, LEGACY_PRICE_ENABLED: the owner approved activating the click model
  // (api/company-price.js, 1 request per cell) on the CompsAPI free quota
  // (Nov7 19:11), not this 4x-cost aggregate, so it stays paused unless both
  // flags are set in the Vercel environment.
  if (process.env.SALES_PROVIDER_ENABLED !== 'true' || process.env.LEGACY_PRICE_ENABLED !== 'true') {
    return res.status(503).json({ error: 'Price lookup is paused' });
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !providerKeyConfigured()) {
    console.error('price lookup failed: a required environment variable is not set');
    return res.status(500).json({ error: 'Server is not configured' });
  }

  // Version-tagged cache key, namespaced per provider: rows written by one
  // provider are never served as the other's data. No schema change needed.
  const CACHE_KEY_PREFIX = 's2:'; // fresh namespace with c2: (Main review Nov7 22:25); legacy aggregate stays gated. Nov9 owner decision: s2 rows (latest-three means) stay valid within the 14-day TTL.
  // Nov9 review (Main): also read the briefly-live s3: generation (Nov9
  // 18:07-18:24) and serve the newest fresh calculation; writes stay on s2:.
  const ALT_CACHE_KEY_PREFIX = 's3:';
  const queryKey = card.trim().toLowerCase().replace(/\s+/g, ' ');
  const cacheKey = CACHE_KEY_PREFIX + providerCacheTag() + ':' + queryKey;

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    // Column names match the user's actual price_cache table.
    const { data: cacheRows, error: cacheReadError } = await supabase
      .from('price_cache')
      .select('*')
      .in('card_key', [cacheKey, ALT_CACHE_KEY_PREFIX + cacheKey.slice(CACHE_KEY_PREFIX.length)])
      .eq('language', language)
      .eq('grade', parsedGrade);

    // PGRST116 = ordinary empty result (a legitimate cache miss). Anything else
    // (missing table/column, bad key, misconfiguration) must stop here, before
    // a billed provider request that could not be cached.
    if (cacheReadError && cacheReadError.code !== 'PGRST116') {
      console.error('cache read failed: ' + errMsg(cacheReadError));
      return res.status(500).json({ error: 'Server is not configured' });
    }

    // Newest fresh row across both generations; fresh = within the TTL and
    // not in the future (5 min skew tolerance).
    const nowTs = Date.now();
    let cachedData = null;
    for (const r of cacheRows || []) {
      const age = nowTs - new Date(r.updated_at).getTime();
      if (age <= -5 * 60 * 1000 || age >= CACHE_TTL_MS) continue;
      if (!cachedData || new Date(r.updated_at).getTime() > new Date(cachedData.updated_at).getTime()) cachedData = r;
    }
    if (cachedData) {
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
        sales = await fetchSales(queryKey, grader, parsedGrade, language);
      } catch (err) {
        failedFetches++;
        // Message only: never log request URLs, they contain the API key.
        console.error('sales fetch failed for grader ' + grader + ': ' + errMsg(err));
      }

      if (sales.length > 0) {
        // Owner instruction Nov8 17:51: simple arithmetic mean, never a median.
        const prices = sales.map(s => s.price);
        const mean = prices.reduce((sum, p) => sum + p, 0) / prices.length;

        perGraderResults[grader] = { price: Math.round(mean * 100) / 100, count: sales.length };
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
