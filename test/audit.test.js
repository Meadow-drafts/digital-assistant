import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { row, sha512 } from './harness/bank-fixtures.js';
import { createFakeModel } from './harness/fake-model.js';
import { startService } from './harness/start-service.js';
import { openWidget } from './harness/open-widget.js';
import { chatTurn } from './harness/sse.js';
import { createFakeClock } from './harness/fake-clock.js';
import { createMemoryAudit } from './harness/memory-audit.js';
import { AGENTS, agentLogin, call } from './harness/cases.js';
import { alice, begin, say, start } from './harness/t1-helpers.js';
import { createAuditTrail, createFileAudit } from '../src/audit.js';

const DAY = 24 * 60 * 60_000;
const iso = (ms) => new Date(ms).toISOString();

// One customer, one conversation, every kind of turn that leaves an audit record.
async function scenario(t) {
  const a = alice();
  a.rows = [row(a, { clientReferenceId: 'REF-0001', sta: '100' })];
  const model = createFakeModel((request) => {
    if (request.purpose !== 'route') return 'Here is what I found.';
    const asked = request.messages.at(-1).content;
    if (/last transactions/.test(asked)) return '[[tool:last_transactions {"count":2}]]';
    if (/wire the money/.test(asked)) return '[[refusal:execute]]';
    return '["transfer-single"]';
  });
  const svc = await start({ customers: [a], model });
  t.after(svc.close);
  const id = await begin(svc, a);
  await say(svc, a, 'show me my last transactions, my account is 12345678901', id);
  await say(svc, a, 'How do I send money to another account?', id);
  await say(svc, a, 'wire the money for me now', id);
  await svc.clock.advance(1500);
  const post = (path, body) => call(svc.baseUrl, 'POST', path, { token: a.token, body: { conversationId: id, ...body } });
  const { body: opened } = await post('/handoff', {});
  const aline = await agentLogin(svc.baseUrl, 'aline');
  await aline.claim(opened.ref);
  await aline.resolve(opened.ref);
  return { a, svc, id, ref: opened.ref, aline, records: svc.audit.records };
}

test('every record carries time, a pseudonymous user, the tenant and the conversation id', async (t) => {
  const { a, svc, id, records } = await scenario(t);

  assert.ok(records.length >= 8, 'session, three turns and the case life all leave records');
  for (const r of records) {
    assert.match(r.time, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/, `${r.outcome}: time`);
    assert.match(r.user, /^sub-[0-9a-f]{12}$/, `${r.outcome}: pseudonymous user`);
    assert.equal(r.tenant, 'demo', `${r.outcome}: tenant`);
    assert.equal(r.conversationId, id, `${r.outcome}: conversation id`);
  }
  const everything = JSON.stringify(records);
  assert.ok(!everything.includes(a.sub), 'the user id is a digest, never the wallet or phone');
  assert.ok(!everything.includes(a.token), 'and never the token');
  assert.equal(new Date(svc.clock.now()).getTime() - Date.parse(records[0].time), 1500, 'times come from the clock');
});

test('a turn records the masked text, the model and latency, the guide ids, the tool call with its arguments and the refusal category', async (t) => {
  const { records } = await scenario(t);
  const turn = (text) => records.find((r) => r.userText?.includes(text));

  const tool = turn('last transactions');
  assert.equal(tool.tool, 'last_transactions');
  assert.deepEqual(tool.toolArgs, { count: 2 }, 'the validated, enumerated arguments');
  assert.equal(tool.toolOutcome, 'ok');
  assert.ok(tool.toolData.includes('****8901'), 'the result as the model saw it, masked');
  assert.doesNotMatch(JSON.stringify(tool), /12345678901/, 'masked text, tool call and result alike');
  assert.equal(tool.model, 'fake-model');
  assert.equal(typeof tool.latencyMs, 'number');

  assert.deepEqual(turn('How do I send money').guideIds, ['transfer-single']);
  assert.equal(turn('wire the money').refusalCategory, 'execute');
});

