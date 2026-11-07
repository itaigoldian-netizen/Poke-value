import { createClient } from '@supabase/supabase-js';
import webpush from 'web-push';

// Web Push dispatcher (zero-cost: Web Push + VAPID, no paid provider).
//
// Two Supabase Database Webhooks call this endpoint, kept fully distinct:
//   * community_trades INSERT (status pending) -> owner phone alert that a
//     trade report waits for approval (owner request Nov7 17:41), sent only
//     to push_subscriptions (owner devices).
//   * articles INSERT -> a new article is live; notify article_subscribers,
//     the visitors who opted in on news.html (owner request Nov7 19:13).
// The shared secret in x-webhook-secret (set in both webhook configs and in
// Vercel env as PUSH_WEBHOOK_SECRET) authenticates the call; without it
// anyone could spam the owner and the subscribers.
//
// Zero-cost behavior: one function invocation per new row, one push per
// stored subscription. Dead subscriptions (404/410 from the push service)
// are deleted so sends stay bounded.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!process.env.PUSH_WEBHOOK_SECRET || req.headers['x-webhook-secret'] !== process.env.PUSH_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY
      || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('push notify failed: a required environment variable is not set');
    return res.status(500).json({ error: 'Server is not configured' });
  }

  const body = req.body || {};
  const table = body.table;
  const record = body.record;

  let targetTable, payload;
  if (table === 'articles') {
    if (!record || !record.title) {
      return res.status(200).json({ skipped: true });
    }
    targetTable = 'article_subscribers';
    payload = JSON.stringify({
      title: 'כתבה חדשה ב-Poke Value',
      body: String(record.title),
      url: '/news.html'
    });
  } else {
    // community_trades (the original webhook): owner alert on pending reports.
    if (!record || record.status !== 'pending') {
      return res.status(200).json({ skipped: true });
    }
    targetTable = 'push_subscriptions';
    payload = JSON.stringify({
      title: 'דיווח עסקה חדש',
      body: (record.card_name ? String(record.card_name) + ' ' : '') + 'ממתין לאישורך בעמוד הניהול',
      url: '/admin.html'
    });
  }

  try {
    // VAPID subject: the site URL itself (a contact URL is all the spec asks
    // for); no email address is exposed for this service use.
    webpush.setVapidDetails(
      'https://pokevalue2.vercel.app',
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { data: subs, error } = await supabase.from(targetTable).select('endpoint, keys');
    if (error) {
      console.error('push notify failed: ' + (error.message || 'unknown'));
      return res.status(500).json({ error: 'Server error' });
    }
    if (!subs || subs.length === 0) {
      return res.status(200).json({ sent: 0, removed: 0 });
    }

    let sent = 0, removed = 0;
    for (const s of subs) {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, payload, { TTL: 86400 });
        sent++;
      } catch (e) {
        const status = e && e.statusCode;
        if (status === 404 || status === 410) {
          // The browser revoked this subscription; delete so it never retries.
          await supabase.from(targetTable).delete().eq('endpoint', s.endpoint);
          removed++;
        } else {
          console.error('push send failed (status ' + (status || 'unknown') + ')');
        }
      }
    }
    return res.status(200).json({ sent, removed });
  } catch (e) {
    console.error('push notify failed: ' + (e && e.message ? e.message : 'unknown'));
    return res.status(500).json({ error: 'Server error' });
  }
}
