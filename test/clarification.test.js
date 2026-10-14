import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alice, begin, say, start } from './harness/t1-helpers.js';
import { createFakeModel } from './harness/fake-model.js';
import { openWidget } from './harness/open-widget.js';
import { loadGuides } from '../src/guides.js';

const event = (events, type) => events.find((item) => item.type === type);

test('a materially ambiguous request asks one localized question without answering, navigating, or reading data', async (t) => {
  const customer = alice();
  const model = createFakeModel((request) => request.purpose === 'route'
    ? '{"clarify":["transfer-single","transfer-remittance"]}'
    : 'Here are the steps.');
  const svc = await start({ customers: [customer], model });
  t.after(svc.close);
  const conversationId = await begin(svc, customer);

  const { events } = await say(svc, customer, 'I need help with my card', conversationId);

  const clarification = event(events, 'clarification');
  assert.deepEqual(clarification, {
    type: 'clarification',
    question: 'What would you like help with?',
    options: ['Send a single transfer', 'Send an outgoing remittance (money to someone who may not have an account)'],
  });
  assert.equal(event(events, 'delta'), undefined);
  assert.equal(event(events, 'action_card'), undefined);
  assert.equal(event(events, 'tool'), undefined);
  assert.equal(model.calls.filter((call) => call.purpose === 'answer').length, 0);
  assert.ok(svc.gateway.calls.every((call) => !/getSolde|history|transfer|plafond|fee/i.test(call.path)));
  assert.doesNotMatch(JSON.stringify(clarification), /transfer-single|transfer-remittance/);
});

test('choosing an offered guide continues with that guide and keeps the original request context', async (t) => {
  const customer = alice();
  const model = createFakeModel((request) => {
    if (request.purpose === 'route') return '{"clarify":["transfer-single","transfer-remittance"]}';
    return 'Open Transfers and follow the steps for that transfer.';
  });
  const svc = await start({ customers: [customer], model });
  t.after(svc.close);
  const conversationId = await begin(svc, customer);
  const first = await say(svc, customer, 'I need help sending money', conversationId);
  const choice = event(first.events, 'clarification').options[1];

  const next = await say(svc, customer, choice, conversationId);

  assert.equal(event(next.events, 'clarification'), undefined);
  assert.equal(event(next.events, 'guides').guides[0].id, 'transfer-remittance');
  assert.match(event(next.events, 'delta').text, /steps/);
  assert.equal(model.calls.filter((call) => call.purpose === 'route').length, 1, 'an offered choice resolves without re-routing');
  const answer = model.calls.find((call) => call.purpose === 'answer');
  assert.ok(answer.messages.some((message) => message.role === 'user' && message.content.includes('I need help sending money')));
});

test('free-text clarification routes with the pending context and continues on a matching verified guide', async (t) => {
  const customer = alice();
  let routes = 0;
  const model = createFakeModel((request) => {
    if (request.purpose === 'route') return ++routes === 1
      ? '{"clarify":["transfer-single","transfer-remittance"]}'
      : '["transfer-remittance"]';
    return 'Use the outgoing remittance steps.';
  });
  const svc = await start({ customers: [customer], model });
  t.after(svc.close);
  const conversationId = await begin(svc, customer);
  await say(svc, customer, 'I need help sending money', conversationId);

  const next = await say(svc, customer, 'I am sending money to someone abroad', conversationId);

  assert.equal(event(next.events, 'clarification'), undefined);
  assert.equal(event(next.events, 'guides').guides[0].id, 'transfer-remittance');
  assert.ok(model.calls.find((call) => call.purpose === 'route' && call.messages.some((m) => m.role === 'assistant' && m.content.includes('What would you like help with?'))));
});

test('one unresolved follow-up falls back to safe fixed guidance without another loop or side effect', async (t) => {
  const customer = alice();
  const model = createFakeModel((request) => request.purpose === 'route'
    ? '{"clarify":["transfer-single","transfer-remittance"]}'
    : 'This must not be used.');
  const svc = await start({ customers: [customer], model });
  t.after(svc.close);
  const conversationId = await begin(svc, customer);
  const first = await say(svc, customer, 'I need help sending money', conversationId);
  const second = await say(svc, customer, 'I am not sure', conversationId);

  assert.equal(first.events.filter((item) => item.type === 'clarification').length, 1);
  assert.equal(second.events.filter((item) => item.type === 'clarification').length, 0);
  assert.match(second.events.filter((item) => item.type === 'delta').map((item) => item.text).join(''), /no verified steps/i);
  assert.equal(event(second.events, 'action_card'), undefined);
  assert.equal(model.calls.filter((call) => call.purpose === 'answer').length, 0);
  assert.ok(svc.gateway.calls.every((call) => !/getSolde|history|transfer|plafond|fee/i.test(call.path)));
});

