import { db, logActivity } from './db.js';
import { broadcastLead, sendSms, sendPush } from './notify.js';

export const STATUSES = ['new', 'contacted', 'appointment', 'sold', 'lost'];

export const US_STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS',
  'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC',
  'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
];

export function normalizePhone(raw = '') {
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return digits ? `+${digits}` : '';
}

export function normalizeStates(raw = '') {
  const list = (Array.isArray(raw) ? raw : String(raw).split(/[\s,]+/))
    .map((s) => s.trim().toUpperCase())
    .filter((s) => US_STATES.includes(s));
  return [...new Set(list)].join(',');
}

const clip = (v, n = 200) => String(v ?? '').trim().slice(0, n);

export function getLead(id) {
  return db.prepare(`
    SELECT l.*, u.name AS agent_name FROM leads l LEFT JOIN users u ON u.id = l.agent_id WHERE l.id = ?
  `).get(id);
}

// Online, approved agents licensed in the lead's state, longest-waiting first.
export function eligibleAgents(state) {
  const agents = db.prepare(`
    SELECT * FROM users WHERE status = 'active' AND available = 1 AND role != 'supplier'
    ORDER BY last_assigned_at IS NOT NULL, last_assigned_at ASC, id ASC
  `).all();
  return agents.filter((a) => !a.states || !state || a.states.split(',').includes(state));
}

export function assignLead(leadId, agentId, actorId = null) {
  const now = new Date().toISOString();
  db.prepare('UPDATE leads SET agent_id = ?, assigned_at = ? WHERE id = ?').run(agentId, now, leadId);
  db.prepare('UPDATE users SET last_assigned_at = ? WHERE id = ?').run(now, agentId);
  const agent = db.prepare('SELECT name, phone, sms_alerts FROM users WHERE id = ?').get(agentId);
  logActivity(leadId, actorId, 'assigned', `Assigned to ${agent.name}`);
  return agent;
}

// Round-robin a fresh lead to the next eligible agent and alert them.
export function routeLead(leadId) {
  const lead = getLead(leadId);
  const [agent] = eligibleAgents(lead.state);
  if (agent) {
    assignLead(leadId, agent.id);
    const name = `${lead.first_name} ${lead.last_name}`.trim() || 'New lead';
    if (agent.sms_alerts) sendSms(agent.phone, `⚡ LeadRush: ${name} (${lead.state || '—'}) ${lead.phone}. Call now!`);
    sendPush(agent.id, {
      title: '⚡ New lead for you',
      body: `${name} · ${lead.state || '—'} · ${lead.coverage_type || lead.source}. Call now!`,
      url: `/dashboard#lead-${leadId}`,
      tag: `lead-${leadId}`,
    });
  }
  const fresh = getLead(leadId);
  broadcastLead('lead:new', fresh);
  return fresh;
}

export function createLead(input, { source = 'form', ip = '', route = true } = {}) {
  const fields = {
    first_name: clip(input.first_name, 80),
    last_name: clip(input.last_name, 80),
    phone: normalizePhone(input.phone),
    email: clip(input.email, 160).toLowerCase(),
    state: normalizeStates(input.state).split(',')[0] || '',
    zip: clip(input.zip, 10),
    age: Number.parseInt(input.age, 10) || null,
    coverage_type: clip(input.coverage_type, 60),
    coverage_amount: clip(input.coverage_amount, 60),
    best_time: clip(input.best_time, 60),
    utm_source: clip(input.utm_source, 100),
    utm_medium: clip(input.utm_medium, 100),
    utm_campaign: clip(input.utm_campaign, 150),
    utm_content: clip(input.utm_content, 150),
    consent_text: clip(input.consent_text, 1000),
    consent_at: input.consent_text ? new Date().toISOString() : null,
    source,
    ip: clip(ip, 64),
  };
  const cols = Object.keys(fields);
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO leads (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
  ).run(...Object.values(fields));
  const id = Number(lastInsertRowid);
  logActivity(id, null, 'created', `Lead came in via ${source}${fields.utm_campaign ? ` (${fields.utm_campaign})` : ''}`);
  return route ? routeLead(id) : getLead(id);
}

export function updateStatus(leadId, status, actorId, premium) {
  const lead = getLead(leadId);
  const now = new Date().toISOString();
  const firstContact = lead.first_contact_at || (status !== 'new' ? now : null);
  db.prepare('UPDATE leads SET status = ?, first_contact_at = ?, premium = ? WHERE id = ?')
    .run(status, firstContact, status === 'sold' ? (premium ?? lead.premium) : lead.premium, leadId);
  if (status !== lead.status) logActivity(leadId, actorId, 'status', `${lead.status} → ${status}`);
}
