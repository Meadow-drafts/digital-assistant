// In-house support console. Plain page, no framework. Every value from the service is set as text.
// The agent logs in with the demo config login; the session token lives in this page (and sessionStorage).
const $ = (role) => document.querySelector(`[data-role="${role}"]`);
const STATE = { waiting: 'Waiting for an agent', with_agent: 'With an agent', resolved: 'Resolved' };

let token = null;
let me = null;
let selected = new URLSearchParams(location.search).get('case');
let timer = null;
let shownLines = '';

try { token = sessionStorage.getItem('console:token'); me = sessionStorage.getItem('console:name'); } catch { /* no storage: sign in again */ }

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token) signOut();
  return { ok: res.ok, status: res.status, body: data };
}

function signOut() {
  token = null;
  me = null;
  clearTimeout(timer);
  try { sessionStorage.removeItem('console:token'); sessionStorage.removeItem('console:name'); } catch { /* nothing stored */ }
  $('console').hidden = true;
  $('login-form').hidden = false;
}

function showConsole() {
  $('login-form').hidden = true;
  $('console').hidden = false;
  $('agent-name').textContent = me ?? '';
  refresh();
}

const label = (c) => {
  if (c.state === 'resolved') return c.closeReason === 'cancelled_by_user' ? 'Resolved (cancelled by user)' : 'Resolved';
  if (c.state === 'with_agent') return c.claimedBy === me ? 'With you' : `With ${c.claimedBy}`;
  return STATE[c.state] ?? c.state;
};

function renderQueue(cases) {
  const queue = $('queue');
  queue.replaceChildren(...cases.map((c) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.role = 'case-row';
    b.dataset.ref = c.ref;
    if (c.ref === selected) b.setAttribute('aria-current', 'true');
    const wait = c.waitingSeconds === null ? '' : ` · waiting ${Math.floor(c.waitingSeconds / 60)}:${String(c.waitingSeconds % 60).padStart(2, '0')}`;
    b.textContent = `${c.ref} · ${label(c)}${wait}`;
    b.addEventListener('click', () => { selected = c.ref; shownLines = ''; refresh(); });
    return b;
  }));
  $('queue-empty').hidden = cases.length > 0;
}

function renderDetail(d) {
  $('detail').hidden = false;
  $('detail-ref').textContent = `Case ${d.ref}`;
  $('detail-state').textContent = label(d);
  $('detail-claimed-by').textContent = d.claimedBy ?? 'nobody';
  const mine = d.state === 'with_agent' && d.claimedBy === me;
  $('claim').disabled = d.state !== 'waiting';
  $('resolve').disabled = !mine;
  $('reply-input').disabled = !mine;
  $('reply-send').disabled = !mine;
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
  if (!token) return;
  try {
    const list = await api('GET', '/agent/cases');
    if (list.ok) renderQueue(list.body.cases);
    if (selected && list.ok) {
      const detail = await api('GET', `/agent/cases/${encodeURIComponent(selected)}`);
      if (detail.ok) renderDetail(detail.body);
    }
  } catch { /* the next refresh tries again */ }
  if (!token) return;
  const wait = Number(document.body.dataset.pollMs ?? 3000);
  timer = setTimeout(refresh, Number.isFinite(wait) ? wait : 3000);
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-error').textContent = '';
  const res = await api('POST', '/agent/login', { id: $('agent-id').value.trim(), password: $('agent-password').value });
  $('agent-password').value = '';
  if (!res.ok) { $('login-error').textContent = 'Wrong agent id or password.'; return; }
  token = res.body.token;
  me = res.body.name;
  try { sessionStorage.setItem('console:token', token); sessionStorage.setItem('console:name', me); } catch { /* works for this page load only */ }
  showConsole();
});

$('logout').addEventListener('click', signOut);

$('claim').addEventListener('click', async () => {
  $('claim-error').textContent = '';
  const res = await api('POST', `/agent/cases/${encodeURIComponent(selected)}/claim`);
  if (!res.ok) $('claim-error').textContent = res.status === 409 ? 'Already claimed by another agent (or no longer waiting).' : 'Could not claim this case.';
  refresh();
});

$('resolve').addEventListener('click', async () => {
  await api('POST', `/agent/cases/${encodeURIComponent(selected)}/resolve`);
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
