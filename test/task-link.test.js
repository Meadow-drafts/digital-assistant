import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alice, begin, say, start } from './harness/t1-helpers.js';
import { createFakeModel } from './harness/fake-model.js';

const cardsOf = (events) => events.filter((e) => e.type === 'action_card');
const replyOf = (events) => events.filter((e) => e.type === 'delta').map((e) => e.text).join('');
const indexOf = (events, type) => events.findIndex((e) => e.type === type);

// The router picks `picks` (or says `route`), the answer model says `answer`.
async function ask(t, { message, route, answer, gating, calls }) {
  const a = alice();
  const model = createFakeModel((req) => {
    if (req.purpose === 'route') { calls?.push(req); return typeof route === 'function' ? route(req, calls?.length ?? 0) : route; }
    return answer;
  });
  const svc = await start({ customers: [a], model });
  t.after(svc.close);
  const id = await begin(svc, a, gating ? { gating } : undefined);
  return { a, svc, model, ...(await say(svc, a, message, id)) };
}

test('a task question gets the "Click here" link first and the guide steps below it, even when the model forgot the tag', async (t) => {
  const { events, svc } = await ask(t, { message: 'I want to send some money', route: '["transfer-single"]', answer: 'Open Transfers, choose Single Transfer, then follow the steps.' });

  const [card, ...more] = cardsOf(events);
  assert.equal(more.length, 0);
  assert.deepEqual([card.kind, card.target, card.path, card.button], ['navigate', 'transfer', '/transfer', 'Click here to send money']);
  assert.ok(indexOf(events, 'action_card') < indexOf(events, 'delta'), 'the link comes before the steps');
  assert.match(replyOf(events), /Single Transfer/);
  assert.deepEqual(svc.audit.records.at(-1).navigate, { outcome: 'offered', proposal: 'transfer', source: 'guide' });
});

test('each task guide links its own page, in the language of the question', async (t) => {
  for (const [guide, target, en, fr] of [
    ['bill-payment', 'bill_payment', 'Click here to pay a bill', 'Cliquez ici pour payer une facture'],
    ['airtime', 'airtime', 'Click here to buy airtime', 'Cliquez ici pour acheter du crédit'],
    ['request-to-pay', 'request_to_pay', 'Click here to request a payment', 'Cliquez ici pour demander un paiement'],
  ]) {
    const english = await ask(t, { message: 'help me with this', route: JSON.stringify([guide]), answer: 'Steps.' });
    assert.deepEqual(cardsOf(english.events).map((c) => [c.target, c.button]), [[target, en]], guide);
    const french = await ask(t, { message: "j'ai besoin d'aide, merci beaucoup", route: JSON.stringify([guide]), answer: 'Étapes.' });
    assert.deepEqual(cardsOf(french.events).map((c) => [c.target, c.button]), [[target, fr]], guide);
  }
});

test('no link when the guide has no page of its own, or the customer may not open it', async (t) => {
  const noPage = await ask(t, { message: 'my transfer failed', route: '["failed-transfer"]', answer: 'See the message table.' });
  assert.deepEqual(cardsOf(noPage.events), []);

  // A merchant has no Transfer page in the portal: the assistant must not link it.
  const merchant = await ask(t, { message: 'I want to send money', route: '["transfer-single"]', answer: 'Steps.', gating: { usePackages: false, audience: 'merchant' } });
  assert.deepEqual(cardsOf(merchant.events), []);
});

test('"send money" refused as execute by the answer model is over-refusal: the customer gets the steps and the link, and it is audited', async (t) => {
  const { events, svc } = await ask(t, { message: 'Send 5000 to 237677000555', route: '["transfer-single"]', answer: '[[refusal:execute]]I cannot execute transactions.' });

  assert.ok(!events.some((e) => e.type === 'refusal'));
  assert.deepEqual(cardsOf(events).map((c) => c.target), ['transfer']);
  assert.doesNotMatch(replyOf(events), /cannot execute/);
  assert.match(replyOf(events), /\S/);
  assert.equal(svc.audit.records.at(-1).navigate.overrodeRefusal, 'execute');
});

