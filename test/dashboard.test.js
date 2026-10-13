import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeModel } from './harness/fake-model.js';
import { startService } from './harness/start-service.js';
import { AGENTS, agentLogin, call } from './harness/cases.js';
import { openWidget } from './harness/open-widget.js';

// Seam 1 (the service's agent API) and seam 3 (the console page). Only fakes and the controllable clock.
// The figures below are worked out by hand from the seeded records, not computed with the code under test.

const turn = (conv, time, language, extra = {}) => ({
  time, user: `u-${conv}`, tenant: 'demo', conversationId: conv, userText: `raw text of ${conv}`, replyText: 'reply', language,
  guideIds: [], model: 'fake', latencyMs: 1000, outcome: 'ok', ...extra,
});
const guide = (id) => ({ guideIds: [id] });
const handoff = (conv, time) => ({ time, user: `u-${conv}`, tenant: 'demo', conversationId: conv, userText: '', replyText: '', outcome: 'handoff_opened', caseRef: 'C-1', caseState: 'waiting' });
const failed = (conv, time, language, question) => ({ time, conversationId: conv, tenant: 'demo', language, question });

// Range under test: 2026-10-10 to 2026-10-12 (inclusive). c8 and c9 sit just outside it.
//   EN  c1  two send-money answers                          -> assistant-resolved
//       c2  bill-payment answer, then a handoff             -> handoff
//       c3  balance tool answer                             -> assistant-resolved
//       c4  send-money answer, then a refusal               -> neither (ended in a refusal)
//       c5  no guide hit (+ failed-question entry)          -> neither (ended in "no verified steps")
//   FR  c6  send-money answer                               -> assistant-resolved
//       c7  bill-payment answer, then a handoff             -> handoff
//   FR then EN  c10: send-money in French, then in English  -> counted FR (its first turn), assistant-resolved
function seed(svc) {
  const rows = [
    turn('c1', '2026-10-10T08:00:00.000Z', 'en', guide('send-money')),
    turn('c1', '2026-10-10T08:05:00.000Z', 'en', guide('send-money')),
    { time: '2026-10-10T07:59:00.000Z', user: 'u-c1', tenant: 'demo', conversationId: 'c1', userText: '', replyText: '', outcome: 'session_started' },
    turn('c2', '2026-10-10T09:00:00.000Z', 'en', guide('bill-payment')),
    handoff('c2', '2026-10-10T09:10:00.000Z'),
    turn('c3', '2026-10-11T10:00:00.000Z', 'en', { tool: 'balance', toolOutcome: 'ok', toolSource: 'router' }),
    turn('c4', '2026-10-11T11:00:00.000Z', 'en', guide('send-money')),
    turn('c4', '2026-10-11T11:05:00.000Z', 'en', { refusalCategory: 'execute' }),
    turn('c5', '2026-10-11T12:00:00.000Z', 'en'),
    turn('c6', '2026-10-12T08:00:00.000Z', 'fr', guide('send-money')),
    turn('c7', '2026-10-12T09:00:00.000Z', 'fr', guide('bill-payment')),
    handoff('c7', '2026-10-12T09:30:00.000Z'),
    turn('c10', '2026-10-12T13:00:00.000Z', 'fr', guide('send-money')),
    turn('c10', '2026-10-12T13:05:00.000Z', 'en', guide('send-money')),
    // a refused tool call is not an answer
    turn('c3', '2026-10-11T10:30:00.000Z', 'en', { tool: 'balance', toolOutcome: 'pin_required', outcome: 'pin_required' }),
    // outside the range
    turn('c8', '2026-10-09T23:59:59.000Z', 'en', guide('send-money')),
    turn('c9', '2026-10-13T00:00:00.000Z', 'en', guide('send-money')),
    handoff('c9', '2026-10-13T00:10:00.000Z'),
  ];
  for (const r of rows) svc.audit.append(r);
  const fq = [
    failed('c5', '2026-10-11T11:59:59.500Z', 'en', 'How do I get a loan?'),
    failed('c11', '2026-10-12T08:00:00.000Z', 'en', 'how do i get a loan'),
    failed('c12', '2026-10-10T10:00:00.000Z', 'fr', 'Comment ouvrir un compte épargne ?'),
    failed('c13', '2026-10-11T15:00:00.000Z', 'en', 'Can I pay my taxes here? my account is 12345678901'),
    failed('c14', '2026-10-11T16:00:00.000Z', 'en', `${'tell me everything about loans '.repeat(8)}`.trim()),
    failed('c15', '2026-10-09T10:00:00.000Z', 'en', 'how do i get a loan'),
  ];
  for (const r of fq) svc.failedQuestions.append(r);
}

