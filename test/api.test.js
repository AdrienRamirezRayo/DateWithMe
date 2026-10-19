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

test('twilio voice rings eligible agents with accept whisper', async () => {
  const form = (path, data) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data) }).then((r) => r.text());
  const twiml = await form('/api/twilio/voice', { CallSid: 'CA1', From: '+15557770000', FromState: 'CA' });
  assert.match(twiml, /<Dial/);
  assert.match(twiml, /\+15553334444/); // CA agent
  assert.doesNotMatch(twiml, /\+15551112222/); // TX agent not licensed in CA
  const leadId = twiml.match(/lead=(\d+)/)[1];

  await form(`/api/twilio/accept?lead=${leadId}`, { To: '+15553334444' });
  const lead = (await agentCA(`/api/leads/${leadId}`)).body.lead;
  assert.equal(lead.source, 'call');
  assert.equal(lead.status, 'contacted');

  await agentCA('/api/me', { method: 'PATCH', body: { available: false } });
  const vm = await form('/api/twilio/voice', { CallSid: 'CA2', From: '+15558880000', FromState: 'CA' });
  assert.match(vm, /<Record/);
});
