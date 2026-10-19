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

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
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
  res.json({ user: publicUser(req.user), states: US_STATES, statuses: STATUSES });
});

app.patch('/api/me', requireUser, (req, res) => {
  const u = req.user;
  const b = req.body;
  if (b.available && u.status !== 'active') return bad(res, 'Your account is waiting for admin approval.');
  db.prepare('UPDATE users SET name = ?, phone = ?, states = ?, available = ?, sms_alerts = ? WHERE id = ?').run(
    b.name !== undefined ? clip(b.name, 80) || u.name : u.name,
    b.phone !== undefined ? normalizePhone(b.phone) : u.phone,
    b.states !== undefined ? normalizeStates(b.states) : u.states,
    b.available !== undefined ? (b.available ? 1 : 0) : u.available,
    b.sms_alerts !== undefined ? (b.sms_alerts ? 1 : 0) : u.sms_alerts,
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

  const out = { days, totals, daily };
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

app.get('/api/settings', requireAdmin, (req, res) => {
  const url = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  res.json({
    webhook_key: getSetting('webhook_key'),
    public_url: url,
    twilio: twilioConfigured(),
    twilio_number: process.env.TWILIO_PHONE_NUMBER || null,
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
