import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.NODE_ENV = 'test';
const { default: app } = await import('../server.js');

let server;
let base;
before(() => new Promise((r) => { server = app.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); }); }));
after(() => server.close());

function client() {
  let cookie = '';
  return async (path, { method = 'GET', body, headers = {} } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json, headers: res.headers };
  };
}

const admin = client();
const agentTX = client();
const agentCA = client();

test('first signup becomes admin, later signups are pending', async () => {
  assert.equal((await admin('/api/auth/signup', { method: 'POST', body: { name: 'Boss', email: 'boss@x.com', password: 'password1' } })).status, 200);
  const me = await admin('/api/me');
  assert.equal(me.body.user.role, 'admin');
  assert.equal(me.body.user.status, 'active');
  assert.equal(me.body.user.password_hash, undefined);

  await agentTX('/api/auth/signup', { method: 'POST', body: { name: 'Tex', email: 'tex@x.com', password: 'password1', phone: '555-111-2222', states: 'tx, fl, zz' } });
  await agentCA('/api/auth/signup', { method: 'POST', body: { name: 'Cali', email: 'cali@x.com', password: 'password1', phone: '5553334444', states: 'CA' } });
  const tex = (await agentTX('/api/me')).body.user;
  assert.equal(tex.status, 'pending');
  assert.equal(tex.states, 'TX,FL');
  assert.equal(tex.phone, '+15551112222');
  assert.equal((await agentTX('/api/me', { method: 'PATCH', body: { available: true } })).status, 400);
  assert.equal((await agentTX('/api/agents')).status, 403);
});

test('admin approves agents, leads route by licensed state', async () => {
  const { agents } = (await admin('/api/agents')).body;
  for (const a of agents.filter((x) => x.status === 'pending')) {
    await admin(`/api/agents/${a.id}`, { method: 'PATCH', body: { status: 'active' } });
  }
  await agentTX('/api/me', { method: 'PATCH', body: { available: true } });
  await agentCA('/api/me', { method: 'PATCH', body: { available: true } });

  const lead = { first_name: 'Ann', phone: '(555) 999-0000', state: 'TX', consent_text: 'I agree', utm_source: 'facebook', utm_campaign: 'fe-oct' };
  assert.equal((await client()('/api/leads/public', { method: 'POST', body: lead })).status, 200);
  await client()('/api/leads/public', { method: 'POST', body: { ...lead, state: 'CA', first_name: 'Bo' } });

  const texLeads = (await agentTX('/api/leads')).body.leads;
  const caLeads = (await agentCA('/api/leads')).body.leads;
  assert.deepEqual(texLeads.map((l) => l.first_name), ['Ann']);
  assert.deepEqual(caLeads.map((l) => l.first_name), ['Bo']);
  assert.equal(texLeads[0].phone, '+15559990000');
  assert.equal(texLeads[0].utm_campaign, 'fe-oct');

  // agents can't open each other's leads
  assert.equal((await agentCA(`/api/leads/${texLeads[0].id}`)).status, 404);
});

test('public form validates consent and honeypot', async () => {
  const c = client();
  assert.equal((await c('/api/leads/public', { method: 'POST', body: { first_name: 'X', phone: '5551234567' } })).status, 400);
  const before = (await admin('/api/leads')).body.total;
  assert.equal((await c('/api/leads/public', { method: 'POST', body: { first_name: 'Bot', phone: '5551234567', consent_text: 'y', company: 'spam' } })).status, 200);
  assert.equal((await admin('/api/leads')).body.total, before);
});

test('status updates track speed-to-lead and premium', async () => {
  const [lead] = (await agentTX('/api/leads')).body.leads;
  await agentTX(`/api/leads/${lead.id}`, { method: 'PATCH', body: { status: 'contacted' } });
  await agentTX(`/api/leads/${lead.id}`, { method: 'PATCH', body: { status: 'sold', premium: '1200' } });
  const { lead: fresh, activities } = (await agentTX(`/api/leads/${lead.id}`)).body;
  assert.equal(fresh.status, 'sold');
  assert.equal(fresh.premium, 1200);
  assert.ok(fresh.first_contact_at);
  assert.ok(activities.some((a) => a.body === 'contacted → sold'));

  const stats = (await agentTX('/api/stats')).body;
  assert.equal(stats.totals.sold, 1);
  assert.equal(stats.totals.premium, 1200);
  assert.equal(stats.campaigns, undefined); // admin-only
  const adminStats = (await admin('/api/stats')).body;
  assert.ok(adminStats.campaigns.some((c) => c.campaign === 'fe-oct' && c.sold === 1));
});