test('an action card is recorded with its outcome', async (t) => {
  const a = alice();
  const svc = await start({ customers: [a], model: createFakeModel((r) => (r.purpose === 'route' ? '["transfer-single"]' : '[[navigate:transfer]]Open Transfers.')) });
  t.after(svc.close);
  await say(svc, a, 'How do I send money?', await begin(svc, a));

  assert.deepEqual(svc.audit.records.at(-1).navigate, { outcome: 'offered', proposal: 'transfer' });
});

test('every handoff state change is recorded with the state the case moved to', async (t) => {
  const { records, ref } = await scenario(t);
  const states = records.filter((r) => r.caseRef === ref && r.caseState).map((r) => [r.outcome, r.caseState]);

  assert.deepEqual(states.filter(([o]) => ['handoff_opened', 'case_claimed', 'case_resolved'].includes(o)), [
    ['handoff_opened', 'waiting'],
    ['case_claimed', 'with_agent'],
    ['case_resolved', 'resolved'],
  ]);
  assert.equal(records.find((r) => r.outcome === 'case_resolved').closeReason, 'resolved_by_agent');
});

test('a cancelled case records the state and the reason', async (t) => {
  const a = alice();
  const svc = await start({ customers: [a], model: createFakeModel(['ok']) });
  t.after(svc.close);
  const id = await begin(svc, a);
  await call(svc.baseUrl, 'POST', '/handoff', { token: a.token, body: { conversationId: id } });
  await call(svc.baseUrl, 'POST', '/case/cancel', { token: a.token, body: { conversationId: id } });

  const cancelled = svc.audit.records.find((r) => r.outcome === 'case_cancelled');
  assert.deepEqual([cancelled.caseState, cancelled.closeReason], ['resolved', 'cancelled_by_user']);
});

// ---- the write point: nothing secret-shaped is stored, whatever a caller hands it ----

test('the audit trail strips tokens, PIN hashes, card numbers and a PIN typed in user text, wherever they appear', async () => {
  const sink = createMemoryAudit();
  const trail = createAuditTrail({ sink, clock: createFakeClock() });
  const jwt = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiIyMzc2OTAwMDAxMTEifQ.signature123';
  await trail.append({
    user: 'u', tenant: 'demo', conversationId: 'c',
    userText: 'my pin is 4821 and the otp is 998877',
    replyText: `Authorization: Bearer opaque-token-value and ${jwt}`,
    toolData: JSON.stringify({ hash: sha512('1234'), card: '4111 1111 1111 1111' }),
    nested: { list: [`card 4111111111111111`] },
  });

  const stored = JSON.stringify(sink.records);
  for (const secret of ['4821', '998877', 'opaque-token-value', jwt, sha512('1234'), '4111 1111 1111 1111', '4111111111111111']) {
    assert.ok(!stored.includes(secret), `${secret.slice(0, 12)}... is stored`);
  }
  assert.match(sink.records[0].userText, /my pin is \[REDACTED\]/);
});

test('the audit trail fills in the time and keeps ordinary values (amounts, references, dates) as they are', async () => {
  const sink = createMemoryAudit();
  const clock = createFakeClock();
  const trail = createAuditTrail({ sink, clock });
  await trail.append({ outcome: 'x', toolData: '{"amount":15000,"reference":"FT2610123456","date":"2026-10-10"}' });

  assert.equal(sink.records[0].time, iso(clock.now()));
  assert.equal(sink.records[0].toolData, '{"amount":15000,"reference":"FT2610123456","date":"2026-10-10"}');
});

// ---- append-only ----

test('the file audit only appends: earlier lines are never rewritten, and it offers no way to change a record', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'audit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'audit.jsonl');
  const audit = createFileAudit(file);

  await audit.append({ time: iso(1000), outcome: 'one' });
  const first = await readFile(file, 'utf8');
  await audit.append({ time: iso(2000), outcome: 'two' });

  assert.ok((await readFile(file, 'utf8')).startsWith(first), 'the first line is untouched');
  assert.deepEqual((await audit.all()).map((r) => r.outcome), ['one', 'two']);
  assert.deepEqual(Object.keys(audit).sort(), ['all', 'append', 'purge'], 'no update, no delete by id');
});

