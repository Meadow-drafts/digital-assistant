import { test } from 'node:test';
import assert from 'node:assert/strict';
import { row } from './harness/bank-fixtures.js';
import { alice, begin, say, start, toolModel } from './harness/t1-helpers.js';
import { openWidget } from './harness/open-widget.js';

const textOf = (events) => events.filter((event) => event.type === 'delta').map((event) => event.text).join('');

test('a recipient-not-received complaint asks one timing question, then guides to History without looking up a transfer', async (t) => {
  const customer = alice();
  const model = toolModel('[]', 'unused');
  const service = await start({ customers: [customer], model });
  t.after(service.close);
  const conversationId = await begin(service, customer);

  const first = await say(service, customer, "I sent money, but my sister hasn't received it.", conversationId);
  assert.match(textOf(first.events), /sorry|understand/i);
  assert.match(textOf(first.events), /when did you send/i);
  assert.equal(service.gateway.calls.some((call) => call.path === '/digitalbank/history/bipay-recent'), false);

  const second = await say(service, customer, 'This morning, I paid for it.', conversationId);
  assert.match(textOf(second.events), /History/i);
  assert.match(textOf(second.events), /transaction reference/i);
  assert.equal(second.events.some((event) => event.type === 'action_card' && event.path === '/history'), true);
  assert.equal(service.gateway.calls.some((call) => call.path === '/digitalbank/history/bipay-recent'), false);
  assert.ok(model.calls.every((call) => call.purpose !== 'answer'));
});

