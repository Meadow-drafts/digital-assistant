import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startService } from './harness/start-service.js';
import { createFakeModel } from './harness/fake-model.js';
import { createGuideModel } from './harness/guide-model.js';
import { agentLogin, customer } from './harness/cases.js';
import { chatTurn } from './harness/sse.js';
import { loadGuides } from '../src/guides.js';
import { loadRetention } from '../src/retention.js';

const DAY = 24 * 60 * 60_000;
const RETENTION = 7 * DAY;
const GUIDES = new URL('../guides/', import.meta.url);

const withRetention = (overrides = {}) => startService({ model: createFakeModel(['ok']), retention: { ms: RETENTION }, ...overrides });
const auditOf = (svc, conversationId) => svc.audit.records.filter((r) => r.conversationId === conversationId);
const caseVisible = async (svc, ref) => (await (await agentLogin(svc.baseUrl, 'aline')).open(ref)).status === 200;
const knows = async (svc, token, conversationId) => (await chatTurn(svc.baseUrl, { message: 'hello again', conversationId, tenant: 'demo' }, { token })).events.at(-1).conversationId === conversationId;

// ---- one configurable value ----

test('retention is one value in one config file, in days, 30 as the placeholder', () => {
  const retention = loadRetention(new URL('../config/retention.json', import.meta.url), {});
  assert.deepEqual(retention, { days: 30, ms: 30 * DAY });
});

test('RETENTION_DAYS in the environment overrides the file, and a value that is not a positive number is refused', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'retention-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'retention.json');
  await writeFile(file, '{"retentionDays": 14}');

  assert.equal(loadRetention(file, {}).days, 14);
  assert.equal(loadRetention(file, { RETENTION_DAYS: '3' }).days, 3);
  for (const bad of ['0', '-5', 'abc', '']) {
    assert.throws(() => loadRetention(file, { RETENTION_DAYS: bad }), /retention/i, bad);
  }
  await writeFile(file, '{"retentionDays": "soon"}');
  assert.throws(() => loadRetention(file, {}), /retention/i);
});

// ---- the purge job ----

test('the purge drops audit records older than the retention value, keeps newer ones, and uses the controllable clock', async (t) => {
  const svc = await withRetention();
  t.after(svc.close);
  const old = await chatTurn(svc.baseUrl, { message: 'first question', tenant: 'demo' });
  await svc.clock.advance(5 * DAY);
  const recent = await chatTurn(svc.baseUrl, { message: 'second question', tenant: 'demo' });
  const [oldId, recentId] = [old, recent].map((r) => r.events.at(-1).conversationId);

  await svc.clock.advance(2 * DAY); // the first record is now exactly 7 days old: not yet past the line
  await svc.server.retention.run();
  assert.equal(auditOf(svc, oldId).length, 1, 'exactly at the limit is kept');

  await svc.clock.advance(1); // one millisecond past
  const removed = await svc.server.retention.run();
  assert.equal(auditOf(svc, oldId).length, 0, 'older than the limit is gone');
  assert.equal(auditOf(svc, recentId).length, 1, 'newer is kept');
  assert.equal(removed.audit, 1);
});

test('the same value ends the transcript: a conversation idle past it is forgotten, one that was used since is not', async (t) => {
  const svc = await withRetention();
  t.after(svc.close);
  const idle = await customer(svc.baseUrl, 'idle-token', 'my private story');
  const busy = await customer(svc.baseUrl, 'busy-token', 'another story');

  await svc.clock.advance(6 * DAY);
  await busy.say('still here');
  await svc.clock.advance(2 * DAY); // idle: 8 days since its last message; busy: 2
  await svc.server.retention.run();

  assert.equal(await knows(svc, 'idle-token', idle.conversationId), false, 'the idle conversation is gone');
  assert.equal(await knows(svc, 'busy-token', busy.conversationId), true, 'the active one stays');
});

test('a forgotten conversation takes its history with it: the model never sees the old messages again', async (t) => {
  const model = createFakeModel(['ok']);
  const svc = await withRetention({ model });
  t.after(svc.close);
  const c = await customer(svc.baseUrl, 'tok', 'the old private story');

  await svc.clock.advance(8 * DAY);
  await svc.server.retention.run();
  await c.say('a fresh start');

  assert.doesNotMatch(JSON.stringify(model.calls.at(-1)), /old private story/);
});

test('a closed case transcript ends with the same value; a case still open is live work and stays', async (t) => {
  const svc = await withRetention();
  t.after(svc.close);
  const closed = await customer(svc.baseUrl, 'closed-token');
  const open = await customer(svc.baseUrl, 'open-token');
  const closedRef = (await closed.handoff()).body.ref;
  const openRef = (await open.handoff()).body.ref;
  const aline = await agentLogin(svc.baseUrl, 'aline');
  await aline.claim(closedRef);
  await aline.resolve(closedRef);

  await svc.clock.advance(RETENTION - 1000);
  await svc.server.retention.run();
  assert.equal(await caseVisible(svc, closedRef), true, 'inside the window');

  await svc.clock.advance(2000);
  await svc.server.retention.run();
  assert.equal(await caseVisible(svc, closedRef), false, 'past the window the transcript is gone');
  assert.equal(await caseVisible(svc, openRef), true, 'an open case is kept');
  assert.equal(await knows(svc, 'open-token', open.conversationId), true, 'and so is the conversation it belongs to');
});

test('the failed-question log, which holds customer wording, follows the same value', async (t) => {
  const svc = await withRetention({ guides: loadGuides(GUIDES), model: createGuideModel({ picks: [] }) });
  t.after(svc.close);
  await chatTurn(svc.baseUrl, { message: 'something no guide covers', tenant: 'demo' });
  assert.equal(svc.failedQuestions.records.length, 1);

  await svc.clock.advance(RETENTION + 1);
  await svc.server.retention.run();

  assert.equal(svc.failedQuestions.records.length, 0);
});

test('the job runs by itself on the clock, no call needed, and keeps running', async (t) => {
  const svc = await withRetention();
  t.after(svc.close);
  const first = await chatTurn(svc.baseUrl, { message: 'first', tenant: 'demo' });
  await svc.clock.advance(8 * DAY);
  assert.equal(auditOf(svc, first.events.at(-1).conversationId).length, 0, 'purged without being asked');

  const second = await chatTurn(svc.baseUrl, { message: 'second', tenant: 'demo' });
  await svc.clock.advance(8 * DAY);
  assert.equal(auditOf(svc, second.events.at(-1).conversationId).length, 0, 'and again later');
});

test('retention is off in a service started without it: nothing is purged and no timer is set', async (t) => {
  const svc = await startService({ model: createFakeModel(['ok']) });
  t.after(svc.close);
  await chatTurn(svc.baseUrl, { message: 'first', tenant: 'demo' });

  await svc.clock.advance(400 * DAY);

  assert.equal(svc.audit.records.length, 1);
  assert.equal(svc.server.retention, undefined);
});
