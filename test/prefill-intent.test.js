import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prefillIntent } from '../src/prefill-intent.js';
import { alice, begin, say, start } from './harness/t1-helpers.js';
import { createFakeModel } from './harness/fake-model.js';

const NUMBER = '237677000555';
const cards = (events) => events.filter((e) => e.type === 'action_card');

test('"send N to <number>" in English and French becomes a single-transfer proposal', () => {
  for (const q of [`Send 5000 to ${NUMBER}`, `send 5000 XAF to ${NUMBER}.`, `Please send 5 000 to 237 677 000 555`, `Envoie 5000 au ${NUMBER}`, `Envoyer 5000 FCFA à ${NUMBER}`, `Vire 12.500 vers ${NUMBER}`]) {
    const p = prefillIntent(q);
    assert.equal(p?.form, 'single_transfer', q);
    assert.equal(JSON.parse(p.raw).destination, NUMBER, q);
  }
  assert.equal(JSON.parse(prefillIntent(`Vire 12.500 vers ${NUMBER}`).raw).amount, 12500);
  assert.equal(prefillIntent(`send  5000   to ${NUMBER}`)?.form, 'single_transfer', 'extra spaces do not matter');
});

test('anything that asks the assistant to complete it, or is not this exact ask, is left to the model', () => {
  for (const q of [`Send 5000 to ${NUMBER} and confirm it`, `confirm my transfer of 5000 to ${NUMBER}`, `do it for me: send 5000 to ${NUMBER}`, `envoie 5000 au ${NUMBER} et valide`,
    'Send 5000 to my landlord', `how do I send 5000 to ${NUMBER} and what are the fees`, 'what is my balance', `send 0 to ${NUMBER}`, 'send 5000 to 12345']) {
    assert.equal(prefillIntent(q), null, q);
  }
});

for (const [name, route, answer] of [
  ['the router refuses it as execute', '[[refusal:execute]]', 'I cannot execute that.'],
  ['the router finds no guide', '[]', 'No steps.'],
  ['the router picks a guide but the answer refuses', '["transfer-single"]', '[[refusal:execute]]I cannot do that.'],
]) {
  test(`${name}: the customer still gets the pre-fill card, with fixed wording, and it is audited as rules-built`, async (t) => {
    const a = alice();
    const model = createFakeModel((req) => (req.purpose === 'route' ? route : answer));
    const svc = await start({ customers: [a], model });
    t.after(svc.close);

    const { events } = await say(svc, a, `Send 5000 to ${NUMBER}`, await begin(svc, a));

    const card = cards(events)[0];
    assert.equal(card.kind, 'prefill');
    assert.equal(card.fields.find((f) => f.field === 'destination').value, NUMBER);
    assert.ok(!events.some((e) => e.type === 'refusal'));
    assert.match(events.filter((e) => e.type === 'delta').map((e) => e.text).join(''), /submit it yourself/);
    const logged = svc.audit.records.at(-1).prefill;
    assert.equal(logged.source, 'rules');
    assert.ok(!JSON.stringify(svc.audit.records).includes(NUMBER), 'the full number is not in the audit');
  });
}

test('with no account session the clear ask gets one fixed message, no card, no refusal and no model guess', async (t) => {
  const model = createFakeModel((req) => (req.purpose === 'route' ? '["transfer-single"]' : 'Open the Overview page.'));
  const svc = await start({ customers: [alice()], model });
  t.after(svc.close);
  const { chatTurn } = await import('./harness/sse.js');

  const { events } = await chatTurn(svc.baseUrl, { message: `Send 5000 to ${NUMBER}`, tenant: 'demo' });

  assert.deepEqual(cards(events), []);
  assert.ok(!events.some((e) => e.type === 'refusal'));
  const text = events.filter((e) => e.type === 'delta').map((e) => e.text).join('');
  assert.match(text, /could not connect to your account/);
  assert.ok(!/Overview/.test(text));
});

test('a rules-built proposal is validated like any other: no session, no card', async (t) => {
  const svc = await start({ customers: [alice()], model: createFakeModel(['[]']) });
  t.after(svc.close);
  const { chatTurn } = await import('./harness/sse.js');

  const { events } = await chatTurn(svc.baseUrl, { message: `Send 5000 to ${NUMBER}`, tenant: 'demo' });

  assert.deepEqual(cards(events), []);
});
