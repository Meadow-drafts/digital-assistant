import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService } from './harness/start-service.js';
import { createFakeModel } from './harness/fake-model.js';
import { chatTurn } from './harness/sse.js';
import { makeToken } from './harness/token.js';

// Ticket 50: a retried message (same messageId) is never processed twice.

test('the same messageId sent again replays the reply: one model call, one audit record', async (t) => {
  const svc = await startService({ model: createFakeModel([['Go to ', 'Transfers.'], 'second']) });
  t.after(svc.close);
  const body = { message: 'How do I send money?', tenant: 'demo', messageId: 'msg-0001-aaaa' };

  const first = await chatTurn(svc.baseUrl, body);
  const id = first.events.at(-1).conversationId;
  const again = await chatTurn(svc.baseUrl, { ...body, conversationId: id });

  assert.deepEqual(again.events, first.events);
  assert.equal(svc.model.calls.length, 1);
  assert.equal(svc.audit.records.length, 1);
});

test('a retry that lost the conversation id still lands in the same conversation', async (t) => {
  const svc = await startService();
  t.after(svc.close);
  const body = { message: 'How do I send money?', tenant: 'demo', messageId: 'msg-0002-bbbb' };

  const first = await chatTurn(svc.baseUrl, body);
  const again = await chatTurn(svc.baseUrl, body); // no conversationId, as after a drop before any byte arrived

  assert.equal(again.events.at(-1).conversationId, first.events.at(-1).conversationId);
  assert.equal(svc.model.calls.length, 1);
});

test('a retry while the first attempt is still running gets the whole reply, once', async (t) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const svc = await startService({ model: createFakeModel([['Go to ', 'Transfers.']], { gate }) });
  t.after(svc.close);
  const body = { message: 'How do I send money?', tenant: 'demo', messageId: 'msg-0003-cccc' };

  const first = chatTurn(svc.baseUrl, body);
  await new Promise((r) => setTimeout(r, 50));
  const again = chatTurn(svc.baseUrl, body);
  await new Promise((r) => setTimeout(r, 50));
  release();
  const [a, b] = await Promise.all([first, again]);

  assert.deepEqual(b.events, a.events);
  assert.equal(b.events.filter((e) => e.type === 'delta').map((e) => e.text).join(''), 'Go to Transfers.');
  assert.equal(svc.model.calls.length, 1);
});

test('a new messageId is a new turn', async (t) => {
  const svc = await startService({ model: createFakeModel(['one', 'two']) });
  t.after(svc.close);
  const base = { message: 'Hello', tenant: 'demo' };
  await chatTurn(svc.baseUrl, { ...base, messageId: 'msg-0004-dddd' });
  const second = await chatTurn(svc.baseUrl, { ...base, messageId: 'msg-0005-eeee' });

  assert.equal(second.events.filter((e) => e.type === 'delta').map((e) => e.text).join(''), 'two');
  assert.equal(svc.model.calls.length, 2);
});

test('a turn that ended in an error is not replayed: trying again asks the model again', async (t) => {
  const svc = await startService({ model: createFakeModel([new Error('down'), 'fine']) });
  t.after(svc.close);
  const body = { message: 'Hello', tenant: 'demo', messageId: 'msg-0006-ffff' };

  const failed = await chatTurn(svc.baseUrl, body);
  assert.ok(failed.events.some((e) => e.type === 'error'));
  const again = await chatTurn(svc.baseUrl, body);

  assert.equal(again.events.filter((e) => e.type === 'delta').map((e) => e.text).join(''), 'fine');
});

test('another customer cannot replay a message id', async (t) => {
  const svc = await startService({ model: createFakeModel(['mine', 'theirs']) });
  t.after(svc.close);
  const body = { message: 'Hello', tenant: 'demo', messageId: 'msg-0007-gggg' };

  await chatTurn(svc.baseUrl, body, { token: makeToken('alice') });
  const other = await chatTurn(svc.baseUrl, body, { token: makeToken('bob') });

  assert.equal(other.events.filter((e) => e.type === 'delta').map((e) => e.text).join(''), 'theirs');
});

test('the thinking event carries the conversation id so a dropped reply can be resumed', async (t) => {
  const svc = await startService();
  t.after(svc.close);
  const { events } = await chatTurn(svc.baseUrl, { message: 'Hi', tenant: 'demo' });

  assert.equal(events[0].type, 'thinking');
  assert.equal(events[0].conversationId, events.at(-1).conversationId);
});
