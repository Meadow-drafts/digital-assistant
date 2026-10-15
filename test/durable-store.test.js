import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createFakeModel } from './harness/fake-model.js';
import { createFakeClock } from './harness/fake-clock.js';
import { AGENTS, agentLogin, call } from './harness/cases.js';
import { rawFetch } from './harness/session-fetch.js';
import { row } from './harness/bank-fixtures.js';
import { alice, bob, open, start, TENANT } from './harness/t1-helpers.js';
import { chatTurn } from './harness/sse.js';
import { say } from './harness/t1-helpers.js';
import { ACCOUNT, LEAK, drive } from './harness/secret-scan.js';
import { openDatabase, loadSessionSecret } from '../src/database.js';
import { SESSION_HEADER } from '../src/identity.js';

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const SECRET = 'a-test-session-secret-0123456789';
const LONG_AGENTS = { ...AGENTS, sessionMs: 1000 * HOUR };
const MONDAY_MORNING = Date.UTC(2026, 9, 12, 9, 0, 0); // 10:00 local, opening hours
const FRIDAY_EVENING = Date.UTC(2026, 9, 16, 17, 30, 0); // 18:30 local, closed
const MONDAY_SHIFT_START = Date.UTC(2026, 9, 19, 7, 0, 0);

// A service on a SQLite file. `restart` is a real restart: the server and the database handle are closed, the file is
// opened again by a new service with a new clock that starts where the old one stopped (plus the time it was down).
async function world(t, { customers = [alice()], at = MONDAY_MORNING, model = () => createFakeModel(['ok']), extra = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'assistant-db-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'assistant.db');
  const ctx = { dir, file, customers };
  let live = null;
  const boot = async (startAt) => {
    const database = openDatabase(file);
    live = await start({ customers, model: model(), database, sessionSecret: SECRET, clock: createFakeClock(startAt), agents: LONG_AGENTS, ...extra });
    return live;
  };
  const stop = async () => { if (!live) return; const prev = live; live = null; await prev.close(); prev.database.close(); return prev; };
  t.after(stop);
  ctx.boot = boot;
  ctx.restart = async (downMs = 0) => { const prev = await stop(); return boot(prev.clock.now() + downMs); };
  ctx.svc = await boot(at);
  return ctx;
}

// The customer, with a session on the current service.
async function customerOn(svc, c) {
  const session = await open(svc, c);
  const withSession = (method, path, body) => call(svc.baseUrl, method, path, { token: c.token, body });
  return {
    c, ...session,
    handoff: () => withSession('POST', '/handoff', { conversationId: session.conversationId, tenant: TENANT }),
    status: () => withSession('GET', `/case?conversationId=${session.conversationId}`),
    mine: () => withSession('GET', '/case/mine'),
    cancel: () => withSession('POST', '/case/cancel', { conversationId: session.conversationId }),
    feedback: (solved) => withSession('POST', '/case/feedback', { conversationId: session.conversationId, solved }),
    post: (path, body) => withSession('POST', path, { conversationId: session.conversationId, tenant: TENANT, ...body }),
  };
}
// A request carrying a session id issued before the restart (the only thing the browser still has).
const withOldSession = (svc, c, sessionId, path) => rawFetch(`${svc.baseUrl}${path}`, { headers: { authorization: `Bearer ${c.token}`, [SESSION_HEADER]: sessionId } }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
// What the widget does after a restart: start the session again on the conversation it already has.
const resume = (svc, c, cust) => open(svc, c, { conversationId: cust.conversationId });
const pages = (svc) => svc.mailer.outbox.filter((m) => /New chat case|Customer waiting/.test(m.subject));
const states = async (cust) => (await cust.mine()).body.cases.map((c) => [c.ref, c.state]);

test('after a restart the customer still sees their case, with the session id from before the restart', async (t) => {
  const ctx = await world(t);
  const a = alice();
  const cust = await customerOn(ctx.svc, a);
  const { ref } = (await cust.handoff()).body;

  const svc = await ctx.restart(5 * MIN);

  const listed = await withOldSession(svc, a, cust.sessionId, '/case/mine');
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.cases.map((c) => [c.ref, c.state]), [[ref, 'waiting']]);
  assert.equal(listed.body.cases[0].openedAt, '2026-10-12T09:00:00.000Z', 'the original opening time');
});

test('guided transfer context survives a service restart so the timing answer still leads to History', async (t) => {
  const a = alice();
  const ctx = await world(t, { customers: [a] });
  const customer = await customerOn(ctx.svc, a);
  await say(ctx.svc, a, 'I sent money, but my sister has not received it.', customer.conversationId);

  const svc = await ctx.restart();
  await resume(svc, a, customer);
  const result = await say(svc, a, 'This morning.', customer.conversationId);
  assert.match(result.events.filter((event) => event.type === 'delta').map((event) => event.text).join(''), /Open History/i);
  assert.equal(svc.gateway.calls.some((call) => call.path === '/digitalbank/history/bipay-recent'), false);
});

test('a case is the customer\'s alone after a restart: another customer sees nothing of it', async (t) => {
  const [a, b] = [alice(), bob()];
  const ctx = await world(t, { customers: [a, b] });
  const mine = await customerOn(ctx.svc, a);
  const { ref } = (await mine.handoff()).body;

  const svc = await ctx.restart();

  const asB = await customerOn(svc, b);
  assert.deepEqual((await asB.mine()).body.cases, []);
  assert.equal((await call(svc.baseUrl, 'GET', `/case/mine/${ref}`, { token: b.token })).status, 404);
  assert.deepEqual((await (await customerOn(svc, a)).mine()).body.cases.map((c) => c.ref), [ref], 'and A, on a new session, still has it');
});

test('reference numbers continue from the highest one stored, even after the highest case was purged', async (t) => {
  const ctx = await world(t, { extra: { retention: { ms: 30 * DAY } } });
  const a = alice();
  let cust = await customerOn(ctx.svc, a);
  const first = (await cust.handoff()).body.ref;
  await cust.cancel();
  assert.equal(first, 'C-1001');
  await ctx.svc.clock.advance(31 * DAY);
  await ctx.svc.server.retention.run();

  const svc = await ctx.restart();
  cust = await customerOn(svc, a);
  const next = (await cust.handoff()).body.ref;
  const another = (await (await customerOn(svc, a)).handoff()).body.ref;

  assert.deepEqual([next, another], ['C-1002', 'C-1003'], 'no reuse of C-1001, no collision');
});

test('every state survives a restart as it was: waiting, with an agent, resolved, cancelled and emailed-only', async (t) => {
  const ctx = await world(t);
  const a = alice();
  const mk = async () => customerOn(ctx.svc, a);
  const waiting = await mk(); const withAgent = await mk(); const resolved = await mk(); const cancelled = await mk(); const emailed = await mk();
  const refs = {
    waiting: (await waiting.handoff()).body.ref,
    withAgent: (await withAgent.handoff()).body.ref,
    resolved: (await resolved.handoff()).body.ref,
    cancelled: (await cancelled.handoff()).body.ref,
  };
  await cancelled.cancel();
  const aline = await agentLogin(ctx.svc.baseUrl, 'aline');
  await aline.claim(refs.withAgent);
  await aline.claim(refs.resolved);
  await aline.reply(refs.resolved, 'Done for you.');
  await aline.resolve(refs.resolved);
  const draft = (await emailed.post('/draft', {})).body;
  const shown = (await emailed.post('/draft/preview', { draftId: draft.draftId, text: 'Please check my payment.', destination: 'email' })).body;
  refs.emailed = (await emailed.post('/draft/confirm', { draftId: draft.draftId, previewToken: shown.previewToken })).body.ref;
  const before = (await (await mk()).mine()).body.cases;

  const svc = await ctx.restart(HOUR);

  const after = (await (await customerOn(svc, a)).mine()).body.cases;
  assert.deepEqual(after.map((c) => [c.ref, c.state, c.openedAt, c.updatedAt]), before.map((c) => [c.ref, c.state, c.openedAt, c.updatedAt]));
  assert.deepEqual(Object.fromEntries(after.map((c) => [c.ref, c.state])), {
    [refs.waiting]: 'waiting', [refs.withAgent]: 'with_agent', [refs.resolved]: 'resolved', [refs.cancelled]: 'cancelled', [refs.emailed]: 'emailed',
  });
  // the agent side too: the holder, the transcript and the resolution are all still there
  const aline2 = await agentLogin(svc.baseUrl, 'aline');
  const list = (await aline2.list()).body.cases;
  assert.equal(list.find((c) => c.ref === refs.withAgent).claimedBy, 'Aline Mbarga');
  assert.equal(list.find((c) => c.ref === refs.resolved).closeReason, 'resolved_by_agent');
  assert.equal(list.find((c) => c.ref === refs.cancelled).closeReason, 'cancelled_by_user');
  const detail = (await aline2.open(refs.resolved)).body;
  assert.ok(detail.transcript.some((m) => m.from === 'agent' && m.text === 'Done for you.'));
  assert.deepEqual(detail.transcript.map((m) => m.seq), detail.transcript.map((_, i) => i + 1), 'in order, none lost');
});

test('the drafted message, summary, priority flag, masked records and transcript of a case are all back after a restart', async (t) => {
  const a = alice();
  a.rows = [row(a, { clientReferenceId: 'REF-0001', sta: '100', mtrans: 15000, partnerlib: 'Jean Paul Mbarga', telop: '237677000999' })];
  const ctx = await world(t, { customers: [a], model: () => createFakeModel((r) => (r.purpose === 'summary' ? 'The customer sent money to the wrong person.' : r.purpose === 'route' ? '[]' : 'General help.')) });
  const cust = await customerOn(ctx.svc, a);
  await say(ctx.svc, a, 'I sent 15000 to the wrong person by mistake, reference REF-0001', cust.conversationId);
  const draft = (await cust.post('/draft', { reference: 'REF-0001' })).body;
  const shown = (await cust.post('/draft/preview', { draftId: draft.draftId, text: 'Please help, I sent 15000 to the wrong person.', destination: 'chat' })).body;
  const { ref } = (await cust.post('/draft/confirm', { draftId: draft.draftId, previewToken: shown.previewToken })).body;
  const aline = await agentLogin(ctx.svc.baseUrl, 'aline');
  await aline.claim(ref);
  await aline.reply(ref, 'Looking into it.');
  const before = (await aline.open(ref)).body;
  assert.equal(before.priority, true);
  assert.match(before.draft, /REF-0001/);
  assert.match(before.summary.text, /wrong person/);
  assert.ok(before.records?.length);

  const svc = await ctx.restart(2 * HOUR);

  const after = (await (await agentLogin(svc.baseUrl, 'aline')).open(ref)).body;
  for (const field of ['priority', 'draft', 'summary', 'records', 'transcript', 'conversationId', 'state', 'linkedTo']) assert.deepEqual(after[field], before[field], field);
});

test('chat conversations come back: the history continues, masked, and only for their owner', async (t) => {
  const [a, b] = [alice(), bob()];
  const ctx = await world(t, { customers: [a, b] });
  const cust = await customerOn(ctx.svc, a);
  await chatTurn(ctx.svc.baseUrl, { message: `How do I send money? My account is ${ACCOUNT}`, conversationId: cust.conversationId, tenant: TENANT }, { token: a.token });

  const svc = await ctx.restart(MIN);

  const asOwner = (message, who, sessionId) => chatTurn(svc.baseUrl, { message, conversationId: cust.conversationId, tenant: TENANT }, { token: who.token, headers: sessionId ? { [SESSION_HEADER]: sessionId } : {} });
  const again = await asOwner('And what about fees?', a, cust.sessionId); // the session id from before the restart
  assert.equal(again.status, 200);
  const sentToModel = JSON.stringify(svc.model.calls.at(-1));
  assert.match(sentToModel, /How do I send money/, 'the earlier turn is part of the conversation');
  assert.doesNotMatch(sentToModel, new RegExp(ACCOUNT), 'stored masked, so the full number does not come back');
  assert.match(sentToModel, /\*\*\*\*8901/);
  const bobsSession = (await open(svc, b)).sessionId;
  assert.equal((await asOwner('hello', b, bobsSession)).status, 404);
});

test('waiting case: the 5 and 15 minute timers fire at their original moments after a restart, and nobody is paged twice', async (t) => {
  const ctx = await world(t);
  const a = alice();
  const cust = await customerOn(ctx.svc, a);
  const { ref } = (await cust.handoff()).body;
  await ctx.svc.clock.advance(4 * MIN);

  const svc = await ctx.restart(); // back at 4 minutes
  await resume(svc, a, cust);
  assert.deepEqual(pages(svc), [], 'a restart does not page again');

  await svc.clock.advance(MIN - SEC);
  assert.deepEqual(pages(svc), [], 'not before 5 minutes after the case opened');
  await svc.clock.advance(SEC);
  assert.ok(pages(svc).some((m) => m.to === 'paul@bank.test' && m.subject.includes(ref)), 'the whole pool is paged at 5 minutes');

  await svc.clock.advance(10 * MIN - SEC);
  assert.equal((await call(svc.baseUrl, 'GET', `/case?conversationId=${cust.conversationId}`, { token: a.token })).body.queued, undefined);
  await svc.clock.advance(SEC);
  const late = (await call(svc.baseUrl, 'GET', `/case?conversationId=${cust.conversationId}`, { token: a.token })).body;
  assert.equal(late.queued, true, 'queued notice at 15 minutes');
});

test('a timer that came due while the server was down fires as soon as it starts; the rest keep their moments', async (t) => {
  const ctx = await world(t);
  const a = alice();
  const cust = await customerOn(ctx.svc, a);
  await cust.handoff();

  const svc = await ctx.restart(10 * MIN); // down from 0 to 10 minutes: the 5 minute broadcast was missed
  await resume(svc, a, cust);
  assert.deepEqual(pages(svc), []);
  await svc.clock.advance(0);

  assert.ok(pages(svc).some((m) => m.to === 'paul@bank.test'), 'the broadcast goes out at once');
  const status = () => call(svc.baseUrl, 'GET', `/case?conversationId=${cust.conversationId}`, { token: a.token });
  assert.equal((await status()).body.queued, undefined);
  await svc.clock.advance(5 * MIN);
  assert.equal((await status()).body.queued, true, 'queued notice at 15 minutes after the case opened');
});

test('with an agent: silence timers keep running across a restart without sending status nudges', async (t) => {
  const ctx = await world(t);
  const a = alice();
  const cust = await customerOn(ctx.svc, a);
  const { ref } = (await cust.handoff()).body;
  await (await agentLogin(ctx.svc.baseUrl, 'aline')).claim(ref);
  await ctx.svc.clock.advance(6 * MIN);

  let svc = await ctx.restart();
  await resume(svc, a, cust);
  const notices = async () => (await call(svc.baseUrl, 'GET', `/case?conversationId=${cust.conversationId}`, { token: a.token })).body.messages.filter((m) => m.from === 'system').map((m) => m.text);
  await svc.clock.advance(4 * MIN - SEC);
  assert.deepEqual(await notices(), []);
  await svc.clock.advance(SEC);
  assert.deepEqual(await notices(), [], 'no status nudge at 10 minutes after the claim');
  assert.equal(svc.audit.records.filter((record) => record.outcome === 'case_still_working').length, 1);

  svc = await ctx.restart(); // the silence event is already recorded; it must not send a customer nudge
  await resume(svc, a, cust);
  await svc.clock.advance(0);
  assert.deepEqual(await notices(), [], 'restarting does not repeat or introduce a customer status nudge');
  svc.mailer.outbox.length = 0;
  await svc.clock.advance(20 * MIN - SEC);
  assert.deepEqual(pages(svc), []);
  await svc.clock.advance(SEC);
  assert.ok(pages(svc).some((m) => m.to === 'paul@bank.test' && /Customer waiting/.test(m.subject)), 'the re-broadcast at 30 minutes');
  const view = (await call(svc.baseUrl, 'GET', `/case?conversationId=${cust.conversationId}`, { token: a.token })).body;
  assert.equal(view.emailFollowUp, true);
  // and from the re-broadcast any agent can take the case over, as before the restart
  const paul = await agentLogin(svc.baseUrl, 'paul');
  assert.equal((await paul.claim(ref)).status, 200);
});

test('with an agent: 24 hours without a message auto-resolves it, counted from the last message, across a restart', async (t) => {
  const ctx = await world(t);
  const a = alice();
  const cust = await customerOn(ctx.svc, a);
  const { ref } = (await cust.handoff()).body;
  const aline = await agentLogin(ctx.svc.baseUrl, 'aline');
  await aline.claim(ref);
  await ctx.svc.clock.advance(HOUR);
  await aline.reply(ref, 'On it.'); // the last message, one hour in: the deadline is at 25 hours

  const svc = await ctx.restart(2 * HOUR); // back at 3 hours
  await resume(svc, a, cust);
  const state = async () => (await call(svc.baseUrl, 'GET', `/case?conversationId=${cust.conversationId}`, { token: a.token })).body.state;
  await svc.clock.advance(22 * HOUR - SEC);
  assert.equal(await state(), 'with_agent');
  await svc.clock.advance(SEC);
  assert.equal(await state(), 'resolved');
});

test('with an agent: the auto-resolve deadline itself is exact across a restart', async (t) => {
  const ctx = await world(t);
  const a = alice();
  const cust = await customerOn(ctx.svc, a);
  const { ref } = (await cust.handoff()).body;
  await (await agentLogin(ctx.svc.baseUrl, 'aline')).claim(ref);
  await ctx.svc.clock.advance(3 * HOUR);

  const svc = await ctx.restart();
  await resume(svc, a, cust);
  const state = async () => (await call(svc.baseUrl, 'GET', `/case?conversationId=${cust.conversationId}`, { token: a.token })).body.state;
  await svc.clock.advance(21 * HOUR - SEC); // 24 hours after the claim minus a second
  assert.equal(await state(), 'with_agent');
  await svc.clock.advance(SEC);
  assert.equal(await state(), 'resolved');
});

// Resolved by an agent, then the server restarts and `wait` passes before the customer answers "No" to "Was this solved?".
async function noAfterRestart(t, wait) {
  const ctx = await world(t);
  const a = alice();
  const cust = await customerOn(ctx.svc, a);
  const { ref } = (await cust.handoff()).body;
  const aline = await agentLogin(ctx.svc.baseUrl, 'aline');
  await aline.claim(ref);
  await aline.resolve(ref);
  const svc = await ctx.restart(wait);
  // the conversation belongs to the same customer; the old session id is still good (same secret)
  const answer = await rawFetch(`${svc.baseUrl}/case/feedback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${a.token}`, [SESSION_HEADER]: cust.sessionId },
    body: JSON.stringify({ conversationId: cust.conversationId, solved: false }),
  });
  return { ref, status: answer.status, body: await answer.json(), svc };
}

