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
import {
  subscribe, broadcastLead, twilioConfigured, vapidPublicKey, savePushSubscription, removePushSubscription, sendPush,
} from './src/notify.js';
import { twilio } from './src/twilio.js';
import { VERTICALS, callsToday } from './src/campaigns.js';
import {
  applyTransaction, resolveDispute, createCheckout, verifyStripeSignature, handleStripeEvent,
  stripeConfigured, maybeAutoRecharge, platformFeePct, MIN_DEPOSIT_CENTS, DISPUTE_WINDOW_HOURS,
} from './src/wallet.js';

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

// Stripe needs the raw body to verify its signature, so this route comes before the JSON parser.
app.post('/api/stripe/webhook', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
  const raw = req.body.toString('utf8');
  if (!verifyStripeSignature(raw, req.get('Stripe-Signature'))) return res.status(400).send('Bad signature');
  await handleStripeEvent(JSON.parse(raw));
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
const money = (c) => `$${(c / 100).toFixed(2)}`;

// Agents and admins buy calls and work leads; suppliers only sell.
function requireBuyer(req, res, next) {
  requireUser(req, res, () => {
    if (req.user.role === 'supplier') return bad(res, 'Not available on supplier accounts.', 403);
    next();
  });
}

// ---------- Auth ----------

app.post('/api/auth/signup', (req, res) => {
  const name = clip(req.body.name, 80);
  const email = clip(req.body.email, 160).toLowerCase();
  const password = String(req.body.password || '');
  if (!name || !/^\S+@\S+\.\S+$/.test(email)) return bad(res, 'Enter your name and a valid email.');
  if (password.length < 8) return bad(res, 'Password must be at least 8 characters.');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) return bad(res, 'That email already has an account.');
  const supplier = req.body.role === 'supplier';
  const company = clip(req.body.company, 100);
  if (supplier && !company) return bad(res, 'Enter your company name.');

  const first = !db.prepare('SELECT 1 FROM users LIMIT 1').get();
  const { lastInsertRowid } = db.prepare(`
    INSERT INTO users (name, email, phone, password_hash, states, company, role, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(name, email, normalizePhone(req.body.phone), hashPassword(password), normalizeStates(req.body.states), company,
    first ? 'admin' : supplier ? 'supplier' : 'agent', first ? 'active' : 'pending');
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
  if (b.available && u.role === 'supplier') return bad(res, 'Supplier accounts sell calls, they don\'t receive them.');
  if (b.available && u.status !== 'active') return bad(res, 'Your account is waiting for admin approval.');
  let timezone = u.timezone;
  if (b.timezone !== undefined) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: b.timezone }); timezone = clip(b.timezone, 60); } catch { return bad(res, 'Unknown timezone.'); }
  }
  db.prepare('UPDATE users SET name = ?, phone = ?, states = ?, available = ?, sms_alerts = ?, timezone = ?, company = ? WHERE id = ?').run(
    b.name !== undefined ? clip(b.name, 80) || u.name : u.name,
    b.phone !== undefined ? normalizePhone(b.phone) : u.phone,
    b.states !== undefined ? normalizeStates(b.states) : u.states,
    b.available !== undefined ? (b.available ? 1 : 0) : u.available,
    b.sms_alerts !== undefined ? (b.sms_alerts ? 1 : 0) : u.sms_alerts,
    timezone,
    b.company !== undefined ? clip(b.company, 100) || u.company : u.company,
    u.id,
  );
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id)) });
});

app.get('/api/events', requireUser, subscribe);

app.get('/api/push/key', requireUser, (req, res) => res.json({ key: vapidPublicKey() }));
app.post('/api/push/subscribe', requireUser, (req, res) => {
  if (!savePushSubscription(req.user.id, req.body.subscription)) return bad(res, 'Invalid push subscription.');
  res.json({ ok: true });
});
app.post('/api/push/unsubscribe', requireUser, (req, res) => {
  removePushSubscription(req.user.id, String(req.body.endpoint || ''));
  res.json({ ok: true });
});

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

app.get('/api/leads', requireBuyer, (req, res) => {
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

app.post('/api/leads', requireBuyer, (req, res) => {
  if (!req.body.phone && !req.body.email) return bad(res, 'Add a phone or email.');
  const lead = createLead(req.body, { source: 'manual', route: false });
  assignLead(lead.id, req.user.id, req.user.id);
  const fresh = getLead(lead.id);
  broadcastLead('lead:new', fresh);
  res.json({ lead: fresh });
});

app.get('/api/leads/:id', requireBuyer, (req, res) => {
  const lead = getLead(Number(req.params.id));
  if (!canSee(req.user, lead)) return bad(res, 'Lead not found.', 404);
  const activities = db.prepare(`
    SELECT a.*, u.name AS user_name FROM activities a LEFT JOIN users u ON u.id = a.user_id
    WHERE a.lead_id = ? ORDER BY a.id DESC
  `).all(lead.id);
  res.json({ lead, activities });
});

app.patch('/api/leads/:id', requireBuyer, (req, res) => {
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

app.post('/api/leads/:id/notes', requireBuyer, (req, res) => {
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
  if (req.user.role === 'supplier') return res.json(supplierStats(req.user, days));
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

function supplierStats(user, days) {
  const since = `c.created_at >= datetime('now', '-${days} days')`;
  const ok = "(c.dispute_status IS NULL OR c.dispute_status != 'approved')";
  const totals = db.prepare(`
    SELECT COUNT(*) AS calls,
      SUM(c.agent_id IS NOT NULL) AS connected,
      SUM(c.price_cents > 0 AND ${ok}) AS billable,
      SUM(c.dispute_status = 'approved') AS returned,
      COALESCE(SUM(CASE WHEN ${ok} THEN c.supplier_cents END), 0) AS earned_cents,
      AVG(CASE WHEN c.status = 'completed' THEN c.duration END) AS avg_duration
    FROM calls c JOIN campaigns k ON k.id = c.campaign_id WHERE k.supplier_id = ? AND ${since}
  `).get(user.id);
  const daily = db.prepare(`
    SELECT date(c.created_at) AS day, COUNT(*) AS leads, SUM(c.price_cents > 0 AND ${ok}) AS sold
    FROM calls c JOIN campaigns k ON k.id = c.campaign_id WHERE k.supplier_id = ? AND ${since} GROUP BY day ORDER BY day
  `).all(user.id);
  const campaigns = db.prepare(`
    SELECT k.id, k.name, k.vertical, k.status, k.price_cents, COUNT(c.id) AS calls,
      SUM(c.price_cents > 0 AND ${ok}) AS billable, SUM(c.dispute_status = 'approved') AS returned,
      COALESCE(SUM(CASE WHEN ${ok} THEN c.supplier_cents END), 0) AS earned_cents
    FROM campaigns k LEFT JOIN calls c ON c.campaign_id = k.id AND ${since}
    WHERE k.supplier_id = ? GROUP BY k.id ORDER BY earned_cents DESC
  `).all(user.id);
  const { balance_cents } = db.prepare('SELECT balance_cents FROM users WHERE id = ?').get(user.id);
  return { days, supplier: { totals, campaigns, owed_cents: balance_cents, fee_pct: platformFeePct() }, daily };
}

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
    agent.role !== 'supplier' && ['admin', 'agent'].includes(b.role) ? b.role : agent.role,
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

// Suppliers submit campaigns for review and can only change pricing while pending;
// admins control the tracking number, approval and everything else.
function campaignInput(b, existing, user) {
  const admin = user.role === 'admin';
  const locked = !admin && existing.id && existing.status !== 'pending';
  const pick = (key, fn, fallback) => (b[key] !== undefined && !(locked && ['name', 'vertical', 'price', 'billable_seconds'].includes(key)) ? fn(b[key]) : fallback);
  const v = {
    name: pick('name', (x) => clip(x, 100), existing.name),
    vertical: pick('vertical', (x) => x, existing.vertical),
    supplier: admin ? pick('supplier', (x) => clip(x, 100), existing.supplier ?? '') : user.company || user.name,
    supplier_id: admin ? pick('supplier_id', (x) => (x ? Number(x) : null), existing.supplier_id ?? null) : user.id,
    phone_number: admin ? pick('phone_number', (x) => normalizePhone(x) || null, existing.phone_number ?? null) : existing.phone_number ?? null,
    price_cents: pick('price', (x) => Math.round(Number(x) * 100), existing.price_cents),
    billable_seconds: pick('billable_seconds', (x) => Math.max(0, Number.parseInt(x, 10) || 0), existing.billable_seconds ?? 90),
    states: pick('states', normalizeStates, existing.states ?? ''),
    description: pick('description', (x) => clip(x, 500), existing.description ?? ''),
    status: existing.status ?? (admin ? 'active' : 'pending'),
  };
  if (admin && ['pending', 'active', 'paused'].includes(b.status)) v.status = b.status;
  // Suppliers can pause/resume an approved campaign, but not approve their own.
  if (!admin && existing.id && existing.status !== 'pending' && ['active', 'paused'].includes(b.status)) v.status = b.status;

  if (!v.name) return { error: 'Give the campaign a name.' };
  if (!VERTICALS[v.vertical]) return { error: 'Pick a vertical.' };
  if (!(v.price_cents > 0)) return { error: 'Set a price per call.' };
  if (v.supplier_id) {
    const s = db.prepare("SELECT company, name FROM users WHERE id = ? AND role = 'supplier'").get(v.supplier_id);
    if (!s) return { error: 'That supplier does not exist.' };
    if (admin && b.supplier === undefined) v.supplier = s.company || s.name;
  } else if (admin && b.supplier_id !== undefined && b.supplier === undefined) {
    v.supplier = '';
  }
  if (v.status === 'active' && !v.phone_number && admin && existing.status === 'pending') {
    return { error: 'Assign a Twilio tracking number before approving.' };
  }
  if (v.phone_number) {
    const clash = db.prepare('SELECT id FROM campaigns WHERE phone_number = ? AND id != ?').get(v.phone_number, existing.id ?? 0);
    if (clash) return { error: 'Another campaign already uses that phone number.' };
  }
  return { v };
}

app.get('/api/campaigns', requireUser, (req, res) => {
  const { role, id: me } = req.user;
  const where = role === 'admin' ? '' : role === 'supplier' ? 'WHERE k.supplier_id = ?' : "WHERE k.status = 'active'";
  const campaigns = db.prepare(`
    SELECT k.*, s.id AS sub_id, s.active AS sub_active, s.daily_cap, s.start_hour, s.end_hour, s.days,
      (SELECT COUNT(*) FROM subscriptions WHERE campaign_id = k.id AND active = 1) AS buyers,
      (SELECT COUNT(*) FROM calls WHERE campaign_id = k.id AND created_at >= datetime('now', '-30 days')) AS calls_30d,
      (SELECT COUNT(*) FROM calls WHERE campaign_id = k.id AND price_cents > 0 AND created_at >= datetime('now', '-30 days')) AS billable_30d
    FROM campaigns k LEFT JOIN subscriptions s ON s.campaign_id = k.id AND s.user_id = ?
    ${where} ORDER BY k.status = 'pending' DESC, k.status, k.vertical, k.price_cents
  `).all(me, ...(role === 'supplier' ? [me] : [])).map((c) => ({
    ...c,
    calls_today: c.sub_id ? callsToday(me, c.id, req.user.timezone) : 0,
    ...(role === 'agent' ? { phone_number: undefined, buyers: undefined, calls_30d: undefined, billable_30d: undefined } : {}),
  }));
  res.json({ campaigns, fee_pct: platformFeePct() });
});

app.post('/api/campaigns', requireUser, (req, res) => {
  if (!['admin', 'supplier'].includes(req.user.role)) return bad(res, 'Only admins and suppliers create campaigns.', 403);
  if (req.user.status !== 'active') return bad(res, 'Your account is waiting for admin approval.');
  const { v, error } = campaignInput(req.body, {}, req.user);
  if (error) return bad(res, error);
  const cols = Object.keys(v);
  const { lastInsertRowid } = db.prepare(`INSERT INTO campaigns (${cols}) VALUES (${cols.map(() => '?')})`).run(...Object.values(v));
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(Number(lastInsertRowid));
  if (req.user.role === 'supplier') {
    for (const a of db.prepare("SELECT id FROM users WHERE role = 'admin' AND status = 'active'").all()) {
      sendPush(a.id, { title: '🆕 Campaign to review', body: `${v.supplier}: ${v.name} (${money(v.price_cents)}/call)`, url: '/dashboard#marketplace' });
    }
  }
  res.json({ campaign });
});

app.patch('/api/campaigns/:id', requireUser, (req, res) => {
  const existing = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(Number(req.params.id));
  const mine = req.user.role === 'admin' || (req.user.role === 'supplier' && existing?.supplier_id === req.user.id);
  if (!existing || !mine) return bad(res, 'Campaign not found.', 404);
  const { v, error } = campaignInput(req.body, existing, req.user);
  if (error) return bad(res, error);
  db.prepare(`UPDATE campaigns SET ${Object.keys(v).map((k) => `${k} = ?`)} WHERE id = ?`).run(...Object.values(v), existing.id);
  if (existing.status === 'pending' && v.status === 'active' && v.supplier_id) {
    sendPush(v.supplier_id, { title: '✅ Campaign approved', body: `${v.name} is live in the marketplace.`, url: '/dashboard#campaigns' });
  }
  res.json({ campaign: db.prepare('SELECT * FROM campaigns WHERE id = ?').get(existing.id) });
});

// An agent turning a campaign on/off for themselves and setting their buying filters.
app.put('/api/campaigns/:id/subscription', requireBuyer, (req, res) => {
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

const maskPhone = (p) => (p ? `•••-•••-${String(p).slice(-4)}` : '');

app.get('/api/calls', requireUser, (req, res) => {
  const { role } = req.user;
  const where = [];
  const args = [];
  if (role === 'supplier') { where.push('k.supplier_id = ?'); args.push(req.user.id); }
  else if (role !== 'admin' || req.query.scope === 'mine') { where.push('c.agent_id = ?'); args.push(req.user.id); }
  if (req.query.dispute === 'pending') where.push("c.dispute_status = 'pending'");
  if (req.query.billed === '1') where.push('c.price_cents > 0');
  let calls = db.prepare(`
    SELECT c.*, k.name AS campaign_name, k.vertical, k.billable_seconds, u.name AS agent_name,
      l.first_name, l.last_name
    FROM calls c LEFT JOIN campaigns k ON k.id = c.campaign_id LEFT JOIN users u ON u.id = c.agent_id
    LEFT JOIN leads l ON l.id = c.lead_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY c.id DESC LIMIT 300
  `).all(...args);
  // Suppliers see how their traffic performed, not who bought it or the caller's identity.
  if (role === 'supplier') {
    calls = calls.map((c) => ({
      ...c, from_number: maskPhone(c.from_number), first_name: '', last_name: '', lead_id: null,
      agent_name: c.agent_name ? c.agent_name.split(' ')[0] : null, price_cents: c.supplier_cents,
    }));
  }
  res.json({ calls, dispute_window_hours: DISPUTE_WINDOW_HOURS });
});

app.post('/api/calls/:id/dispute', requireBuyer, (req, res) => {
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

// ---------- Wallet (agents) / payouts (suppliers) ----------

app.get('/api/wallet', requireUser, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const transactions = db.prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 200').all(u.id);
  res.json({
    balance_cents: u.balance_cents,
    transactions,
    stripe: stripeConfigured(),
    min_deposit_cents: MIN_DEPOSIT_CENTS,
    card_label: u.card_label,
    auto_recharge: !!u.auto_recharge,
    recharge_threshold_cents: u.recharge_threshold_cents,
    recharge_amount_cents: u.recharge_amount_cents,
    recharge_error: u.recharge_error,
    fee_pct: platformFeePct(),
  });
});

app.post('/api/wallet/checkout', requireBuyer, async (req, res) => {
  if (!stripeConfigured()) return bad(res, 'Card payments are not set up yet. Ask your admin to add funds.');
  const cents = Math.round(Number(req.body.amount) * 100);
  if (!(cents >= MIN_DEPOSIT_CENTS) || cents > 5000000) return bad(res, `Minimum deposit is $${MIN_DEPOSIT_CENTS / 100}.`);
  const baseUrl = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  res.json({ url: await createCheckout({ user: req.user, amountCents: cents, baseUrl }) });
});

app.put('/api/wallet/auto-recharge', requireBuyer, async (req, res) => {
  const u = req.user;
  const enabled = !!req.body.enabled;
  const threshold = req.body.threshold !== undefined ? Math.round(Number(req.body.threshold) * 100) : u.recharge_threshold_cents;
  const amount = req.body.amount !== undefined ? Math.round(Number(req.body.amount) * 100) : u.recharge_amount_cents;
  if (enabled && !u.stripe_payment_method) return bad(res, 'Add funds by card once first — that card is used for auto-recharge.');
  if (!(threshold >= 0) || threshold > 1000000) return bad(res, 'Enter the balance that should trigger a recharge.');
  if (!(amount >= MIN_DEPOSIT_CENTS) || amount > 5000000) return bad(res, `Recharge amount must be at least $${MIN_DEPOSIT_CENTS / 100}.`);
  db.prepare('UPDATE users SET auto_recharge = ?, recharge_threshold_cents = ?, recharge_amount_cents = ?, recharge_error = NULL WHERE id = ?')
    .run(enabled ? 1 : 0, threshold, amount, u.id);
  if (enabled) await maybeAutoRecharge(u.id);
  const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(u.id);
  res.json({ auto_recharge: !!fresh.auto_recharge, balance_cents: fresh.balance_cents, recharge_error: fresh.recharge_error });
});

// ---------- Suppliers (admin) ----------

app.get('/api/suppliers', requireAdmin, (req, res) => {
  const suppliers = db.prepare(`
    SELECT u.*,
      (SELECT COUNT(*) FROM campaigns WHERE supplier_id = u.id AND status = 'active') AS live_campaigns,
      (SELECT COUNT(*) FROM campaigns WHERE supplier_id = u.id AND status = 'pending') AS pending_campaigns,
      (SELECT COUNT(*) FROM calls WHERE supplier_id = u.id AND created_at >= datetime('now', '-30 days')) AS billable_30d,
      (SELECT COALESCE(SUM(supplier_cents), 0) FROM calls WHERE supplier_id = u.id AND created_at >= datetime('now', '-30 days')
        AND (dispute_status IS NULL OR dispute_status != 'approved')) AS earned_30d,
      (SELECT COALESCE(SUM(price_cents), 0) FROM calls WHERE supplier_id = u.id AND created_at >= datetime('now', '-30 days')
        AND (dispute_status IS NULL OR dispute_status != 'approved')) AS gross_30d
    FROM users u WHERE u.role = 'supplier' ORDER BY u.status = 'pending' DESC, u.balance_cents DESC
  `).all().map((s) => ({ ...publicUser(s), ...Object.fromEntries(['live_campaigns', 'pending_campaigns', 'billable_30d', 'earned_30d', 'gross_30d'].map((k) => [k, s[k]])) }));
  res.json({ suppliers, fee_pct: platformFeePct() });
});

app.post('/api/suppliers/:id/payout', requireAdmin, (req, res) => {
  const s = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'supplier'").get(Number(req.params.id));
  if (!s) return bad(res, 'Supplier not found.', 404);
  const cents = Math.round(Number(req.body.amount) * 100);
  if (!(cents > 0)) return bad(res, 'Enter the amount you paid.');
  applyTransaction({
    userId: s.id, amountCents: -cents, type: 'payout', allowNegative: true,
    note: clip(req.body.note, 200) || 'Payout sent',
  });
  sendPush(s.id, { title: '💸 Payout sent', body: `${money(cents)} is on its way.`, url: '/dashboard#payouts' });
  res.json({ balance_cents: db.prepare('SELECT balance_cents FROM users WHERE id = ?').get(s.id).balance_cents });
});

app.get('/api/settings', requireAdmin, (req, res) => {
  const url = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  res.json({
    webhook_key: getSetting('webhook_key'),
    public_url: url,
    twilio: twilioConfigured(),
    twilio_number: process.env.TWILIO_PHONE_NUMBER || null,
    stripe: stripeConfigured(),
    fee_pct: platformFeePct(),
  });
});

app.put('/api/settings/fee', requireAdmin, (req, res) => {
  const pct = Number(req.body.fee_pct);
  if (!(pct >= 0 && pct <= 100)) return bad(res, 'Fee must be between 0 and 100%.');
  setSetting('platform_fee_pct', String(pct));
  res.json({ fee_pct: platformFeePct() });
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
