import { createClient } from '@supabase/supabase-js';
import { fetchSales, providerKeyConfigured, providerCacheTag, resolveCardVariant } from './_sales-provider.js';
import { fetchEasCommunityCells } from './_community-sales.js';

// Per-company+grade lookup (owner-approved click model, Nov7): one request
// serves exactly one cell. A fresh cached value (<=14 days) is served from
// Supabase; only a stale or missing cell calls the provider. Same ScraperAPI
// eBay-sold integration as api/price.js, restricted here to a single
// grader+grade search instead of the all-graders fanout.
//
//   GET /api/company-price?card=<query>&language=<lang>
//       &grader=PSA|BGS|CGC|TAG|EAS|RAW[&grade=1..10]
//
// EAS never calls the external provider (owner decision Nov7 17:36): EAS
// recorded sales come only from this site's approved deal reports, so the
// EAS branch reads community_trades directly (see _community-sales.js) and
// returns an honest no-data when no approved report matches the exact
// printing + language + variant + grade. The EAS formula estimate stays
// hidden: cross-company grade equivalence is not validated.
//
// RAW means ungraded: the search carries no grader/grade and any title that
// mentions a grading company with a grade is filtered out, so the raw value
// comes from ungraded sales only, never inferred from graded prices.
// Note: the provider's sold listings have no reliable condition field, so
// damaged and clean raw copies cannot yet be separated; the frontend shows
// the raw value without a condition claim.

const GRADERS = ['PSA', 'BGS', 'CGC', 'TAG']; // no EAS: local deal reports only
const LANGUAGES = ['English', 'Japanese', 'Chinese', 'Korean'];

// Cache validity: 14 days (owner request Nov7, was 24h). Responses carry
// updated_at so the display shows the stored value's age.
const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

// Version-tagged cache key, separate namespace from the EAS estimate rows
// ('s2:'). The grader is part of the key because the shared table's unique
// constraint is (card_key, language, grade). Raw rows use grade 0.
// c2: is a FRESH namespace (Main review Nov7 22:25): rows written before
// variant separation could hold mixed-variant data, so none of them is ever
// served again - not even for single-variant cards.
const CACHE_KEY_PREFIX = 'c2:';

function errMsg(err) {
  let m = err && err.message ? err.message : String(err);
  for (const key of [process.env.SCRAPER_API_KEY, process.env.COMPS_API_KEY]) {
    if (key) m = m.split(key).join('[redacted-key]');
  }
  return m.replace(/https?:\/\/\S+/g, '[url]');
}

// The resolved variant is ALWAYS part of the key (Main review Nov7 22:25):
// every lookup is variant-scoped, even for single-variant printings.
function cacheKeyFor(queryKey, grader, variantKey) {
  return CACHE_KEY_PREFIX + providerCacheTag() + ':' + queryKey + '|' + grader.toLowerCase() + '|v:' + variantKey;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { card, language, grader, grade, variant, tcg } = req.query;
  if (!card || !language || !grader) {
    return res.status(400).json({ error: 'Missing parameters' });
  }
  // Server-side variant validation (Main review Nov7 22:25): the exact TCGdex
  // card id is required so the server itself verifies which variants this
  // printing has; the UI's picker alone is not proof.
  if (!tcg) {
    return res.status(400).json({ error: 'Missing parameters' });
  }

  const graderKey = String(grader).toUpperCase();
  const isRaw = graderKey === 'RAW';
  const isEas = graderKey === 'EAS';
  if (!isRaw && !isEas && !GRADERS.includes(graderKey)) {
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

  // The provider key is only required for external-source cells: an EAS cell
  // reads community_trades and must not fail when no provider key is set.
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || (!isEas && !providerKeyConfigured())) {
    console.error('company price lookup failed: a required environment variable is not set');
    return res.status(500).json({ error: 'Server is not configured' });
  }

  const variantInfo = await resolveCardVariant(String(tcg), language, variant);
  if (variantInfo.error) {
    return res.status(variantInfo.error.status).json(variantInfo.error.body);
  }
  const variantKey = variantInfo.resolved;

  // The matching/caching query comes from the TCGdex record, not the client.
  const queryKey = variantInfo.derivedQuery.toLowerCase().replace(/\s+/g, ' ');
  const cacheKey = cacheKeyFor(queryKey, graderKey, variantKey);

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    // EAS: live read of approved community deal reports only - no provider
    // request, no cache write (community data changes on every approval).
    if (isEas) {
      const { cells, error: communityError } = await fetchEasCommunityCells(supabase, String(tcg), language, variantKey);
      if (communityError) {
        console.error('community sales read failed: ' + errMsg(communityError));
        return res.status(500).json({ error: 'Server is not configured' });
      }
      const cell = (cells || []).find(c => c.grade === gradeValue);
      if (!cell) return res.status(404).json({ error: 'No data found' });
      return res.status(200).json({ card_name: variantInfo.cardName, language, variant: variantKey, ...cell });
    }

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
        variant: variantKey,
        price: cachedData.price,
        total_sales: cachedData.sample_count,
        source: 'sold',
        cached: true,
        updated_at: cachedData.updated_at
      });
    }

    let sales;
    try {
      sales = await fetchSales(queryKey, graderKey, gradeValue, language, variantKey);
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
      card_name: variantInfo.cardName,
      language,
      variant: variantKey,
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
      card_query: variantInfo.derivedQuery,
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
