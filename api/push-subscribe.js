import { createClient } from '@supabase/supabase-js';

// Push subscription store (owner request Nov7 17:41: phone notification when
// a trade report waits for approval). The subscription endpoint URL is a
// capability - anyone holding it can push to that browser, and the payloads
// carry private report info - so:
//   * POST requires the site owner's own Supabase session token, verified
//     server-side; a random visitor cannot register a subscription.
//   * the table has no public access; only this backend touches it.
//   * endpoints are limited to known browser push services (no SSRF to
//     arbitrary/private hosts) and the subscription count is capped.
//
//   GET  /api/push-subscribe -> { publicKey } (VAPID public key is public by
//                               design; the admin page fetches it instead of
//                               hardcoding it in the repo)
//   POST /api/push-subscribe Authorization: Bearer <owner access token>
//        { subscription } -> upsert by endpoint

const MAX_ENDPOINT_LEN = 2000;
const MAX_SUBSCRIPTIONS = 10; // the owner has a phone and maybe a desktop

// Known browser push services. Chrome/Android: FCM. Firefox: Mozilla autopush.
// Safari: Apple. Windows/Edge legacy: WNS. Anything else is refused, so a
// stored endpoint can never aim the notify worker at an arbitrary host.
const PUSH_HOSTS = [
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'notify.windows.com',
  'wns2-par02p.notify.windows.com',
];

function isAllowedPushEndpoint(endpoint) {
  let url;
  try { url = new URL(endpoint); } catch { return false; }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  if (PUSH_HOSTS.includes(host)) return true;
  if (host.endsWith('.push.apple.com')) return true;
  if (host.endsWith('.notify.windows.com')) return true;
  return false;
}

async function ownerFromToken(req) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return null;
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data || !data.user) return null;
  const email = (data.user.email || '').toLowerCase();
  const ownerEmail = (process.env.PUSH_OWNER_EMAIL || '').toLowerCase();
  if (!ownerEmail || email !== ownerEmail) return null;
  return data.user;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const publicKey = process.env.VAPID_PUBLIC_KEY;
  if (!publicKey || !process.env.VAPID_PRIVATE_KEY) {
    return res.status(503).json({ error: 'Push is not configured' });
  }

  if (req.method === 'GET') {
    return res.status(200).json({ publicKey });
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('push subscribe failed: a required environment variable is not set');
    return res.status(500).json({ error: 'Server is not configured' });
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    const owner = await ownerFromToken(req);
    if (!owner) {
      return res.status(403).json({ error: 'Only the site owner can enable notifications' });
    }

    const sub = req.body && req.body.subscription;
    const endpoint = sub && typeof sub.endpoint === 'string' ? sub.endpoint : '';
    const keys = sub && sub.keys;
    if (endpoint.length > MAX_ENDPOINT_LEN || !isAllowedPushEndpoint(endpoint)
        || !keys || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string'
        || !keys.p256dh || !keys.auth) {
      return res.status(400).json({ error: 'Invalid subscription' });
    }

    const { count } = await supabase
      .from('push_subscriptions')
      .select('*', { count: 'exact', head: true });
    const { data: existing } = await supabase
      .from('push_subscriptions')
      .select('endpoint')
      .eq('endpoint', endpoint)
      .single();
    if (!existing && typeof count === 'number' && count >= MAX_SUBSCRIPTIONS) {
      return res.status(409).json({ error: 'Subscription limit reached' });
    }

    const { error } = await supabase
      .from('push_subscriptions')
      .upsert({ endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } }, { onConflict: 'endpoint' });
    if (error) {
      console.error('push subscribe failed: ' + (error.message || 'unknown'));
      return res.status(500).json({ error: 'Server error' });
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('push subscribe failed: ' + (e && e.message ? e.message : 'unknown'));
    return res.status(500).json({ error: 'Server error' });
  }
}
