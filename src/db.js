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

CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY,
  call_sid TEXT UNIQUE,
  from_number TEXT NOT NULL DEFAULT '',
  lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  agent_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'ringing',      -- ringing | connected | missed | voicemail
  duration INTEGER,
  recording_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

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
