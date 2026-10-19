import express from 'express';
import { randomBytes } from 'node:crypto';
import { db, getSetting, setSetting, logActivity } from './src/db.js';
import {
  hashPassword, verifyPassword, createSession, destroySession, currentUser,
  requireUser, requireAdmin, publicUser,
} from './src/auth.js';
import {
  STATUSES, US_STATES, createLead, getLead, assignLead, updateStatus, normalizePhone, normalizeStates,
} from './src/leads.js';
import { subscribe, broadcastLead, twilioConfigured } from './src/notify.js';
import { twilio } from './src/twilio.js';
import { VERTICALS, callsToday } from './src/campaigns.js';
import {
  applyTransaction, resolveDispute, createCheckout, verifyStripeSignature, handleStripeEvent,
  stripeConfigured, MIN_DEPOSIT_CENTS, DISPUTE_WINDOW_HOURS,
} from './src/wallet.js';

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

// Stripe needs the raw body to verify its signature, so this route comes before the JSON parser.
app.post('/api/stripe/webhook', express.raw({ type: 'application/json', limit: '1mb' }), (req, res) => {
  const raw = req.body.toString('utf8');
  if (!verifyStripeSignature(raw, req.get('Stripe-Signature'))) return res.status(400).send('Bad signature');
  handleStripeEvent(JSON.parse(raw));
  res.json({ received: true });
});
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));

if (!getSetting('webhook_key')) setSetting('webhook_key', randomBytes(24).toString('hex'));

