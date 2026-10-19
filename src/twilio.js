import { Router } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { db, logActivity } from './db.js';
import { createLead, eligibleAgents, assignLead, getLead, normalizePhone, routeLead } from './leads.js';
import { VERTICALS, campaignByNumber, eligibleBuyers } from './campaigns.js';
import { billCall } from './wallet.js';
import { broadcastLead, sendToUser } from './notify.js';

// Pay-per-call flow:
//   caller dials a campaign number → /voice: log lead + call, build a queue of eligible buyers
//   ring buyers one at a time → /whisper: "press any key to accept" (skips agent voicemail)
//   agent presses key → /accept: call is theirs, bridged and recorded
//   call ends → /dial-done: bill the agent if it passed the billable duration,
//               otherwise try the next buyer, finally voicemail
export const twilio = Router();

const xml = (res, body) => res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`);
const esc = (s) => String(s).replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
const base = () => (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const greeting = () => process.env.CALL_GREETING_NAME || 'our licensed insurance team';
const RING_SECONDS = 18;

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

const getCall = (id) => db.prepare('SELECT * FROM calls WHERE id = ?').get(id);
const getCampaign = (id) => (id ? db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id) : null);

function voicemail(res, call) {
  db.prepare("UPDATE calls SET status = 'missed', ended_at = datetime('now') WHERE id = ?").run(call.id);
  xml(res, `<Say voice="Polly.Joanna">Sorry, all of our agents are helping other callers. Please leave your name and the best time to reach you after the tone, and we will call you right back.</Say>
<Record maxLength="120" playBeep="true" action="${base()}/api/twilio/voicemail?call=${call.id}" />`);
}

// Ring the next buyer in the queue who is still eligible (they may have gone offline or taken another call).
function dialNext(res, call, attempt, greet = '') {
  const campaign = getCampaign(call.campaign_id);
  const queue = call.queue.split(',').filter(Boolean).map(Number);
  const stillOk = new Set((campaign ? eligibleBuyers(campaign, call.caller_state) : eligibleAgents(call.caller_state)).map((a) => a.id));
  for (let i = attempt; i < queue.length; i++) {
    if (!stillOk.has(queue[i])) continue;
    const agent = db.prepare('SELECT phone FROM users WHERE id = ?').get(queue[i]);
    if (!agent?.phone) continue;
    const q = `call=${call.id}&amp;agent=${queue[i]}`;
    return xml(res, `${greet}<Dial timeout="${RING_SECONDS}" answerOnBridge="true" record="record-from-answer-dual"
 recordingStatusCallback="${base()}/api/twilio/recording?call=${call.id}"
 action="${base()}/api/twilio/dial-done?call=${call.id}&amp;attempt=${i + 1}">
<Number url="${base()}/api/twilio/whisper?${q}">${esc(agent.phone)}</Number></Dial>`);
  }
  voicemail(res, call);
}

twilio.post('/voice', (req, res) => {
  const { CallSid, From = '', FromState = '', To = '' } = req.body;
  const phone = normalizePhone(From);
  const campaign = campaignByNumber(normalizePhone(To));

  // Reuse a recent lead from the same caller rather than duplicating it.
  const recent = phone && db.prepare(
    "SELECT id FROM leads WHERE phone = ? AND created_at > datetime('now', '-30 days') ORDER BY id DESC LIMIT 1",
  ).get(phone);
  const lead = recent ? getLead(recent.id) : createLead({
    phone, state: FromState, coverage_type: campaign ? VERTICALS[campaign.vertical] : '',
    utm_source: campaign?.supplier || 'phone', utm_campaign: campaign?.name || '',
  }, { source: 'call', route: false });
  const state = lead.state || FromState;
  logActivity(lead.id, null, 'call', `Inbound call from ${phone || 'unknown number'}${campaign ? ` on ${campaign.name}` : ''}`);

  const buyers = (campaign ? eligibleBuyers(campaign, state) : eligibleAgents(state).filter((a) => a.phone)).slice(0, 8);
  db.prepare(`
    INSERT INTO calls (call_sid, from_number, caller_state, lead_id, campaign_id, queue) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(call_sid) DO UPDATE SET queue = excluded.queue
  `).run(CallSid, phone, state, lead.id, campaign?.id ?? null, buyers.map((b) => b.id).join(','));
  broadcastLead('lead:new', getLead(lead.id));

  const call = db.prepare('SELECT * FROM calls WHERE call_sid = ?').get(CallSid);
  dialNext(res, call, 0, `<Say voice="Polly.Joanna">Thanks for calling ${esc(greeting())}. Connecting you with a licensed agent now.</Say>`);
});

twilio.post('/whisper', (req, res) => {
  const call = getCall(Number(req.query.call));
  const campaign = getCampaign(call?.campaign_id);
  const what = campaign ? VERTICALS[campaign.vertical] : 'insurance';
  const where = call?.caller_state ? ` from ${call.caller_state}` : '';
  xml(res, `<Gather numDigits="1" timeout="8" action="${base()}/api/twilio/accept?call=${call?.id}&amp;agent=${Number(req.query.agent)}">
