import { createClient } from '@supabase/supabase-js';
import { providerCacheTag, resolveCardVariant } from './_sales-provider.js';

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
const CACHE_KEY_PREFIX = 'c2:'; // fresh namespace, mirrors company-price.js (Main review Nov7 22:25)
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
  const keyPrefix = CACHE_KEY_PREFIX + providerCacheTag() + ':' + queryKey + '|';

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    const { data: rows, error } = await supabase
      .from('price_cache')
      .select('*')
      .eq('language', language)
      .like('card_key', keyPrefix + '%');

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
      .filter(r => (now - new Date(r.updated_at).getTime()) < CACHE_TTL_MS)
      .map(r => ({
        grader: String(r.card_key).slice(keyPrefix.length).split('|')[0].toUpperCase(),
        grade: r.grade,
        price: r.price,
        total_sales: r.sample_count,
        updated_at: r.updated_at,
        cached: true
      }));

    return res.status(200).json({
      card_name: card.trim(),
      language,
      cells
    });

  } catch (error) {
    console.error('cached prices read failed: ' + errMsg(error));
    return res.status(502).json({ error: 'Server error' });
  }
}