test('the assistant checks a customer-provided reference against only that wallet and does not equate completion with recipient credit', async (t) => {
  const customer = alice();
  customer.rows = [row(customer, { sta: '01' })];
  const model = toolModel('[]', 'unused');
  const service = await start({ customers: [customer], model });
  t.after(service.close);
  const conversationId = await begin(service, customer, { gating: { usePackages: true, pack: { natureCodes: ['HIST'] } } });

  await say(service, customer, "I sent money, but my sister hasn't received it.", conversationId);
  const prompt = await say(service, customer, 'About an hour ago.', conversationId);
  assert.match(textOf(prompt.events), /transaction reference/i);
  assert.equal(service.gateway.calls.filter((call) => call.path === '/digitalbank/history/bipay-recent').length, 0);

  const checked = await say(service, customer, 'The reference is REF-0001', conversationId);
  assert.match(textOf(checked.events), /bank's record reports transfer.*completed/i);
  assert.match(textOf(checked.events), /does not confirm.*recipient's account was credited/i);
  assert.match(textOf(checked.events), /Ask the recipient to check their account/i);
  assert.equal(checked.events.find((event) => event.type === 'tool').result.found, true);
  assert.equal(service.gateway.calls.filter((call) => call.path === '/digitalbank/history/bipay-recent').length, 1);
  assert.equal(service.gateway.calls.some((call) => call.path === '/digitalbank/history/transactions'), false);
  assert.deepEqual(checked.events.find((event) => event.type === 'quick_replies').options, [
    'Where do I find the reference?', 'Check another transfer', 'Talk to an agent',
  ]);
});

test('a mixed-language continuation uses the latest language and lets the customer correct one reference', async (t) => {
  const customer = alice();
  customer.rows = [row(customer, { clientReferenceId: 'REF-GOOD', sta: '1000' })];
  const service = await start({ customers: [customer], model: toolModel('[]', 'unused') });
  t.after(service.close);
  const conversationId = await begin(service, customer, { gating: { usePackages: true, pack: { natureCodes: ['HIST'] } } });

  const first = await say(service, customer, "J'ai envoyé l'argent, mais ma sœur ne l'a pas reçu.", conversationId);
  assert.match(textOf(first.events), /Quand avez-vous envoyé/i);
  const second = await say(service, customer, 'This morning.', conversationId);
  assert.match(textOf(second.events), /Open History/i);
  assert.equal(second.events.at(-1).language, 'en');

  const firstReference = await say(service, customer, 'REF-WRONG', conversationId);
  assert.match(textOf(firstReference.events), /cannot find a transfer/i);
  assert.equal(firstReference.events.find((event) => event.type === 'next_step').kind, 'history');
  const corrected = await say(service, customer, 'REF-GOOD', conversationId);
  assert.match(textOf(corrected.events), /still pending/i);
  assert.equal(corrected.events.find((event) => event.type === 'tool').result.found, true);
  assert.equal(service.gateway.calls.filter((call) => call.path === '/digitalbank/history/bipay-recent').length, 2);
  assert.ok(service.gateway.calls.filter((call) => call.path === '/digitalbank/history/bipay-recent').every((call) => call.body.codewaldo === customer.sub));
});

test('after one corrected reference is still not found, the next step is the existing human path', async (t) => {
  const customer = alice();
  const service = await start({ customers: [customer], model: toolModel('[]', 'unused') });
  t.after(service.close);
  const conversationId = await begin(service, customer, { gating: { usePackages: true, pack: { natureCodes: ['HIST'] } } });
  await say(service, customer, 'I sent money but the recipient has not received it.', conversationId);
  await say(service, customer, 'Today.', conversationId);
  await say(service, customer, 'REF-WRONG', conversationId);
  const corrected = await say(service, customer, 'REF-ALSO-WRONG', conversationId);
  assert.match(textOf(corrected.events), /cannot find a transfer/i);
  assert.equal(corrected.events.find((event) => event.type === 'next_step').kind, 'human');
  assert.equal(corrected.events.find((event) => event.type === 'chip').prominent, true);
});

test('guided reference checks fail closed without History entitlement and offer a human without making the lookup', async (t) => {
  const customer = alice();
  const service = await start({ customers: [customer], model: toolModel('[]', 'unused') });
  t.after(service.close);
  const conversationId = await begin(service, customer, { gating: { usePackages: true, pack: { natureCodes: ['TRINW'] } } });
  await say(service, customer, 'I sent money, but my sister has not received it.', conversationId);
  await say(service, customer, 'Today.', conversationId);
  const result = await say(service, customer, 'REF-0001', conversationId);
  assert.match(textOf(result.events), /needs History access/i);
  assert.equal(service.gateway.calls.some((call) => call.path === '/digitalbank/history/bipay-recent'), false);
  assert.deepEqual(result.events.find((event) => event.type === 'chip').reasons, ['tool_not_in_package', 'contact_bank']);
});

test('an unavailable own-wallet lookup makes no status claim and offers the existing agent path', async (t) => {
  const customer = alice();
  const service = await start({ customers: [customer], model: toolModel('[]', 'unused') });
  t.after(service.close);
  const conversationId = await begin(service, customer, { gating: { usePackages: true, pack: { natureCodes: ['HIST'] } } });
  await say(service, customer, 'I sent money, but my sister has not received it.', conversationId);
  await say(service, customer, 'Today.', conversationId);
  service.gateway.throwNext(Object.assign(new Error('fake timeout'), { name: 'TimeoutError' }));
  const result = await say(service, customer, 'REF-0001', conversationId);
  assert.match(textOf(result.events), /cannot reach your bank data right now/i);
  assert.match(textOf(result.events), /talk to a human agent/i);
  assert.doesNotMatch(textOf(result.events), /pending|completed|failed/i);
  assert.equal(result.events.find((event) => event.type === 'next_step').kind, 'human');
  assert.deepEqual(result.events.find((event) => event.type === 'quick_replies').options, [
    'Where do I find the reference?', 'Check another transfer', 'Talk to an agent',
  ]);
});

test('a French guided reference check reports only the returned status and its safe next step', async (t) => {
  const customer = alice();
  customer.rows = [row(customer, { clientReferenceId: 'REF-FR', sta: '1000' })];
  const service = await start({ customers: [customer], model: toolModel('[]', 'unused') });
  t.after(service.close);
  const conversationId = await begin(service, customer, { gating: { usePackages: true, pack: { natureCodes: ['HIST'] } } });

  await say(service, customer, "J'ai envoyé l'argent, mais le destinataire ne l'a pas reçu.", conversationId);
  await say(service, customer, 'Ce matin.', conversationId);
  const result = await say(service, customer, 'La référence est REF-FR', conversationId);
  assert.match(textOf(result.events), /encore en attente/i);
  assert.match(textOf(result.events), /Ne réessayez pas/i);
  assert.equal(result.events.find((event) => event.type === 'next_step').kind, 'history');
  assert.deepEqual(result.events.find((event) => event.type === 'quick_replies').options, [
    'Où trouver la référence ?', 'Vérifier un autre transfert', 'Parler à un agent',
  ]);
  assert.equal(service.gateway.calls.filter((call) => call.path === '/digitalbank/history/bipay-recent').length, 1);
});

test('customer-selected reference help makes no lookup or case change; selecting an agent reply uses the existing handoff', async (t) => {
  const customer = alice();
  const model = toolModel('[]', 'unused');
  const service = await start({ customers: [customer], model });
  t.after(service.close);
  const widget = await openWidget(service.baseUrl);
  t.after(() => widget.dom.window.close());
  const element = widget.document.querySelector('bank-assistant');
  element.setAttribute('token', customer.token);
  element.setAttribute('cli', customer.cli);
  element.setAttribute('tenant', 'demo');
  element.setAttribute('gating', JSON.stringify({ usePackages: false }));

  await widget.send("I sent money, but my sister hasn't received it.");
  await widget.until(() => widget.q('thinking').hidden && /When did you send/.test(widget.qa('message').at(-1)?.textContent ?? ''));
  await widget.send('This morning.');
  await widget.until(() => widget.q('thinking').hidden && widget.qa('quick-reply').length === 3);
  widget.qa('quick-reply').at(-3).click();
  await widget.until(() => widget.q('thinking').hidden && widget.qa('message').some((message) => message.dataset.from === 'user' && message.textContent === 'Where do I find the reference?'));

  assert.equal(service.gateway.calls.some((call) => call.path === '/digitalbank/history/bipay-recent'), false);
  assert.equal(service.mailer.outbox.length, 0);
  assert.equal(widget.q('case-banner').hidden, true);

  widget.qa('quick-reply').at(-1).click();
  await widget.until(() => widget.q('case-banner').hidden === false);
  assert.ok(service.mailer.outbox.length > 0);
});
