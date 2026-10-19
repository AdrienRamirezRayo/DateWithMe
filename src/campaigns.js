import { db } from './db.js';

export const VERTICALS = {
  final_expense: 'Final Expense',
  medicare: 'Medicare',
  aca: 'ACA / Health',
  term_life: 'Term Life',
  mortgage: 'Mortgage Protection',
};

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function localClock(timezone, now = new Date()) {
  let tz = timezone;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { tz = 'America/New_York'; }
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'short', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23',
  }).formatToParts(now).map((p) => [p.type, p.value]));
  const hour = Number(parts.hour);
  const secondsToday = hour * 3600 + Number(parts.minute) * 60 + Number(parts.second);
  return { day: WEEKDAYS[parts.weekday], hour, midnight: new Date(now - secondsToday * 1000) };
}

export function inSchedule(sub, timezone, now) {
  const { day, hour } = localClock(timezone, now);
  if (!String(sub.days).includes(String(day))) return false;
  if (sub.start_hour === sub.end_hour) return true; // 24h
  return sub.start_hour < sub.end_hour
    ? hour >= sub.start_hour && hour < sub.end_hour
    : hour >= sub.start_hour || hour < sub.end_hour; // overnight window
}

export function callsToday(userId, campaignId, timezone) {
  const { midnight } = localClock(timezone);
  const since = midnight.toISOString().replace('T', ' ').slice(0, 19);
  return db.prepare(`
    SELECT COUNT(*) AS n FROM calls WHERE agent_id = ? AND campaign_id = ? AND price_cents > 0 AND created_at >= ?
  `).get(userId, campaignId, since).n;
}

const licensed = (states, state) => !states || !state || states.split(',').includes(state);

// Agents who can take a call on this campaign right now, next-in-rotation first.
export function eligibleBuyers(campaign, callerState) {
  const rows = db.prepare(`
    SELECT u.*, s.daily_cap, s.start_hour, s.end_hour, s.days
    FROM subscriptions s JOIN users u ON u.id = s.user_id
    WHERE s.campaign_id = ? AND s.active = 1
      AND u.status = 'active' AND u.available = 1 AND u.phone != ''
      AND u.balance_cents >= ?
      AND NOT EXISTS (
        SELECT 1 FROM calls c WHERE c.agent_id = u.id AND c.status = 'connected'
          AND c.created_at > datetime('now', '-3 hours'))
    ORDER BY u.last_assigned_at IS NOT NULL, u.last_assigned_at ASC, u.id ASC
  `).all(campaign.id, campaign.price_cents);
  return rows.filter((r) => licensed(r.states, callerState)
    && inSchedule(r, r.timezone)
    && callsToday(r.id, campaign.id, r.timezone) < r.daily_cap);
}

export function campaignByNumber(number) {
  return db.prepare("SELECT * FROM campaigns WHERE phone_number = ? AND status = 'active'").get(number);
}