test('the 72-hour window after resolution survives a restart: exactly 72 h later "No" reopens the same case', async (t) => {
  const { ref, status, body } = await noAfterRestart(t, 72 * HOUR);

  assert.equal(status, 200);
  assert.equal(body.ref, ref);
  assert.equal(body.state, 'with_agent');
});

test('the 72-hour window after resolution survives a restart: 1 s later "No" opens a new linked case', async (t) => {
  const { ref, status, body, svc } = await noAfterRestart(t, 72 * HOUR + SEC);

  assert.equal(status, 200);
  assert.notEqual(body.ref, ref);
  assert.equal(body.state, 'waiting');
  const detail = (await (await agentLogin(svc.baseUrl, 'aline')).open(body.ref)).body;
  assert.equal(detail.linkedTo, ref);
});

test('after hours: a case queued for the next shift is paged at the shift start after a restart, and its confirmation is not sent again', async (t) => {
  const ctx = await world(t, { at: FRIDAY_EVENING });
  const a = alice();
  const cust = await customerOn(ctx.svc, a);
  const { ref } = (await cust.handoff()).body;
  assert.equal(ctx.svc.mailer.outbox.filter((m) => m.to === `${a.sub}@mail.test`).length, 1);

  const svc = await ctx.restart(10 * HOUR);
  assert.deepEqual(svc.mailer.outbox, [], 'nothing re-sent at start');
  await svc.clock.advance(MONDAY_SHIFT_START - svc.clock.now() - SEC);
  assert.deepEqual(pages(svc), []);
  await svc.clock.advance(SEC);
  assert.deepEqual(pages(svc).map((m) => m.to), ['aline@bank.test'], 'the on-call agent at the start of the shift');
  assert.ok(pages(svc)[0].subject.includes(ref));
  await svc.clock.advance(5 * MIN);
  assert.ok(pages(svc).some((m) => m.to === 'paul@bank.test'), 'and the normal 5 minute broadcast after that');
});