const RANGE = 'from=2026-10-10&to=2026-10-12';
const dashboard = (svc, agent, query = RANGE) => call(svc.baseUrl, 'GET', `/agent/dashboard?${query}`, { token: agent?.token });

async function seeded(t) {
  const svc = await startService({ model: createFakeModel(['ok']) });
  t.after(svc.close);
  seed(svc);
  return { svc, aline: await agentLogin(svc.baseUrl, 'aline') };
}

test('only an audit reader can open the dashboard: no login 401, an ordinary agent 403, other verbs 405', async (t) => {
  const { svc, aline } = await seeded(t);
  const paul = await agentLogin(svc.baseUrl, 'paul');
  assert.equal((await dashboard(svc, null)).status, 401);
  assert.equal((await dashboard(svc, paul)).status, 403);
  assert.equal((await dashboard(svc, aline)).status, 200);
  for (const method of ['POST', 'PUT', 'DELETE']) {
    assert.equal((await call(svc.baseUrl, method, `/agent/dashboard?${RANGE}`, { token: aline.token })).status, 405, method);
  }
  assert.equal((await dashboard(svc, aline, 'from=soon')).status, 400);
  assert.equal((await dashboard(svc, aline, `${RANGE}&language=de`)).status, 400);
});

test('all languages: handoff rate and assistant-resolved share are the hand-computed counts and percentages', async (t) => {
  const { svc, aline } = await seeded(t);
  const { body } = await dashboard(svc, aline);
  // 8 conversations in range: c1 c2 c3 c4 c5 c6 c7 c10. Handoffs: c2, c7. Assistant-resolved: c1, c3, c6, c10.
  assert.equal(body.conversations.count, 8);
  assert.deepEqual({ count: body.handoffRate.count, of: body.handoffRate.of, percent: body.handoffRate.percent }, { count: 2, of: 8, percent: 25 });
  assert.deepEqual({ count: body.assistantResolved.count, of: body.assistantResolved.of, percent: body.assistantResolved.percent }, { count: 4, of: 8, percent: 50 });
});

test('per language: a conversation counts under the language of its first turn in the range', async (t) => {
  const { svc, aline } = await seeded(t);
  const en = (await dashboard(svc, aline, `${RANGE}&language=en`)).body;
  assert.equal(en.conversations.count, 5); // c1..c5
  assert.deepEqual([en.handoffRate.count, en.handoffRate.of, en.handoffRate.percent], [1, 5, 20]);
  assert.deepEqual([en.assistantResolved.count, en.assistantResolved.of, en.assistantResolved.percent], [2, 5, 40]);

  const fr = (await dashboard(svc, aline, `${RANGE}&language=fr`)).body;
  assert.equal(fr.conversations.count, 3); // c6, c7, c10
  assert.deepEqual([fr.handoffRate.count, fr.handoffRate.of, fr.handoffRate.percent], [1, 3, 33.3]);
  assert.deepEqual([fr.assistantResolved.count, fr.assistantResolved.of, fr.assistantResolved.percent], [2, 3, 66.7]);
});

test('top questions group by the guide or tool that answered, with turns and conversations; refusals and refused tools are not answers', async (t) => {
  const { svc, aline } = await seeded(t);
  const rows = (query) => dashboard(svc, aline, query).then((r) => r.body.topQuestions.map((q) => [q.kind, q.id, q.turns, q.conversations]));
  assert.deepEqual(await rows(RANGE), [
    ['guide', 'send-money', 6, 4], // c1 x2, c4, c6, c10 x2
    ['guide', 'bill-payment', 2, 2], // c2, c7
    ['tool', 'balance', 1, 1], // c3 (the refused call is not counted)
  ]);
  assert.deepEqual(await rows(`${RANGE}&language=en`), [
    ['guide', 'send-money', 4, 3], ['tool', 'balance', 1, 1], ['guide', 'bill-payment', 1, 1], // a tie is listed by id
  ]);
  assert.deepEqual(await rows(`${RANGE}&language=fr`), [['guide', 'send-money', 2, 2], ['guide', 'bill-payment', 1, 1]]);
});

