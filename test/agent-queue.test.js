import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService } from './harness/start-service.js';
import { createFakeModel } from './harness/fake-model.js';
import { AGENTS, agentLogin, customer } from './harness/cases.js';
import { loadSupport } from '../src/support.js';

const SEC = 1000;
const MIN = 60 * SEC;
const LONG_SESSION = { ...AGENTS, sessionMs: 1000 * 60 * MIN };
const REAL = loadSupport(new URL('../config/support.json', import.meta.url));

async function service(t, over = {}) {
  const svc = await startService({ model: createFakeModel(['ok']), agents: LONG_SESSION, ...over });
  t.after(svc.close);
  svc.open = async (token, first = 'hello') => (await (await customer(svc.baseUrl, token, first)).handoff()).body.ref;
  return svc;
}
const rowOf = async (agent, ref) => (await agent.list()).body.cases.find((c) => c.ref === ref);

test('each waiting case shows how long it has waited, counted from when it opened', async (t) => {
  const svc = await service(t);
  const aline = await agentLogin(svc.baseUrl);
  const first = await svc.open('a');
  await svc.clock.advance(90 * SEC);
  const second = await svc.open('b');
  await svc.clock.advance(30 * SEC);

  assert.equal((await rowOf(aline, first)).waitingSeconds, 120);
  assert.equal((await rowOf(aline, second)).waitingSeconds, 30);
  assert.equal((await rowOf(aline, first)).waitingFor, 'claim');
});

test('a case with an agent counts the customer\'s wait for a reply, and stops counting when the agent answers', async (t) => {
  const svc = await service(t);
  const aline = await agentLogin(svc.baseUrl);
  const c = await customer(svc.baseUrl, 'a', 'hello');
  const { ref } = (await c.handoff()).body;
  await aline.claim(ref);

  await svc.clock.advance(4 * MIN);
  assert.deepEqual([(await rowOf(aline, ref)).waitingSeconds, (await rowOf(aline, ref)).waitingFor], [240, 'reply']);

  await aline.reply(ref, 'On it.');
  await svc.clock.advance(MIN);
  assert.deepEqual([(await rowOf(aline, ref)).waitingSeconds, (await rowOf(aline, ref)).waitingFor, (await rowOf(aline, ref)).waitLevel], [null, null, null]);

  await svc.clock.advance(MIN);
  await c.say('And what about the fee?');
  await svc.clock.advance(10 * SEC);
  assert.equal((await rowOf(aline, ref)).waitingSeconds, 10, 'the clock starts again at the customer\'s message');

  await aline.resolve(ref);
  assert.equal((await rowOf(aline, ref)).waitingSeconds, null);
});

test('the list is sorted with priority cases first, then the longest waiting', async (t) => {
  const svc = await service(t);
  const aline = await agentLogin(svc.baseUrl);
  const oldest = await svc.open('a');
  await svc.clock.advance(MIN);
  const middle = await svc.open('b');
  await svc.clock.advance(MIN);
  const priority = await svc.open('c', 'I sent money to the wrong person');
  await svc.clock.advance(MIN);
  const newest = await svc.open('d');

  const order = (await aline.list()).body.cases.map((c) => c.ref);

  assert.deepEqual(order, [priority, oldest, middle, newest]);
});

test('among priority cases the longest waiting comes first, and a case waiting on a reply ranks by its own wait', async (t) => {
  const svc = await service(t);
  const aline = await agentLogin(svc.baseUrl);
  const claimedEarly = await svc.open('a');
  await aline.claim(claimedEarly); // customer waits for a reply from here
  await svc.clock.advance(MIN);
  const priorityOld = await svc.open('b', 'wrong person');
  await svc.clock.advance(MIN);
  const priorityNew = await svc.open('c', 'by mistake');
  await svc.clock.advance(MIN);
  const waiting = await svc.open('d');
  await svc.clock.advance(30 * SEC);

  const order = (await aline.list()).body.cases.map((c) => c.ref);

  assert.deepEqual(order, [priorityOld, priorityNew, claimedEarly, waiting]);
});

test('closed and answered cases sit below the ones that are waiting, and a resolved priority case does not jump the queue', async (t) => {
  const svc = await service(t);
  const aline = await agentLogin(svc.baseUrl);
  const doneRef = await svc.open('a', 'wrong person');
  await aline.claim(doneRef);
  await aline.resolve(doneRef);
  await svc.clock.advance(MIN);
  const waiting = await svc.open('b');
  await svc.clock.advance(MIN);
  const answered = await svc.open('c');
  await aline.claim(answered);
  await aline.reply(answered, 'Hi');

  const order = (await aline.list()).body.cases.map((c) => c.ref);

  assert.equal(order[0], waiting);
  assert.deepEqual(new Set(order.slice(1)), new Set([doneRef, answered]));
});