test('claim race on one service: of two simultaneous claims exactly one wins', async (t) => {
  const ctx = await world(t);
  const cust = await customerOn(ctx.svc, alice());
  const { ref } = (await cust.handoff()).body;
  const [aline, paul] = await Promise.all([agentLogin(ctx.svc.baseUrl, 'aline'), agentLogin(ctx.svc.baseUrl, 'paul')]);

  const results = await Promise.all([aline.claim(ref), paul.claim(ref), aline.claim(ref), paul.claim(ref)]);

  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal(results.filter((r) => r.status === 409).length, 3);
});

test('claim race across two services on the same database file: exactly one claim wins, the other is told it is taken', async (t) => {
  const ctx = await world(t);
  const cust = await customerOn(ctx.svc, alice());
  const { ref } = (await cust.handoff()).body;
  // a second service (another process, in effect) starts on the same file and knows the case as waiting
  const second = await start({ customers: [alice()], model: createFakeModel(['ok']), database: openDatabase(ctx.file), sessionSecret: SECRET, clock: createFakeClock(MONDAY_MORNING), agents: LONG_AGENTS });
  t.after(async () => { await second.close(); second.database.close(); });
  const [onFirst, onSecond] = await Promise.all([agentLogin(ctx.svc.baseUrl, 'aline'), agentLogin(second.baseUrl, 'paul')]);

  const results = await Promise.all([onFirst.claim(ref), onSecond.claim(ref)]);

  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  const loser = results.find((r) => r.status === 409);
  assert.equal(loser.body.error, 'already_claimed');
});

