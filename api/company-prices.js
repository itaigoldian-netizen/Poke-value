import { createClient } from '@supabase/supabase-js';
import { providerCacheTag, resolveCardVariant } from './_sales-provider.js';
import { fetchEasCommunityCells } from './_community-sales.js';

// Passive batch read for the click model (owner-approved Nov7): returns every
// per-company+grade cached value for the card that is still fresh (<=14 days),
// so the frontend can auto-display current stored prices with their update
// dates. This endpoint NEVER calls the sales provider - stale or missing
// cells are simply absent from the response, and the frontend leaves them in
// their click-to-load state.
//
//   GET /api/company-prices?card=<query>&language=<lang>
//   -> { card_name, language, cells: [{ grader, grade, price, total_sales,
//        updated_at, cached:true }] }

const LANGUAGES = ['English', 'Japanese', 'Chinese', 'Korean'];

// Mirrors api/company-price.js: cache namespace and validity must match the
// click endpoint exactly, or the auto-displayed values would drift from what
// a click would show.
// Mirrors api/company-price.js: c4 = mean-method namespace for foreign
// graders (Nov8 owner-approved valuation change); c3 medians are provenance
// only, never served. c5 (Nov8 17:51: no medians anywhere) re-keys RAW rows;
// a c4 RAW row is a stale median and is never served.
const CACHE_KEY_PREFIX = 'c4:';
const RAW_CACHE_KEY_PREFIX = 'c5:';
// c6 (Nov8 18:02, owner: special grades): foreign grade-10 rows. c4 normal-10
// rows may mix positively labeled special grades and are never served.
const TEN_CACHE_KEY_PREFIX = 'c6:';
// Synthetic grade codes for special cells (see api/company-price.js).
const SPECIAL_CODE_LABEL = { 101: 'pristine', 102: 'black label' };
const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

function errMsg(err) {
  let m = err && err.message ? err.message : String(err);
  return m.replace(/https?:\/\/\S+/g, '[url]');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { card, language, variant, tcg } = req.query;
  if (!card || !language || !tcg) {
    return res.status(400).json({ error: 'Missing parameters' });
  }
  if (!LANGUAGES.includes(language)) {
    return res.status(400).json({ error: 'Invalid language' });
  }

  // Same pause gate as the click endpoint: the whole price display stays off
  // until the owner enables it.
  if (process.env.SALES_PROVIDER_ENABLED !== 'true') {
    return res.status(503).json({ error: 'Price lookup is paused' });
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('cached prices read failed: a required environment variable is not set');
    return res.status(500).json({ error: 'Server is not configured' });
  }

  // Same server-side variant validation as the click endpoint (Main review
  // Nov7 22:25). This endpoint is passive: a required-but-missing variant
  // returns an empty cell list with a variant_required flag, not an error.
  const variantInfo = await resolveCardVariant(String(tcg), language, variant);
  if (variantInfo.error) {
    const st = variantInfo.error.status;
    if (st === 409) {
      return res.status(200).json({ card_name: card.trim(), language, cells: [], variant_required: true, options: variantInfo.error.body.options, unsupported: variantInfo.error.body.unsupported || [] });
    }
    if (st === 404) {
      return res.status(200).json({ card_name: card.trim(), language, cells: [], unsupported: variantInfo.error.body.unsupported || [] });
    }
    return res.status(st).json(variantInfo.error.body);
  }
  const variantKey = variantInfo.resolved;

  // Same derivation as the click endpoint: the client query is never trusted.
  const queryKey = variantInfo.derivedQuery.toLowerCase().replace(/\s+/g, ' ');
  const tag = providerCacheTag() + ':' + queryKey + '|';
  const keyPrefix = CACHE_KEY_PREFIX + tag;
  const rawKeyPrefix = RAW_CACHE_KEY_PREFIX + tag;
  const tenKeyPrefix = TEN_CACHE_KEY_PREFIX + tag;

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    const { data: rows, error } = await supabase
      .from('price_cache')
      .select('*')
      .eq('language', language)
      .or(`card_key.like.$${keyPrefix}%,card_key.like.$${rawKeyPrefix}%,card_key.like.$${tenKeyPrefix}%`);

    if (error) {
      console.error('cached prices read failed: ' + errMsg(error));
      return res.status(500).json({ error: 'Server is not configured' });
    }

    const now = Date.now();
    const cells = (rows || [])
      // EAS never comes from the external provider (owner decision Nov7
      // 17:36): its recorded sales are this site's own deal reports, so any
      // cached EAS row is excluded here rather than displayed as a company price.
      .filter(r => !String(r.card_key).toLowerCase().endsWith('|eas'))
      // Every c2: row is variant-scoped: only cells stored for THIS resolved
      // variant auto-display, for single-variant printings too.
      .filter(r => String(r.card_key).endsWith('|v:' + variantKey))
      // A c4 RAW row predates the no-medians rule (Nov8 17:51) and is a
      // median: never serve it. RAW cells are served from c5 rows only.
      .filter(r => !(String(r.card_key).startsWith(CACHE_KEY_PREFIX) && String(r.card_key).toLowerCase().includes('|raw|')))
      // A c4 foreign grade-10 row predates the special-grade split (Nov8
      // 18:02) and may mix labeled specials: never serve it. Grade-10 cells
      // are served from c6 rows only.
      .filter(r => !(String(r.card_key).startsWith(CACHE_KEY_PREFIX) && Number(r.grade) === 10))
      .filter(r => (now - new Date(r.updated_at).getTime()) < CACHE_TTL_MS)
      .map(r => ({
        grader: String(r.card_key).split('|')[1].toUpperCase(),
        grade: Number(r.grade) > 100 ? 10 : r.grade,
        grade_label: SPECIAL_CODE_LABEL[r.grade] || undefined,
        price: r.price,
        total_sales: r.sample_count,
        updated_at: r.updated_at,
        cached: true
      }));

    // EAS cells come live from approved community deal reports (owner
    // decision Nov7 17:36 + reports-in-valuation steering Nov7 14:06): no
    // provider request, no cache. A community read failure never breaks the
    // cached foreign cells - the EAS column just stays click-to-load.
    const { cells: communityCells, error: communityError } = await fetchEasCommunityCells(supabase, String(tcg), language, variantKey);
    if (communityError) {
      console.error('community sales read failed: ' + errMsg(communityError));
    } else {
      cells.push(...communityCells);
    }

    return res.status(200).json({
      card_name: variantInfo.cardName,
      language,
      cells
    });

  } catch (error) {
    console.error('cached prices read failed: ' + errMsg(error));
    return res.status(502).json({ error: 'Server error' });
  }
}