test('the thresholds are the configured timers: 5 and 15 minutes for a waiting case, 10 and 30 for a case awaiting a reply', async (t) => {
  const svc = await service(t);
  const aline = await agentLogin(svc.baseUrl);

  const { body } = await aline.list();

  assert.deepEqual(body.thresholds, {
    waiting: { warnSeconds: REAL.timers.broadcastMs / 1000, urgentSeconds: REAL.timers.queuedNoticeMs / 1000 },
    withAgent: { warnSeconds: REAL.timers.agentSilenceMs / 1000, urgentSeconds: REAL.timers.agentFollowUpMs / 1000 },
  });
  assert.deepEqual([body.thresholds.waiting.warnSeconds, body.thresholds.waiting.urgentSeconds, body.thresholds.withAgent.warnSeconds, body.thresholds.withAgent.urgentSeconds], [300, 900, 600, 1800]);
});

test('a waiting case changes level exactly at the configured timers: -1 s, exactly, +1 s', async (t) => {
  const svc = await service(t);
  const aline = await agentLogin(svc.baseUrl);
  const ref = await svc.open('a');
  const level = async () => (await rowOf(aline, ref)).waitLevel;

  await svc.clock.advance(5 * MIN - SEC);
  assert.equal(await level(), 'normal');
  await svc.clock.advance(SEC);
  assert.equal(await level(), 'warning', 'at exactly the broadcast time');
  await svc.clock.advance(SEC);
  assert.equal(await level(), 'warning');
  await svc.clock.advance(10 * MIN - 2 * SEC);
  assert.equal(await level(), 'warning', '1 s before the queued notice');
  await svc.clock.advance(SEC);
  assert.equal(await level(), 'urgent', 'at exactly the queued notice');
});

test('a case awaiting a reply changes level exactly at the silence and follow-up timers', async (t) => {
  const svc = await service(t);
  const aline = await agentLogin(svc.baseUrl);
  const ref = await svc.open('a');
  await aline.claim(ref);
  const level = async () => (await rowOf(aline, ref)).waitLevel;

  await svc.clock.advance(10 * MIN - SEC);
  assert.equal(await level(), 'normal');
  await svc.clock.advance(SEC);
  assert.equal(await level(), 'warning');
  await svc.clock.advance(20 * MIN - SEC);
  assert.equal(await level(), 'warning');
  await svc.clock.advance(SEC);
  assert.equal(await level(), 'urgent');
});

test('change the timers in config and the queue follows: the levels and thresholds use the new values', async (t) => {
  const timers = { ...REAL.timers, broadcastMs: 2 * MIN, queuedNoticeMs: 4 * MIN, agentSilenceMs: 3 * MIN, agentFollowUpMs: 6 * MIN };
  const svc = await service(t, { support: { ...REAL, timers } });
  const aline = await agentLogin(svc.baseUrl);
  const ref = await svc.open('a');

  await svc.clock.advance(2 * MIN - SEC);
  assert.equal((await rowOf(aline, ref)).waitLevel, 'normal');
  await svc.clock.advance(SEC);
  assert.equal((await rowOf(aline, ref)).waitLevel, 'warning');
  await svc.clock.advance(2 * MIN);
  assert.equal((await rowOf(aline, ref)).waitLevel, 'urgent');
  assert.deepEqual((await aline.list()).body.thresholds, { waiting: { warnSeconds: 120, urgentSeconds: 240 }, withAgent: { warnSeconds: 180, urgentSeconds: 360 } });
});

test('a case taken over after the re-broadcast starts a fresh wait for its new holder', async (t) => {
  const svc = await service(t);
  const aline = await agentLogin(svc.baseUrl, 'aline');
  const paul = await agentLogin(svc.baseUrl, 'paul');
  const ref = await svc.open('a');
  await aline.claim(ref);
  await svc.clock.advance(30 * MIN);
  assert.equal((await rowOf(paul, ref)).waitLevel, 'urgent');

  await paul.claim(ref);

  assert.deepEqual([(await rowOf(paul, ref)).waitingSeconds, (await rowOf(paul, ref)).waitLevel], [0, 'normal']);
});