test('the retention purge removes closed cases and their conversations from the database; open cases and their conversations stay', async (t) => {
  const ctx = await world(t, { extra: { retention: { ms: 30 * DAY } } });
  const a = alice();
  const closed = await customerOn(ctx.svc, a);
  const closedRef = (await closed.handoff()).body.ref;
  await closed.cancel();
  const live = await customerOn(ctx.svc, a);
  const liveRef = (await live.handoff()).body.ref;
  await ctx.svc.clock.advance(31 * DAY);

  await ctx.svc.server.retention.run(); // (the job also ran by itself while the clock moved)
  ctx.svc.server.flushStorage();
  const raw = new DatabaseSync(ctx.file);
  t.after(() => raw.close());
  assert.deepEqual(raw.prepare('SELECT ref FROM cases').all().map((r) => r.ref), [liveRef]);
  assert.equal(raw.prepare('SELECT count(*) AS n FROM case_messages WHERE case_ref = ?').get(closedRef).n, 0, 'its messages went with it');
  assert.deepEqual(raw.prepare('SELECT id FROM conversations').all().map((r) => r.id), [live.conversationId]);
  // and it stays gone after a restart
  const svc = await ctx.restart();
  assert.deepEqual((await (await customerOn(svc, a)).mine()).body.cases.map((c) => c.ref), [liveRef]);
});

