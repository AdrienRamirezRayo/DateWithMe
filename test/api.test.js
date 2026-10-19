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
