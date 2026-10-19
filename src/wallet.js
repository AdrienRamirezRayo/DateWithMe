import { createHmac, timingSafeEqual } from 'node:crypto';
import { db, getSetting } from './db.js';
import { sendToUser, sendPush, sendSms } from './notify.js';

export const MIN_DEPOSIT_CENTS = Number(process.env.MIN_DEPOSIT_CENTS) || 2500;
export const DISPUTE_WINDOW_HOURS = Number(process.env.DISPUTE_WINDOW_HOURS) || 72;

export const stripeConfigured = () => !!process.env.STRIPE_SECRET_KEY;
// Share of each billed call kept by LeadRush; the rest is owed to the campaign's supplier.
export const platformFeePct = () => Math.min(100, Math.max(0, Number(getSetting('platform_fee_pct') ?? 20)));

const money = (c) => `$${(c / 100).toFixed(2)}`;

// Every balance change goes through here so the ledger and balance never drift.
// For agents the balance is prepaid funds; for suppliers it's what LeadRush owes them.
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

// Charge the agent for a connected call once it passes the campaign's billable duration,
// and credit the supplier their share.
export function billCall(callId) {
  const call = db.prepare(`
    SELECT c.*, k.price_cents AS campaign_price, k.billable_seconds, k.name AS campaign_name, k.supplier_id AS campaign_supplier
    FROM calls c JOIN campaigns k ON k.id = c.campaign_id WHERE c.id = ?
  `).get(callId);
  if (!call?.agent_id || (call.duration ?? 0) < call.billable_seconds) return 0;
  const note = `${call.campaign_name} — ${Math.floor(call.duration / 60)}m ${call.duration % 60}s`;
  // A call that started while funded is always billed, even if it takes the wallet below zero.
  const charged = applyTransaction({
    userId: call.agent_id,
    amountCents: -call.campaign_price,
    type: 'call',
    callId,
    reference: `call:${call.call_sid || call.id}`,
    note,
    allowNegative: true,
  });
  if (!charged) return 0;

  const supplierCents = call.campaign_supplier ? Math.round(call.campaign_price * (100 - platformFeePct()) / 100) : 0;
  db.prepare('UPDATE calls SET price_cents = ?, supplier_id = ?, supplier_cents = ? WHERE id = ?')
    .run(call.campaign_price, call.campaign_supplier ?? null, supplierCents, callId);
  if (supplierCents) {
    applyTransaction({
      userId: call.campaign_supplier, amountCents: supplierCents, type: 'earning', callId,
      reference: `earn:${callId}`, note, allowNegative: true,
    });
  }
  checkLowBalance(call.agent_id, call.campaign_price);
  return call.campaign_price;
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
    if (call.supplier_id && call.supplier_cents) {
      applyTransaction({
        userId: call.supplier_id, amountCents: -call.supplier_cents, type: 'reversal', callId,
        reference: `reverse:${callId}`, note: `Call returned by buyer: ${call.dispute_reason || ''}`.trim(), allowNegative: true,
      });
    }
  }
  sendPush(call.agent_id, {
    title: approve ? '↩️ Return approved' : 'Return denied',
    body: approve ? `${money(call.price_cents)} is back in your wallet.` : 'An admin reviewed the call and kept the charge.',
    url: '/dashboard#calls',
  });
  return true;
}

// After a charge: top up automatically, or warn once the wallet can't cover another call.
function checkLowBalance(userId, nextCallCents) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (u.auto_recharge) {
    maybeAutoRecharge(userId);
  } else if (u.balance_cents < nextCallCents) {
    sendPush(userId, { title: '💳 Wallet low', body: `You're at ${money(u.balance_cents)}. Add funds to keep calls coming.`, url: '/dashboard#wallet', tag: 'wallet-low' });
  }
}

// ---------- Stripe (REST, no SDK) ----------

async function stripe(path, params, method = 'POST') {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: method === 'GET' ? undefined : new URLSearchParams(params),
  });
  const out = await res.json();
  if (!res.ok) {
    const err = new Error(out.error?.message || `Stripe error ${res.status}`);
    err.stripe = out.error;
    throw err;
  }
  return out;
}

