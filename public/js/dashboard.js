// LeadRush dashboard — plain JS, no build step.
const $ = (sel, root = document) => root.querySelector(sel);
const h = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const state = { me: null, states: [], statuses: [], verticals: {}, view: 'overview', days: 30, filters: { status: '', q: '', scope: '' }, agents: [] };

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) { location.href = '/login'; throw new Error('Logged out'); }
  const out = await res.json();
  if (!res.ok) throw new Error(out.error || 'Request failed');
  return out;
}

// ---------- formatting ----------
const toDate = (s) => (s ? new Date(/[TZ]/.test(s) ? s : `${s.replace(' ', 'T')}Z`) : null);
function ago(s) {
  const d = toDate(s);
  if (!d) return '';
  const m = Math.round((Date.now() - d) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  if (m < 1440) return `${Math.round(m / 60)}h ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
const when = (s) => toDate(s)?.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) ?? '';
const money = (n) => `$${Math.round(n || 0).toLocaleString()}`;
const cents = (c) => `${c < 0 ? '-' : ''}$${(Math.abs(c || 0) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const mmss = (s) => (s == null ? '—' : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const hourLabel = (h) => (h === 0 ? '12am' : h < 12 ? `${h}am` : h === 12 ? '12pm' : `${h - 12}pm`);
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');
function phone(p) {
  const d = String(p || '').replace(/\D/g, '');
  return d.length === 11 && d[0] === '1' ? `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}` : p || '—';
}
function speed(min) {
  if (min == null) return '—';
  if (min < 1) return `${Math.max(1, Math.round(min * 60))}s`;
  if (min < 60) return `${Math.round(min)}m`;
  return `${(min / 60).toFixed(1)}h`;
}
const fullName = (l) => `${l.first_name} ${l.last_name}`.trim() || (l.source === 'call' ? 'Inbound caller' : 'Unknown');
const initials = (name) => name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '?';
const pill = (s) => `<span class="pill ${h(s)}">${h(s)}</span>`;
const srcLabel = (l) => {
  const icon = { call: '📞', form: '📝', webhook: '🔗', manual: '✍️' }[l.source] || '';
  const camp = l.utm_campaign ? `<b>${h(l.utm_campaign)}</b>` : '';
  return `<span class="src">${icon} ${h(l.utm_source || l.source)}${camp ? ` · ${camp}` : ''}</span>`;
};
const isAdmin = () => state.me?.role === 'admin';

// ---------- shell ----------
async function boot() {
  const { user, states, statuses, verticals } = await api('/api/me');
  Object.assign(state, { me: user, states, statuses, verticals });
  renderMe();
  document.querySelectorAll('.admin-only').forEach((el) => (el.hidden = !isAdmin()));
  window.addEventListener('hashchange', route);
  route();
  connectEvents();
  refreshBadges();
  if (new URLSearchParams(location.search).has('funded')) {
    toast('Payment received', 'Funds will show in your wallet in a few seconds.', true);
    history.replaceState(null, '', `/dashboard${location.hash}`);
  }
}

function renderMe() {
  $('#meName').textContent = state.me.name;
  $('#meRole').textContent = state.me.role === 'admin' ? 'Admin' : 'Agent';
  const on = state.me.available;
  $('#avail').classList.toggle('on', on);
  $('#avail').setAttribute('aria-checked', on);
  $('#availText').textContent = on ? 'Receiving leads' : 'Offline';
  const bal = state.me.balance_cents;
  $('#balance').textContent = cents(bal);
  $('#balance').classList.toggle('low', bal < 5000);
}

async function toggleAvail() {
  try {
    const { user } = await api('/api/me', { method: 'PATCH', body: { available: !state.me.available } });
    state.me = user;
    renderMe();
    if (user.available && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  } catch (e) { toast('Heads up', e.message); }
}
$('#avail').onclick = toggleAvail;
$('#avail').onkeydown = (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggleAvail(); } };
$('#logout').onclick = async () => { await api('/api/auth/logout', { method: 'POST' }); location.href = '/login'; };
$('#menuBtn').onclick = () => $('#side').classList.toggle('open');
$('#scrim').onclick = closeDrawer;
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

const VIEWS = { overview: 'Overview', marketplace: 'Marketplace', calls: 'Calls', leads: 'Leads', wallet: 'Wallet', agents: 'Agents', sources: 'Ad Sources', settings: 'Settings' };
function route() {
  let view = location.hash.slice(1) || 'overview';
  if (!VIEWS[view] || (['agents', 'sources'].includes(view) && !isAdmin())) view = 'overview';
  state.view = view;
  $('#title').textContent = VIEWS[view];
  document.querySelectorAll('.nav-item').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
  $('#side').classList.remove('open');
  render();
}

function render() {
  const fn = { overview: renderOverview, marketplace: renderMarketplace, calls: renderCalls, leads: renderLeads, wallet: renderWallet, agents: renderAgents, sources: renderSources, settings: renderSettings }[state.view];
  fn().catch((e) => { $('#view').innerHTML = `<div class="empty">${h(e.message)}</div>`; });
}

function pendingBanner() {
  return state.me.status === 'pending'
    ? '<div class="banner">⏳ Your account is waiting for admin approval. Once approved, fund your wallet, pick campaigns in the Marketplace, and flip on <b>Receiving leads</b>.</div>'
    : state.me.balance_cents < 5000 && state.view !== 'wallet'
      ? `<div class="banner">💳 Your wallet is at <b>${cents(state.me.balance_cents)}</b>. Calls only ring through when you can cover the call price — <a href="#wallet" class="red">add funds</a>.</div>`
      : '';
}

async function refreshBadges() {
  const { total } = await api('/api/leads?status=new&limit=1' + (isAdmin() ? '&scope=mine' : ''));
  $('#newCount').hidden = !total;
  $('#newCount').textContent = total;
  if (isAdmin()) {
    const { agents } = await api('/api/agents');
    const pending = agents.filter((a) => a.status === 'pending').length;
    $('#pendingCount').hidden = !pending;
    $('#pendingCount').textContent = pending;
    const { calls } = await api('/api/calls?dispute=pending');
    $('#disputeCount').hidden = !calls.length;
    $('#disputeCount').textContent = calls.length;
  }
}

// ---------- overview ----------
async function renderOverview() {
  const [stats, { leads }] = await Promise.all([
    api(`/api/stats?days=${state.days}`),
    api('/api/leads?limit=15'),
  ]);
  const t = stats.totals;
  const c = stats.calls;
  const v = $('#view');
  v.innerHTML = `
    ${pendingBanner()}
    <div class="toolbar">
      <div class="seg" id="range">${[7, 30, 90].map((d) => `<button data-d="${d}" class="${d === state.days ? 'on' : ''}">${d} days</button>`).join('')}</div>
      <div class="grow"></div>
      ${isAdmin() ? `<span class="muted small">🟢 ${stats.online} agent${stats.online === 1 ? '' : 's'} online · ${stats.unassigned} unassigned</span>` : ''}
    </div>
    <div class="kpis">
      <div class="kpi"><div class="label">${isAdmin() ? 'Call revenue' : 'Spend on calls'}</div><div class="value">${money(c.spend_cents / 100)}</div><div class="hint">${c.billable || 0} billable of ${c.calls} calls</div></div>
      <div class="kpi"><div class="label">Cost per sale</div><div class="value">${t.sold ? money(c.spend_cents / 100 / t.sold) : '—'}</div><div class="hint">avg call ${mmss(Math.round(c.avg_duration || 0))}</div></div>
      ${isAdmin() ? `<div class="kpi"><div class="label">Agent wallets</div><div class="value">${money(stats.wallets_cents / 100)}</div><div class="hint">prepaid, not yet spent</div></div>
      <div class="kpi ${stats.disputes ? 'hot' : ''}"><div class="label">Returns to review</div><div class="value">${stats.disputes}</div><div class="hint"><a href="#calls" class="red">open calls</a></div></div>` : `
      <div class="kpi"><div class="label">ROI</div><div class="value">${c.spend_cents ? `${(t.premium * 100 / c.spend_cents).toFixed(1)}x` : '—'}</div><div class="hint">premium ÷ spend</div></div>`}
      <div class="kpi"><div class="label">Leads</div><div class="value">${t.leads}</div><div class="hint">${t.calls || 0} inbound calls</div></div>
      <div class="kpi ${t.new ? 'hot' : ''}"><div class="label">Waiting on you</div><div class="value">${t.new || 0}</div><div class="hint">status: new</div></div>
      <div class="kpi"><div class="label">Contact rate</div><div class="value">${pct(t.contacted, t.leads)}</div><div class="hint">${t.contacted || 0} reached</div></div>
      <div class="kpi"><div class="label">Appointments</div><div class="value">${t.appointments || 0}</div><div class="hint">${pct(t.appointments, t.leads)} of leads</div></div>
      <div class="kpi"><div class="label">Policies sold</div><div class="value">${t.sold || 0}</div><div class="hint">${pct(t.sold, t.leads)} close rate</div></div>
      <div class="kpi"><div class="label">Premium sold</div><div class="value">${money(t.premium)}</div><div class="hint">annual premium</div></div>
      <div class="kpi"><div class="label">Speed to lead</div><div class="value">${speed(t.speed_minutes)}</div><div class="hint">avg time to first contact</div></div>
    </div>
    <div class="grid-2">
      <div class="card"><h2>Leads per day <span class="muted">last ${state.days} days</span></h2>${chart(stats.daily, state.days)}</div>
      <div class="card"><h2>⚡ Live feed <span class="muted">newest first</span></h2>
        ${leads.length ? `<ul class="feed" id="feed">${leads.map((l) => feedItem(l)).join('')}</ul>` : '<div class="empty">No leads yet. They\'ll pop in here the second they arrive.</div>'}
      </div>
    </div>
    ${isAdmin() ? `
    <div class="card" style="padding:0">
      <h2 style="padding:20px 20px 0">🏆 Agent leaderboard</h2>
      <div style="overflow-x:auto"><table>
        <thead><tr><th>Agent</th><th>Status</th><th class="num">Leads</th><th class="num">Sold</th><th class="num">Close rate</th><th class="num">Premium</th><th class="num">Speed</th></tr></thead>
        <tbody>${stats.agents.map((a) => `<tr>
          <td><b>${h(a.name)}</b></td><td>${a.available ? '🟢 Online' : '<span class="muted">Offline</span>'}</td>
          <td class="num">${a.leads}</td><td class="num">${a.sold || 0}</td><td class="num">${pct(a.sold, a.leads)}</td>
          <td class="num">${money(a.premium)}</td><td class="num">${speed(a.speed_minutes)}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">No active agents yet.</td></tr>'}</tbody>
      </table></div>
    </div>` : ''}
  `;
  v.querySelectorAll('#range button').forEach((b) => (b.onclick = () => { state.days = +b.dataset.d; render(); }));
  bindFeed();
}

function feedItem(l, fresh = false) {
  const name = fullName(l);
  return `<li data-id="${l.id}" class="${fresh ? 'fresh' : ''}">
    <span class="avatar">${l.source === 'call' ? '📞' : h(initials(name))}</span>
    <span class="who"><b>${h(name)}</b><small>${h(l.state || '—')} · ${h(l.coverage_type || l.source)}${isAdmin() ? ` · ${h(l.agent_name || 'Unassigned')}` : ''}</small></span>
    ${pill(l.status)}<small class="muted">${ago(l.created_at)}</small></li>`;
}
function bindFeed() {
  document.querySelectorAll('#feed li').forEach((li) => (li.onclick = () => openLead(+li.dataset.id)));
}

function chart(daily, days) {
  const map = Object.fromEntries(daily.map((d) => [d.day, d]));
  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
    series.push({ day, leads: map[day]?.leads || 0, sold: map[day]?.sold || 0 });
  }
  const max = Math.max(1, ...series.map((s) => s.leads));
  const fmt = (d) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `<div class="chart">${series.map((s) => `
    <div class="bar" data-tip="${fmt(s.day)}: ${s.leads} leads, ${s.sold} sold">
      <span style="height:${((s.leads - s.sold) / max) * 100}%"></span>
      <span class="sold" style="height:${(s.sold / max) * 100}%"></span>
    </div>`).join('')}</div>
    <div class="chart-x"><span>${fmt(series[0].day)}</span><span>Today</span></div>
    <div class="legend"><span><i style="background:var(--red)"></i>Leads</span><span><i style="background:var(--green)"></i>Sold</span></div>`;
}

// ---------- leads ----------
async function renderLeads() {
  const f = state.filters;
  if (isAdmin() && !state.agents.length) state.agents = (await api('/api/agents')).agents;
  const qs = new URLSearchParams({ limit: 200, ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)) });
  const { leads, total } = await api(`/api/leads?${qs}`);
  const v = $('#view');
  v.innerHTML = `
    ${pendingBanner()}
    <div class="toolbar">
      <input class="input" id="q" placeholder="Search name, phone, email…" value="${h(f.q)}" style="max-width:280px">
      <div class="seg" id="statusSeg">${['', ...state.statuses].map((s) => `<button data-s="${s}" class="${s === f.status ? 'on' : ''}">${s || 'All'}</button>`).join('')}</div>
      ${isAdmin() ? `<select class="input" id="scope" style="width:auto">
        <option value="">All agents</option><option value="unassigned">Unassigned</option><option value="mine">My leads</option>
        ${state.agents.filter((a) => a.status === 'active').map((a) => `<option value="${a.id}">${h(a.name)}</option>`).join('')}
      </select>` : ''}
      <div class="grow"></div>
      ${isAdmin() ? `<a class="btn ghost sm" href="/api/leads.csv?${qs}">⬇ Export CSV</a>` : ''}
      <button class="btn sm" id="addLead">+ Add lead</button>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Lead</th><th>Phone</th><th>State</th><th>Looking for</th><th>Source</th><th>Status</th>${isAdmin() ? '<th>Agent</th>' : ''}<th>Received</th></tr></thead>
      <tbody>${leads.map((l) => `<tr class="click" data-id="${l.id}">
        <td><b>${h(fullName(l))}</b><span class="sub">${h(l.email)}</span></td>
        <td><a href="tel:${h(l.phone)}" onclick="event.stopPropagation()">${h(phone(l.phone))}</a></td>
        <td>${h(l.state || '—')}${l.age ? `<span class="sub">Age ${l.age}</span>` : ''}</td>
        <td>${h(l.coverage_type || '—')}<span class="sub">${h(l.coverage_amount)}</span></td>
        <td>${srcLabel(l)}</td>
        <td>${pill(l.status)}</td>
        ${isAdmin() ? `<td>${l.agent_name ? h(l.agent_name) : '<span class="pill new">Unassigned</span>'}</td>` : ''}
        <td title="${h(when(l.created_at))}">${ago(l.created_at)}</td>
      </tr>`).join('') || `<tr><td colspan="8" class="empty">No leads match. ${f.q || f.status || f.scope ? 'Try clearing filters.' : 'Turn on <b>Receiving leads</b> and they\'ll show up here.'}</td></tr>`}</tbody>
    </table></div>
    <p class="muted small">${total} lead${total === 1 ? '' : 's'}${total > leads.length ? ` · showing newest ${leads.length}` : ''}</p>
  `;
  let t;
  $('#q').oninput = (e) => { clearTimeout(t); t = setTimeout(() => { f.q = e.target.value; renderLeads().then(() => { const q = $('#q'); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }); }, 300); };
  v.querySelectorAll('#statusSeg button').forEach((b) => (b.onclick = () => { f.status = b.dataset.s; renderLeads(); }));
  if ($('#scope')) { $('#scope').value = f.scope; $('#scope').onchange = (e) => { f.scope = e.target.value; renderLeads(); }; }
  $('#addLead').onclick = openNewLead;
  v.querySelectorAll('tr.click').forEach((tr) => (tr.onclick = () => openLead(+tr.dataset.id)));
}

// ---------- lead drawer ----------
function openDrawer(html) {
  $('#drawer').innerHTML = html;
  $('#drawer').classList.add('open');
  $('#scrim').classList.add('open');
}
function closeDrawer() {
  $('#drawer').classList.remove('open');
  $('#scrim').classList.remove('open');
}

async function openLead(id) {
  const [{ lead, activities }] = await Promise.all([
    api(`/api/leads/${id}`),
    isAdmin() && !state.agents.length ? api('/api/agents').then((r) => (state.agents = r.agents)) : null,
  ]);
  const l = lead;
  const fact = (k, v) => `<div><dt>${k}</dt><dd>${v || '—'}</dd></div>`;
  openDrawer(`
    <div class="drawer-head"><span class="avatar">${h(initials(fullName(l)))}</span><h2>${h(fullName(l))}</h2><button class="x" id="closeD" aria-label="Close">×</button></div>
    <div class="drawer-body">
      ${l.phone ? `<a class="btn call-btn" href="tel:${h(l.phone)}">📞 Call ${h(phone(l.phone))}</a>` : ''}
      <div>
        <p class="section-label">Pipeline</p>
        <div class="pipeline" id="pipe">${state.statuses.map((s) => `<button data-s="${s}" class="${s === l.status ? `on ${s}` : ''}">${s}</button>`).join('')}</div>
        <div class="row-inline" id="premiumRow" style="margin-top:10px" ${l.status === 'sold' ? '' : 'hidden'}>
          <input class="input" id="premium" type="number" min="0" step="1" placeholder="Annual premium ($)" value="${l.premium ?? ''}">
          <button class="btn sm" id="savePremium">Save</button>
        </div>
      </div>
      <dl class="facts">
        ${fact('Phone', h(phone(l.phone)))}${fact('Email', l.email ? `<a href="mailto:${h(l.email)}">${h(l.email)}</a>` : '')}
        ${fact('State / ZIP', h([l.state, l.zip].filter(Boolean).join(' ')))}${fact('Age', h(l.age))}
        ${fact('Coverage', h(l.coverage_type))}${fact('Amount', h(l.coverage_amount))}
        ${fact('Best time', h(l.best_time))}${fact('Received', h(when(l.created_at)))}
        ${fact('Source', srcLabel(l))}${fact('Ad', h([l.utm_medium, l.utm_content].filter(Boolean).join(' · ')))}
        ${fact('Speed to lead', l.first_contact_at ? speed((toDate(l.first_contact_at) - toDate(l.created_at)) / 60000) : '<span class="red">Not contacted yet</span>')}
        ${fact('Consent', l.consent_at ? `✅ ${h(when(l.consent_at))}` : '')}
      </dl>
      ${isAdmin() ? `<div>
        <p class="section-label">Assigned agent</p>
        <select class="input" id="assign">
          <option value="">— Unassigned —</option>
          ${state.agents.filter((a) => a.status === 'active').map((a) => `<option value="${a.id}" ${a.id === l.agent_id ? 'selected' : ''}>${h(a.name)}${a.available ? ' 🟢' : ''}</option>`).join('')}
        </select>
      </div>` : ''}
      <div>
        <p class="section-label">Notes</p>
        <div class="row-inline"><textarea class="input" id="note" rows="2" placeholder="Add a note — what did they say?"></textarea><button class="btn sm" id="addNote">Add</button></div>
      </div>
      <div>
        <p class="section-label">Activity</p>
        <ul class="timeline">${activities.map(activityItem).join('')}</ul>
      </div>
    </div>`);

  $('#closeD').onclick = closeDrawer;
  const save = async (body, msg) => {
    try {
      await api(`/api/leads/${id}`, { method: 'PATCH', body });
      await openLead(id);
      if (msg) toast(msg, fullName(l), true);
      if (state.view !== 'settings') render();
      refreshBadges();
    } catch (e) { toast('Could not save', e.message); }
  };
  document.querySelectorAll('#pipe button').forEach((b) => (b.onclick = () => {
    if (b.dataset.s === 'sold') { $('#premiumRow').hidden = false; $('#premium').focus(); return; }
    save({ status: b.dataset.s });
  }));
  $('#savePremium').onclick = () => save({ status: 'sold', premium: $('#premium').value }, '🎉 Policy sold!');
  if ($('#assign')) $('#assign').onchange = (e) => save({ agent_id: e.target.value ? +e.target.value : null });
  $('#addNote').onclick = async () => {
    const body = $('#note').value.trim();
    if (!body) return;
    await api(`/api/leads/${id}/notes`, { method: 'POST', body: { body } });
    openLead(id);
  };
}

function activityItem(a) {
  let body = h(a.body);
  if (a.type === 'voicemail') {
    const [url, secs] = a.body.split('|');
    body = `Voicemail (${secs}s)${/^https:\/\//.test(url) ? `<audio controls preload="none" src="${h(url)}.mp3"></audio>` : ''}`;
  }
  return `<li class="${h(a.type)}"><span class="body">${body}</span><small>${h(a.user_name || 'LeadRush')} · ${h(when(a.created_at))}</small></li>`;
}

function openNewLead() {
  openDrawer(`
    <div class="drawer-head"><h2>Add a lead</h2><button class="x" id="closeD" aria-label="Close">×</button></div>
    <form class="drawer-body" id="newLead">
      <div class="form-grid">
        <div class="field"><label>First name</label><input class="input" name="first_name" required></div>
        <div class="field"><label>Last name</label><input class="input" name="last_name"></div>
        <div class="field"><label>Phone</label><input class="input" name="phone" type="tel"></div>
        <div class="field"><label>Email</label><input class="input" name="email" type="email"></div>
        <div class="field"><label>State</label><select class="input" name="state"><option value="">—</option>${state.states.map((s) => `<option>${s}</option>`).join('')}</select></div>
        <div class="field"><label>Age</label><input class="input" name="age" type="number" min="18" max="99"></div>
        <div class="field"><label>Coverage type</label><select class="input" name="coverage_type"><option>Term Life</option><option>Whole Life</option><option>Final Expense</option><option>Mortgage Protection</option><option>Not Sure</option></select></div>
        <div class="field"><label>Coverage amount</label><input class="input" name="coverage_amount" placeholder="$250k"></div>
        <div class="field full"><label>Source</label><input class="input" name="utm_source" placeholder="referral, walk-in, etc."></div>
      </div>
      <p class="error" id="newErr"></p>
      <button class="btn" type="submit">Save lead</button>
    </form>`);
  $('#closeD').onclick = closeDrawer;
  $('#newLead').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const { lead } = await api('/api/leads', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
      render();
      openLead(lead.id);
    } catch (err) { $('#newErr').textContent = err.message; }
  };
}

// ---------- agents (admin) ----------
async function renderAgents() {
  const { agents } = await api('/api/agents');
  state.agents = agents;
  const v = $('#view');
  v.innerHTML = `
    <div class="table-wrap"><table>
      <thead><tr><th>Agent</th><th>Phone</th><th>Licensed states</th><th>Status</th><th>Role</th><th>Online</th><th class="num">Wallet</th><th class="num">Leads</th><th></th></tr></thead>
      <tbody>${agents.map((a) => `<tr data-id="${a.id}">
        <td><b>${h(a.name)}</b><span class="sub">${h(a.email)}</span></td>
        <td>${h(phone(a.phone))}</td>
        <td><input class="input states" value="${h(a.states)}" placeholder="All states" style="width:160px;padding:6px 10px"></td>
        <td>${pill(a.status)}</td>
        <td>${a.role === 'admin' ? '👑 Admin' : 'Agent'}</td>
        <td>${a.available ? '🟢' : '⚪'}</td>
        <td class="num">${cents(a.balance_cents)}</td>
        <td class="num">${a.lead_count}</td>
        <td style="text-align:right">
          <button class="btn ghost sm act" data-act="credit">± Funds</button>
          ${a.status !== 'active' ? '<button class="btn sm act" data-act="approve">Approve</button>' : ''}
          ${a.status === 'active' && a.id !== state.me.id ? '<button class="btn ghost sm act" data-act="disable">Disable</button>' : ''}
          ${a.status === 'active' && a.id !== state.me.id ? `<button class="btn ghost sm act" data-act="role">${a.role === 'admin' ? 'Make agent' : 'Make admin'}</button>` : ''}
        </td>
      </tr>`).join('')}</tbody>
    </table></div>
    <p class="muted small">Leads round-robin to <b>approved, online</b> agents licensed in the lead's state (blank = all states). New signups wait here for approval. Share <code>${h(location.origin)}/signup</code> to invite agents.</p>`;
  v.querySelectorAll('tr[data-id]').forEach((tr) => {
    const id = +tr.dataset.id;
    const a = agents.find((x) => x.id === id);
    const patch = async (body) => {
      try { await api(`/api/agents/${id}`, { method: 'PATCH', body }); renderAgents(); refreshBadges(); } catch (e) { toast('Could not update', e.message); }
    };
    tr.querySelector('.states').onchange = (e) => patch({ states: e.target.value });
    tr.querySelectorAll('.act').forEach((b) => (b.onclick = () => {
      if (b.dataset.act === 'approve') patch({ status: 'active' });
      if (b.dataset.act === 'disable' && confirm(`Disable ${a.name}? They'll be logged out and stop getting leads.`)) patch({ status: 'disabled' });
      if (b.dataset.act === 'role') patch({ role: a.role === 'admin' ? 'agent' : 'admin' });
      if (b.dataset.act === 'credit') {
        const amount = prompt(`Add funds to ${a.name}'s wallet (use a minus sign to deduct), in dollars:`, '100');
        if (!amount) return;
        const note = prompt('Note (shows on their wallet):', 'Manual credit') || '';
        api(`/api/agents/${id}/credit`, { method: 'POST', body: { amount, note } })
          .then(() => { toast('Wallet updated', a.name, true); renderAgents(); })
          .catch((e) => toast('Could not update', e.message));
      }
    }));
  });
}

// ---------- campaigns (admin) ----------
async function renderSources() {
  const stats = await api(`/api/stats?days=${state.days}`);
  const v = $('#view');
  v.innerHTML = `
    <div class="toolbar"><div class="seg" id="range">${[7, 30, 90].map((d) => `<button data-d="${d}" class="${d === state.days ? 'on' : ''}">${d} days</button>`).join('')}</div></div>
    <div class="card" style="margin-bottom:16px">
      <h2>🔗 Ad link builder</h2>
      <p class="muted small" style="margin-top:-6px">Give these links to your ad guy. Every lead gets tagged with its source and campaign so you can see what's actually selling policies.</p>
      <div class="form-grid" style="grid-template-columns:repeat(3,1fr)">
        <div class="field"><label>Source</label><input class="input" id="uSource" value="facebook"></div>
        <div class="field"><label>Campaign</label><input class="input" id="uCampaign" placeholder="final-expense-oct"></div>
        <div class="field"><label>Ad / creative</label><input class="input" id="uContent" placeholder="video-1"></div>
      </div>
      <p class="section-label" style="margin-top:16px">Click to copy</p>
      <code class="copy" id="uLink"></code>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Source</th><th>Campaign</th><th class="num">Leads</th><th class="num">Appts</th><th class="num">Sold</th><th class="num">Close rate</th><th class="num">Premium</th></tr></thead>
      <tbody>${stats.campaigns.map((c) => `<tr><td>${h(c.source)}</td><td><b>${h(c.campaign)}</b></td>
        <td class="num">${c.leads}</td><td class="num">${c.appointments || 0}</td><td class="num">${c.sold || 0}</td>
        <td class="num">${pct(c.sold, c.leads)}</td><td class="num">${money(c.premium)}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">No campaign data yet.</td></tr>'}</tbody>
    </table></div>`;
  v.querySelectorAll('#range button').forEach((b) => (b.onclick = () => { state.days = +b.dataset.d; render(); }));
  const build = () => {
    const p = new URLSearchParams();
    if ($('#uSource').value) p.set('utm_source', $('#uSource').value.trim());
    if ($('#uCampaign').value) p.set('utm_campaign', $('#uCampaign').value.trim());
    if ($('#uContent').value) p.set('utm_content', $('#uContent').value.trim());
    p.set('utm_medium', 'paid');
    $('#uLink').textContent = `${location.origin}/quote?${p}`;
  };
  ['#uSource', '#uCampaign', '#uContent'].forEach((s) => ($(s).oninput = build));
  build();
  bindCopy();
}

function bindCopy() {
  document.querySelectorAll('code.copy').forEach((c) => (c.onclick = () => {
    navigator.clipboard.writeText(c.textContent).then(() => toast('Copied', c.textContent.slice(0, 60), true));
  }));
}

// ---------- settings ----------
async function renderSettings() {
  const me = state.me;
  const admin = isAdmin() ? await api('/api/settings') : null;
  const v = $('#view');
  v.innerHTML = `
    <div class="settings">
      ${pendingBanner()}
      <form class="card" id="profile">
        <h2>Your profile</h2>
        <div class="form-grid">
          <div class="field"><label>Name</label><input class="input" name="name" value="${h(me.name)}"></div>
          <div class="field"><label>Mobile phone (calls + texts ring here)</label><input class="input" name="phone" value="${h(phone(me.phone))}"></div>
          <div class="field"><label>Licensed states (blank = all)</label><input class="input" name="states" value="${h(me.states)}" placeholder="TX, FL, GA"></div>
          <div class="field"><label>Your time zone (for call hours)</label><select class="input" name="timezone">${['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu'].map((z) => `<option ${z === me.timezone ? 'selected' : ''}>${z}</option>`).join('')}</select></div>
          <label class="check-row full"><input type="checkbox" name="sms_alerts" ${me.sms_alerts ? 'checked' : ''}> Text me when a new lead is assigned</label>
        </div>
        <p class="error" id="pErr"></p>
        <button class="btn sm" type="submit">Save profile</button>
      </form>
      ${admin ? `
      <div class="card">
        <h2>📝 Your quote page</h2>
        <p>This is the page your ads send people to. Build tagged links in <a href="#sources" class="red">Ad Sources</a>.</p>
        <code class="copy">${h(admin.public_url)}/quote</code>
      </div>
      <div class="card">
        <h2>🔗 Lead webhook <span class="muted">Facebook Lead Ads, Zapier, vendors</span></h2>
        <p>POST JSON to this URL with header <b>x-api-key</b>. Fields: first_name, last_name, phone, email, state, zip, age, coverage_type, coverage_amount, utm_source, utm_campaign.</p>
        <p class="section-label">URL</p><code class="copy">${h(admin.public_url)}/api/leads/webhook</code>
        <p class="section-label" style="margin-top:12px">API key</p><code class="copy" id="key">${h(admin.webhook_key)}</code>
        <button class="btn ghost sm" id="rotate" style="margin-top:12px">Rotate key</button>
      </div>
      <div class="card">
        <h2>📞 Inbound calls ${admin.twilio ? '<span class="pill active">Connected</span>' : '<span class="pill pending">Not set up</span>'}</h2>
        ${admin.twilio
          ? `<p>Calls to <b>${h(phone(admin.twilio_number))}</b> ring every online agent licensed in the caller's state. First to press a key gets the call; if nobody answers, the caller leaves a voicemail that lands on a lead.</p>`
          : '<p>Add your Twilio keys to the server environment (see README) to turn on live inbound call routing and SMS alerts.</p>'}
        <p class="section-label">Twilio voice webhook (POST) — use it on every campaign number</p><code class="copy">${h(admin.public_url)}/api/twilio/voice</code>
      </div>
      <div class="card">
        <h2>💳 Card payments ${admin.stripe ? '<span class="pill active">Connected</span>' : '<span class="pill pending">Not set up</span>'}</h2>
        <p>${admin.stripe ? 'Agents can top up their wallets by card.' : 'Add STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET (see README) so agents can top up by card. Until then, add funds from the Agents page.'}</p>
        <p class="section-label">Stripe webhook (event: checkout.session.completed)</p><code class="copy">${h(admin.public_url)}/api/stripe/webhook</code>
      </div>` : ''}
    </div>`;
  $('#profile').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      const { user } = await api('/api/me', { method: 'PATCH', body: { name: f.get('name'), phone: f.get('phone'), states: f.get('states'), timezone: f.get('timezone'), sms_alerts: f.has('sms_alerts') } });
      state.me = user;
      renderMe();
      toast('Saved', 'Profile updated', true);
    } catch (err) { $('#pErr').textContent = err.message; }
  };
  if ($('#rotate')) $('#rotate').onclick = async () => {
    if (!confirm('Rotate the key? Anything using the old key (Zapier, vendors) will stop working until updated.')) return;
    const { webhook_key } = await api('/api/settings/rotate-key', { method: 'POST' });
    $('#key').textContent = webhook_key;
  };
  bindCopy();
}

// ---------- marketplace ----------
const VERT_ICON = { final_expense: '🕊️', medicare: '🩺', aca: '🏥', term_life: '🛡️', mortgage: '🏠' };

async function renderMarketplace() {
  const { campaigns } = await api('/api/campaigns');
  state.campaigns = campaigns;
  const v = $('#view');
  const verts = [...new Set(campaigns.map((c) => c.vertical))];
  const filter = state.vertFilter || '';
  const shown = campaigns.filter((c) => !filter || c.vertical === filter);
  v.innerHTML = `
    ${pendingBanner()}
    <div class="toolbar">
      <div class="seg" id="vertSeg"><button data-v="" class="${!filter ? 'on' : ''}">All</button>${verts.map((x) => `<button data-v="${x}" class="${x === filter ? 'on' : ''}">${h(state.verticals[x])}</button>`).join('')}</div>
      <div class="grow"></div>
      <span class="muted small">Pay only for calls that pass the billable time. No subscriptions, no minimums.</span>
      ${isAdmin() ? '<button class="btn sm" id="newCamp">+ New campaign</button>' : ''}
    </div>
    <div class="market">${shown.map((c) => {
      const on = c.sub_id && c.sub_active;
      return `<article class="camp ${on ? 'on' : ''} ${c.status === 'paused' ? 'paused' : ''}" data-id="${c.id}">
        <header>
          <span class="vert">${VERT_ICON[c.vertical] || '📞'} ${h(state.verticals[c.vertical])}</span>
          ${c.status === 'paused' ? '<span class="pill lost">Paused</span>' : on ? '<span class="pill active">Buying</span>' : ''}
        </header>
        <h3>${h(c.name)}</h3>
        ${c.supplier ? `<p class="muted small">by ${h(c.supplier)}</p>` : ''}
        <div class="price">${cents(c.price_cents)}<span>/call</span></div>
        <ul class="terms">
          <li>⏱ Billable after <b>${mmss(c.billable_seconds)}</b></li>
          <li>📍 ${c.states ? h(c.states.split(',').join(', ')) : 'Nationwide'}</li>
          ${c.description ? `<li>💬 ${h(c.description)}</li>` : ''}
          ${on ? `<li>📅 ${h(c.days.split('').map((d) => DAY_NAMES[d]).join(' '))} · ${hourLabel(c.start_hour)}–${hourLabel(c.end_hour)}</li>
          <li>🎯 ${c.calls_today}/${c.daily_cap} billable calls today</li>` : ''}
          ${isAdmin() ? `<li class="admin-line">👥 ${c.buyers} buyer${c.buyers === 1 ? '' : 's'} · ${c.calls_30d} calls (30d) · ${c.phone_number ? h(phone(c.phone_number)) : '<span class="red">no number</span>'}</li>` : ''}
        </ul>
        <footer>
          ${c.status === 'active' ? `<div class="switch ${on ? 'on' : ''}" role="switch" aria-checked="${!!on}" tabindex="0" data-toggle title="Buy calls from this campaign"></div>
          <span class="small">${on ? 'Buying calls' : 'Not buying'}</span>
          <button class="btn ghost sm" data-filters>Filters</button>` : '<span class="muted small">Not taking buyers right now</span>'}
          ${isAdmin() ? '<button class="btn ghost sm" data-edit>Edit</button>' : ''}
        </footer>
      </article>`;
    }).join('') || `<div class="empty">${isAdmin() ? 'No campaigns yet. Create one for each tracking number your ad guy or suppliers run.' : 'No campaigns are open right now. Check back soon.'}</div>`}</div>`;

  v.querySelectorAll('#vertSeg button').forEach((b) => (b.onclick = () => { state.vertFilter = b.dataset.v; renderMarketplace(); }));
  if ($('#newCamp')) $('#newCamp').onclick = () => openCampaignForm();
  v.querySelectorAll('.camp').forEach((card) => {
    const c = campaigns.find((x) => x.id === +card.dataset.id);
    const tgl = card.querySelector('[data-toggle]');
    if (tgl) {
      const flip = async () => {
        try {
          await api(`/api/campaigns/${c.id}/subscription`, { method: 'PUT', body: { active: !(c.sub_id && c.sub_active) } });
          if (!(c.sub_id && c.sub_active) && !state.me.available) toast('Almost live', 'Flip on "Receiving leads" up top to start getting calls.', true);
          renderMarketplace();
        } catch (e) { toast('Heads up', e.message); }
      };
      tgl.onclick = flip;
      tgl.onkeydown = (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flip(); } };
    }
    card.querySelector('[data-filters]')?.addEventListener('click', () => openFilters(c));
    card.querySelector('[data-edit]')?.addEventListener('click', () => openCampaignForm(c));
  });
}

function openFilters(c) {
  const days = c.days || '12345';
  const hours = Array.from({ length: 24 }, (_, i) => i);
  openDrawer(`
    <div class="drawer-head"><h2>${h(c.name)} filters</h2><button class="x" id="closeD" aria-label="Close">×</button></div>
    <form class="drawer-body" id="filters">
      <p class="muted small" style="margin:0">Calls only ring you inside these hours (${h(state.me.timezone)}), on these days, up to your daily cap. Calls are also limited to the states you're licensed in (<a href="#settings" class="red">${h(state.me.states || 'all states')}</a>).</p>
      <div>
        <p class="section-label">Days</p>
        <div class="days">${DAY_NAMES.map((d, i) => `<label><input type="checkbox" name="day" value="${i}" ${days.includes(String(i)) ? 'checked' : ''}><span>${d}</span></label>`).join('')}</div>
      </div>
      <div class="form-grid">
        <div class="field"><label>From</label><select class="input" name="start_hour">${hours.map((i) => `<option value="${i}" ${i === (c.start_hour ?? 9) ? 'selected' : ''}>${hourLabel(i)}</option>`).join('')}</select></div>
        <div class="field"><label>Until</label><select class="input" name="end_hour">${hours.map((i) => `<option value="${i}" ${i === (c.end_hour ?? 18) ? 'selected' : ''}>${hourLabel(i)}</option>`).join('')}</select></div>
        <div class="field full"><label>Max billable calls per day</label><input class="input" type="number" min="1" max="500" name="daily_cap" value="${c.daily_cap ?? 10}"></div>
      </div>
      <p class="muted small" style="margin:0">Daily max spend: <b id="maxSpend"></b></p>
      <p class="error" id="fErr"></p>
      <button class="btn" type="submit">Save filters</button>
    </form>`);
  $('#closeD').onclick = closeDrawer;
  const form = $('#filters');
  const upd = () => ($('#maxSpend').textContent = cents((+form.daily_cap.value || 0) * c.price_cents));
  form.daily_cap.oninput = upd;
  upd();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    try {
      await api(`/api/campaigns/${c.id}/subscription`, {
        method: 'PUT',
        body: { active: c.sub_id ? !!c.sub_active : true, days: f.getAll('day').join(''), start_hour: f.get('start_hour'), end_hour: f.get('end_hour'), daily_cap: f.get('daily_cap') },
      });
      closeDrawer();
      toast('Saved', `${c.name} filters updated`, true);
      renderMarketplace();
    } catch (err) { $('#fErr').textContent = err.message; }
  };
}

function openCampaignForm(c = {}) {
  openDrawer(`
    <div class="drawer-head"><h2>${c.id ? 'Edit campaign' : 'New campaign'}</h2><button class="x" id="closeD" aria-label="Close">×</button></div>
    <form class="drawer-body" id="campForm">
      <div class="form-grid">
        <div class="field full"><label>Name</label><input class="input" name="name" value="${h(c.name)}" placeholder="Final Expense — Facebook" required></div>
        <div class="field"><label>Vertical</label><select class="input" name="vertical">${Object.entries(state.verticals).map(([k, l]) => `<option value="${k}" ${k === c.vertical ? 'selected' : ''}>${h(l)}</option>`).join('')}</select></div>
        <div class="field"><label>Supplier</label><input class="input" name="supplier" value="${h(c.supplier)}" placeholder="Your ad guy / vendor"></div>
        <div class="field"><label>Price per call ($)</label><input class="input" type="number" min="1" step="0.01" name="price" value="${c.price_cents ? c.price_cents / 100 : ''}" required></div>
        <div class="field"><label>Billable after (seconds)</label><input class="input" type="number" min="0" name="billable_seconds" value="${c.billable_seconds ?? 90}"></div>
        <div class="field full"><label>Twilio tracking number</label><input class="input" name="phone_number" value="${h(c.phone_number ? phone(c.phone_number) : '')}" placeholder="(555) 123-4567"></div>
        <div class="field full"><label>States calls come from (blank = nationwide)</label><input class="input" name="states" value="${h(c.states)}" placeholder="TX, FL, GA"></div>
        <div class="field full"><label>Description for buyers</label><textarea class="input" name="description" rows="2" placeholder="Ages 50–80, live transfer, pre-qualified">${h(c.description)}</textarea></div>
        ${c.id ? `<label class="check-row full"><input type="checkbox" name="paused" ${c.status === 'paused' ? 'checked' : ''}> Paused (no calls route, hidden from agents)</label>` : ''}
      </div>
      <p class="error" id="cErr"></p>
      <button class="btn" type="submit">${c.id ? 'Save campaign' : 'Create campaign'}</button>
    </form>`);
  $('#closeD').onclick = closeDrawer;
  $('#campForm').onsubmit = async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    if (c.id) body.status = body.paused ? 'paused' : 'active';
    delete body.paused;
    try {
      await api(c.id ? `/api/campaigns/${c.id}` : '/api/campaigns', { method: c.id ? 'PATCH' : 'POST', body });
      closeDrawer();
      renderMarketplace();
    } catch (err) { $('#cErr').textContent = err.message; }
  };
}