test('webhook requires the api key', async () => {
  const c = client();
  assert.equal((await c('/api/leads/webhook', { method: 'POST', body: { phone: '5550001111' } })).status, 401);
  const { webhook_key } = (await admin('/api/settings')).body;
  const res = await c('/api/leads/webhook', { method: 'POST', body: { phone: '5550001111', first_name: '=HYPERLINK("x")', state: 'FL' }, headers: { 'x-api-key': webhook_key } });
  assert.equal(res.status, 200);
  const csv = (await admin('/api/leads.csv')).body;
  assert.match(csv, /'=HYPERLINK/); // formula injection neutralised
});

const form = (path, data) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data) }).then((r) => r.text());

test('twilio voice without a campaign rings eligible agents with accept whisper', async () => {
  const twiml = await form('/api/twilio/voice', { CallSid: 'CA1', From: '+15557770000', FromState: 'CA', To: '+15550009999' });
  assert.match(twiml, /<Dial/);
  assert.match(twiml, /\+15553334444/); // CA agent
  assert.doesNotMatch(twiml, /\+15551112222/); // TX agent not licensed in CA
  const [, callId, agentId] = twiml.match(/whisper\?call=(\d+)&amp;agent=(\d+)/);

  await form(`/api/twilio/accept?call=${callId}&agent=${agentId}`, {});
  const { calls } = (await agentCA('/api/calls')).body;
  assert.equal(calls[0].status, 'connected');
  const lead = (await agentCA(`/api/leads/${calls[0].lead_id}`)).body.lead;
  assert.equal(lead.source, 'call');
  assert.equal(lead.status, 'contacted');
  await form(`/api/twilio/dial-done?call=${callId}&attempt=1`, { DialCallStatus: 'completed', DialCallDuration: '200' });
});

test('pay-per-call: wallet, subscription filters, billing and returns', async () => {
  const camp = await admin('/api/campaigns', { method: 'POST', body: { name: 'FE Calls', vertical: 'final_expense', price: 45, billable_seconds: 90, phone_number: '(555) 800-0001', supplier: 'Acme Media' } });
  assert.equal(camp.status, 200);
  const id = camp.body.campaign.id;
  assert.equal(camp.body.campaign.price_cents, 4500);

  // Agents see the campaign but not the tracking number
  const listed = (await agentTX('/api/campaigns')).body.campaigns.find((c) => c.id === id);
  assert.equal(listed.phone_number, undefined);

  // TX agent subscribes 24/7 but has no money yet → call goes to voicemail
  assert.equal((await agentTX(`/api/campaigns/${id}/subscription`, { method: 'PUT', body: { active: true, start_hour: 0, end_hour: 0, days: '0123456', daily_cap: 1 } })).status, 200);
  let twiml = await form('/api/twilio/voice', { CallSid: 'P1', From: '+15556660001', FromState: 'TX', To: '+15558000001' });
  assert.match(twiml, /<Record/);

  // Fund the wallet and the call rings them
  const tex = (await admin('/api/agents')).body.agents.find((a) => a.email === 'tex@x.com');
  assert.equal((await admin(`/api/agents/${tex.id}/credit`, { method: 'POST', body: { amount: 100 } })).body.balance_cents, 10000);
  twiml = await form('/api/twilio/voice', { CallSid: 'P2', From: '+15556660002', FromState: 'TX', To: '+15558000001' });
  assert.match(twiml, /\+15551112222/);
  assert.match(twiml, /record-from-answer-dual/);
  const callId = twiml.match(/whisper\?call=(\d+)/)[1];
  assert.match(await form(`/api/twilio/whisper?call=${callId}&agent=${tex.id}`, {}), /Final Expense call from TX/);
  await form(`/api/twilio/accept?call=${callId}&agent=${tex.id}`, {});

  // While on the call they are not offered another one
  twiml = await form('/api/twilio/voice', { CallSid: 'P3', From: '+15556660003', FromState: 'TX', To: '+15558000001' });
  assert.match(twiml, /<Record/);

  // A 2-minute call passes the 90s billable mark → charged $45
  await form(`/api/twilio/dial-done?call=${callId}&attempt=1`, { DialCallStatus: 'completed', DialCallDuration: '120' });
  let wallet = (await agentTX('/api/wallet')).body;
  assert.equal(wallet.balance_cents, 5500);
  assert.equal(wallet.transactions[0].type, 'call');
  // billing is idempotent
  await form(`/api/twilio/dial-done?call=${callId}&attempt=1`, { DialCallStatus: 'completed', DialCallDuration: '120' });
  assert.equal((await agentTX('/api/wallet')).body.balance_cents, 5500);

  // Daily cap of 1 reached → next call skips them
  twiml = await form('/api/twilio/voice', { CallSid: 'P4', From: '+15556660004', FromState: 'TX', To: '+15558000001' });
  assert.match(twiml, /<Record/);

  // Return request → admin approves → refund
  assert.equal((await agentTX(`/api/calls/${callId}/dispute`, { method: 'POST', body: {} })).status, 400);
  assert.equal((await agentTX(`/api/calls/${callId}/dispute`, { method: 'POST', body: { reason: 'Caller was 92, outside age range' } })).status, 200);
  assert.equal((await agentCA(`/api/calls/${callId}/dispute`, { method: 'POST', body: { reason: 'x' } })).status, 404);
  assert.equal((await admin('/api/calls?dispute=pending')).body.calls.length, 1);
  await admin(`/api/calls/${callId}/resolve`, { method: 'POST', body: { approve: true } });
  wallet = (await agentTX('/api/wallet')).body;
  assert.equal(wallet.balance_cents, 10000);
  assert.equal(wallet.transactions[0].type, 'refund');
});

