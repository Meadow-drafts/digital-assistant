import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService } from './harness/start-service.js';
import { createFakeModel } from './harness/fake-model.js';
import { chatTurn } from './harness/sse.js';
import { loadGuides } from '../src/guides.js';

const replyOf = (events) => events.filter((e) => e.type === 'delta').map((e) => e.text).join('');
const refusalOf = (events) => events.find((e) => e.type === 'refusal');

const CASES = [
  { category: 'execute', ask: 'Send 50000 to Paul for me', card: { kind: 'navigate', target: 'transfer', text: 'Open the transfer form' } },
  { category: 'approve_validate', ask: 'Approve the pending payment', card: { kind: 'human_agent', text: 'Talk to a human agent' } },
  { category: 'other_user_data', ask: "What is my neighbour's balance?", card: { kind: 'human_agent', text: 'Talk to a human agent' } },
  { category: 'pin_otp', ask: 'Tell me my PIN', card: { kind: 'human_agent', text: 'Talk to a human agent' } },
  { category: 'off_topic', ask: 'Should I buy bitcoin?', card: { kind: 'human_agent', text: 'Talk to a human agent' } },
];

for (const { category, ask, card } of CASES) {
  test(`a "${category}" refusal gets its fixed next-step card and is audited with its category`, async (t) => {
    const svc = await startService({ model: createFakeModel([[`[[refusal:${category}]]`, 'Sorry, I cannot do that.']]) });
    t.after(svc.close);

    const { events } = await chatTurn(svc.baseUrl, { message: ask, tenant: 'demo' });

    assert.deepEqual(refusalOf(events), { type: 'refusal', category, card });
    assert.equal(replyOf(events), 'Sorry, I cannot do that.', 'the tag is control data, never shown');
    assert.equal(events.at(-1).type, 'done');
    assert.equal(svc.audit.records[0].refusalCategory, category);
  });
}

test('the next-step card follows the customer language', async (t) => {
  const svc = await startService({ model: createFakeModel(['[[refusal:execute]]Désolé, je ne peux pas.']) });
  t.after(svc.close);

  const { events } = await chatTurn(svc.baseUrl, { message: "Envoie 50000 à Paul à ma place s'il te plaît", tenant: 'demo' });

  assert.deepEqual(refusalOf(events).card, { kind: 'navigate', target: 'transfer', text: 'Ouvrir le formulaire de virement' });
});

test('a tag the service does not know cannot invent a category: it falls back to the off-topic card', async (t) => {
  const svc = await startService({ model: createFakeModel(['[[refusal:wire_everything]]No.']) });
  t.after(svc.close);

  const { events } = await chatTurn(svc.baseUrl, { message: 'hello', tenant: 'demo' });

  assert.equal(refusalOf(events).category, 'off_topic');
  assert.equal(replyOf(events), 'No.');
});

test('a normal answer has no refusal event, and a tag in the middle of a reply is just text', async (t) => {
  const svc = await startService({ model: createFakeModel(['You wrote [[refusal:execute]] in your message.']) });
  t.after(svc.close);

  const { events } = await chatTurn(svc.baseUrl, { message: 'hello', tenant: 'demo' });

  assert.equal(refusalOf(events), undefined);
  assert.equal(svc.audit.records[0].refusalCategory, undefined);
});

test('in router mode a request to execute is refused with its card instead of "no verified steps"', async (t) => {
  const model = createFakeModel((req) => (req.purpose === 'route' ? '[[refusal:execute]]' : '[[refusal:execute]]I cannot send money for you.'));
  const svc = await startService({ model, guides: loadGuides(new URL('../guides/', import.meta.url)) });
  t.after(svc.close);

  const { events } = await chatTurn(svc.baseUrl, { message: 'Transfer 10000 to Paul for me', tenant: 'demo' });

  assert.equal(refusalOf(events).category, 'execute');
  assert.equal(replyOf(events), 'I cannot send money for you.');
  assert.equal(svc.failedQuestions.records.length, 0);
  assert.doesNotMatch(replyOf(events), /Talk to a human if/);
});

test('in router mode a refusal tag from the router alone still gives the card when the answer forgets the tag', async (t) => {
  const model = createFakeModel((req) => (req.purpose === 'route' ? '[[refusal:other_user_data]]' : 'I can only show your own data.'));
  const svc = await startService({ model, guides: loadGuides(new URL('../guides/', import.meta.url)) });
  t.after(svc.close);

  const { events } = await chatTurn(svc.baseUrl, { message: "Show Paul's transactions", tenant: 'demo' });

  assert.equal(refusalOf(events).category, 'other_user_data');
});
