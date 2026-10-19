import { db } from './db.js';

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

function send(userId, event, data) {
  for (const res of streams.get(userId) ?? []) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
}

// Push a lead event to its agent and every admin.
export function broadcastLead(event, lead) {
  const admins = db.prepare("SELECT id FROM users WHERE role = 'admin' AND status = 'active'").all();
  const targets = new Set(admins.map((a) => a.id));
  if (lead.agent_id) targets.add(lead.agent_id);
  for (const id of targets) send(id, event, lead);
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