test('short calls are not billed', async () => {
  const { campaigns } = (await admin('/api/campaigns')).body;
  const id = campaigns.find((c) => c.name === 'FE Calls').id;
  await agentTX(`/api/campaigns/${id}/subscription`, { method: 'PUT', body: { daily_cap: 5 } });
  const twiml = await form('/api/twilio/voice', { CallSid: 'S1', From: '+15556660009', FromState: 'TX', To: '+15558000001' });
  const callId = twiml.match(/whisper\?call=(\d+)/)[1];
  const agent = twiml.match(/agent=(\d+)/)[1];
  await form(`/api/twilio/accept?call=${callId}&agent=${agent}`, {});
  await form(`/api/twilio/dial-done?call=${callId}&attempt=1`, { DialCallStatus: 'completed', DialCallDuration: '30' });
  assert.equal((await agentTX('/api/wallet')).body.balance_cents, 10000);
});

test('stripe webhook credits wallet once with a valid signature', async () => {
  const { createHmac } = await import('node:crypto');
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  const tex = (await admin('/api/agents')).body.agents.find((a) => a.email === 'tex@x.com');
  const payload = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_1', amount_total: 25000, payment_status: 'paid', metadata: { user_id: String(tex.id) } } } });
  const t = Math.floor(Date.now() / 1000);
  const sig = `t=${t},v1=${createHmac('sha256', 'whsec_test').update(`${t}.${payload}`).digest('hex')}`;
  const post = (s) => fetch(`${base}/api/stripe/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': s }, body: payload });
  assert.equal((await post('t=1,v1=bad')).status, 400);
  assert.equal((await post(sig)).status, 200);
  assert.equal((await post(sig)).status, 200);
  assert.equal((await agentTX('/api/wallet')).body.balance_cents, 35000);
});

test('supplier portal: submit campaign, admin approves, earnings, returns and payouts', async () => {
  const sup = client();
  assert.equal((await sup('/api/auth/signup', { method: 'POST', body: { role: 'supplier', name: 'Ad Guy', email: 'ads@x.com', password: 'password1' } })).status, 400); // needs company
  await sup('/api/auth/signup', { method: 'POST', body: { role: 'supplier', name: 'Ad Guy', company: 'Blaze Media', email: 'ads@x.com', password: 'password1' } });
  const me = (await sup('/api/me')).body.user;
  assert.equal(me.role, 'supplier');
  assert.equal((await sup('/api/campaigns', { method: 'POST', body: { name: 'Mine', vertical: 'medicare', price: 40 } })).status, 400); // pending account
  assert.equal((await sup('/api/me', { method: 'PATCH', body: { available: true } })).status, 400);
  assert.equal((await sup('/api/leads')).status, 403);

  await admin(`/api/agents/${me.id}`, { method: 'PATCH', body: { status: 'active' } });
  const created = await sup('/api/campaigns', { method: 'POST', body: { name: 'Blaze Medicare', vertical: 'medicare', price: 40, billable_seconds: 60, phone_number: '+15551110000', status: 'active' } });
  const camp = created.body.campaign;
  assert.equal(camp.status, 'pending'); // suppliers can't self-approve
  assert.equal(camp.phone_number, null); // or pick numbers
  assert.equal(camp.supplier, 'Blaze Media');

  // agents don't see pending campaigns; supplier can still edit price while pending
  assert.ok(!(await agentTX('/api/campaigns')).body.campaigns.some((c) => c.id === camp.id));
  await sup(`/api/campaigns/${camp.id}`, { method: 'PATCH', body: { price: 42 } });
  assert.equal((await admin(`/api/campaigns/${camp.id}`, { method: 'PATCH', body: { status: 'active' } })).status, 400); // needs number
  await admin(`/api/campaigns/${camp.id}`, { method: 'PATCH', body: { status: 'active', phone_number: '+15558000099' } });
  // once live, price is locked for the supplier but they can pause
  await sup(`/api/campaigns/${camp.id}`, { method: 'PATCH', body: { price: 99, status: 'paused' } });
  let mine = (await sup('/api/campaigns')).body.campaigns[0];
  assert.equal(mine.price_cents, 4200);
  assert.equal(mine.status, 'paused');
  await sup(`/api/campaigns/${camp.id}`, { method: 'PATCH', body: { status: 'active' } });

  // TX agent buys a call → supplier earns price minus 20% fee
  await agentTX(`/api/campaigns/${camp.id}/subscription`, { method: 'PUT', body: { active: true, start_hour: 0, end_hour: 0, days: '0123456', daily_cap: 5 } });
  const twiml = await form('/api/twilio/voice', { CallSid: 'SUP1', From: '+15554440001', FromState: 'TX', To: '+15558000099' });
  const callId = twiml.match(/whisper\?call=(\d+)/)[1];
  const agentId = twiml.match(/agent=(\d+)/)[1];
  await form(`/api/twilio/accept?call=${callId}&agent=${agentId}`, {});
  await form(`/api/twilio/dial-done?call=${callId}&attempt=1`, { DialCallStatus: 'completed', DialCallDuration: '75' });
  assert.equal((await sup('/api/wallet')).body.balance_cents, 3360);

  // supplier sees masked caller + their payout per call, not the buyer's full identity
  const [call] = (await sup('/api/calls')).body.calls;
  assert.match(call.from_number, /•••-•••-0001/);
  assert.equal(call.price_cents, 3360);
  assert.equal(call.agent_name, 'Tex');
  const stats = (await sup('/api/stats')).body.supplier;
  assert.equal(stats.totals.billable, 1);
  assert.equal(stats.owed_cents, 3360);

  // a refunded return claws back the supplier's earning
  await agentTX(`/api/calls/${callId}/dispute`, { method: 'POST', body: { reason: 'wrong state' } });
  await admin(`/api/calls/${callId}/resolve`, { method: 'POST', body: { approve: true } });
  assert.equal((await sup('/api/wallet')).body.balance_cents, 0);

  // admin records a payout
  const { suppliers } = (await admin('/api/suppliers')).body;
  assert.equal(suppliers[0].company, 'Blaze Media');
  await admin(`/api/suppliers/${me.id}/payout`, { method: 'POST', body: { amount: 10, note: 'ACH' } });
  const w = (await sup('/api/wallet')).body;
  assert.equal(w.balance_cents, -1000);
  assert.equal(w.transactions[0].type, 'payout');
  // fee is configurable
  assert.equal((await admin('/api/settings/fee', { method: 'PUT', body: { fee_pct: 30 } })).body.fee_pct, 30);
  await admin('/api/settings/fee', { method: 'PUT', body: { fee_pct: 20 } });
});

test('auto-recharge charges the saved card when the balance drops below the threshold', async () => {
  process.env.STRIPE_SECRET_KEY = 'sk_test';
  const realFetch = globalThis.fetch;
  const stripeCalls = [];
  globalThis.fetch = async (url, opts) => {
    if (!String(url).startsWith('https://api.stripe.com')) return realFetch(url, opts);
    stripeCalls.push({ url: String(url), body: opts.body ? Object.fromEntries(new URLSearchParams(opts.body.toString())) : null });
    if (String(url).includes('expand')) {
      return new Response(JSON.stringify({ id: 'pi_dep', payment_method: { id: 'pm_1', card: { brand: 'visa', last4: '4242' } } }));
    }
    const b = Object.fromEntries(new URLSearchParams(opts.body.toString()));
    return new Response(JSON.stringify({ id: `pi_${stripeCalls.length}`, status: 'succeeded', amount: Number(b.amount), amount_received: Number(b.amount), metadata: { user_id: b['metadata[user_id]'], kind: 'auto_recharge' } }));
  };
  try {
    const tex = (await admin('/api/agents')).body.agents.find((a) => a.email === 'tex@x.com');
    // no saved card yet
    assert.equal((await agentTX('/api/wallet/auto-recharge', { method: 'PUT', body: { enabled: true, threshold: 50, amount: 200 } })).status, 400);

    // a card deposit saves the card
    const { createHmac } = await import('node:crypto');
    const payload = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_save', amount_total: 2500, payment_status: 'paid', customer: 'cus_1', payment_intent: 'pi_dep', metadata: { user_id: String(tex.id) } } } });
    const t = Math.floor(Date.now() / 1000);
    await realFetch(`${base}/api/stripe/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${t},v1=${createHmac('sha256', 'whsec_test').update(`${t}.${payload}`).digest('hex')}` }, body: payload });
    let w = (await agentTX('/api/wallet')).body;
    assert.equal(w.card_label, 'Visa •••• 4242');

    // drain the wallet below $50, then enable → immediate recharge of $200
    await admin(`/api/agents/${tex.id}/credit`, { method: 'POST', body: { amount: -(w.balance_cents / 100) + 10 } });
    const r = await agentTX('/api/wallet/auto-recharge', { method: 'PUT', body: { enabled: true, threshold: 50, amount: 200 } });
    assert.equal(r.status, 200);
    assert.equal(r.body.balance_cents, 21000);
    const charge = stripeCalls.find((c) => c.url.endsWith('/payment_intents'));
    assert.equal(charge.body.off_session, 'true');
    assert.equal(charge.body.customer, 'cus_1');
    assert.equal(charge.body.payment_method, 'pm_1');

    // the payment_intent.succeeded webhook for the same charge doesn't double-credit
    const pi = JSON.stringify({ type: 'payment_intent.succeeded', data: { object: { id: 'pi_2', amount: 20000, amount_received: 20000, metadata: { user_id: String(tex.id), kind: 'auto_recharge' } } } });
    await realFetch(`${base}/api/stripe/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${t},v1=${createHmac('sha256', 'whsec_test').update(`${t}.${pi}`).digest('hex')}` }, body: pi });
    w = (await agentTX('/api/wallet')).body;
    assert.equal(w.balance_cents, 21000);
    assert.equal(w.auto_recharge, true);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.STRIPE_SECRET_KEY;
  }
});

test('push subscriptions are saved per user', async () => {
  const key = (await agentTX('/api/push/key')).body.key;
  assert.ok(key.length > 40);
  assert.equal((await agentTX('/api/push/subscribe', { method: 'POST', body: { subscription: { endpoint: 'http://bad' } } })).status, 400);
  assert.equal((await agentTX('/api/push/subscribe', { method: 'POST', body: { subscription: { endpoint: 'https://push.example/abc', keys: { p256dh: 'x', auth: 'y' } } } })).status, 200);
});
