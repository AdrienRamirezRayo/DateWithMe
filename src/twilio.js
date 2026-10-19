import { Router } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { db, logActivity } from './db.js';
import { createLead, eligibleAgents, assignLead, getLead, normalizePhone, routeLead } from './leads.js';
import { broadcastLead } from './notify.js';

// Inbound call flow:
//   caller → /voice: log lead, ring every eligible online agent at once
//   agent answers → /whisper: "press any key to accept" (skips agent voicemail)
//   agent presses key → /accept: lead assigned, calls bridged
//   nobody accepts → /dial-done → voicemail recorded to the lead
export const twilio = Router();

const xml = (res, body) => res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`);
const esc = (s) => String(s).replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
const base = () => (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const BRAND = () => process.env.CALL_GREETING_NAME || 'our licensed life insurance team';

function validSignature(req) {
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token) return process.env.NODE_ENV !== 'production';
  const url = base() + req.originalUrl;
  const params = req.body || {};
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
  const expected = createHmac('sha1', token).update(data).digest('base64');
  const given = req.get('X-Twilio-Signature') || '';
  return given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

twilio.use((req, res, next) => {
  if (!validSignature(req)) return res.status(403).send('Invalid signature');
  next();
});

function voicemail(res, leadId) {
  xml(res, `<Say voice="Polly.Joanna">Sorry, all of our agents are helping other callers. Please leave your name and the best time to reach you after the tone, and we will call you right back.</Say>
<Record maxLength="120" playBeep="true" action="${base()}/api/twilio/voicemail?lead=${leadId}" />`);
}

twilio.post('/voice', (req, res) => {
  const { CallSid, From = '', FromState = '' } = req.body;
  const phone = normalizePhone(From);

  // Reuse a recent lead from the same caller rather than duplicating it.
  const recent = phone && db.prepare(
    "SELECT id FROM leads WHERE phone = ? AND created_at > datetime('now', '-30 days') ORDER BY id DESC LIMIT 1",
  ).get(phone);
  const lead = recent ? getLead(recent.id) : createLead({ phone, state: FromState }, { source: 'call', route: false });
  logActivity(lead.id, null, 'call', `Inbound call from ${phone || 'unknown number'}`);
  db.prepare('INSERT OR IGNORE INTO calls (call_sid, from_number, lead_id) VALUES (?, ?, ?)').run(CallSid, phone, lead.id);
  broadcastLead('lead:new', getLead(lead.id));

  const agents = eligibleAgents(lead.state || FromState).filter((a) => a.phone).slice(0, 10);
  if (!agents.length) return voicemail(res, lead.id);

  const numbers = agents.map((a) =>
    `<Number url="${base()}/api/twilio/whisper?lead=${lead.id}">${esc(a.phone)}</Number>`).join('');
  xml(res, `<Say voice="Polly.Joanna">Thanks for calling ${esc(BRAND())}. Connecting you with a licensed agent now.</Say>
<Dial timeout="25" answerOnBridge="true" action="${base()}/api/twilio/dial-done?lead=${lead.id}">${numbers}</Dial>`);
});

twilio.post('/whisper', (req, res) => {
  const lead = getLead(Number(req.query.lead));
  const where = lead?.state ? ` from ${lead.state}` : '';
  xml(res, `<Gather numDigits="1" timeout="8" action="${base()}/api/twilio/accept?lead=${lead?.id}">
<Say voice="Polly.Matthew">LeadRush inbound life insurance call${esc(where)}. Press any key to accept.</Say></Gather><Hangup/>`);
});

twilio.post('/accept', (req, res) => {
  const leadId = Number(req.query.lead);
  const agent = db.prepare('SELECT id FROM users WHERE phone = ?').get(normalizePhone(req.body.To));
  if (agent) {
    assignLead(leadId, agent.id);
    db.prepare("UPDATE calls SET agent_id = ?, status = 'connected' WHERE lead_id = ? AND status = 'ringing'").run(agent.id, leadId);
    db.prepare("UPDATE leads SET status = CASE status WHEN 'new' THEN 'contacted' ELSE status END, first_contact_at = COALESCE(first_contact_at, ?) WHERE id = ?")
      .run(new Date().toISOString(), leadId);
    broadcastLead('lead:update', getLead(leadId));
  }
  xml(res, '');
});

twilio.post('/dial-done', (req, res) => {
  const leadId = Number(req.query.lead);
  const { CallSid, DialCallStatus, DialCallDuration } = req.body;
  if (DialCallStatus === 'completed') {
    db.prepare('UPDATE calls SET duration = ? WHERE call_sid = ?').run(Number(DialCallDuration) || 0, CallSid);
    logActivity(leadId, null, 'call', `Call connected (${Math.round((Number(DialCallDuration) || 0) / 60)} min)`);
    return xml(res, '<Hangup/>');
  }
  db.prepare("UPDATE calls SET status = 'missed' WHERE call_sid = ?").run(CallSid);
  voicemail(res, leadId);
});

twilio.post('/voicemail', (req, res) => {
  const leadId = Number(req.query.lead);
  const { CallSid, RecordingUrl, RecordingDuration } = req.body;
  db.prepare("UPDATE calls SET status = 'voicemail', recording_url = ? WHERE call_sid = ?").run(RecordingUrl, CallSid);
  logActivity(leadId, null, 'voicemail', `${RecordingUrl}|${RecordingDuration || 0}`);
  // Nobody picked up live, so hand the callback to the next agent in rotation.
  if (getLead(leadId)?.agent_id) broadcastLead('lead:update', getLead(leadId));
  else routeLead(leadId);
  xml(res, '<Say voice="Polly.Joanna">Thank you. An agent will call you back shortly. Goodbye.</Say><Hangup/>');
});