test('the database file holds no PIN, OTP, card number, token or PIN hash, and no full account number (the ticket 33 scan, over the file)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'assistant-db-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'assistant.db');
  const database = openDatabase(file);
  const { svc } = await drive(t, { database, sessionSecret: SECRET });
  svc.server.flushStorage();
  const bytes = readFileSync(file).toString('latin1');

  assert.ok(statSync(file).size > 8192, 'a real database, not an empty file that trivially passes');
  const raw = new DatabaseSync(file);
  t.after(() => raw.close());
  assert.ok(raw.prepare('SELECT count(*) AS n FROM cases').get().n >= 1, 'it holds the case');
  assert.ok(raw.prepare('SELECT count(*) AS n FROM case_messages').get().n >= 5, 'and its messages');
  assert.ok(raw.prepare('SELECT count(*) AS n FROM conversations').get().n >= 1, 'and the conversation');
  assert.match(bytes, /How do I send money/, 'the scan conversation is really in the file');
  for (const [name, pattern] of LEAK) assert.doesNotMatch(bytes, pattern, `${name} is in the database file`);
  assert.ok(!bytes.includes(alice().token), 'the session token is in the database file');
  assert.doesNotMatch(bytes, new RegExp(ACCOUNT), 'the full account number is in the database file');
  assert.doesNotMatch(bytes, new RegExp(SECRET), 'the session secret is in the database file');
});

test('with no database the service keeps everything in memory, exactly as before', async (t) => {
  const svc = await start({ customers: [alice()], model: createFakeModel(['ok']) });
  t.after(svc.close);
  const cust = await customerOn(svc, alice());
  const { ref } = (await cust.handoff()).body;

  assert.deepEqual(await states(cust), [[ref, 'waiting']]);
  assert.equal(svc.database, undefined);
});

test('the session secret is created once under data/, reused on the next start, and an environment value wins', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'assistant-secret-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'nested', 'session-secret');

  const first = loadSessionSecret(file, {});
  const second = loadSessionSecret(file, {});

  assert.ok(first.length >= 32);
  assert.equal(second, first, 'the same secret after a restart');
  assert.equal(statSync(file).mode & 0o077, 0, 'readable by the owner only');
  assert.equal(loadSessionSecret(file, { SESSION_SECRET: 'x'.repeat(20) }), 'x'.repeat(20));
  assert.throws(() => loadSessionSecret(file, { SESSION_SECRET: 'short' }), /at least 16/);
  assert.ok(existsSync(file));
});