test('unresolved topics come from the failed-question log: grouped, counted, masked and truncated, inside the range', async (t) => {
  const { svc, aline } = await seeded(t);
  const { body } = await dashboard(svc, aline, `${RANGE}&language=en`);
  const byText = Object.fromEntries(body.unresolved.map((u) => [u.text, u]));
  assert.equal(byText['how do i get a loan'].count, 2); // c5 and c11, case and punctuation ignored; the 10-09 entry is outside the range
  assert.equal(byText['how do i get a loan'].conversations, 2);
  assert.equal(byText['Can I pay my taxes here? my account is ****8901'].count, 1);
  const long = body.unresolved.find((u) => u.text.startsWith('tell me everything'));
  assert.ok(long.text.length <= 81 && long.text.endsWith('…'), `truncated: ${long.text.length}`);
  assert.equal(body.unresolved.length, 3);
  assert.deepEqual(body.unresolved[0].text, 'how do i get a loan', 'most asked first');

  const fr = (await dashboard(svc, aline, `${RANGE}&language=fr`)).body;
  assert.deepEqual(fr.unresolved.map((u) => [u.text, u.count]), [['Comment ouvrir un compte épargne ?', 1]]);
  assert.equal((await dashboard(svc, aline)).body.unresolved.length, 4, 'all languages: the French topic joins the three English ones');
});

test('figures reconcile with the audit reader: the same conversations, handoffs and answered turns', async (t) => {
  const { svc, aline } = await seeded(t);
  const { body } = await dashboard(svc, aline);
  const records = (await call(svc.baseUrl, 'GET', `/agent/audit?${RANGE}&limit=500`, { token: aline.token })).body.records;
  const turns = records.filter((r) => typeof r.language === 'string' && Array.isArray(r.guideIds));
  assert.equal(new Set(turns.map((r) => r.conversationId)).size, body.conversations.count);
  const opened = new Set(records.filter((r) => r.outcome === 'handoff_opened').map((r) => r.conversationId));
  assert.equal([...opened].filter((id) => turns.some((r) => r.conversationId === id)).length, body.handoffRate.count);
  const answeredTurns = turns.filter((r) => r.guideIds.length || (r.tool && r.toolOutcome === 'ok')).length;
  assert.equal(body.topQuestions.reduce((sum, q) => sum + q.turns, 0), answeredTurns, 'each answered turn is counted under exactly one group');
});

test('a figure from fewer than 20 conversations carries the small-number flag; 20 does not', async (t) => {
  const { svc, aline } = await seeded(t);
  const small = (await dashboard(svc, aline)).body;
  assert.equal(small.smallNumberBelow, 20);
  assert.equal(small.conversations.small, true);
  assert.equal(small.handoffRate.small, true);
  assert.equal(small.assistantResolved.small, true);
  assert.ok(small.topQuestions.every((q) => q.small === true));

  const svc2 = await startService({ model: createFakeModel(['ok']) });
  t.after(svc2.close);
  const agent = await agentLogin(svc2.baseUrl, 'aline');
  for (let i = 0; i < 19; i += 1) svc2.audit.append(turn(`n${i}`, '2026-10-10T08:00:00.000Z', 'en', guide('send-money')));
  assert.equal((await dashboard(svc2, agent)).body.handoffRate.small, true, '19 conversations');
  svc2.audit.append(turn('n19', '2026-10-10T08:00:00.000Z', 'en', guide('send-money')));
  const twenty = (await dashboard(svc2, agent)).body;
  assert.equal(twenty.conversations.count, 20);
  assert.equal(twenty.handoffRate.small, false);
  assert.equal(twenty.assistantResolved.small, false);
  assert.equal(twenty.topQuestions[0].small, false);
});

test('an empty range gives zero counts and no percentage, not a division by zero', async (t) => {
  const { svc, aline } = await seeded(t);
  const { body } = await dashboard(svc, aline, 'from=2027-01-01&to=2027-01-02');
  assert.equal(body.conversations.count, 0);
  assert.equal(body.handoffRate.percent, null);
  assert.equal(body.assistantResolved.percent, null);
  assert.deepEqual(body.topQuestions, []);
  assert.deepEqual(body.unresolved, []);
});

// ---- no personal data ----

