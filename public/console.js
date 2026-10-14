// In-house support console. Plain page, no framework. Every value from the service is set as text.
// The agent logs in with the demo config login; the session token lives in this page (and sessionStorage).
const $ = (role) => document.querySelector(`[data-role="${role}"]`);
const pageOpen = () => Boolean(document?.body?.isConnected);
const STATE = { waiting: 'Waiting for an agent', with_agent: 'With an agent', resolved: 'Resolved', emailed: 'Emailed to support (no chat)' };

let token = null;
let me = null;
let selected = new URLSearchParams(location.search).get('case');
let timer = null;
let shownLines = '';
let canReadAudit = false;

try { token = sessionStorage.getItem('console:token'); me = sessionStorage.getItem('console:name'); canReadAudit = sessionStorage.getItem('console:audit') === '1'; } catch { /* no storage: sign in again */ }

async function api(method, path, body) {
  try {
    const res = await fetch(path, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && token) signOut();
    return { ok: res.ok, status: res.status, body: data };
  } catch {
    // Network loss (including a page closing with a poll in flight) is a failed request, not an unhandled event-handler rejection.
    return { ok: false, status: 0, body: {} };
  }
}

function signOut() {
  token = null;
  me = null;
  clearTimeout(timer);
  canReadAudit = false;
  try { sessionStorage.removeItem('console:token'); sessionStorage.removeItem('console:name'); sessionStorage.removeItem('console:audit'); } catch { /* nothing stored */ }
  $('audit-panel').hidden = true;
  $('dashboard-panel').hidden = true;
  $('console').hidden = true;
  $('login-form').hidden = false;
}

function showConsole() {
  $('login-form').hidden = true;
  $('console').hidden = false;
  $('agent-name').textContent = me ?? '';
  $('dashboard-open').hidden = !canReadAudit;
  $('audit-open').hidden = !canReadAudit; // the service enforces it; this only keeps the button away from staff who cannot use it
  refresh();
}

const label = (c) => {
  if (c.state === 'resolved') return c.closeReason === 'cancelled_by_user' ? 'Resolved (cancelled by user)' : 'Resolved';
  // A re-broadcast case (30 minutes without a reply) is open to every agent: say so in the list.
  if (c.state === 'with_agent') return c.claimedBy === me ? 'With you' : `With ${c.claimedBy}${c.claimable ? ' · open to any agent' : ''}`;
  return STATE[c.state] ?? c.state;
};

// m:ss, however long (a case can wait for hours).
const clock = (seconds) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
const SLOW = { warning: ' · slow', urgent: ' · overdue' };

// The colours are explained with the service's own thresholds, which come from its timer config.
function renderThresholds(t) {
  $('queue-thresholds').textContent = t
    ? `Waiting for an agent: slow from ${clock(t.waiting.warnSeconds)}, overdue from ${clock(t.waiting.urgentSeconds)}. Waiting for a reply: slow from ${clock(t.withAgent.warnSeconds)}, overdue from ${clock(t.withAgent.urgentSeconds)}.`
    : '';
}

function renderQueue(cases) {
  const queue = $('queue');
  queue.replaceChildren(...cases.map((c) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.role = 'case-row';
    b.dataset.ref = c.ref;
    if (c.ref === selected) b.setAttribute('aria-current', 'true');
    if (c.waitLevel) b.dataset.level = c.waitLevel;
    const wait = c.waitingSeconds === null ? '' : ` · waiting ${clock(c.waitingSeconds)}${c.waitingFor === 'reply' ? ' for a reply' : ''}${SLOW[c.waitLevel] ?? ''}`;
    b.textContent = `${c.priority ? 'PRIORITY · ' : ''}${c.ref} · ${label(c)}${wait}`;
    b.addEventListener('click', () => { if (selected !== c.ref) clearSuggestions(); selected = c.ref; shownLines = ''; refresh(); });
    return b;
  }));
  $('queue-empty').hidden = cases.length > 0;
}

const money = (r) => `${r.amount ?? '?'}${r.currency ? ` ${r.currency}` : ''}`;
const recordLine = (r) => [r.reference, r.date, `${r.direction === 'out' ? 'out' : 'in'} ${money(r)}`, r.status, r.account, r.counterparty].filter(Boolean).join(' · ');

