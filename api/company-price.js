import { createClient } from '@supabase/supabase-js';
import { fetchSales, providerKeyConfigured, providerCacheTag, resolveCardVariant } from './_sales-provider.js';
import { fetchEasCommunityCells } from './_community-sales.js';
import { easFormulaEstimate } from './_eas-formula.js';

// Per-company+grade lookup (owner-approved click model, Nov7): one request
// serves exactly one cell. A fresh cached value (<=14 days) is served from
// Supabase; only a stale or missing cell calls the provider. Same ScraperAPI
// eBay-sold integration as api/price.js, restricted here to a single
// grader+grade search instead of the all-graders fanout.
//
//   GET /api/company-price?card=<query>&language=<lang>
//       &grader=PSA|BGS|CGC|SGC|TAG|EAS|RAW[&grade=1..10]
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

const GRADERS = ['PSA', 'BGS', 'CGC', 'SGC', 'TAG']; // no EAS: local deal reports only
const LANGUAGES = ['English', 'Japanese', 'Chinese', 'Korean'];

// Cache validity: 14 days (owner request Nov7, was 24h). Responses carry
// updated_at so the display shows the stored value's age.
const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

// Version-tagged cache key, separate namespace from the EAS estimate rows
// ('s2:'). The grader is part of the key because the shared table's unique
// constraint is (card_key, language, grade). Raw rows use grade 0.
// c4: is a FRESH namespace (Nov8 valuation-method change, owner-approved):
// c3 rows were computed as MEDIANS. Foreign-company cells are now simple
// arithmetic means (owner instruction Nov8 16:17), so a cached c3 median must
// never be served as a mean. c3 rows stay in the table as provenance but are
// never read. c2 keys (old TCGdex-id query format) remain unread as before.
// c5: (Nov8 17:51, owner: no medians anywhere) re-keys RAW rows only: c4 RAW
// rows are medians and must never be served as means; c4 foreign-graded rows
// were always means and stay valid, so their cache is kept.
const CACHE_KEY_PREFIX = 'c4:';
const RAW_CACHE_KEY_PREFIX = 'c5:';
// c6: (Nov8 18:02, owner: special grades) re-keys foreign grade-10 rows: c4
// normal-10 rows may mix positively labeled special grades (CGC pristine, BGS
// black label). Grades 1-9 are unaffected and keep c4.
const TEN_CACHE_KEY_PREFIX = 'c6:';

// Special-grade tokens (owner request Nov8 18:02): separate cells above a
// regular 10, never mixed into normal-10 cells or the EAS formula. Stored as
// synthetic grade codes so cache rows stay separate under the table's
// (card_key, language, grade) constraint; the provider still sees grade 10.
const SPECIAL_GRADES = {
  pristine10: { grader: 'CGC', grade: 10, label: 'pristine', code: 101 },
  blacklabel: { grader: 'BGS', grade: 10, label: 'black label', code: 102 }
};

function errMsg(err) {
  let m = err && err.message ? err.message : String(err);
  for (const key of [process.env.SCRAPER_API_KEY, process.env.COMPS_API_KEY]) {
    if (key) m = m.split(key).join('[redacted-key]');
  }
  return m.replace(/https?:\/\/\S+/g, '[url]');
}

