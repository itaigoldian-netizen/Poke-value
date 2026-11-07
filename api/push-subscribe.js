import { createClient } from '@supabase/supabase-js';

// Push subscription store (owner request Nov7 17:41: phone notification when
// a trade report waits for approval). The subscription endpoint URL is a
// capability - anyone holding it can push to the owner's browser - so the
// table has no public access; only this backend touches it (service role).
//
//   GET  /api/push-subscribe         -> { publicKey } (VAPID public key is
//                                      public by design; admin page fetches it
//                                      instead of hardcoding it in the repo)
//   POST /api/push-subscribe         { subscription } -> upsert by endpoint

const MAX_ENDPOINT_LEN = 2000;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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

  const sub = req.body && req.body.subscription;
  const endpoint = sub && typeof sub.endpoint === 'string' ? sub.endpoint : '';
  const keys = sub && sub.keys;
  if (!endpoint.startsWith('https://') || endpoint.length > MAX_ENDPOINT_LEN
      || !keys || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string'
      || !keys.p256dh || !keys.auth) {
    return res.status(400).json({ error: 'Invalid subscription' });
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
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