// The case-specific context. A case held by a colleague comes back without any, and these blocks stay hidden.
function renderContext(d) {
  $('priority').hidden = !d.priority;
  $('draft').hidden = !d.draft;
  $('draft-text').textContent = d.draft ?? '';
  $('summary').hidden = !d.summary && !d.summaryUnavailable;
  $('summary-label').textContent = d.summary?.label ?? '';
  $('summary-text').textContent = d.summary?.text ?? (d.summaryUnavailable ? 'No summary available' : '');
  $('records-box').hidden = !d.records?.length;
  $('records').replaceChildren(...(d.records ?? []).map((r) => {
    const line = document.createElement('div');
    line.dataset.role = 'record';
    line.textContent = recordLine(r);
    return line;
  }));
}

// Suggested replies (drafts only). They belong to the case they were asked for and are cleared when the agent moves to another.
let suggesting = false;
function clearSuggestions() {
  $('suggestions').replaceChildren();
  $('suggestions-message').textContent = '';
}
async function suggestReplies() {
  const ref = selected;
  if (!ref || suggesting) return;
  suggesting = true;
  $('suggest').disabled = true;
  clearSuggestions();
  $('suggestions-message').textContent = 'Writing drafts…';
  let res;
  try { res = await api('POST', `/agent/cases/${encodeURIComponent(ref)}/suggestions`, { count: Number($('suggest-count').value) }); }
  catch { res = { ok: false, body: {} }; }
  suggesting = false;
  if (!pageOpen() || ref !== selected) return; // the agent moved on or closed the page while the model was writing
  const drafts = res.ok ? res.body.suggestions : [];
  $('suggestions-message').textContent = drafts.length ? '' : (res.body.message ?? 'No suggestions available'); // a failure is just "none", never an error
  $('suggestions').replaceChildren(...drafts.map((text) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.role = 'suggestion';
    b.textContent = text;
    // A draft only fills the reply box; sending stays the agent's own click on Send.
    b.addEventListener('click', () => { $('reply-input').value = text; $('reply-input').focus(); });
    return b;
  }));
}

// Internal notes: the service sends them only to an agent who may open the case.
let shownNotes = '';
function renderNotes(notes) {
  $('note-add').disabled = !notes;
  $('note-input').disabled = !notes;
  const key = JSON.stringify(notes ?? []);
  if (key === shownNotes) return;
  shownNotes = key;
  $('notes').replaceChildren(...(notes ?? []).map((n) => {
    const item = document.createElement('div');
    item.dataset.role = 'note';
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = `${n.agent} · ${new Date(n.at).toLocaleString()}`;
    item.append(who, document.createTextNode(n.text));
    return item;
  }));
}

function renderDetail(d) {
  $('detail').hidden = false;
  renderContext(d);
  renderNotes(d.notes);
  $('detail-ref').textContent = `Case ${d.ref}`;
  $('detail-state').textContent = label(d);
  $('detail-claimed-by').textContent = d.claimedBy ?? 'nobody';
  const mine = d.state === 'with_agent' && d.claimedBy === me;
  $('claim').disabled = !d.claimable;
  $('resolve').disabled = !mine;
  // The colleagues come with the case; the choice survives the periodic refresh.
  const names = JSON.stringify(d.colleagues ?? []);
  if ($('transfer-to').dataset.names !== names) {
    $('transfer-to').dataset.names = names;
    $('transfer-to').replaceChildren(...(d.colleagues ?? []).map((a) => new Option(a.name, a.id)));
  }
  $('transfer-to').disabled = !mine;
  $('transfer').disabled = !mine || !$('transfer-to').value;
  $('reply-input').disabled = !mine;
  $('reply-send').disabled = !mine;
  $('suggest').disabled = !mine || suggesting;
  $('suggest-count').disabled = !mine;
  if (!mine) clearSuggestions();
  const key = JSON.stringify(d.transcript.map((m) => m.seq));
  if (key === shownLines) return;
  shownLines = key;
  const box = $('transcript');
  box.replaceChildren(...d.transcript.map((m) => {
    const line = document.createElement('div');
    line.dataset.role = 'line';
    line.dataset.from = m.from;
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = { customer: 'Customer', bot: 'Assistant (automated)', agent: 'Agent', system: '' }[m.from] ?? m.from;
    if (who.textContent) line.append(who);
    line.append(document.createTextNode(m.text));
    return line;
  }));
  box.scrollTop = box.scrollHeight;
}