// Optional first admin from env, so a fresh deploy isn't claimable by whoever signs up first.
const { ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
if (ADMIN_EMAIL && ADMIN_PASSWORD && !db.prepare('SELECT 1 FROM users WHERE email = ?').get(ADMIN_EMAIL)) {
  db.prepare("INSERT INTO users (name, email, password_hash, role, status) VALUES (?, ?, ?, 'admin', 'active')")
    .run('Admin', ADMIN_EMAIL, hashPassword(ADMIN_PASSWORD));
}

const clip = (v, n = 200) => String(v ?? '').trim().slice(0, n);
const bad = (res, error, code = 400) => res.status(code).json({ error });

// ---------- Auth ----------

app.post('/api/auth/signup', (req, res) => {
  const name = clip(req.body.name, 80);
  const email = clip(req.body.email, 160).toLowerCase();
  const password = String(req.body.password || '');
  if (!name || !/^\S+@\S+\.\S+$/.test(email)) return bad(res, 'Enter your name and a valid email.');
  if (password.length < 8) return bad(res, 'Password must be at least 8 characters.');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) return bad(res, 'That email already has an account.');

  const first = !db.prepare('SELECT 1 FROM users LIMIT 1').get();
  const { lastInsertRowid } = db.prepare(`
    INSERT INTO users (name, email, phone, password_hash, states, role, status) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(name, email, normalizePhone(req.body.phone), hashPassword(password), normalizeStates(req.body.states),
    first ? 'admin' : 'agent', first ? 'active' : 'pending');
  createSession(res, Number(lastInsertRowid));
  res.json({ ok: true });
});

app.post('/api/auth/login', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(clip(req.body.email, 160).toLowerCase());
  if (!user || !verifyPassword(String(req.body.password || ''), user.password_hash)) {
    return bad(res, 'Wrong email or password.', 401);
  }
  if (user.status === 'disabled') return bad(res, 'This account has been disabled.', 403);
  createSession(res, user.id);
  res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => {
  destroySession(req, res);
  res.json({ ok: true });
});

app.get('/api/me', requireUser, (req, res) => {
  res.json({ user: publicUser(req.user), states: US_STATES, statuses: STATUSES, verticals: VERTICALS });
});

app.patch('/api/me', requireUser, (req, res) => {
  const u = req.user;
  const b = req.body;
  if (b.available && u.status !== 'active') return bad(res, 'Your account is waiting for admin approval.');
  let timezone = u.timezone;
  if (b.timezone !== undefined) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: b.timezone }); timezone = clip(b.timezone, 60); } catch { return bad(res, 'Unknown timezone.'); }
  }
  db.prepare('UPDATE users SET name = ?, phone = ?, states = ?, available = ?, sms_alerts = ?, timezone = ? WHERE id = ?').run(
    b.name !== undefined ? clip(b.name, 80) || u.name : u.name,
    b.phone !== undefined ? normalizePhone(b.phone) : u.phone,
    b.states !== undefined ? normalizeStates(b.states) : u.states,
    b.available !== undefined ? (b.available ? 1 : 0) : u.available,
    b.sms_alerts !== undefined ? (b.sms_alerts ? 1 : 0) : u.sms_alerts,
    timezone,
    u.id,
  );
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id)) });
});

app.get('/api/events', requireUser, subscribe);

// ---------- Lead intake ----------

const hits = new Map();
function rateLimited(ip, max = 5, windowMs = 10 * 60e3) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > max;
}

// The consumer quote form that ads point at.
app.post('/api/leads/public', (req, res) => {
  const b = req.body;
  if (b.company) return res.json({ ok: true }); // honeypot: bots fill hidden fields
  if (rateLimited(req.ip)) return bad(res, 'Too many submissions. Please try again later.', 429);
  if (!clip(b.first_name) || normalizePhone(b.phone).length < 12) return bad(res, 'Please enter your name and a valid phone number.');
  if (!b.consent_text) return bad(res, 'Please agree to be contacted so an agent can reach you.');
  createLead(b, { source: 'form', ip: req.ip });
  res.json({ ok: true });
});

// For Facebook Lead Ads / Zapier / any lead vendor: POST JSON with header x-api-key.
app.post('/api/leads/webhook', (req, res) => {
  if (req.get('x-api-key') !== getSetting('webhook_key')) return bad(res, 'Invalid API key.', 401);
  const b = req.body;
  if (!b.phone && !b.email) return bad(res, 'A lead needs a phone or email.');
  const lead = createLead(b, { source: 'webhook', ip: req.ip });
  res.json({ ok: true, id: lead.id });
});

// ---------- Leads (dashboard) ----------

function canSee(user, lead) {
  return lead && (user.role === 'admin' || lead.agent_id === user.id);
}

function leadQuery(user, q) {
  const where = [];
  const args = [];
  if (user.role !== 'admin' || q.scope === 'mine') { where.push('l.agent_id = ?'); args.push(user.id); }
  else if (q.scope === 'unassigned') where.push('l.agent_id IS NULL');
  else if (/^\d+$/.test(q.scope || '')) { where.push('l.agent_id = ?'); args.push(Number(q.scope)); }
  if (STATUSES.includes(q.status)) { where.push('l.status = ?'); args.push(q.status); }
  if (q.source) { where.push('l.source = ?'); args.push(q.source); }
  if (q.q) {
    where.push("(l.first_name || ' ' || l.last_name LIKE ? OR l.phone LIKE ? OR l.email LIKE ?)");
    const like = `%${clip(q.q, 80)}%`;
    args.push(like, `%${q.q.replace(/\D/g, '') || clip(q.q, 80)}%`, like);
  }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', args };
}

app.get('/api/leads', requireUser, (req, res) => {
  const { sql, args } = leadQuery(req.user, req.query);
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const offset = Number(req.query.offset) || 0;
  const leads = db.prepare(`
    SELECT l.*, u.name AS agent_name FROM leads l LEFT JOIN users u ON u.id = l.agent_id
    ${sql} ORDER BY l.created_at DESC, l.id DESC LIMIT ? OFFSET ?
  `).all(...args, limit, offset);
  const { total } = db.prepare(`SELECT COUNT(*) AS total FROM leads l ${sql}`).get(...args);
  res.json({ leads, total });
});

app.get('/api/leads.csv', requireAdmin, (req, res) => {
  const { sql, args } = leadQuery(req.user, req.query);
  const rows = db.prepare(`
    SELECT l.id, l.created_at, l.first_name, l.last_name, l.phone, l.email, l.state, l.zip, l.age,
      l.coverage_type, l.coverage_amount, l.source, l.utm_source, l.utm_medium, l.utm_campaign, l.utm_content,
      l.status, u.name AS agent, l.premium, l.consent_at, l.ip
    FROM leads l LEFT JOIN users u ON u.id = l.agent_id ${sql} ORDER BY l.id DESC
  `).all(...args);
  const cols = rows[0] ? Object.keys(rows[0]) : ['id'];
  const cell = (v) => {
    const s = String(v ?? '');
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s; // block spreadsheet formula injection
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  res.type('text/csv').attachment('leadrush-leads.csv')
    .send([cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n'));
});

app.post('/api/leads', requireUser, (req, res) => {
  if (!req.body.phone && !req.body.email) return bad(res, 'Add a phone or email.');
  const lead = createLead(req.body, { source: 'manual', route: false });
  assignLead(lead.id, req.user.id, req.user.id);
  const fresh = getLead(lead.id);
  broadcastLead('lead:new', fresh);
  res.json({ lead: fresh });
});

app.get('/api/leads/:id', requireUser, (req, res) => {
  const lead = getLead(Number(req.params.id));
  if (!canSee(req.user, lead)) return bad(res, 'Lead not found.', 404);
  const activities = db.prepare(`
    SELECT a.*, u.name AS user_name FROM activities a LEFT JOIN users u ON u.id = a.user_id
    WHERE a.lead_id = ? ORDER BY a.id DESC
  `).all(lead.id);
  res.json({ lead, activities });
});

app.patch('/api/leads/:id', requireUser, (req, res) => {
  const id = Number(req.params.id);
  const lead = getLead(id);
  if (!canSee(req.user, lead)) return bad(res, 'Lead not found.', 404);
  const b = req.body;

  if (b.status !== undefined) {
    if (!STATUSES.includes(b.status)) return bad(res, 'Unknown status.');
    const premium = b.premium !== undefined && b.premium !== '' ? Number(b.premium) || 0 : undefined;
    updateStatus(id, b.status, req.user.id, premium);
  }
  if (b.agent_id !== undefined && req.user.role === 'admin') {
    if (b.agent_id === null) {
      db.prepare('UPDATE leads SET agent_id = NULL, assigned_at = NULL WHERE id = ?').run(id);
      logActivity(id, req.user.id, 'assigned', 'Moved back to unassigned pool');
    } else {
      const agent = db.prepare("SELECT id FROM users WHERE id = ? AND status = 'active'").get(Number(b.agent_id));
      if (!agent) return bad(res, 'That agent is not active.');
      assignLead(id, agent.id, req.user.id);
    }
  }
  const fresh = getLead(id);
  broadcastLead('lead:update', fresh);
  if (lead.agent_id && lead.agent_id !== fresh.agent_id) broadcastLead('lead:removed', { ...fresh, agent_id: lead.agent_id });
  res.json({ lead: fresh });
});

app.post('/api/leads/:id/notes', requireUser, (req, res) => {
  const lead = getLead(Number(req.params.id));
  if (!canSee(req.user, lead)) return bad(res, 'Lead not found.', 404);
  const body = clip(req.body.body, 2000);
  if (!body) return bad(res, 'Note is empty.');
  logActivity(lead.id, req.user.id, 'note', body);
  res.json({ ok: true });
});

// ---------- Stats ----------

app.get('/api/stats', requireUser, (req, res) => {
  const days = [7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
  const admin = req.user.role === 'admin';
  const scope = admin ? '1=1' : 'agent_id = ?';
  const args = admin ? [] : [req.user.id];
  const since = `created_at >= datetime('now', '-${days} days')`;

  const totals = db.prepare(`
    SELECT COUNT(*) AS leads,
      SUM(status = 'new') AS new,
      SUM(status IN ('contacted','appointment','sold')) AS contacted,
      SUM(status IN ('appointment','sold')) AS appointments,
      SUM(status = 'sold') AS sold,
      COALESCE(SUM(CASE WHEN status = 'sold' THEN premium END), 0) AS premium,
      AVG(CASE WHEN first_contact_at IS NOT NULL
        THEN (julianday(first_contact_at) - julianday(created_at)) * 1440 END) AS speed_minutes,
      SUM(source = 'call') AS calls
    FROM leads WHERE ${scope} AND ${since}
  `).get(...args);

  const daily = db.prepare(`
    SELECT date(created_at) AS day, COUNT(*) AS leads, SUM(status = 'sold') AS sold
    FROM leads WHERE ${scope} AND ${since} GROUP BY day ORDER BY day
  `).all(...args);

  const calls = db.prepare(`
    SELECT COUNT(*) AS calls, SUM(price_cents > 0) AS billable, COALESCE(SUM(price_cents), 0) AS spend_cents,
      AVG(CASE WHEN status = 'completed' THEN duration END) AS avg_duration
    FROM calls WHERE ${scope} AND ${since} AND (dispute_status IS NULL OR dispute_status != 'approved')
  `).get(...args);

  const out = { days, totals, daily, calls };
  if (admin) {
    out.campaigns = db.prepare(`
      SELECT COALESCE(NULLIF(utm_source, ''), source) AS source, COALESCE(NULLIF(utm_campaign, ''), '—') AS campaign,
        COUNT(*) AS leads, SUM(status IN ('appointment','sold')) AS appointments, SUM(status = 'sold') AS sold,
        COALESCE(SUM(CASE WHEN status = 'sold' THEN premium END), 0) AS premium
      FROM leads WHERE ${since} GROUP BY 1, 2 ORDER BY leads DESC LIMIT 50
    `).all();
    out.agents = db.prepare(`
      SELECT u.id, u.name, u.available, COUNT(l.id) AS leads, SUM(l.status = 'sold') AS sold,
        COALESCE(SUM(CASE WHEN l.status = 'sold' THEN l.premium END), 0) AS premium,
        AVG(CASE WHEN l.first_contact_at IS NOT NULL
          THEN (julianday(l.first_contact_at) - julianday(l.created_at)) * 1440 END) AS speed_minutes
      FROM users u LEFT JOIN leads l ON l.agent_id = u.id AND l.${since}
      WHERE u.status = 'active' GROUP BY u.id ORDER BY premium DESC, sold DESC, leads DESC
    `).all();
    out.unassigned = db.prepare("SELECT COUNT(*) AS n FROM leads WHERE agent_id IS NULL AND status = 'new'").get().n;
    out.online = db.prepare("SELECT COUNT(*) AS n FROM users WHERE status = 'active' AND available = 1").get().n;
    out.wallets_cents = db.prepare('SELECT COALESCE(SUM(balance_cents), 0) AS n FROM users').get().n;
    out.disputes = db.prepare("SELECT COUNT(*) AS n FROM calls WHERE dispute_status = 'pending'").get().n;
  }
  res.json(out);
});

// ---------- Admin ----------

app.get('/api/agents', requireAdmin, (req, res) => {
  const agents = db.prepare(`
    SELECT u.*, (SELECT COUNT(*) FROM leads WHERE agent_id = u.id) AS lead_count
    FROM users u ORDER BY u.status = 'pending' DESC, u.name
  `).all().map((a) => ({ ...publicUser(a), lead_count: a.lead_count }));
  res.json({ agents });
});

app.patch('/api/agents/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const agent = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!agent) return bad(res, 'Agent not found.', 404);
  const b = req.body;
  if (id === req.user.id && (b.role === 'agent' || b.status === 'disabled')) {
    return bad(res, "You can't demote or disable yourself.");
  }
  const status = ['pending', 'active', 'disabled'].includes(b.status) ? b.status : agent.status;
  db.prepare('UPDATE users SET status = ?, role = ?, states = ?, phone = ?, available = ? WHERE id = ?').run(
    status,
    ['admin', 'agent'].includes(b.role) ? b.role : agent.role,
    b.states !== undefined ? normalizeStates(b.states) : agent.states,
    b.phone !== undefined ? normalizePhone(b.phone) : agent.phone,
    status === 'active' ? agent.available : 0,
    id,
  );
  if (status === 'disabled') db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  res.json({ agent: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id)) });
});

app.post('/api/agents/:id/credit', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) return bad(res, 'Agent not found.', 404);
  const cents = Math.round(Number(req.body.amount) * 100);
  if (!Number.isFinite(cents) || cents === 0) return bad(res, 'Enter an amount, e.g. 100 or -25.');
  applyTransaction({
    userId: id, amountCents: cents, type: 'adjustment', allowNegative: true,
    note: clip(req.body.note, 200) || `${cents > 0 ? 'Credit' : 'Debit'} by ${req.user.name}`,
  });
  res.json({ balance_cents: db.prepare('SELECT balance_cents FROM users WHERE id = ?').get(id).balance_cents });
});

// ---------- Campaigns (pay-per-call marketplace) ----------

function campaignInput(b, existing = {}) {
  const v = {
    name: b.name !== undefined ? clip(b.name, 100) : existing.name,
    vertical: b.vertical !== undefined ? b.vertical : existing.vertical,
    supplier: b.supplier !== undefined ? clip(b.supplier, 100) : existing.supplier ?? '',
    phone_number: b.phone_number !== undefined ? normalizePhone(b.phone_number) || null : existing.phone_number ?? null,
    price_cents: b.price !== undefined ? Math.round(Number(b.price) * 100) : existing.price_cents,
    billable_seconds: b.billable_seconds !== undefined ? Math.max(0, Number.parseInt(b.billable_seconds, 10) || 0) : existing.billable_seconds ?? 90,
    states: b.states !== undefined ? normalizeStates(b.states) : existing.states ?? '',
    description: b.description !== undefined ? clip(b.description, 500) : existing.description ?? '',
    status: ['active', 'paused'].includes(b.status) ? b.status : existing.status ?? 'active',
  };
  if (!v.name) return { error: 'Give the campaign a name.' };
  if (!VERTICALS[v.vertical]) return { error: 'Pick a vertical.' };
  if (!(v.price_cents > 0)) return { error: 'Set a price per call.' };
  if (v.phone_number) {
    const clash = db.prepare('SELECT id FROM campaigns WHERE phone_number = ? AND id != ?').get(v.phone_number, existing.id ?? 0);
    if (clash) return { error: 'Another campaign already uses that phone number.' };
  }
  return { v };
}

app.get('/api/campaigns', requireUser, (req, res) => {
  const admin = req.user.role === 'admin';
  const campaigns = db.prepare(`
    SELECT k.*, s.id AS sub_id, s.active AS sub_active, s.daily_cap, s.start_hour, s.end_hour, s.days,
      (SELECT COUNT(*) FROM subscriptions WHERE campaign_id = k.id AND active = 1) AS buyers,
      (SELECT COUNT(*) FROM calls WHERE campaign_id = k.id AND created_at >= datetime('now', '-30 days')) AS calls_30d
    FROM campaigns k LEFT JOIN subscriptions s ON s.campaign_id = k.id AND s.user_id = ?
    ${admin ? '' : "WHERE k.status = 'active'"} ORDER BY k.status, k.vertical, k.price_cents
  `).all(req.user.id).map((c) => ({
    ...c,
    calls_today: c.sub_id ? callsToday(req.user.id, c.id, req.user.timezone) : 0,
    ...(admin ? {} : { phone_number: undefined, buyers: undefined, calls_30d: undefined }),
  }));
  res.json({ campaigns });
});

app.post('/api/campaigns', requireAdmin, (req, res) => {
  const { v, error } = campaignInput(req.body);
  if (error) return bad(res, error);
  const cols = Object.keys(v);
  const { lastInsertRowid } = db.prepare(`INSERT INTO campaigns (${cols}) VALUES (${cols.map(() => '?')})`).run(...Object.values(v));
  res.json({ campaign: db.prepare('SELECT * FROM campaigns WHERE id = ?').get(Number(lastInsertRowid)) });
});

app.patch('/api/campaigns/:id', requireAdmin, (req, res) => {
  const existing = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(Number(req.params.id));
  if (!existing) return bad(res, 'Campaign not found.', 404);
  const { v, error } = campaignInput(req.body, existing);
  if (error) return bad(res, error);
  db.prepare(`UPDATE campaigns SET ${Object.keys(v).map((k) => `${k} = ?`)} WHERE id = ?`).run(...Object.values(v), existing.id);
  res.json({ campaign: db.prepare('SELECT * FROM campaigns WHERE id = ?').get(existing.id) });
});

// An agent turning a campaign on/off for themselves and setting their buying filters.
app.put('/api/campaigns/:id/subscription', requireUser, (req, res) => {
  const campaign = db.prepare("SELECT * FROM campaigns WHERE id = ? AND status = 'active'").get(Number(req.params.id));
  if (!campaign) return bad(res, 'Campaign not found.', 404);
  if (req.user.status !== 'active') return bad(res, 'Your account is waiting for admin approval.');
  const b = req.body;
  const hour = (h, d) => (Number.isInteger(Number(h)) && h !== '' && h !== null && Number(h) >= 0 && Number(h) <= 23 ? Number(h) : d);
  const cur = db.prepare('SELECT * FROM subscriptions WHERE user_id = ? AND campaign_id = ?').get(req.user.id, campaign.id) || {};
  const sub = {
    active: b.active !== undefined ? (b.active ? 1 : 0) : cur.active ?? 1,
    daily_cap: b.daily_cap !== undefined ? Math.min(500, Math.max(1, Number.parseInt(b.daily_cap, 10) || 1)) : cur.daily_cap ?? 10,
    start_hour: hour(b.start_hour, cur.start_hour ?? 9),
    end_hour: hour(b.end_hour, cur.end_hour ?? 18),
    days: b.days !== undefined ? [...new Set(String(b.days).replace(/[^0-6]/g, ''))].sort().join('') : cur.days ?? '12345',
  };
  if (!sub.days) return bad(res, 'Pick at least one day.');
  db.prepare(`
    INSERT INTO subscriptions (user_id, campaign_id, active, daily_cap, start_hour, end_hour, days) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, campaign_id) DO UPDATE SET active = excluded.active, daily_cap = excluded.daily_cap,
      start_hour = excluded.start_hour, end_hour = excluded.end_hour, days = excluded.days
  `).run(req.user.id, campaign.id, sub.active, sub.daily_cap, sub.start_hour, sub.end_hour, sub.days);
  res.json({ subscription: sub });
});

// ---------- Calls, returns ----------

app.get('/api/calls', requireUser, (req, res) => {
  const admin = req.user.role === 'admin';
  const where = [];
  const args = [];
  if (!admin || req.query.scope === 'mine') { where.push('c.agent_id = ?'); args.push(req.user.id); }
  if (req.query.dispute === 'pending') where.push("c.dispute_status = 'pending'");
  if (req.query.billed === '1') where.push('c.price_cents > 0');
  const calls = db.prepare(`
    SELECT c.*, k.name AS campaign_name, k.vertical, k.billable_seconds, u.name AS agent_name,
      l.first_name, l.last_name
    FROM calls c LEFT JOIN campaigns k ON k.id = c.campaign_id LEFT JOIN users u ON u.id = c.agent_id
    LEFT JOIN leads l ON l.id = c.lead_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY c.id DESC LIMIT 300
  `).all(...args);
  res.json({ calls, dispute_window_hours: DISPUTE_WINDOW_HOURS });
});

app.post('/api/calls/:id/dispute', requireUser, (req, res) => {
  const call = db.prepare('SELECT * FROM calls WHERE id = ?').get(Number(req.params.id));
  if (!call || call.agent_id !== req.user.id) return bad(res, 'Call not found.', 404);
  if (!(call.price_cents > 0)) return bad(res, 'Only billed calls can be returned.');
  if (call.dispute_status) return bad(res, 'A return was already requested for this call.');
  const age = (Date.now() - new Date(`${call.created_at.replace(' ', 'T')}Z`)) / 36e5;
  if (age > DISPUTE_WINDOW_HOURS) return bad(res, `Returns must be requested within ${DISPUTE_WINDOW_HOURS} hours.`);
  const reason = clip(req.body.reason, 300);
  if (!reason) return bad(res, 'Tell us why this call should be returned.');
  db.prepare("UPDATE calls SET dispute_status = 'pending', dispute_reason = ? WHERE id = ?").run(reason, call.id);
  res.json({ ok: true });
});

app.post('/api/calls/:id/resolve', requireAdmin, (req, res) => {
  if (!resolveDispute(Number(req.params.id), !!req.body.approve)) return bad(res, 'No pending return on that call.');
  res.json({ ok: true });
});

// ---------- Wallet ----------

app.get('/api/wallet', requireUser, (req, res) => {
  const transactions = db.prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 200').all(req.user.id);
  const { balance_cents } = db.prepare('SELECT balance_cents FROM users WHERE id = ?').get(req.user.id);
  res.json({ balance_cents, transactions, stripe: stripeConfigured(), min_deposit_cents: MIN_DEPOSIT_CENTS });
});

app.post('/api/wallet/checkout', requireUser, async (req, res) => {
  if (!stripeConfigured()) return bad(res, 'Card payments are not set up yet. Ask your admin to add funds.');
  const cents = Math.round(Number(req.body.amount) * 100);
  if (!(cents >= MIN_DEPOSIT_CENTS) || cents > 5000000) return bad(res, `Minimum deposit is $${MIN_DEPOSIT_CENTS / 100}.`);
  const baseUrl = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  res.json({ url: await createCheckout({ user: req.user, amountCents: cents, baseUrl }) });
});

app.get('/api/settings', requireAdmin, (req, res) => {
  const url = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  res.json({
    webhook_key: getSetting('webhook_key'),
    public_url: url,
    twilio: twilioConfigured(),
    twilio_number: process.env.TWILIO_PHONE_NUMBER || null,
    stripe: stripeConfigured(),
  });
});

app.post('/api/settings/rotate-key', requireAdmin, (req, res) => {
  setSetting('webhook_key', randomBytes(24).toString('hex'));
  res.json({ webhook_key: getSetting('webhook_key') });
});

// ---------- Calls + pages ----------

app.use('/api/twilio', twilio);
app.use('/api', (req, res) => bad(res, 'Not found.', 404));

app.get(['/login', '/signup'], (req, res, next) => (currentUser(req) ? res.redirect('/dashboard') : next()));
app.get('/dashboard', (req, res, next) => (currentUser(req) ? next() : res.redirect('/login')));
app.use(express.static('public', { extensions: ['html'] }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong.' });
});

const port = Number(process.env.PORT) || 3000;
if (process.env.NODE_ENV !== 'test') {
  app.listen(port, () => console.log(`⚡ LeadRush running on http://localhost:${port}`));
}

export default app;
