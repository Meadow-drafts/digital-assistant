import { test } from 'node:test';
import assert from 'node:assert/strict';
import { row, sha512 } from './harness/bank-fixtures.js';
import { alice, begin, open, say, start, toolModel } from './harness/t1-helpers.js';

const networkError = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });
const textOf = (events) => events.filter((e) => e.type === 'delta').map((e) => e.text).join('');
const EXPLAIN = '[[tool:explain_failure {"reference":"REF-0001"}]]';
const lastRecord = (svc) => svc.audit.records.at(-1);

async function setup(t) {
  const a = alice();
  a.rows = [row(a, { sta: '100', msg: 'Insufficient balance' })];
  const svc = await start({ customers: [a], model: toolModel(EXPLAIN, '[[next:retry]]Your balance was too low.') });
  t.after(svc.close);
  return { a, svc, conversationId: await begin(svc, a) };
}

test('a read that fails once at the network level (a dropped idle connection) is tried again and answers normally', async (t) => {
  const { a, svc, conversationId } = await setup(t);
  svc.gateway.throwNext(networkError());

  const { events } = await say(svc, a, 'Why did my transfer REF-0001 fail?', conversationId);

  assert.match(textOf(events), /balance was too low/);
  assert.equal(events.some((e) => e.type === 'tool_blocked'), false);
  assert.equal(svc.gateway.calls.filter((c) => c.path.endsWith('bipay-recent')).length, 2);
});

test('a read that keeps failing is tried once more only, and the audit says what failed without any customer data', async (t) => {
  const { a, svc, conversationId } = await setup(t);
  const before = svc.gateway.calls.length;
  svc.gateway.throwNext(networkError(), 5);

  const { events } = await say(svc, a, 'Why did my transfer REF-0001 fail?', conversationId);

  assert.equal(events.find((e) => e.type === 'tool_blocked').code, 'unavailable');
  assert.equal(svc.gateway.calls.length - before, 2);
  assert.match(lastRecord(svc).toolReason, /^gateway ECONNRESET$/);
});

test('the PIN check is never tried again: it counts attempts', async (t) => {
  const { a, svc, conversationId } = await setup(t);
  svc.gateway.throwNext(networkError(), 5);

  const res = await fetch(`${svc.baseUrl}/unlock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${a.token}` },
    body: JSON.stringify({ conversationId, pinHash: sha512('1234') }),
  });

  assert.equal(res.status, 502);
  assert.equal(svc.gateway.calls.filter((c) => c.path.endsWith('checkPin')).length, 1);
});
