import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alice, begin, start } from './harness/t1-helpers.js';
import { createFakeModel } from './harness/fake-model.js';
import { chatTurn } from './harness/sse.js';
import { openWidget } from './harness/open-widget.js';

const NOW = Date.parse('2026-10-14T10:00:00.000Z');
const validContext = (path) => ({ path, capturedAt: new Date(NOW).toISOString() });

async function ask(t, { message, pageContext }) {
  const customer = alice();
  const calls = [];
  const model = createFakeModel((request) => {
    calls.push(request);
    if (request.purpose === 'route') {
      const currentPage = request.messages[0].content;
      if (currentPage.includes('VERIFIED PAGE HINT')) return '["bill-payment"]';
      return '[]';
    }
    const guide = request.messages[0].content;
    if (guide.includes('1. Ouvrez **Payments**, puis **Bill payment**')) return 'Ouvrez **Payments**, puis **Bill payment**. Choisissez le **pays**, puis le **facturier**.';
    if (guide.includes('1. Open **Payments**, then **Bill payment**')) return 'Open **Payments**, then **Bill payment**. Choose the **country**, then the **biller**.';
    return 'I have no verified steps for that.';
  });
  const svc = await start({ customers: [customer], model, clock: { now: () => NOW, setTimeout, clearTimeout } });
  t.after(svc.close);
  const conversationId = await begin(svc, customer);
  const body = { message, conversationId, tenant: 'demo', ...(pageContext === undefined ? {} : { pageContext }) };
  const result = await chatTurn(svc.baseUrl, body, { token: customer.token });
  return { ...result, calls, svc };
}

test('fresh supported page context guides a contextual request in English and French with an eligible page link', async (t) => {
  for (const [message, language, button, title, step] of [
    ['What do I do on this page?', 'en', 'Click here to pay a bill', 'Pay a bill', 'Choose the **country**, then the **biller**.'],
    ['Que dois-je faire sur cette page ?', 'fr', 'Cliquez ici pour payer une facture', 'Payer une facture', 'Choisissez le **pays**, puis le **facturier**.'],
  ]) {
    const result = await ask(t, { message, pageContext: validContext('/payments/bill-payment') });
    const router = result.calls.find((call) => call.purpose === 'route');
    const answer = result.calls.find((call) => call.purpose === 'answer');
    const allModelText = result.calls.flatMap((call) => call.messages.map((item) => item.content)).join('\n');
    const reply = result.events.filter((event) => event.type === 'delta').map((event) => event.text).join('');
    assert.match(router.messages[0].content, /VERIFIED PAGE HINT/);
    assert.match(answer.messages[0].content, /VERIFIED PAGE HINT/);
    assert.match(answer.messages[0].content, language === 'fr' ? /Choisissez le \*\*pays\*\*, puis le \*\*facturier\*\*/ : /Choose the \*\*country\*\*, then the \*\*biller\*\*/);
    assert.match(reply, new RegExp(step.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.deepEqual(result.events.filter((event) => event.type === 'guides').at(-1).guides.map((guide) => guide.title), [title]);
    assert.equal(result.events.find((event) => event.type === 'action_card')?.button, button);
    assert.doesNotMatch(allModelText, /capturedAt|pageContext|accountNo/i);
    assert.equal(JSON.stringify(result.svc.audit.records.at(-1)).includes('/payments/bill-payment'), false);
  }
});

test('unsupported, stale, and malformed page context are ignored and cannot add page claims or links', async (t) => {
  const contexts = [
    { path: '/validations', capturedAt: new Date(NOW).toISOString() },
    { path: '/payments/bill-payment', capturedAt: new Date(NOW - 3 * 60_000).toISOString() },
    { ...validContext('/payments/bill-payment'), amount: 5000, pin: '1234', cardNumber: 'FORM_SECRET_SENTINEL' },
    { path: '/payments/bill-payment/12345', capturedAt: new Date(NOW).toISOString() },
    { path: '/payments/bill-payment?amount=5000', capturedAt: new Date(NOW).toISOString() },
    { surface: 'case-detail', capturedAt: new Date(NOW).toISOString() },
    { surface: 'my-cases', capturedAt: new Date(NOW).toISOString(), accountNo: 'FORM_SECRET_SENTINEL' },
    { surface: 'my-cases', capturedAt: new Date(NOW - 3 * 60_000).toISOString() },
  ];
  for (const pageContext of contexts) {
    const result = await ask(t, { message: 'What do I do on this page?', pageContext });
    assert.doesNotMatch(result.calls[0].messages[0].content, /VERIFIED PAGE HINT/);
    assert.deepEqual(result.events.filter((event) => event.type === 'guides').at(-1)?.guides ?? [], []);
    assert.equal(result.events.some((event) => event.type === 'action_card'), false);
    assert.doesNotMatch(result.events.filter((event) => event.type === 'delta').map((event) => event.text).join(''), /you are on|this is the transfer page|transfer page/i);
    assert.doesNotMatch(JSON.stringify(result.calls), /FORM_SECRET_SENTINEL/);
    assert.equal(JSON.stringify(result.svc.audit.records.at(-1)).includes('1234'), false);
    assert.equal(JSON.stringify(result.svc.audit.records.at(-1)).includes('5000'), false);
    assert.equal(JSON.stringify(result.svc.audit.records.at(-1)).includes('FORM_SECRET_SENTINEL'), false);
  }
});

test('omitting page context keeps the established guide selection, reply events, and navigation behavior', async (t) => {
  const withoutContext = await ask(t, { message: 'I want to send money' });
  const withAbsentContext = await ask(t, { message: 'I want to send money', pageContext: undefined });
  const publicEvents = (events) => events.filter((event) => !['thinking', 'done'].includes(event.type));
  assert.deepEqual(publicEvents(withAbsentContext.events), publicEvents(withoutContext.events));
  assert.doesNotMatch(withoutContext.calls.flatMap((call) => call.messages.map((item) => item.content)).join('\n'), /VERIFIED PAGE HINT/);
});

test('the widget sends only the pathname and capture time to /chat, never query or form values', async (t) => {
  const customer = alice();
  const model = createFakeModel((request) => request.purpose === 'route' ? '["bill-payment"]' : 'Use the verified bill payment steps.');
  const svc = await start({ customers: [customer], model });
  t.after(svc.close);
  const widget = await openWidget(svc.baseUrl);
  t.after(() => widget.dom.window.close());
  const element = widget.document.querySelector('bank-assistant');
  element.setAttribute('token', customer.token);
  element.setAttribute('cli', customer.cli);
  element.setAttribute('tenant', 'demo');
  widget.dom.window.history.pushState({}, '', '/payments/bill-payment?amount=5000&pin=1234');
  const form = widget.document.createElement('form');
  const amount = widget.document.createElement('input');
  amount.name = 'amount';
  amount.value = 'FORM_VALUE_SENTINEL';
  form.append(amount);
  widget.document.body.append(form);

  await widget.send('What do I do on this page?');
  await widget.until(() => widget.q('approved-answer-link'));

  const request = widget.net.requests.at(-1);
  assert.deepEqual(request.pageContext && Object.keys(request.pageContext).sort(), ['capturedAt', 'path']);
  assert.equal(request.pageContext.path, '/payments/bill-payment');
  assert.ok(Number.isFinite(Date.parse(request.pageContext.capturedAt)));
  assert.doesNotMatch(JSON.stringify(request), /amount|5000|1234|FORM_VALUE_SENTINEL|pin=/i);
  assert.equal(widget.q('approved-answer-link').dataset.target, 'bill_payment');
  assert.equal(widget.qa('action-card').length, 0);
});