// ---------- calls ----------
async function renderCalls() {
  const pendingOnly = isAdmin() && state.callsFilter === 'pending';
  const { calls, dispute_window_hours: windowH } = await api(`/api/calls${pendingOnly ? '?dispute=pending' : ''}`);
  const v = $('#view');
  const disputeCell = (c) => {
    if (c.dispute_status === 'pending') {
      return isAdmin()
        ? `<span class="pill pending" title="${h(c.dispute_reason)}">Review</span>
           <button class="btn sm" data-resolve="1">Refund</button><button class="btn ghost sm" data-resolve="0">Deny</button>`
        : `<span class="pill pending" title="${h(c.dispute_reason)}">Return pending</span>`;
    }
    if (c.dispute_status === 'approved') return '<span class="pill active">Refunded</span>';
    if (c.dispute_status === 'denied') return '<span class="pill lost">Return denied</span>';
    const fresh = (Date.now() - toDate(c.created_at)) / 36e5 < windowH;
    return c.price_cents > 0 && c.agent_id === state.me.id && fresh ? '<button class="btn ghost sm" data-dispute>Return</button>' : '';
  };
  const statusPill = (c) => ({
    completed: c.price_cents > 0 ? '<span class="pill sold">Billable</span>' : '<span class="pill contacted">Under time</span>',
    connected: '<span class="pill appointment">Live now</span>',
    ringing: '<span class="pill new">Ringing</span>',
    missed: '<span class="pill lost">Missed</span>',
    voicemail: '<span class="pill lost">Voicemail</span>',
  }[c.status] || pill(c.status));
  v.innerHTML = `
    ${isAdmin() ? `<div class="toolbar"><div class="seg" id="callSeg">
      <button data-f="" class="${!pendingOnly ? 'on' : ''}">All calls</button>
      <button data-f="pending" class="${pendingOnly ? 'on' : ''}">Returns to review</button></div></div>` : ''}
    <div class="table-wrap"><table>
      <thead><tr><th>When</th><th>Caller</th><th>Campaign</th>${isAdmin() ? '<th>Agent</th>' : ''}<th>Duration</th><th>Status</th><th class="num">Cost</th><th>Recording</th><th></th></tr></thead>
      <tbody>${calls.map((c) => `<tr data-id="${c.id}" data-lead="${c.lead_id || ''}">
        <td title="${h(when(c.created_at))}">${ago(c.created_at)}</td>
        <td><a href="#" data-lead-open>${h(`${c.first_name || ''} ${c.last_name || ''}`.trim() || phone(c.from_number))}</a><span class="sub">${h(c.caller_state || '—')}</span></td>
        <td>${h(c.campaign_name || 'Main line')}${c.vertical ? `<span class="sub">${h(state.verticals[c.vertical])}</span>` : ''}</td>
        ${isAdmin() ? `<td>${h(c.agent_name || '—')}</td>` : ''}
        <td>${mmss(c.duration)}${c.billable_seconds ? `<span class="sub">billable at ${mmss(c.billable_seconds)}</span>` : ''}</td>
        <td>${statusPill(c)}</td>
        <td class="num">${c.price_cents ? cents(c.price_cents) : '—'}</td>
        <td>${/^https:\/\//.test(c.recording_url || '') ? `<audio controls preload="none" src="${h(c.recording_url)}.mp3"></audio>` : '<span class="muted">—</span>'}</td>
        <td style="text-align:right">${disputeCell(c)}</td>
      </tr>`).join('') || `<tr><td colspan="9" class="empty">${pendingOnly ? 'No returns waiting. 🎉' : 'No calls yet. Pick campaigns in the Marketplace and go online.'}</td></tr>`}</tbody>
    </table></div>
    <p class="muted small">Calls are billed only after they pass the campaign's billable time. Bad call? Request a return within ${windowH} hours.</p>`;
  v.querySelectorAll('#callSeg button').forEach((b) => (b.onclick = () => { state.callsFilter = b.dataset.f; renderCalls(); }));
  v.querySelectorAll('tr[data-id]').forEach((tr) => {
    const id = +tr.dataset.id;
    tr.querySelector('[data-lead-open]').onclick = (e) => { e.preventDefault(); if (tr.dataset.lead) openLead(+tr.dataset.lead); };
    tr.querySelector('[data-dispute]')?.addEventListener('click', async () => {
      const reason = prompt('Why should this call be returned? (e.g. wrong age, already insured, hung up, language)');
      if (!reason) return;
      try { await api(`/api/calls/${id}/dispute`, { method: 'POST', body: { reason } }); toast('Return requested', 'An admin will review it.', true); renderCalls(); } catch (e) { toast('Could not request', e.message); }
    });
    tr.querySelectorAll('[data-resolve]').forEach((b) => (b.onclick = async () => {
      await api(`/api/calls/${id}/resolve`, { method: 'POST', body: { approve: b.dataset.resolve === '1' } });
      toast(b.dataset.resolve === '1' ? 'Refunded' : 'Return denied', '', true);
      renderCalls();
      refreshBadges();
    }));
  });
}

// ---------- wallet ----------
async function renderWallet() {
  const w = await api('/api/wallet');
  state.me.balance_cents = w.balance_cents;
  renderMe();
  const min = w.min_deposit_cents / 100;
  const typeLabel = { deposit: '💳 Deposit', call: '📞 Call', refund: '↩️ Refund', adjustment: '✍️ Adjustment' };
  const v = $('#view');
  v.innerHTML = `
    <div class="grid-2">
      <div class="card wallet-card">
        <p class="section-label">Available balance</p>
        <div class="big-balance ${w.balance_cents < 5000 ? 'red' : ''}">${cents(w.balance_cents)}</div>
        <p class="muted small">Calls only ring through when your balance covers the call price. Unused funds stay in your wallet.</p>
        ${w.stripe ? `
          <div class="amounts">${[100, 250, 500, 1000].filter((a) => a >= min).map((a) => `<button class="btn ghost sm" data-amt="${a}">+ $${a}</button>`).join('')}</div>
          <div class="row-inline" style="margin-top:12px">
            <input class="input" id="customAmt" type="number" min="${min}" step="1" placeholder="Custom amount ($${min} min)">
            <button class="btn sm" id="fund">Add funds</button>
          </div>
          <p class="error" id="wErr"></p>`
        : '<div class="banner" style="margin:12px 0 0">Card top-ups aren\'t switched on yet. Ask your admin to add funds to your wallet.</div>'}
      </div>
      <div class="card">
        <p class="section-label">How billing works</p>
        <ul class="terms">
          <li>💸 Pay per call. No subscriptions, no minimums.</li>
          <li>⏱ A call is billed only if it lasts past the campaign's billable time.</li>
          <li>🎯 Set daily caps and hours per campaign in the Marketplace.</li>
          <li>↩️ Bad call? Request a return from the Calls page.</li>
        </ul>
      </div>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Date</th><th>Type</th><th>Details</th><th class="num">Amount</th></tr></thead>
      <tbody>${w.transactions.map((t) => `<tr>
        <td>${h(when(t.created_at))}</td><td>${typeLabel[t.type] || h(t.type)}</td><td class="muted">${h(t.note)}</td>
        <td class="num ${t.amount_cents > 0 ? 'pos' : ''}">${t.amount_cents > 0 ? '+' : ''}${cents(t.amount_cents)}</td></tr>`).join('')
        || '<tr><td colspan="4" class="empty">No transactions yet.</td></tr>'}</tbody>
    </table></div>`;
  const checkout = async (amount) => {
    try {
      const { url } = await api('/api/wallet/checkout', { method: 'POST', body: { amount } });
      location.href = url;
    } catch (e) { $('#wErr').textContent = e.message; }
  };
  v.querySelectorAll('[data-amt]').forEach((b) => (b.onclick = () => checkout(+b.dataset.amt)));
  if ($('#fund')) $('#fund').onclick = () => checkout(+$('#customAmt').value);
}

// ---------- realtime ----------
function connectEvents() {
  const es = new EventSource('/api/events');
  es.addEventListener('lead:new', (e) => {
    const lead = JSON.parse(e.data);
    const mine = lead.agent_id === state.me.id;
    if (mine || isAdmin()) {
      const title = mine ? '⚡ New lead for you!' : '⚡ New lead';
      const body = `${fullName(lead)} · ${lead.state || '—'} · ${lead.coverage_type || lead.source}`;
      toast(title, body, false, () => openLead(lead.id));
      if (mine) { ding(); notify(title, body); }
    }
    const feed = $('#feed');
    if (feed && state.view === 'overview') {
      feed.querySelector(`li[data-id="${lead.id}"]`)?.remove();
      feed.insertAdjacentHTML('afterbegin', feedItem(lead, true));
      bindFeed();
    } else if (state.view === 'leads') renderLeads();
    refreshBadges();
  });
  es.addEventListener('wallet:update', (e) => {
    state.me.balance_cents = JSON.parse(e.data).balance_cents;
    renderMe();
    if (state.view === 'wallet') renderWallet();
  });
  es.addEventListener('call:update', () => { if (state.view === 'calls') renderCalls(); });
  es.addEventListener('lead:update', () => {
    if (state.view === 'leads') renderLeads();
    refreshBadges();
  });
}

function toast(title, body, quiet = false, onclick) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.style.borderColor = quiet ? 'var(--line)' : '';
  el.innerHTML = `<span class="bolt">${quiet ? '✓' : '⚡'}</span><div><b>${h(title)}</b><small>${h(body)}</small></div>`;
  el.onclick = () => { el.remove(); onclick?.(); };
  $('#toasts').append(el);
  setTimeout(() => el.remove(), quiet ? 2500 : 8000);
}

function notify(title, body) {
  if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
    new Notification(title, { body, icon: '/img/icon.png' });
  }
}

let audio;
function ding() {
  try {
    audio ||= new AudioContext();
    [880, 1320].forEach((f, i) => {
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0.2, audio.currentTime + i * 0.15);
      g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + i * 0.15 + 0.3);
      o.connect(g).connect(audio.destination);
      o.start(audio.currentTime + i * 0.15);
      o.stop(audio.currentTime + i * 0.15 + 0.3);
    });
  } catch {}
}

boot();
