import { createClient } from '@supabase/supabase-js';

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
const CACHE_KEY_PREFIX = 'c1:';
const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

function errMsg(err) {
  let m = err && err.message ? err.message : String(err);
  return m.replace(/https?:\/\/\S+/g, '[url]');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { card, language } = req.query;
  if (!card || !language) {
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

  const queryKey = card.trim().toLowerCase().replace(/\s+/g, ' ');
  const keyPrefix = CACHE_KEY_PREFIX + queryKey + '|';

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
      .filter(r => (now - new Date(r.updated_at).getTime()) < CACHE_TTL_MS)
      .map(r => ({
        grader: String(r.card_key).slice(keyPrefix.length).toUpperCase(),
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