<Say voice="Polly.Matthew">LeadRush ${esc(what)} call${esc(where)}. Press any key to accept.</Say></Gather><Hangup/>`);
});

twilio.post('/accept', (req, res) => {
  const call = getCall(Number(req.query.call));
  const agentId = Number(req.query.agent);
  if (call && call.status === 'ringing') {
    db.prepare("UPDATE calls SET agent_id = ?, status = 'connected' WHERE id = ?").run(agentId, call.id);
    assignLead(call.lead_id, agentId);
    db.prepare("UPDATE leads SET status = CASE status WHEN 'new' THEN 'contacted' ELSE status END, first_contact_at = COALESCE(first_contact_at, ?) WHERE id = ?")
      .run(new Date().toISOString(), call.lead_id);
    broadcastLead('lead:update', getLead(call.lead_id));
    sendToUser(agentId, 'call:update', { id: call.id });
  }
  xml(res, '');
});

twilio.post('/dial-done', (req, res) => {
  const call = getCall(Number(req.query.call));
  if (!call) return xml(res, '<Hangup/>');
  if (call.status === 'connected') {
    const duration = Number(req.body.DialCallDuration) || 0;
    db.prepare("UPDATE calls SET status = 'completed', duration = ?, ended_at = datetime('now') WHERE id = ?").run(duration, call.id);
    const charged = billCall(call.id);
    logActivity(call.lead_id, call.agent_id, 'call',
      `Call connected (${Math.floor(duration / 60)}m ${duration % 60}s)${charged ? ` · billed $${(charged / 100).toFixed(2)}` : ''}`);
    sendToUser(call.agent_id, 'call:update', { id: call.id });
    return xml(res, '<Hangup/>');
  }
  // Nobody accepted on that attempt; move down the queue.
  dialNext(res, call, Number(req.query.attempt) || 0);
});

twilio.post('/recording', (req, res) => {
  const { RecordingUrl, RecordingStatus } = req.body;
  if (RecordingStatus === 'completed' && RecordingUrl) {
    db.prepare('UPDATE calls SET recording_url = ? WHERE id = ?').run(RecordingUrl, Number(req.query.call));
  }
  res.sendStatus(204);
});

twilio.post('/voicemail', (req, res) => {
  const call = getCall(Number(req.query.call));
  const { RecordingUrl, RecordingDuration } = req.body;
  if (call) {
    db.prepare("UPDATE calls SET status = 'voicemail', recording_url = ? WHERE id = ?").run(RecordingUrl, call.id);
    logActivity(call.lead_id, null, 'voicemail', `${RecordingUrl}|${RecordingDuration || 0}`);
    // Nobody picked up live, so hand the callback to the next agent in rotation.
    if (getLead(call.lead_id)?.agent_id) broadcastLead('lead:update', getLead(call.lead_id));
    else routeLead(call.lead_id);
  }
  xml(res, '<Say voice="Polly.Joanna">Thank you. An agent will call you back shortly. Goodbye.</Say><Hangup/>');
});