// Everything personal or secret that the seeded logs hold. None of it may reach the page data.
const SECRETS = [
  'u-c1', 'u-c2', 'u-c5', 'u-c10', // pseudonymous user ids
  'raw text of c1', 'raw text of c4', // raw message text
  'C-1', // case reference
  '12345678901', // a full account number typed into a failed question
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJl', // token
  'a'.repeat(128), // PIN hash
  '4111111111111111', // card number
  'jean.dupont@example.com', '237690000111',
];
const SHAPES = {
  'a conversation id': /\bc\d{1,2}\b/,
  'a long digit run': /\d{9,}/,
  'a JWT': /\beyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]*/,
  'a long hex digest': /\b[0-9a-f]{40,}\b/i,
  'an email': /[\w.+-]+@[\w-]+\.[\w.-]+/,
  'a bearer token': /Bearer\s+(?!\[REDACTED\])\S+/i,
  'a user id': /\bu-c\d+\b/,
};

function plant(svc) {
  svc.audit.append(turn('c1', '2026-10-10T08:10:00.000Z', 'en', { ...guide('send-money'), userText: `my pin is 4821, card 4111111111111111, ${'a'.repeat(128)}`, replyText: 'jean.dupont@example.com 237690000111' }));
  svc.failedQuestions.append(failed('c20', '2026-10-10T08:20:00.000Z', 'en', 'call jean.dupont@example.com on 237690000111 about 12345678901 token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJl'));
  svc.failedQuestions.append(failed('c21', '2026-10-10T08:21:00.000Z', 'en', `Bearer abc123 ${'a'.repeat(128)} card 4111111111111111`));
}

test('the page data holds no user id, conversation id, account number, phone, email, token, hash or raw message text', async (t) => {
  const { svc, aline } = await seeded(t);
  plant(svc);
  const res = await dashboard(svc, aline);
  const text = JSON.stringify(res.body);
  for (const secret of SECRETS) assert.ok(!text.includes(secret), `leaked: ${secret}`);
  for (const [name, shape] of Object.entries(SHAPES)) assert.ok(!shape.test(text), `a value shaped like ${name} is in the page data`);
  assert.ok(!/"(user|conversationId|tenant|caseRef)"/.test(text), 'no identifying field names either');
  assert.ok(res.body.unresolved.length > 0 && res.body.topQuestions.length > 0, 'the scan ran over real content');
});

// ---- the console page ----

async function consoleAs(t, svc, id) {
  const w = await openWidget(svc.baseUrl, '/console');
  t.after(() => w.dom.window.close());
  w.document.body.dataset.pollMs = '600000'; // no case-list polling during these tests
  w.q('agent-id').value = id;
  w.q('agent-password').value = AGENTS.list.find((a) => a.id === id).password;
  w.q('login-form').dispatchEvent(new w.dom.window.Event('submit', { cancelable: true, bubbles: true }));
  await w.until(() => !w.q('console').hidden);
  return w;
}

test('the console shows the dashboard to an audit reader only, with counts, percentages, the small-number note and no personal data', async (t) => {
  const { svc } = await seeded(t);
  plant(svc);
  const paul = await consoleAs(t, svc, 'paul');
  assert.equal(paul.q('dashboard-open').hidden, true);

  const w = await consoleAs(t, svc, 'aline');
  assert.equal(w.q('dashboard-open').hidden, false);
  w.q('dashboard-open').click();
  w.q('dashboard-from').value = '2026-10-10';
  w.q('dashboard-to').value = '2026-10-12';
  w.q('dashboard-language').value = 'en';
  w.q('dashboard-form').dispatchEvent(new w.dom.window.Event('submit', { cancelable: true, bubbles: true }));
  await w.until(() => /1 of 5/.test(w.q('dashboard-handoff').textContent));
  assert.match(w.q('dashboard-handoff').textContent, /1 of 5 \(20%\)/);
  assert.match(w.q('dashboard-resolved').textContent, /2 of 5 \(40%\)/);
  assert.match(w.q('dashboard-note').textContent, /fewer than 20 conversations/i);
  assert.match(w.q('dashboard-top').textContent, /send-money/);
  assert.match(w.q('dashboard-unresolved').textContent, /how do i get a loan/);

  const page = w.q('dashboard-panel').textContent;
  for (const secret of SECRETS) assert.ok(!page.includes(secret), `leaked on the page: ${secret}`);
  for (const [name, shape] of Object.entries(SHAPES)) assert.ok(!shape.test(page), `a value shaped like ${name} is on the page`);
});

