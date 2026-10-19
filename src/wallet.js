import { createHmac, timingSafeEqual } from 'node:crypto';
import { db } from './db.js';
import { sendToUser } from './notify.js';

export const MIN_DEPOSIT_CENTS = Number(process.env.MIN_DEPOSIT_CENTS) || 2500;
export const DISPUTE_WINDOW_HOURS = Number(process.env.DISPUTE_WINDOW_HOURS) || 72;

export const stripeConfigured = () => !!process.env.STRIPE_SECRET_KEY;

// Every balance change goes through here so the ledger and balance never drift.
// Returns false if the reference was already applied (idempotent) or funds are short.
export function applyTransaction({ userId, amountCents, type, callId = null, reference = null, note = '', allowNegative = false }) {
  db.exec('BEGIN IMMEDIATE');
  try {
    if (reference && db.prepare('SELECT 1 FROM transactions WHERE reference = ?').get(reference)) {
      db.exec('ROLLBACK');
      return false;
    }
    const { balance_cents } = db.prepare('SELECT balance_cents FROM users WHERE id = ?').get(userId);
    if (!allowNegative && amountCents < 0 && balance_cents + amountCents < 0) {
      db.exec('ROLLBACK');
      return false;
    }
    db.prepare('INSERT INTO transactions (user_id, amount_cents, type, call_id, reference, note) VALUES (?, ?, ?, ?, ?, ?)')
      .run(userId, amountCents, type, callId, reference, note);
    db.prepare('UPDATE users SET balance_cents = balance_cents + ? WHERE id = ?').run(amountCents, userId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  const { balance_cents } = db.prepare('SELECT balance_cents FROM users WHERE id = ?').get(userId);
  sendToUser(userId, 'wallet:update', { balance_cents });
  return true;
}

// Charge the agent for a connected call once it passes the campaign's billable duration.
export function billCall(callId) {
  const call = db.prepare(`
    SELECT c.*, k.price_cents AS campaign_price, k.billable_seconds, k.name AS campaign_name
    FROM calls c JOIN campaigns k ON k.id = c.campaign_id WHERE c.id = ?
  `).get(callId);
  if (!call?.agent_id || (call.duration ?? 0) < call.billable_seconds) return 0;
  // A call that started while funded is always billed, even if it takes the wallet below zero.
  const charged = applyTransaction({
    userId: call.agent_id,
    amountCents: -call.campaign_price,
    type: 'call',
    callId,
    reference: `call:${call.call_sid || call.id}`,
    note: `${call.campaign_name} — ${Math.floor(call.duration / 60)}m ${call.duration % 60}s`,
    allowNegative: true,
  });
  if (charged) db.prepare('UPDATE calls SET price_cents = ? WHERE id = ?').run(call.campaign_price, callId);
  return charged ? call.campaign_price : 0;
}

export function resolveDispute(callId, approve) {
  const call = db.prepare('SELECT * FROM calls WHERE id = ?').get(callId);
  if (!call || call.dispute_status !== 'pending') return false;
  db.prepare('UPDATE calls SET dispute_status = ? WHERE id = ?').run(approve ? 'approved' : 'denied', callId);
  if (approve && call.price_cents > 0) {
    applyTransaction({
      userId: call.agent_id, amountCents: call.price_cents, type: 'refund', callId,
      reference: `refund:${callId}`, note: 'Call return approved',
    });
  }
  return true;
}

// ---------- Stripe (REST, no SDK) ----------

export async function createCheckout({ user, amountCents, baseUrl }) {
  const body = new URLSearchParams({
    mode: 'payment',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][product_data][name]': 'LeadRush wallet funds',
    'line_items[0][price_data][unit_amount]': String(amountCents),
    'line_items[0][quantity]': '1',
    client_reference_id: String(user.id),
    customer_email: user.email,
    'metadata[user_id]': String(user.id),
    success_url: `${baseUrl}/dashboard?funded=1#wallet`,
    cancel_url: `${baseUrl}/dashboard#wallet`,
  });
  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const out = await res.json();
  if (!res.ok) throw new Error(out.error?.message || 'Stripe checkout failed');
  return out.url;
}

export function verifyStripeSignature(rawBody, header = '') {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return false;
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  if (!parts.t || !parts.v1 || Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return false;
  const expected = createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex');
  return parts.v1.length === expected.length && timingSafeEqual(Buffer.from(parts.v1), Buffer.from(expected));
}

export function handleStripeEvent(event) {
  if (event.type !== 'checkout.session.completed') return;
  const s = event.data.object;
  const userId = Number(s.metadata?.user_id || s.client_reference_id);
  if (!userId || s.payment_status !== 'paid') return;
  applyTransaction({
    userId, amountCents: s.amount_total, type: 'deposit', reference: `stripe:${s.id}`, note: 'Card deposit',
  });
}
