import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRig } from '../eval/rig.js';
import { createFakeModel } from './harness/fake-model.js';

const howTo = (guide, answer) => createFakeModel((r) => (r.purpose === 'route' ? JSON.stringify([guide]) : answer));
const item = (over) => ({ id: 'X', prompts: { en: 'How do I send money to another person?', fr: "Comment envoyer de l'argent ?" }, lines: [], ...over });
async function rig(t, model) {
  const r = await createRig({ model });
  t.after(r.close);
  return r;
}

test('a how-to goes through the real service: router call, guide chosen, answer, link card, closing line', async (t) => {
  const model = howTo('transfer-single', 'Open Transfers, then Single Transfer.');
  const r = await rig(t, model);
  const turn = await r.run(item(), 'en');
  assert.deepEqual(model.calls.map((c) => c.purpose), ['route', 'answer']);
  assert.match(turn.text, /Single Transfer/);
  assert.deepEqual(turn.guides, ['transfer-single']);
  assert.equal(turn.cards[0].path, '/transfer');
  assert.equal(turn.error, false);
  assert.equal(turn.refusal, null);
  assert.ok(turn.ms >= 0);
});

test('the model input is recorded, and a PIN typed in chat is not in it', async (t) => {
  const r = await rig(t, createFakeModel(['ok']));
  const turn = await r.run(item({ prompts: { en: 'my pin is 4821', fr: 'mon code pin est 4821' } }), 'en');
  assert.doesNotMatch(turn.modelInput, /4821/);
  assert.match(turn.modelInput, /REDACTED/);
  assert.deepEqual(turn.warnings, ['secret_input']);
});

test('sessions: none says sign in again; locked asks for the PIN box; unlocked reads the balance', async (t) => {
  const r = await rig(t, createFakeModel((req) => (req.purpose === 'route' ? '[]' : 'Your balance is shown above.')));
  const ask = { prompts: { en: 'what is my balance', fr: 'quel est mon solde' } };
  const none = await r.run(item({ ...ask, session: 'none' }), 'en');
  assert.equal(none.toolBlocked, 'session_expired');
  const locked = await r.run(item({ ...ask }), 'en');
  assert.equal(locked.toolBlocked, 'pin_required');
  const open = await r.run(item({ ...ask, session: 'unlocked' }), 'en');
  assert.equal(open.tool, 'balance');
  assert.equal(open.toolBlocked, null);
});

test('transfer fixtures: a failed transfer and a debit with no credit can be explained by reference', async (t) => {
  const model = createFakeModel((req) => (req.purpose === 'route' ? '[[tool:explain_failure {"reference":"REF-FAIL1"}]]' : '[[next:retry]]The balance was too low.'));
  const r = await rig(t, model);
  const turn = await r.run(item({ prompts: { en: 'Why did my transfer REF-FAIL1 fail?', fr: 'Pourquoi mon virement REF-FAIL1 a échoué ?' } }), 'en');
  assert.equal(turn.tool, 'explain_failure');
  assert.deepEqual(turn.nextSteps, ['retry']);
  assert.deepEqual(turn.guides, ['failed-transfer']);
});

test('a secondary connect is not offered account history', async (t) => {
  const model = createFakeModel((req) => (req.purpose === 'route' ? '["history-statement"]' : '[[navigate:account_history]]Open Account History.'));
  const r = await rig(t, model);
  const turn = await r.run(item({ session: 'secondary', prompts: { en: 'I need my statement', fr: 'Il me faut mon relevé' } }), 'en');
  assert.ok(!turn.cards.some((c) => c.path === '/history/account'));
});

test('repeat sends the same prompt twice and scores the second turn', async (t) => {
  const r = await rig(t, createFakeModel((req) => (req.purpose === 'route' ? '["transfer-single"]' : 'Open Transfers.')));
  const turn = await r.run(item({ repeat: true }), 'en');
  assert.ok(turn.chip.reasons.includes('repeated_question'));
});

test('a model that fails is an error turn, not a failed one', async (t) => {
  const r = await rig(t, createFakeModel([new Error('provider returned 413')]));
  const turn = await r.run(item(), 'en');
  assert.equal(turn.error, true);
});

test('many items in a row never hit the service rate limits', async (t) => {
  const r = await rig(t, howTo('transfer-single', 'Open Transfers.'));
  for (let i = 0; i < 14; i++) assert.equal((await r.run(item(), 'en')).busy, false);
});