test('one unresolved follow-up gives only an exact step shared by every eligible guide when one exists', async (t) => {
  const customer = alice();
  const model = createFakeModel((request) => request.purpose === 'route'
    ? '{"clarify":["shared-a","shared-b"]}'
    : 'This must not be used.');
  const svc = await start({ customers: [customer], model, guides: loadGuides(new URL('./fixtures/clarification-guides/', import.meta.url)) });
  t.after(svc.close);
  const conversationId = await begin(svc, customer);
  await say(svc, customer, 'I need help with this task', conversationId);

  const { events } = await say(svc, customer, 'I am not sure', conversationId);
  const reply = events.filter((item) => item.type === 'delta').map((item) => item.text).join('');

  assert.match(reply, /Open Transfers/);
  assert.doesNotMatch(reply, /Enter the destination details|no verified steps/i);
  assert.equal(event(events, 'clarification'), undefined);
  assert.equal(event(events, 'action_card'), undefined);
  assert.equal(model.calls.filter((call) => call.purpose === 'answer').length, 0);
});

test('an ambiguous account question does not run a T1 read selected by the normal intent rules', async (t) => {
  const customer = alice();
  const model = createFakeModel((request) => request.purpose === 'route'
    ? '{"clarify":["account-info","history-statement"]}'
    : 'This must not be used.');
  const svc = await start({ customers: [customer], model });
  t.after(svc.close);
  const conversationId = await begin(svc, customer);

  const { events } = await say(svc, customer, 'I need my balance or recent transactions', conversationId);

  assert.equal(event(events, 'clarification')?.options.length, 2);
  assert.equal(event(events, 'tool'), undefined);
  assert.ok(svc.gateway.calls.every((call) => !/getSolde|history\/bipay-recent/i.test(call.path)));
});

test('an unavailable interpretation is never offered or silently answered', async (t) => {
  const customer = alice();
  const model = createFakeModel((request) => request.purpose === 'route'
    ? '{"clarify":["transfer-single","transfer-remittance"]}'
    : 'This must not be used.');
  const svc = await start({ customers: [customer], model });
  t.after(svc.close);
  const conversationId = await begin(svc, customer, {
    gating: { usePackages: true, pack: { natureCodes: ['TRINC'] }, audience: 'individual' },
  });

  const { events } = await say(svc, customer, 'I need help sending money', conversationId);

  assert.equal(event(events, 'clarification'), undefined);
  assert.deepEqual(event(events, 'guides').guides, []);
  assert.match(events.filter((item) => item.type === 'delta').map((item) => item.text).join(''), /no verified steps/i);
  assert.equal(model.calls.filter((call) => call.purpose === 'answer').length, 0);
});

test('the clarification question and offered guide titles follow the customer’s language', async (t) => {
  const customer = alice();
  const model = createFakeModel((request) => request.purpose === 'route'
    ? '{"clarify":["transfer-single","transfer-remittance"]}'
    : 'Étapes.');
  const svc = await start({ customers: [customer], model });
  t.after(svc.close);
  const conversationId = await begin(svc, customer);

  const { events } = await say(svc, customer, "J'ai besoin d'aide pour envoyer de l'argent", conversationId);
  const clarification = event(events, 'clarification');

  assert.equal(event(events, 'done').language, 'fr');
  assert.equal(clarification.question, 'Vous cherchez des informations sur quel sujet ?');
  assert.deepEqual(clarification.options, ['Effectuer un transfert unique', 'Effectuer un envoi sortant (remittance)']);
});

test('a clear request continues directly without an unnecessary clarification', async (t) => {
  const customer = alice();
  const model = createFakeModel((request) => request.purpose === 'route' ? '["transfer-single"]' : 'Open Single Transfer.');
  const svc = await start({ customers: [customer], model });
  t.after(svc.close);
  const conversationId = await begin(svc, customer);

  const { events } = await say(svc, customer, 'How do I send money to another account?', conversationId);

  assert.equal(event(events, 'clarification'), undefined);
  assert.equal(event(events, 'guides').guides[0].id, 'transfer-single');
  assert.equal(model.calls.filter((call) => call.purpose === 'answer').length, 1);
});

test('the widget presents plain-language choices and sends the selected choice back to the service', async (t) => {
  const customer = alice();
  const model = createFakeModel((request) => request.purpose === 'route'
    ? '{"clarify":["transfer-single","transfer-remittance"]}'
    : 'Follow the outgoing remittance guide.');
  const svc = await start({ customers: [customer], model });
  t.after(svc.close);
  const widget = await openWidget(svc.baseUrl, '/', { clock: svc.clock });
  t.after(() => widget.dom.window.close());
  const element = widget.document.querySelector('bank-assistant');
  element.setAttribute('token', customer.token);
  element.setAttribute('cli', customer.cli);
  element.setAttribute('tenant', 'demo');

  await widget.send('I need help sending money');
  await widget.until(() => widget.qa('clarification-option').length === 2);
  assert.deepEqual(widget.qa('clarification-option').map((button) => button.textContent), [
    'Send a single transfer',
    'Send an outgoing remittance (money to someone who may not have an account)',
  ]);
  assert.doesNotMatch(widget.q('messages').textContent, /transfer-single|transfer-remittance/);

  widget.qa('clarification-option')[1].dispatchEvent(new widget.dom.window.Event('click', { bubbles: true }));
  await widget.until(() => widget.q('guides-used')?.textContent.includes('outgoing remittance'));

  assert.equal(widget.net.requests.length, 2);
  assert.equal(widget.net.requests[1].message, 'Send an outgoing remittance (money to someone who may not have an account)');
});
