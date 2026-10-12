// In-house support console. Plain page, no framework. Every value from the service is set as text.
// The agent logs in with the demo config login; the session token lives in this page (and sessionStorage).
const $ = (role) => document.querySelector(`[data-role="${role}"]`);
const STATE = { waiting: 'Waiting for an agent', with_agent: 'With an agent', resolved: 'Resolved', emailed: 'Emailed to support (no chat)' };

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
    b.textContent = `${c.priority ? 'PRIORITY · ' : ''}${c.ref} · ${label(c)}${wait}`;
    b.addEventListener('click', () => { selected = c.ref; shownLines = ''; refresh(); });
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
  $('summary').hidden = !d.summary;
  $('summary-label').textContent = d.summary?.label ?? '';
  $('summary-text').textContent = d.summary?.text ?? '';
  $('records-box').hidden = !d.records?.length;
  $('records').replaceChildren(...(d.records ?? []).map((r) => {
    const line = document.createElement('div');
    line.dataset.role = 'record';
    line.textContent = recordLine(r);
    return line;
  }));
}

function renderDetail(d) {
  $('detail').hidden = false;
  renderContext(d);
  $('detail-ref').textContent = `Case ${d.ref}`;
  $('detail-state').textContent = label(d);
  $('detail-claimed-by').textContent = d.claimedBy ?? 'nobody';
  const mine = d.state === 'with_agent' && d.claimedBy === me;
  $('claim').disabled = d.state !== 'waiting';
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
      else if (detail.status === 403) {
        // Another agent has it: show who, and nothing of the case itself.
        const held = list.body.cases.find((c) => c.ref === selected);
        shownLines = '';
        renderDetail({ ...held, claimedBy: detail.body.claimedBy ?? held?.claimedBy ?? null, ref: selected, transcript: [] });
      }
    }
  } catch { /* the next refresh tries again */ }
  if (!token || !document?.body) return; // the page was closed while a request was in flight
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

$('transfer').addEventListener('click', async () => {
  $('claim-error').textContent = '';
  const res = await api('POST', `/agent/cases/${encodeURIComponent(selected)}/transfer`, { to: $('transfer-to').value });
  if (!res.ok) $('claim-error').textContent = 'Could not transfer this case.';
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