async function refresh() {
  clearTimeout(timer);
  if (!token || !document?.body?.isConnected) return;
  try {
    const list = await api('GET', '/agent/cases');
    if (!document?.body?.isConnected) return;
    if (list.ok) { renderQueue(list.body.cases); renderThresholds(list.body.thresholds); }
    if (selected && list.ok) {
      const detail = await api('GET', `/agent/cases/${encodeURIComponent(selected)}`);
      if (!document?.body?.isConnected) return;
      if (detail.ok) renderDetail(detail.body);
      else if (detail.status === 403) {
        // Another agent has it: show who, and nothing of the case itself.
        const held = list.body.cases.find((c) => c.ref === selected);
        shownLines = '';
        renderDetail({ ...held, claimedBy: detail.body.claimedBy ?? held?.claimedBy ?? null, ref: selected, transcript: [] });
      }
    }
  } catch { /* the next refresh tries again */ }
  if (!token || !document?.body || !document.body.isConnected) return; // the page was closed while a request was in flight
  const wait = Number(document.body.dataset.pollMs ?? 3000);
  timer = setTimeout(refresh, Number.isFinite(wait) ? wait : 3000);
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-error').textContent = '';
  const res = await api('POST', '/agent/login', { id: $('agent-id').value.trim(), password: $('agent-password').value });
  if (!pageOpen()) return;
  $('agent-password').value = '';
  if (!res.ok) { $('login-error').textContent = 'Wrong agent id or password.'; return; }
  token = res.body.token;
  me = res.body.name;
  canReadAudit = res.body.canReadAudit === true;
  try { sessionStorage.setItem('console:token', token); sessionStorage.setItem('console:name', me); sessionStorage.setItem('console:audit', canReadAudit ? '1' : '0'); } catch { /* works for this page load only */ }
  showConsole();
});

$('logout').addEventListener('click', signOut);