test('a real chat turn is counted (guards the record shape the chat route writes)', async (t) => {
  const { chatTurn } = await import('./harness/sse.js');
  const svc = await startService({ model: createFakeModel(['ok']) });
  t.after(svc.close);
  await chatTurn(svc.baseUrl, { message: 'How do I send money?', tenant: 'demo' });
  const today = new Date(svc.clock.now()).toISOString().slice(0, 10);
  const aline = await agentLogin(svc.baseUrl, 'aline');
  const { body } = await dashboard(svc, aline, `from=${today}&to=${today}`);
  assert.equal(body.conversations.count, 1);
  assert.deepEqual([body.assistantResolved.count, body.handoffRate.count], [1, 0]);
});

// ---- last turn ends the conversation unresolved: model error, busy, blocked ----

test('a conversation whose last turn was a model error, a busy message or a blocked reply is not assistant-resolved', async (t) => {
  const svc = await startService({ model: createFakeModel(['ok']) });
  t.after(svc.close);
  const agent = await agentLogin(svc.baseUrl, 'aline');
  const day = '2026-11-02';
  const at = (h) => `${day}T${h}:00:00.000Z`;
  // e1 answered; e2 ended in a model error; e3 ended busy; e4 ended blocked; e5 had an error first, then an answer.
  for (const r of [
    turn('e1', at('08'), 'en', guide('send-money')),
    turn('e2', at('09'), 'en', { outcome: 'error', model: 'fake' }),
    turn('e3', at('10'), 'en', { outcome: 'limited', limit: 'rate', guideIds: [] }),
    turn('e4', at('11'), 'en', { outcome: 'filtered', filter: 'url' }),
    turn('e5', at('12'), 'en', { outcome: 'error' }),
    turn('e5', `${day}T12:30:00.000Z`, 'en', guide('send-money')),
  ]) svc.audit.append(r);

  const { body } = await dashboard(svc, agent, `from=${day}&to=${day}`);
  assert.equal(body.conversations.count, 5);
  assert.deepEqual([body.assistantResolved.count, body.assistantResolved.of, body.assistantResolved.percent], [2, 5, 40]); // e1 and e5
  assert.equal(body.handoffRate.count, 0);
});

// ---- the failed-question log is masked and truncated when it is written ----

test('an 11-digit account number, a phone, an email and a token never reach the stored failed-question file; the text is cut', async (t) => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createFileAudit } = await import('../src/audit.js');
  const { createGuideModel } = await import('./harness/guide-model.js');
  const { loadGuides } = await import('../src/guides.js');
  const { chatTurn } = await import('./harness/sse.js');
  const dir = await mkdtemp(join(tmpdir(), 'failed-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'failed.jsonl');
  const svc = await startService({
    model: createGuideModel({ picks: [] }), guides: loadGuides(new URL('../guides/', import.meta.url)), failedQuestions: createFileAudit(path),
  });
  t.after(svc.close);

  await chatTurn(svc.baseUrl, { message: 'how do I trade stocks with account 12345678901, phone 237690000111, mail jean.dupont@example.com, Bearer abc123def?', tenant: 'demo' });
  await chatTurn(svc.baseUrl, { message: `stocks ${'very long question '.repeat(40)}`.trim(), tenant: 'demo' });

  const file = await readFile(path, 'utf8');
  const entries = file.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(entries.length, 2);
  for (const secret of ['12345678901', '237690000111', 'jean.dupont', 'abc123def']) assert.ok(!file.includes(secret), `stored: ${secret}`);
  assert.match(entries[0].question, /\*\*\*\*8901/, 'masked the way the audit masks');
  assert.match(entries[0].question, /how do I trade stocks/);
  assert.ok(entries[1].question.length <= 201 && entries[1].question.endsWith('…'), `cut: ${entries[1].question.length}`);
});

test('the console shows one of the audit log and the dashboard at a time: opening one closes the other', async (t) => {
  const { svc } = await seeded(t);
  const w = await consoleAs(t, svc, 'aline');
  w.q('dashboard-open').click();
  assert.equal(w.q('dashboard-panel').hidden, false);
  await w.until(() => w.q('dashboard-conversations').textContent !== '');
  w.q('audit-open').click();
  assert.equal(w.q('audit-panel').hidden, false);
  assert.equal(w.q('dashboard-panel').hidden, true, 'the audit log is not left hidden below the dashboard');
  await w.until(() => w.qa('audit-row').length > 0);
  w.q('dashboard-conversations').textContent = ''; // so the wait below is for this second load
  w.q('dashboard-open').click();
  assert.equal(w.q('audit-panel').hidden, true);
  assert.equal(w.q('dashboard-panel').hidden, false);
  await w.until(() => w.q('dashboard-conversations').textContent !== '');
});