// The resolved variant is ALWAYS part of the key (Main review Nov7 22:25):
// every lookup is variant-scoped, even for single-variant printings.
function cacheKeyFor(queryKey, grader, variantKey, gradeValue) {
  const prefix = grader === 'RAW' ? RAW_CACHE_KEY_PREFIX
    : (gradeValue === 10 || gradeValue > 100 ? TEN_CACHE_KEY_PREFIX : CACHE_KEY_PREFIX);
  return prefix + providerCacheTag() + ':' + queryKey + '|' + grader.toLowerCase() + '|v:' + variantKey;
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
  let specialLabel = null;
  if (!isRaw) {
    const token = String(grade === undefined ? '' : grade).toLowerCase();
    if (Object.prototype.hasOwnProperty.call(SPECIAL_GRADES, token)) {
      const spec = SPECIAL_GRADES[token];
      // A special cell exists only for its own company; EAS has no specials.
      if (isEas || graderKey !== spec.grader) {
        return res.status(400).json({ error: 'Invalid grade' });
      }
      gradeValue = spec.code;
      specialLabel = spec.label;
    } else {
      const parsedGrade = Number(grade); // '9.5' and 'abc' are not valid integer grades
      if (!Number.isInteger(parsedGrade) || parsedGrade < 1 || parsedGrade > 10) {
        return res.status(400).json({ error: 'Invalid grade' });
      }
      gradeValue = parsedGrade;
    }
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
  const cacheKey = cacheKeyFor(queryKey, graderKey, variantKey, gradeValue);

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    // EAS: the owner's weighted formula (Nov8 17:51:22 "והקלפים של EAS
    // מחושבים לפי הנוסחה"), blending per-company USD arithmetic means with
    // fixed weights (api/_eas-formula.js). The owner's own design sets the
    // input cost (Nov7 17:37:35: "בשביל החישוב של הנוסחה צריך 4 בקשות"):
    // cache-first per company, and a company with no fresh cached cell is
    // fetched once - at most 4 provider requests per click, then cached for
    // 14 days. When no community reports exist the formula still runs from
    // eBay data alone (Nov8 17:56:12). ILS community reports are kept and
    // labeled separately; they never enter the USD blend (Nov8 17:57:05).
    // EAS's own weight comes only from approved USD community reports, never
    // from the external provider (Nov7 17:36). The free-quota guard stands: a
    // provider 429 fails that company's input honestly, never a paid overage.
    if (isEas) {
      const { cells, error: communityError } = await fetchEasCommunityCells(supabase, String(tcg), language, variantKey);
      if (communityError) {
        console.error('community sales read failed: ' + errMsg(communityError));
        return res.status(500).json({ error: 'Server is not configured' });
      }
      const communityCell = (cells || []).find(c => c.grade === gradeValue) || null;

      const means = {};
      let totalSamples = 0;
      // Every company's outcome is tracked: a provider failure (quota pause,
      // network) is NOT the same as legitimately missing sales, and the
      // response must say which happened. An incomplete estimate is never
      // cached - the EAS cell is always computed live.
      const omitted = [];
      const usdCommunity = communityCell && communityCell.per_currency && communityCell.per_currency.USD;
      if (usdCommunity) {
        means.EAS = usdCommunity.price;
        totalSamples += usdCommunity.count;
      }
      for (const fg of ['PSA', 'BGS', 'CGC', 'TAG']) {
        const fKey = cacheKeyFor(queryKey, fg, variantKey, gradeValue);
        let mean = null;
        let samples = 0;
        let fetched = false;
        let failed = false;
        try {
          const { data: row } = await supabase
            .from('price_cache')
            .select('*')
            .eq('card_key', fKey)
            .eq('language', language)
            .eq('grade', gradeValue)
            .single();
          if (row && (Date.now() - new Date(row.updated_at).getTime()) < CACHE_TTL_MS) {
            mean = Number(row.price);
            samples = Number(row.sample_count) || 0;
          }
        } catch (cacheReadErr) { /* no fresh row: fetch below */ }
        if (mean === null) {
          fetched = true;
          try {
            const fSales = await fetchSales(queryKey, fg, gradeValue, language, variantKey, variantInfo.printing, null);
            if (fSales.length > 0) {
              mean = Math.round((fSales.reduce((sum, x) => sum + x.price, 0) / fSales.length) * 100) / 100;
              samples = fSales.length;
              try {
                const { error: fCacheError } = await supabase
                  .from('price_cache')
                  .upsert({
                    card_key: fKey,
                    card_query: variantInfo.derivedQuery,
                    language,
                    grade: gradeValue,
                    price: mean,
                    sample_count: samples,
                    breakdown: {},
                    updated_at: new Date().toISOString()
                  }, { onConflict: 'card_key,language,grade' });
                if (fCacheError) console.error('cache write failed: ' + errMsg(fCacheError));
              } catch (fCacheErr) { console.error('cache write failed: ' + errMsg(fCacheErr)); }
            }
          } catch (fErr) {
            const msg = errMsg(fErr);
            console.error('formula input failed for ' + fg + ' ' + gradeValue + ': ' + msg);
            failed = true;
            omitted.push({ grader: fg, reason: /quota/i.test(msg) ? 'provider-quota' : 'provider-error' });
          }
        }
        if (typeof mean === 'number' && isFinite(mean) && mean > 0) {
          means[fg] = mean;
          totalSamples += samples;
        } else if (fetched && !failed) {
          // The provider answered fine; this company genuinely has no sales.
          omitted.push({ grader: fg, reason: 'no-sales' });
        }
      }

      const estimate = easFormulaEstimate(means);
      if (!estimate) {
        // No USD formula is possible. ILS-only community reports are NOT a
        // substitute (owner: USD-only blend, Nov8 17:57:05): they return as
        // their own clearly labeled community stats with the formula marked
        // explicitly unavailable.
        if (communityCell) {
          return res.status(200).json({
            card_name: variantInfo.cardName,
            language,
            variant: variantKey,
            ...communityCell,
            formula_status: 'unavailable',
            formula_reason: 'no-usd-inputs',
            formula: { contributors: [], omitted }
          });
        }
        return res.status(404).json({ error: 'No data found' });
      }
      return res.status(200).json({
        card_name: variantInfo.cardName,
        language,
        variant: variantKey,
        grader: 'EAS',
        grade: gradeValue,
        price: estimate.price,
        currency: 'USD',
        total_sales: totalSamples,
        source: 'formula',
        formula_status: omitted.length ? 'partial' : 'complete',
        formula: { contributors: estimate.contributors, active_weight: estimate.activeWeight, omitted },
        per_currency: communityCell ? communityCell.per_currency : undefined,
        cached: false,
        updated_at: new Date().toISOString()
      });
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
        grade: specialLabel ? 10 : gradeValue,
        grade_label: specialLabel || undefined,
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
      sales = await fetchSales(queryKey, graderKey, specialLabel ? 10 : gradeValue, language, variantKey, variantInfo.printing, specialLabel);
    } catch (err) {
      // Message only: never log request URLs, they contain the API key.
      console.error('sales fetch failed for ' + graderKey + ' ' + gradeValue + ': ' + errMsg(err));
      return res.status(502).json({ error: 'Sales data provider unavailable' });
    }

    if (sales.length === 0) {
      return res.status(404).json({ error: 'No data found' });
    }

    // Owner instruction Nov8 17:51: nothing on the site is computed with a
    // median. Foreign grader companies (PSA/BGS/CGC/SGC/TAG) and RAW alike:
    // simple arithmetic mean. RAW stays honestly labeled as condition-mixed.
    const prices = sales.map(s => s.price);
    const mean = prices.reduce((sum, p) => sum + p, 0) / prices.length;
    const finalPrice = Math.round(mean * 100) / 100;

    const payload = {
      card_name: variantInfo.cardName,
      language,
      variant: variantKey,
      grader: graderKey,
      grade: specialLabel ? 10 : gradeValue,
      grade_label: specialLabel || undefined,
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