export async function createCheckout({ user, amountCents, baseUrl }) {
  const params = {
    mode: 'payment',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][product_data][name]': 'LeadRush wallet funds',
    'line_items[0][price_data][unit_amount]': String(amountCents),
    'line_items[0][quantity]': '1',
    // Save the card so auto-recharge can use it later.
    'payment_intent_data[setup_future_usage]': 'off_session',
    client_reference_id: String(user.id),
    'metadata[user_id]': String(user.id),
    success_url: `${baseUrl}/dashboard?funded=1#wallet`,
    cancel_url: `${baseUrl}/dashboard#wallet`,
  };
  if (user.stripe_customer_id) params.customer = user.stripe_customer_id;
  else Object.assign(params, { customer_creation: 'always', customer_email: user.email });
  return (await stripe('/checkout/sessions', params)).url;
}

export function verifyStripeSignature(rawBody, header = '') {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return false;
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  if (!parts.t || !parts.v1 || Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return false;
  const expected = createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex');
  return parts.v1.length === expected.length && timingSafeEqual(Buffer.from(parts.v1), Buffer.from(expected));
}

function creditAutoRecharge(pi) {
  const userId = Number(pi.metadata?.user_id);
  if (!userId) return;
  const credited = applyTransaction({
    userId, amountCents: pi.amount_received || pi.amount, type: 'deposit', reference: `stripe:${pi.id}`, note: 'Auto-recharge',
  });
  if (credited) sendPush(userId, { title: '💳 Wallet recharged', body: `${money(pi.amount_received || pi.amount)} added automatically.`, url: '/dashboard#wallet', tag: 'wallet' });
}

export async function handleStripeEvent(event) {
  const obj = event.data.object;
  if (event.type === 'payment_intent.succeeded' && obj.metadata?.kind === 'auto_recharge') return creditAutoRecharge(obj);
  if (event.type !== 'checkout.session.completed') return;

  const userId = Number(obj.metadata?.user_id || obj.client_reference_id);
  if (!userId || obj.payment_status !== 'paid') return;
  applyTransaction({ userId, amountCents: obj.amount_total, type: 'deposit', reference: `stripe:${obj.id}`, note: 'Card deposit' });

  // Remember the card for auto-recharge.
  if (obj.customer && obj.payment_intent) {
    try {
      const pi = await stripe(`/payment_intents/${obj.payment_intent}?expand[]=payment_method`, null, 'GET');
      const card = pi.payment_method?.card;
      db.prepare('UPDATE users SET stripe_customer_id = ?, stripe_payment_method = ?, card_label = ?, recharge_error = NULL WHERE id = ?').run(
        obj.customer, pi.payment_method?.id ?? pi.payment_method,
        card ? `${card.brand[0].toUpperCase()}${card.brand.slice(1)} •••• ${card.last4}` : 'Saved card', userId,
      );
    } catch (err) {
      console.error('Could not save card', err.message);
    }
  }
}

// Charge the saved card when the balance drops below the agent's threshold.
// A lock column keeps two calls ending at once from double-charging.
export async function maybeAutoRecharge(userId) {
  if (!stripeConfigured()) return;
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!u?.auto_recharge || !u.stripe_customer_id || !u.stripe_payment_method || u.balance_cents >= u.recharge_threshold_cents) return;
  const claimed = db.prepare(`UPDATE users SET recharge_pending_at = datetime('now')
    WHERE id = ? AND (recharge_pending_at IS NULL OR recharge_pending_at < datetime('now', '-10 minutes'))`).run(userId).changes;
  if (!claimed) return;
  try {
    const pi = await stripe('/payment_intents', {
      amount: String(u.recharge_amount_cents),
      currency: 'usd',
      customer: u.stripe_customer_id,
      payment_method: u.stripe_payment_method,
      off_session: 'true',
      confirm: 'true',
      description: 'LeadRush wallet auto-recharge',
      'metadata[user_id]': String(userId),
      'metadata[kind]': 'auto_recharge',
    });
    if (pi.status === 'succeeded') creditAutoRecharge(pi);
    db.prepare('UPDATE users SET recharge_error = NULL WHERE id = ?').run(userId);
  } catch (err) {
    const msg = err.stripe?.decline_code ? `Card declined (${err.stripe.decline_code})` : err.message;
    db.prepare('UPDATE users SET recharge_error = ? WHERE id = ?').run(msg, userId);
    sendToUser(userId, 'wallet:update', { balance_cents: u.balance_cents, recharge_error: msg });
    sendPush(userId, { title: '⚠️ Auto-recharge failed', body: `${msg}. Update your card to keep calls coming.`, url: '/dashboard#wallet', tag: 'wallet' });
    sendSms(u.phone, `LeadRush: auto-recharge failed (${msg}). Add funds to keep receiving calls.`);
  } finally {
    db.prepare('UPDATE users SET recharge_pending_at = NULL WHERE id = ?').run(userId);
  }
}
