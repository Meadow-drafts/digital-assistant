import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService } from './harness/start-service.js';
import { createFakeModel } from './harness/fake-model.js';
import { chatTurn } from './harness/sse.js';

test('a message streams a reply and ends with a done event', async (t) => {
  const svc = await startService({ model: createFakeModel([['Hello', ' there']]) });
  t.after(svc.close);

  const { status, events } = await chatTurn(svc.baseUrl, { message: 'Can you explain this?', tenant: 'demo' });

  assert.equal(status, 200);
  assert.equal(events[0].type, 'thinking');
  const text = events.filter((e) => e.type === 'delta').map((e) => e.text).join('');
  assert.equal(text, 'Hello there');
  const done = events.at(-1);
  assert.equal(done.type, 'done');
  assert.ok(done.conversationId);
});

test('language follows the latest message, switching mid-chat', async (t) => {
  const svc = await startService();
  t.after(svc.close);
  const say = (message, conversationId) => chatTurn(svc.baseUrl, { message, conversationId, tenant: 'demo' });

  const first = await say('How do I send money to another account?');
  const id = first.events.at(-1).conversationId;
  const second = await say('Comment faire un virement vers un autre compte ?', id);
  const third = await say('ok thanks, and how do I pay a bill?', id);

  assert.deepEqual(
    [first, second, third].map((r) => r.events.at(-1).language),
    ['en', 'fr', 'en'],
  );
  assert.deepEqual(svc.model.calls.map((c) => c.language), ['en', 'fr', 'en']);
});

test('misspelled or accent-free French is still detected as French', async (t) => {
  const svc = await startService();
  t.after(svc.close);
  const { events } = await chatTurn(svc.baseUrl, { message: 'jai pas recu mon virement, ou est mon argent', tenant: 'demo' });
  assert.equal(events.at(-1).language, 'fr');
});

test('every turn writes one audit record with the fields and without secrets', async (t) => {
  const svc = await startService({ model: createFakeModel([['Sure.']]) });
  t.after(svc.close);
  await svc.clock.advance(5000);

  const { events } = await chatTurn(svc.baseUrl, { message: 'Can you explain this?', tenant: 'demo' }, { token: 'SECRET-TOKEN-123' });

  assert.equal(svc.audit.records.length, 1);
  const rec = svc.audit.records[0];
  assert.equal(rec.time, new Date(svc.clock.now()).toISOString());
  assert.equal(rec.tenant, 'demo');
  assert.equal(rec.conversationId, events.at(-1).conversationId);
  assert.equal(rec.userText, 'Can you explain this?');
  assert.equal(rec.replyText, 'Sure.');
  assert.equal(rec.language, 'en');
  assert.equal(rec.model, 'fake-model');
  assert.equal(rec.outcome, 'ok');
  assert.equal(typeof rec.latencyMs, 'number');
  assert.match(rec.user, /^(guest-|sub-)?[0-9a-f]{12}$/, 'a pseudonym, never the token');
  assert.ok(!JSON.stringify(rec).includes('SECRET-TOKEN-123'));
});

test('a failing model is reported to the customer and still audited', async (t) => {
  const svc = await startService({ model: createFakeModel([new Error('provider down')]) });
  t.after(svc.close);

  const { events } = await chatTurn(svc.baseUrl, { message: 'Can you explain this?', tenant: 'demo' });

  assert.equal(events.at(-1).type, 'error');
  assert.equal(svc.audit.records.length, 1);
  assert.equal(svc.audit.records[0].outcome, 'error');
});
