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

// Suppliers (log in as acme@leadrush.test / password123 to see the supplier portal)
const supplierIds = {};
for (const [company, name, email, status] of [
  ['Acme Media', 'Alex Carter', 'acme@leadrush.test', 'active'],
  ['ClickFlow', 'Dana Brooks', 'clickflow@leadrush.test', 'active'],
  ['Senior Reach', 'Sam Patel', 'seniorreach@leadrush.test', 'active'],
  ['New Leads Co', 'Nina Lopez', 'newleads@leadrush.test', 'pending'],
]) {
  db.prepare(`INSERT OR IGNORE INTO users (name, email, phone, password_hash, role, status, company) VALUES (?, ?, '+15550000099', ?, 'supplier', ?, ?)`)
    .run(name, email, pw, status, company);
  supplierIds[company] = db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;
}

// Pay-per-call campaigns, buyers, calls and wallets
const camps = [
  ['Final Expense — Live Transfers', 'final_expense', 'Acme Media', '+15558000001', 4500, 90, 'Ages 50–85, pre-qualified for final expense'],
  ['Medicare Advantage Inbound', 'medicare', 'Senior Reach', '+15558000002', 3800, 120, 'Turning 65 and AEP shoppers'],
  ['ACA Health — Open Enrollment', 'aca', 'Acme Media', '+15558000003', 2800, 90, 'Under-65 health shoppers'],
  ['Term Life — Search Calls', 'term_life', 'ClickFlow', '+15558000004', 6000, 120, 'Google search, ages 25–60'],
  ['Mortgage Protection', 'mortgage', 'ClickFlow', '+15558000005', 5200, 90, 'Recent homebuyers'],
].map(([name, vertical, supplier, num, price, secs, desc]) => {
  db.prepare(`INSERT OR IGNORE INTO campaigns (name, vertical, supplier, supplier_id, phone_number, price_cents, billable_seconds, description)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(name, vertical, supplier, supplierIds[supplier], num, price, secs, desc);
  return db.prepare('SELECT * FROM campaigns WHERE phone_number = ?').get(num);
});
db.prepare(`INSERT INTO campaigns (name, vertical, supplier, supplier_id, price_cents, billable_seconds, description, status)
  VALUES ('Medicare — Spanish Language', 'medicare', 'Senior Reach', ?, 4200, 120, 'Spanish-speaking Medicare callers', 'pending')`).run(supplierIds['Senior Reach']);
for (const uid of ids.slice(1)) {
  for (const c of camps.slice(0, 3 + (uid % 2))) {
    db.prepare(`INSERT OR IGNORE INTO subscriptions (user_id, campaign_id, daily_cap, start_hour, end_hour, days)
      VALUES (?, ?, ?, 8, 20, '123456')`).run(uid, c.id, 8 + (uid % 5));
  }
}
const tx = db.prepare('INSERT INTO transactions (user_id, amount_cents, type, call_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?)');
for (const uid of ids) tx.run(uid, 200000, 'deposit', null, 'Card deposit', fmt(new Date(Date.now() - 31 * 864e5)));
const callLeads = db.prepare("SELECT * FROM leads WHERE source = 'call'").all();
for (const l of callLeads) {
  const c = pick(camps);
  const agent = l.agent_id;
  const missed = !agent;
  const duration = missed ? null : Math.round(20 + Math.random() * 900);
  const billed = !missed && duration >= c.billable_seconds ? c.price_cents : 0;
  const dispute = billed && Math.random() < 0.08 ? pick(['pending', 'approved', 'denied']) : null;
  const supplierCut = billed ? Math.round(billed * 0.8) : 0;
  const { lastInsertRowid } = db.prepare(`INSERT INTO calls (call_sid, from_number, caller_state, lead_id, agent_id, campaign_id, status, duration,
    price_cents, supplier_id, supplier_cents, dispute_status, dispute_reason, created_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    `SEED${l.id}`, l.phone, l.state, l.id, agent, c.id, missed ? 'voicemail' : 'completed', duration, billed,
    billed ? c.supplier_id : null, supplierCut, dispute, dispute ? 'Caller said they already have coverage' : null, l.created_at, l.created_at);
  db.prepare('UPDATE leads SET coverage_type = ?, utm_source = ?, utm_campaign = ? WHERE id = ?')
    .run({ final_expense: 'Final Expense', medicare: 'Medicare', aca: 'ACA / Health', term_life: 'Term Life', mortgage: 'Mortgage Protection' }[c.vertical], c.supplier, c.name, l.id);
  if (billed) {
    tx.run(agent, -billed, 'call', Number(lastInsertRowid), `${c.name} — ${Math.floor(duration / 60)}m ${duration % 60}s`, l.created_at);
    tx.run(c.supplier_id, supplierCut, 'earning', Number(lastInsertRowid), `${c.name} — ${Math.floor(duration / 60)}m ${duration % 60}s`, l.created_at);
    if (dispute === 'approved') {
      tx.run(agent, billed, 'refund', Number(lastInsertRowid), 'Call return approved', l.created_at);
      tx.run(c.supplier_id, -supplierCut, 'reversal', Number(lastInsertRowid), 'Call returned by buyer: already has coverage', l.created_at);
    }
  }
}
tx.run(supplierIds['Acme Media'], -30000, 'payout', null, 'ACH transfer', fmt(new Date(Date.now() - 7 * 864e5)));
db.exec('UPDATE users SET balance_cents = (SELECT COALESCE(SUM(amount_cents), 0) FROM transactions WHERE user_id = users.id)');
// Leave one agent nearly empty so the low-balance warnings show.
const marcus = db.prepare("SELECT id, balance_cents FROM users WHERE email = 'marcus@leadrush.test'").get();
tx.run(marcus.id, 3200 - marcus.balance_cents, 'adjustment', null, 'Demo: low balance', fmt(new Date()));
db.prepare('UPDATE users SET balance_cents = 3200 WHERE id = ?').run(marcus.id);

console.log('Seeded demo data. Password for every account is password123:\n  admin@leadrush.test (admin)\n  jasmine@leadrush.test (agent)\n  acme@leadrush.test (supplier)');