test('a purge removes only records older than the cutoff, and an append racing it is not lost', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'audit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const audit = createFileAudit(join(dir, 'audit.jsonl'));
  for (const [ms, outcome] of [[1000, 'old'], [5000, 'edge'], [9000, 'new']]) await audit.append({ time: iso(ms), outcome });

  const [removed] = await Promise.all([audit.purge(5000), audit.append({ time: iso(9500), outcome: 'raced' })]);

  assert.equal(removed, 1);
  assert.deepEqual((await audit.all()).map((r) => r.outcome), ['edge', 'new', 'raced']);
});

// ---- the reader view ----

const read = (svc, agent, query = '') => call(svc.baseUrl, 'GET', `/agent/audit${query}`, { token: agent?.token });

test('only an authorised staff member can read the audit log: no login, a customer token and an agent without the right all fail', async (t) => {
  const { a, svc } = await scenario(t);
  const aline = await agentLogin(svc.baseUrl, 'aline');
  const paul = await agentLogin(svc.baseUrl, 'paul');

  assert.equal((await read(svc, null)).status, 401);
  assert.equal((await read(svc, { token: a.token })).status, 401, 'a customer token is not a staff session');
  assert.equal((await read(svc, paul)).status, 403);
  assert.equal((await read(svc, aline)).status, 200);
});

test('the reader shows records newest first and can filter by conversation, outcome and a limit', async (t) => {
  const { svc, id, aline } = await scenario(t);

  const all = (await read(svc, aline)).body.records;
  assert.deepEqual(all.map((r) => r.time), [...all.map((r) => r.time)].sort().reverse(), 'newest first');

  const mine = (await read(svc, aline, `?conversationId=${id}`)).body.records;
  assert.ok(mine.length > 0 && mine.every((r) => r.conversationId === id));
  const claims = (await read(svc, aline, '?outcome=case_claimed')).body.records;
  assert.ok(claims.length === 1 && claims[0].outcome === 'case_claimed');
  assert.equal((await read(svc, aline, '?limit=2')).body.records.length, 2);
  assert.equal((await read(svc, aline, '?limit=banana')).status, 400);
});

test('the reader is read-only: no verb changes or deletes a record', async (t) => {
  const { svc, aline } = await scenario(t);
  const before = svc.audit.records.length;

  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const res = await call(svc.baseUrl, method, '/agent/audit', { token: aline.token, body: method === 'DELETE' ? undefined : { outcome: 'forged' } });
    assert.ok([404, 405].includes(res.status), `${method} answered ${res.status}`);
  }
  assert.equal(svc.audit.records.length, before);
});

// ---- the reader view in the console ----

test('the console shows the audit log read-only to an authorised agent and offers it to nobody else', async (t) => {
  const svc = await startService({ model: createFakeModel(['ok']) });
  t.after(svc.close);
  await chatTurn(svc.baseUrl, { message: 'my account is 12345678901, hello', tenant: 'demo' });
  await chatTurn(svc.baseUrl, { message: 'a second one', tenant: 'demo' });

  const open = async (id) => {
    const w = await openWidget(svc.baseUrl, '/console');
    t.after(() => w.dom.window.close());
    w.document.body.dataset.pollMs = '20';
    w.q('agent-id').value = id;
    w.q('agent-password').value = AGENTS.list.find((a) => a.id === id).password;
    w.q('login-form').dispatchEvent(new w.dom.window.Event('submit', { cancelable: true, bubbles: true }));
    await w.until(() => !w.q('console').hidden);
    return w;
  };

  const paul = await open('paul');
  assert.equal(paul.q('audit-open').hidden, true, 'an ordinary agent is not offered it');

  const aline = await open('aline');
  assert.equal(aline.q('audit-open').hidden, false);
  aline.q('audit-open').click();
  await aline.until(() => aline.qa('audit-row').length === 2);
  const shown = aline.qa('audit-row').map((r) => r.textContent).join('\n');
  assert.match(shown, /a second one/);
  assert.match(shown, /\*\*\*\*8901/, 'masked, as stored');
  assert.doesNotMatch(shown, /12345678901/);

  aline.q('audit-outcome').value = 'nothing_like_this';
  aline.q('audit-form').dispatchEvent(new aline.dom.window.Event('submit', { cancelable: true, bubbles: true }));
  await aline.until(() => aline.qa('audit-row').length === 0);
});