test('a legacy pre-fill proposal is discarded: valued requests get guide steps and navigation only', async (t) => {
  const { events, svc } = await ask(t, {
    message: 'Send 5000 to 237677000555', route: '["transfer-single"]',
    answer: '[[prefill:single_transfer {"destination":"237677000555","amount":5000}]]I filled the form with 5000 for 237677000555.',
  });

  assert.deepEqual(cardsOf(events).map((card) => [card.kind, card.target, card.path]), [['navigate', 'transfer', '/transfer']]);
  assert.match(replyOf(events), /Single Transfer/);
  assert.doesNotMatch(replyOf(events), /filled the form|5000|237677000555/i);
  assert.equal(svc.audit.records.at(-1).prefill, undefined);
});

test('asking the assistant itself to complete or approve something is still refused, with no link', async (t) => {
  for (const message of ['Please confirm my transfer of 5000', 'approve it for me', 'send 5000 to 237677000555 and validate it']) {
    const { events } = await ask(t, { message, route: '["transfer-single"]', answer: '[[refusal:execute]]I cannot do that.' });
    assert.equal(events.find((e) => e.type === 'refusal')?.category, 'execute', message);
    assert.deepEqual(cardsOf(events), [], message);
  }
});

test('a router that refuses a task as execute is asked once more with a reminder, and its second answer is used', async (t) => {
  const calls = [];
  const { events } = await ask(t, {
    message: 'I want to pay my electricity bill', calls, answer: 'Open Bill payment and follow the steps.',
    route: (req, n) => (n === 1 ? '[[refusal:execute]]' : '["bill-payment"]'),
  });

  assert.equal(calls.length, 2);
  assert.match(calls[1].messages[0].content, /not a request to execute/);
  assert.ok(!events.some((e) => e.type === 'refusal'));
  assert.deepEqual(cardsOf(events).map((c) => c.target), ['bill_payment']);
});

test('the router is not asked again when the customer asked the assistant to complete it', async (t) => {
  const calls = [];
  const { events } = await ask(t, { message: 'do it for me: send 5000', calls, route: '[[refusal:execute]]', answer: 'I cannot.' });

  assert.equal(calls.length, 1);
  assert.equal(events.find((e) => e.type === 'refusal')?.category, 'execute');
});

test('a model that tags Overview for a bill question does not get an Overview link: the guide\'s own page wins', async (t) => {
  const { events, svc } = await ask(t, { message: 'pay my electricity bill', route: '["bill-payment"]', answer: '[[navigate:overview]]Open Payments, then Bill payment.' });

  assert.deepEqual(cardsOf(events).map((c) => c.target), ['bill_payment']);
  assert.deepEqual(svc.audit.records.at(-1).navigate, { outcome: 'offered', proposal: 'bill_payment', source: 'guide', replaced: 'overview' });
});

test('Overview is only linked when the customer asked for it, and a "take me to" request keeps the page the model named', async (t) => {
  const none = await ask(t, { message: 'how do I log in', route: '["login-access"]', answer: '[[navigate:overview]]Open the login page.' });
  assert.deepEqual(cardsOf(none.events), []);

  const asked = await ask(t, { message: 'show me my dashboard please', route: '["dashboard"]', answer: '[[navigate:overview]]Here is your overview.' });
  assert.deepEqual(cardsOf(asked.events).map((c) => c.target), ['overview']);

  // The guide for history is about account history, but the customer asked for "transaction history": the model's page stands.
  const go = await ask(t, { message: 'please take me to transaction history', route: '["history-statement"]', answer: '[[navigate:history]]Open History.' });
  assert.deepEqual(cardsOf(go.events).map((c) => c.target), ['history']);
});

test('with no account session the package is unknown: no task link (fail closed), and the audit says why', async (t) => {
  const a = alice();
  const model = createFakeModel((req) => (req.purpose === 'route' ? '["airtime"]' : 'Open Airtime.'));
  const svc = await start({ customers: [a], model });
  t.after(svc.close);

  const { events } = await say(svc, a, 'buy airtime', undefined); // no session was started for this conversation

  assert.deepEqual(cardsOf(events), []);
  assert.deepEqual(svc.audit.records.at(-1).navigate, { outcome: 'none', proposal: 'airtime', source: 'guide', reason: 'not_in_package' });
});
