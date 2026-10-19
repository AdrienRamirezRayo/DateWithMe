import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const file = process.env.DATABASE_PATH || './data/leadrush.db';
if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });

export const db = new DatabaseSync(file);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  phone TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'agent',          -- admin | agent
  status TEXT NOT NULL DEFAULT 'pending',      -- pending | active | disabled
  states TEXT NOT NULL DEFAULT '',             -- comma-separated licensed states, '' = all
  available INTEGER NOT NULL DEFAULT 0,        -- online to receive leads/calls
  sms_alerts INTEGER NOT NULL DEFAULT 1,
  last_assigned_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT '',
  zip TEXT NOT NULL DEFAULT '',
  age INTEGER,
  coverage_type TEXT NOT NULL DEFAULT '',
  coverage_amount TEXT NOT NULL DEFAULT '',
  best_time TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'form',         -- form | call | webhook | manual
  utm_source TEXT NOT NULL DEFAULT '',
  utm_medium TEXT NOT NULL DEFAULT '',
  utm_campaign TEXT NOT NULL DEFAULT '',
  utm_content TEXT NOT NULL DEFAULT '',
  consent_text TEXT NOT NULL DEFAULT '',
  consent_at TEXT,
  ip TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new',          -- new | contacted | appointment | sold | lost
  agent_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  assigned_at TEXT,
  first_contact_at TEXT,
  premium REAL
);
CREATE INDEX IF NOT EXISTS leads_agent ON leads(agent_id, created_at);
CREATE INDEX IF NOT EXISTS leads_phone ON leads(phone);

CREATE TABLE IF NOT EXISTS activities (
  id INTEGER PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  type TEXT NOT NULL,                          -- created | assigned | status | note | call | voicemail
  body TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS activities_lead ON activities(lead_id);

CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  vertical TEXT NOT NULL,                      -- final_expense | medicare | aca | term_life | mortgage
  supplier TEXT NOT NULL DEFAULT '',
  phone_number TEXT UNIQUE,                    -- inbound tracking number the ads use
  price_cents INTEGER NOT NULL,
  billable_seconds INTEGER NOT NULL DEFAULT 90,
  states TEXT NOT NULL DEFAULT '',             -- states the supplier generates calls from, '' = all
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',       -- active | paused
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- An agent buying calls from a campaign, with their own filters.
CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  active INTEGER NOT NULL DEFAULT 1,
  daily_cap INTEGER NOT NULL DEFAULT 10,
  start_hour INTEGER NOT NULL DEFAULT 9,
  end_hour INTEGER NOT NULL DEFAULT 18,
  days TEXT NOT NULL DEFAULT '12345',          -- 0 = Sunday … 6 = Saturday
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, campaign_id)
);

CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY,
  call_sid TEXT UNIQUE,
  from_number TEXT NOT NULL DEFAULT '',
  caller_state TEXT NOT NULL DEFAULT '',
  lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  agent_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
  queue TEXT NOT NULL DEFAULT '',              -- agent ids to try in order
  status TEXT NOT NULL DEFAULT 'ringing',      -- ringing | connected | completed | missed | voicemail
  duration INTEGER,
  price_cents INTEGER NOT NULL DEFAULT 0,      -- what the agent was charged (0 = not billable)
  recording_url TEXT,
  dispute_status TEXT,                         -- pending | approved | denied
  dispute_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS calls_agent ON calls(agent_id, created_at);

-- Wallet ledger. Balance on users is the running total of these rows.
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL,               -- + credit, - debit
  type TEXT NOT NULL,                          -- deposit | call | refund | adjustment
  call_id INTEGER REFERENCES calls(id) ON DELETE SET NULL,
  reference TEXT UNIQUE,                       -- idempotency key (Stripe session, call sid…)
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

// Add columns introduced after a database was first created.
function addColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}
addColumn('users', 'balance_cents', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'timezone', "TEXT NOT NULL DEFAULT 'America/New_York'");
for (const [col, ddl] of [
  ['caller_state', "TEXT NOT NULL DEFAULT ''"], ['campaign_id', 'INTEGER REFERENCES campaigns(id)'],
  ['queue', "TEXT NOT NULL DEFAULT ''"], ['price_cents', 'INTEGER NOT NULL DEFAULT 0'],
  ['dispute_status', 'TEXT'], ['dispute_reason', 'TEXT'], ['ended_at', 'TEXT'],
]) addColumn('calls', col, ddl);

export function getSetting(key) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value;
}

export function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

export function logActivity(leadId, userId, type, body = '') {
  db.prepare('INSERT INTO activities (lead_id, user_id, type, body) VALUES (?, ?, ?, ?)')
    .run(leadId, userId ?? null, type, body);
}