// Audit log reader (authorised staff only; the service refuses everyone else). Read only, set as text.
function auditFilters() {
  const query = new URLSearchParams();
  for (const [name, role] of [['conversationId', 'audit-conversation'], ['outcome', 'audit-outcome'], ['from', 'audit-from'], ['to', 'audit-to']]) {
    if ($(role).value.trim()) query.set(name, $(role).value.trim());
  }
  return query;
}
async function loadAudit() {
  $('audit-error').textContent = '';
  const query = auditFilters();
  const res = await api('GET', `/agent/audit${query.size ? `?${query}` : ''}`);
  if (!res.ok) { $('audit-error').textContent = res.status === 403 ? 'You are not authorised to read the audit log.' : 'Could not load the audit log.'; $('audit-rows').replaceChildren(); return; }
  const detail = (r) => Object.entries(r)
    .filter(([k, v]) => !['time', 'user', 'outcome'].includes(k) && v !== '' && v !== null && !(Array.isArray(v) && !v.length))
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' · ');
  $('audit-rows').replaceChildren(...res.body.records.map((r) => {
    const row = document.createElement('div');
    row.dataset.role = 'audit-row';
    for (const text of [r.time, r.outcome ?? '', `${r.user} · ${detail(r)}`]) {
      const cell = document.createElement('span');
      cell.textContent = text;
      row.append(cell);
    }
    return row;
  }));
}
// The export file for the filters on screen. Fetched with the session token, then handed to the browser as a download.
async function exportAudit(format) {
  $('audit-error').textContent = '';
  const query = auditFilters();
  query.set('format', format);
  const res = await fetch(`/agent/audit/export?${query}`, { headers: { authorization: `Bearer ${token}` } }).catch(() => null);
  if (!res || !res.ok) { $('audit-error').textContent = res?.status === 403 ? 'You are not authorised to export the audit log.' : 'Could not export the audit log.'; return; }
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? `audit.${format}`;
  const url = URL.createObjectURL(new Blob([await res.text()], { type: format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}
$('audit-export-csv').addEventListener('click', () => exportAudit('csv'));
$('audit-export-json').addEventListener('click', () => exportAudit('json'));
$('audit-open').addEventListener('click', () => { $('dashboard-panel').hidden = true; $('audit-panel').hidden = false; loadAudit(); });
$('audit-close').addEventListener('click', () => { $('audit-panel').hidden = true; });
$('audit-form').addEventListener('submit', (e) => { e.preventDefault(); loadAudit(); });

// Staff dashboard (same staff as the audit log). Counts and percentages, set as text; the service sends no personal data.
const figureText = (f) => (f.percent === null ? `0 of ${f.of}` : `${f.count} of ${f.of} (${f.percent}%)`);
function rows(into, items, label) {
  into.replaceChildren(...items.map((item) => {
    const row = document.createElement('div');
    row.textContent = label(item);
    return row;
  }));
  if (!items.length) into.textContent = 'Nothing in this range.';
}
async function loadDashboard() {
  $('dashboard-error').textContent = '';
  const query = new URLSearchParams();
  for (const [name, role] of [['from', 'dashboard-from'], ['to', 'dashboard-to'], ['language', 'dashboard-language']]) {
    if ($(role).value.trim()) query.set(name, $(role).value.trim());
  }
  const res = await api('GET', `/agent/dashboard${query.size ? `?${query}` : ''}`);
  if (!res.ok) { $('dashboard-error').textContent = res.status === 403 ? 'You are not authorised to read the dashboard.' : 'Could not load the dashboard.'; return; }
  const d = res.body;
  $('dashboard-conversations').textContent = String(d.conversations.count);
  $('dashboard-handoff').textContent = figureText(d.handoffRate);
  $('dashboard-resolved').textContent = figureText(d.assistantResolved);
  $('dashboard-note').textContent = d.conversations.small ? `Small number: these figures come from fewer than ${d.smallNumberBelow} conversations, so read them with care.` : '';
  const small = (item) => (item.small ? ` (fewer than ${d.smallNumberBelow} conversations)` : '');
  rows($('dashboard-top'), d.topQuestions, (q) => `${q.kind} ${q.id}: ${q.turns} questions in ${q.conversations} conversations${small(q)}`);
  rows($('dashboard-unresolved'), d.unresolved, (u) => `${u.text} [${u.language}]: ${u.count} times in ${u.conversations} conversations${small(u)}`);
}
$('dashboard-open').addEventListener('click', () => { $('audit-panel').hidden = true; $('dashboard-panel').hidden = false; loadDashboard(); });
$('dashboard-close').addEventListener('click', () => { $('dashboard-panel').hidden = true; });
$('dashboard-form').addEventListener('submit', (e) => { e.preventDefault(); loadDashboard(); });

$('claim').addEventListener('click', async () => {
  $('claim-error').textContent = '';
  const res = await api('POST', `/agent/cases/${encodeURIComponent(selected)}/claim`);
  if (!pageOpen()) return;
  if (!res.ok) $('claim-error').textContent = res.status === 409 ? 'Already claimed by another agent (or no longer open).' : 'Could not claim this case.';
  refresh();
});

$('resolve').addEventListener('click', async () => {
  await api('POST', `/agent/cases/${encodeURIComponent(selected)}/resolve`);
  refresh();
});

$('transfer').addEventListener('click', async () => {
  $('claim-error').textContent = '';
  const res = await api('POST', `/agent/cases/${encodeURIComponent(selected)}/transfer`, { to: $('transfer-to').value });
  if (!pageOpen()) return;
  if (!res.ok) $('claim-error').textContent = 'Could not transfer this case.';
  refresh();
});

$('suggest').addEventListener('click', suggestReplies);

$('note-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('note-input').value.trim();
  if (!text || !selected) return;
  $('note-error').textContent = '';
  const res = await api('POST', `/agent/cases/${encodeURIComponent(selected)}/notes`, { text });
  if (!pageOpen()) return;
  if (!res.ok) { $('note-error').textContent = 'Could not add the note.'; return; }
  $('note-input').value = '';
  refresh();
});

$('reply-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('reply-input').value.trim();
  if (!text || !selected) return;
  $('reply-input').value = '';
  await api('POST', `/agent/cases/${encodeURIComponent(selected)}/messages`, { text });
  refresh();
});

if (token) showConsole();
