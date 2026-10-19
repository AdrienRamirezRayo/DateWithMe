// Fills the database with demo agents and leads so you can see the dashboard working.
// Usage: npm run seed   (log in as admin@leadrush.test / password123)
import { db } from '../src/db.js';
import { hashPassword } from '../src/auth.js';

const pw = hashPassword('password123');
const agents = [
  ['Admin Demo', 'admin@leadrush.test', '+15550000001', 'admin', ''],
  ['Jasmine Moore', 'jasmine@leadrush.test', '+15550000002', 'agent', 'TX,FL,GA'],
  ['Marcus Reed', 'marcus@leadrush.test', '+15550000003', 'agent', 'CA,AZ,NV'],
  ['Kayla Santos', 'kayla@leadrush.test', '+15550000004', 'agent', ''],
];
const ids = agents.map(([name, email, phone, role, states]) => {
  db.prepare(`INSERT OR IGNORE INTO users (name, email, phone, password_hash, role, status, states, available)
    VALUES (?, ?, ?, ?, ?, 'active', ?, 1)`).run(name, email, phone, pw, role, states);
  return db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;
});
db.prepare(`INSERT OR IGNORE INTO users (name, email, phone, password_hash, states) VALUES ('Pending Pete', 'pete@leadrush.test', '+15550000005', ?, 'OH')`).run(pw);

const first = ['James', 'Maria', 'Robert', 'Linda', 'Michael', 'Patricia', 'David', 'Barbara', 'Carlos', 'Angela', 'Tyrone', 'Susan', 'Kevin', 'Denise', 'Luis'];
const last = ['Johnson', 'Garcia', 'Williams', 'Brown', 'Davis', 'Martinez', 'Wilson', 'Taylor', 'Thomas', 'Lee'];
const states = ['TX', 'FL', 'GA', 'CA', 'AZ', 'OH', 'NC', 'NV'];
const types = ['Term Life', 'Whole Life', 'Final Expense', 'Mortgage Protection'];
const amounts = ['$25k–$100k', '$100k–$250k', '$250k–$500k', 'Under $25k'];
const campaigns = [['facebook', 'final-expense-oct'], ['facebook', 'mortgage-protect-v2'], ['google', 'term-life-search'], ['tiktok', 'family-first']];
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const statusPick = () => pick(['new', 'new', 'contacted', 'contacted', 'contacted', 'appointment', 'appointment', 'sold', 'lost']);
const fmt = (d) => d.toISOString().replace('T', ' ').slice(0, 19);

const insert = db.prepare(`INSERT INTO leads (created_at, first_name, last_name, phone, email, state, age, coverage_type, coverage_amount,
  source, utm_source, utm_medium, utm_campaign, status, agent_id, assigned_at, first_contact_at, premium, consent_text, consent_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'paid', ?, ?, ?, ?, ?, ?, 'demo consent', ?)`);
for (let i = 0; i < 140; i++) {
  const created = new Date(Date.now() - Math.random() * 30 * 864e5);
  const f = pick(first);
  const l = pick(last);
  const status = statusPick();
  const call = Math.random() < 0.3;
  const [src, camp] = call ? ['call', ''] : pick(campaigns);
  const contact = status === 'new' ? null : fmt(new Date(+created + (1 + Math.random() * 40) * 60000));
  const agent = Math.random() < 0.08 ? null : pick(ids);
  const { lastInsertRowid } = insert.run(fmt(created), f, l, `+1555${String(1000000 + i).slice(-7)}`,
    `${f}.${l}${i}@example.com`.toLowerCase(), pick(states), 30 + Math.floor(Math.random() * 45), pick(types), pick(amounts),
    call ? 'call' : 'form', src, camp, status, agent, agent ? fmt(created) : null, contact,
    status === 'sold' ? 600 + Math.round(Math.random() * 2400) : null, fmt(created));
  db.prepare("INSERT INTO activities (lead_id, type, body, created_at) VALUES (?, 'created', ?, ?)")
    .run(Number(lastInsertRowid), `Lead came in via ${call ? 'call' : 'form'}`, fmt(created));
}
console.log('Seeded demo data. Log in as admin@leadrush.test / password123');
