import webpush from 'web-push';
import { db, getSetting, setSetting } from './db.js';

// Web Push (phone + desktop notifications even when the app is closed).
// VAPID keys are generated once and kept in the settings table.
if (!getSetting('vapid_public')) {
  const keys = webpush.generateVAPIDKeys();
  setSetting('vapid_public', keys.publicKey);
  setSetting('vapid_private', keys.privateKey);
}
webpush.setVapidDetails(
  `mailto:${process.env.ADMIN_EMAIL || 'admin@leadrush.app'}`,
  getSetting('vapid_public'),
  getSetting('vapid_private'),
);
export const vapidPublicKey = () => getSetting('vapid_public');

export function savePushSubscription(userId, sub) {
  if (!sub?.endpoint || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) return false;
  db.prepare(`INSERT INTO push_subscriptions (user_id, endpoint, keys) VALUES (?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, keys = excluded.keys`)
    .run(userId, sub.endpoint, JSON.stringify({ p256dh: sub.keys.p256dh, auth: sub.keys.auth }));
  return true;
}

export function removePushSubscription(userId, endpoint) {
  db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(userId, endpoint);
}

export function sendPush(userId, { title, body, url = '/dashboard', tag }) {
  if (process.env.NODE_ENV === 'test') return;
  const subs = db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId);
  for (const s of subs) {
    webpush.sendNotification({ endpoint: s.endpoint, keys: JSON.parse(s.keys) }, JSON.stringify({ title, body, url, tag }), { TTL: 600 })
      .catch((err) => {
        if (err.statusCode === 404 || err.statusCode === 410) db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(s.id);
        else console.error('Push failed', err.statusCode || err.message);
      });
  }
}

// Live dashboard updates over Server-Sent Events, keyed by user id.
const streams = new Map();

export function subscribe(req, res) {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('retry: 3000\n\n');

  const id = req.user.id;
  if (!streams.has(id)) streams.set(id, new Set());
  streams.get(id).add(res);

  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    streams.get(id)?.delete(res);
  });
}

export function sendToUser(userId, event, data) {
  for (const res of streams.get(userId) ?? []) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
}

// Push a lead event to its agent and every admin.
export function broadcastLead(event, lead) {
  const admins = db.prepare("SELECT id FROM users WHERE role = 'admin' AND status = 'active'").all();
  const targets = new Set(admins.map((a) => a.id));
  if (lead.agent_id) targets.add(lead.agent_id);
  for (const id of targets) sendToUser(id, event, lead);
}

export const twilioConfigured = () =>
  !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER);

export async function sendSms(to, body) {
  if (!twilioConfigured() || !to) return;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: to, From: process.env.TWILIO_PHONE_NUMBER, Body: body }),
    });
    if (!res.ok) console.error('SMS failed', res.status, await res.text());
  } catch (err) {
    console.error('SMS failed', err.message);
  }
}
