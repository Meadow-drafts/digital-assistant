import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alice, start } from './harness/t1-helpers.js';
import { createGuideModel } from './harness/guide-model.js';
import { openWidget } from './harness/open-widget.js';
import { mountPortalForm, ACCOUNTS } from './harness/portal-forms.js';
import { row } from './harness/bank-fixtures.js';
import { readFileSync } from 'node:fs';
import { NAVIGATION, PREFILL } from './harness/t1-helpers.js';
import { loadNavigation } from '../src/navigate.js';
import { loadPrefill } from '../src/prefill.js';

// The shipped single transfer is in "directions" mode (the portal form sits behind choices); these tests exercise the
// fill mechanism, so they run it in fill mode.
const fillMode = () => {
  const config = JSON.parse(readFileSync(PREFILL, 'utf8'));
  config.forms.single_transfer.mode = 'fill';
  delete config.forms.single_transfer.waitSeconds;
  return loadPrefill(config, loadNavigation(NAVIGATION));
};

const WALLET = '237677000555';
const tag = (form, params) => `[[prefill:${form} ${JSON.stringify(params)}]]`;

// The widget on the demo host page (service on a fake model and fake gateway). The host behaves like the portal's
// router: it handles bank-assistant:navigate, and renders the form a moment later, as a route change does.
async function setup(t, {
  message = `Send 5000 to ${WALLET} for rent`, picks = ['transfer-single'], form = 'single_transfer', params, mount = {}, mountDelay = 80,
  routed = true, mountOnNavigate = true, fillTimeout = 400, rows = [row(alice())],
} = {}) {
  const a = alice();
  a.rows = rows.map((r) => ({ ...r, codewaldo: a.sub, teldo: a.phone, dcpt: a.accountNo }));
  const answer = tag(form, params ?? { destination: WALLET, amount: 5000, narrative: 'rent', sourceAccount: 0 });
  const svc = await start({ customers: [a], prefill: fillMode(), model: createGuideModel({ picks, answer: [answer] }) });
  t.after(svc.close);
  const w = await openWidget(svc.baseUrl);
  const el = w.document.querySelector('bank-assistant');
  for (const [k, v] of Object.entries({ token: a.token, cli: a.cli, tenant: 'demo', gating: JSON.stringify({ usePackages: false }), 'fill-timeout': String(fillTimeout) })) el.setAttribute(k, v);
  const page = { portal: null, navigations: [], prefills: [] };
  if (routed) {
    w.document.addEventListener('bank-assistant:navigate', (e) => {
      e.preventDefault();
      page.navigations.push({ ...e.detail });
      if (mountOnNavigate) setTimeout(() => { page.portal = mountPortalForm(w.document, form, mount); }, mountDelay);
    });
  }
  w.document.addEventListener('bank-assistant:prefill', (e) => page.prefills.push({ defaultPrevented: e.defaultPrevented, detail: e.detail }));
  await w.send(message);
  await w.until(() => w.q('action-card'));
  const card = () => w.q('action-card');
  const open = async () => {
    card().querySelector('button').click();
    await w.until(() => page.portal && !w.document.querySelector('[data-role="thinking"]:not([hidden])') && (w.qa('assistant-filled').length || w.q('copy-values')), 3000);
  };
  return { a, svc, w, el, page, card, open };
}

test('the card shows the masked beneficiary, the amount with a summary and one Open and review button; the full number is not on screen', async (t) => {
  const { card } = await setup(t, { rows: [] });

  assert.equal(card().dataset.kind, 'prefill');
  assert.equal(card().dataset.form, 'single_transfer');
  assert.equal(card().querySelector('[data-role="action-summary"]').textContent, 'Transfer 5000 XAF to ******555 from ****8901 for “rent”');
  assert.match(card().querySelector('[data-role="action-beneficiary"]').textContent, /\*{6}555/);
  assert.match(card().querySelector('[data-role="action-amount"]').textContent, /5000 XAF/);
  assert.equal(card().querySelectorAll('button').length, 1);
  assert.equal(card().querySelector('button').textContent, 'Click here to send money');
  assert.doesNotMatch(card().textContent, new RegExp(WALLET), 'before the fill, the number is not shown anywhere on the card');
  assert.match(card().querySelector('[data-role="double-check"]').textContent, /Is this beneficiary and amount right\?/);
});

test('a known beneficiary and an ordinary amount show no double-check line', async (t) => {
  const { card } = await setup(t, { message: 'Send 5000 to 237677000999', params: { destination: '237677000999', amount: 5000 } });
  assert.equal(card().querySelector('[data-role="double-check"]'), null);
});

test('Open and review asks the host to navigate, then fills the form fields with a native setter and input events; nothing else', async (t) => {
  const { page, open } = await setup(t);
  await open();

  assert.deepEqual(page.navigations, [{ path: '/transfer', target: 'transfer' }]);
  const { input, state } = page.portal;
  assert.equal(input('account').value, WALLET);
  assert.equal(input('mtrans').value, '5000');
  assert.equal(input('raison').value, 'rent');
  assert.equal(input('ccptsou').value, ACCOUNTS[0].value);
  assert.deepEqual(state.events.account, ['input'], 'the portal sees a normal input event, like typing');
  assert.deepEqual(state.events.ccptsou, ['change'], 'a select gets a change event');
  assert.deepEqual(state.values, { ccptsou: ACCOUNTS[0].value, account: WALLET, mtrans: '5000', raison: 'rent' });
});

test('the assistant never presses Next, Confirm or Proceed, never submits, and never touches PIN, OTP, password or voucher inputs', async (t) => {
  const { page, open } = await setup(t);
  await open();
  const { state, input } = page.portal;

  assert.deepEqual(state.presses, []);
  assert.equal(state.submits, 0);
  for (const name of ['pin', 'otp', 'newPassword', 'vouchercode']) {
    assert.deepEqual(state.events[name], [], `${name} received no event`);
    assert.equal(input(name).value, '');
  }
});

test('a card that lists a PIN, OTP, password or voucher field is not filled there, even if the service sent it', async (t) => {
  const { w, el, page } = await setup(t, { mountOnNavigate: false });
  page.portal = mountPortalForm(w.document, 'single_transfer');
  const forged = (field, dom) => ({ field, dom: [dom], label: field, value: '4321', display: '****' });
  el.addActionCard({
    kind: 'prefill', form: 'single_transfer', target: 'transfer', path: '/transfer', title: 'Transfer', summary: 'Transfer', beneficiary: null, amount: null, doubleCheck: null, button: 'Open and review',
    fields: [forged('pin', 'pin'), forged('otp', 'otp'), forged('password', 'newPassword'), forged('voucher', 'vouchercode'), { field: 'amount', dom: ['mtrans'], label: 'Amount', value: '700', display: '700 XAF' }],
  });
  const cards = w.qa('action-card');
  cards.at(-1).querySelector('button').click();
  await w.until(() => w.qa('assistant-filled').length > 0);

  const { state } = page.portal;
  assert.equal(state.values.mtrans, '700');
  for (const name of ['pin', 'otp', 'newPassword', 'vouchercode']) assert.deepEqual(state.events[name], [], name);
});

test('an input that looks like a secret by type is never filled even under an innocent name, and its value is offered to copy instead', async (t) => {
  const { w, el, page } = await setup(t, { mountOnNavigate: false });
  page.portal = mountPortalForm(w.document, 'single_transfer', { extraSecret: {} });
  const sneaky = page.portal.input('raison');
  sneaky.type = 'password';
  el.addActionCard({
    kind: 'prefill', form: 'single_transfer', target: 'transfer', path: '/transfer', title: 'Transfer', summary: 'Transfer', beneficiary: null, amount: null, doubleCheck: null, button: 'Open and review',
    fields: [{ field: 'narrative', dom: ['raison'], label: 'Reason', value: 'rent', display: 'rent' }],
  });
  w.qa('action-card').at(-1).querySelector('button').click();
  await w.until(() => w.q('copy-values'), 3000);

  assert.equal(sneaky.value, '');
  assert.deepEqual(page.portal.state.events.raison, []);
});

test('every assistant-filled field carries a banner, and editing a field clears only its own banner', async (t) => {
  const { w, page, open } = await setup(t);
  await open();

  const fields = () => w.qa('assistant-filled').map((b) => b.dataset.field).sort();
  assert.deepEqual(fields(), ['amount', 'destination', 'narrative', 'sourceAccount']);
  assert.match(w.qa('assistant-filled')[0].textContent, /Filled by the assistant/);
  const amountBanner = () => w.document.querySelector('[data-role="assistant-filled"][data-field="amount"]');
  assert.equal(amountBanner().previousElementSibling, page.portal.input('mtrans'), 'the banner sits next to its field');

  const amount = page.portal.input('mtrans');
  amount.value = '6000';
  amount.dispatchEvent(new w.dom.window.Event('input', { bubbles: true }));

  assert.deepEqual(fields(), ['destination', 'narrative', 'sourceAccount']);
  const account = page.portal.input('ccptsou');
  account.dispatchEvent(new w.dom.window.Event('change', { bubbles: true }));
  assert.deepEqual(fields(), ['destination', 'narrative']);
});

test('a field the page does not have is not invented: the card shows the values to copy, and the other fields are still filled', async (t) => {
  const { w, page, open } = await setup(t, { mount: { omit: ['raison'] } });
  await open();
  await w.until(() => w.q('copy-values'), 3000); // shown once the wait for the missing input ends

  assert.equal(page.portal.input('mtrans').value, '5000');
  const copy = w.q('copy-values');
  assert.ok(copy, 'values to copy are shown');
  const rows = [...copy.querySelectorAll('li')].map((li) => [li.dataset.field, li.textContent]);
  assert.deepEqual(rows.map(([f]) => f), ['narrative']);
  assert.match(rows[0][1], /Reason/);
  assert.match(rows[0][1], /rent/);
  assert.equal(w.qa('assistant-filled').some((b) => b.dataset.field === 'narrative'), false);
});

test('when the form never appears, every value is shown to copy, nothing is sent and nothing throws', async (t) => {
  const { w, el, card } = await setup(t, { routed: false, fillTimeout: 150 });
  w.document.addEventListener('bank-assistant:navigate', (e) => e.preventDefault()); // host routes, but renders no form
  card().querySelector('button').click();
  await w.until(() => w.q('copy-values'), 3000);

  const rows = [...w.q('copy-values').querySelectorAll('li')].map((li) => li.dataset.field);
  assert.deepEqual(rows, ['destination', 'amount', 'narrative', 'sourceAccount']);
  const destination = w.q('copy-values').querySelector('[data-field="destination"]');
  assert.match(destination.textContent, new RegExp(WALLET), 'the copy list carries the real value so the customer can paste it');
  assert.equal(w.qa('assistant-filled').length, 0);
  assert.ok(el);
});

test('a disabled input is treated as not found: the portal keeps it locked until an operator is picked, so the value is offered to copy', async (t) => {
  const { w, page, open } = await setup(t, {
    message: 'Top up 1000 on 237677000555 with MTN', picks: ['airtime'], form: 'airtime', params: { number: WALLET, amount: 1000, operator: 'MTN' },
    mount: { disabled: ['tel', 'mtrans'] },
  });
  await open();

  assert.equal(page.portal.input('tel').value, '');
  assert.deepEqual([...w.q('copy-values').querySelectorAll('li')].map((li) => li.dataset.field), ['number', 'amount']);
  assert.deepEqual(page.portal.state.events.tel, []);
});

test('bill payment fills whichever of Bill Number or Contract Number the form shows', async (t) => {
  const { page, open } = await setup(t, {
    message: 'Pay bill number 556677', picks: ['bill-payment'], form: 'bill_payment', params: { service: 'ENEO', reference: '556677' },
  });
  await open();
  assert.equal(page.portal.input('billRef').value, '556677');
  assert.equal(page.portal.input('contractRef'), null);
});

test('request to pay fills payer, amount and motive', async (t) => {
  const { page, open } = await setup(t, {
    message: `Request 2500 from ${WALLET} for lunch`, picks: ['request-to-pay'], form: 'request_to_pay', params: { payer: WALLET, amount: 2500, narrative: 'lunch' },
  });
  await open();
  assert.deepEqual(page.portal.state.values, { account: WALLET, mtrans: '2500', raison: 'lunch' });
});

test('the host can take over the fill: if it cancels bank-assistant:prefill, the widget fills nothing and shows no banners', async (t) => {
  const { w, page, card } = await setup(t);
  w.document.addEventListener('bank-assistant:prefill', (e) => e.preventDefault());
  card().querySelector('button').click();
  await w.until(() => page.portal, 2000);
  await new Promise((r) => setTimeout(r, 150));

  assert.equal(page.prefills.length, 1);
  assert.equal(page.prefills[0].detail.form, 'single_transfer');
  assert.deepEqual(Array.from(page.prefills[0].detail.fields, (f) => f.field), ['destination', 'amount', 'narrative', 'sourceAccount']);
  assert.deepEqual(page.portal.state.values, {});
  assert.equal(w.qa('assistant-filled').length, 0);
  assert.equal(w.q('copy-values'), null);
});

test('an input inside the widget itself is never filled', async (t) => {
  const { w, el, page } = await setup(t, { mountDelay: 10 });
  const own = w.document.createElement('input');
  own.name = 'mtrans';
  el.append(own);
  w.q('action-card').querySelector('button').click();
  await w.until(() => w.qa('assistant-filled').length > 0, 3000);
  assert.equal(own.value, '');
  assert.equal(page.portal.input('mtrans').value, '5000');
});

test('card text is set as text, never markup', async (t) => {
  const { w, el } = await setup(t, { rows: [] });
  el.addActionCard({
    kind: 'prefill', form: 'single_transfer', target: 'transfer', path: '/transfer', title: '<b>T</b>', summary: '<img src=x onerror=alert(1)>', beneficiary: '<i>x</i>', amount: { value: 1, currency: 'XAF' },
    doubleCheck: '<u>sure?</u>', button: '<b>Go</b>', fields: [],
  });
  const last = w.qa('action-card').at(-1);
  assert.equal(last.querySelector('img, b, i, u'), null);
});

test('a prefill card with a path that is not a plain portal path is not rendered', async (t) => {
  const { w, el } = await setup(t, { rows: [] });
  const before = w.qa('action-card').length;
  for (const path of ['https://evil.example/', '//evil.example/', 'javascript:alert(1)', '/transfer?x=1']) {
    el.addActionCard({ kind: 'prefill', form: 'single_transfer', target: 'transfer', path, title: 'T', summary: 'S', beneficiary: null, amount: null, doubleCheck: null, button: 'Open', fields: [] });
  }
  assert.equal(w.qa('action-card').length, before);
});

test('without a router handler the widget goes to the page and, on the next load, finishes the fill once from a short-lived note', async (t) => {
  const { w, el, page, card } = await setup(t, { routed: false });
  const note = () => w.dom.window.sessionStorage.getItem('bank-assistant:prefill');
  card().querySelector('button').click(); // jsdom cannot navigate (it only reports it); the widget leaves the note first
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(note(), 'a note is left for the next page load');

  // "next load": a fresh widget on a page that now has the form
  page.portal = mountPortalForm(w.document, 'single_transfer');
  el.remove();
  const fresh = w.document.createElement('bank-assistant');
  fresh.setAttribute('fill-timeout', '300');
  w.document.body.append(fresh);
  await w.until(() => w.qa('assistant-filled').length > 0, 3000);
  assert.equal(page.portal.input('mtrans').value, '5000');
  assert.equal(note(), null, 'the note is removed when read');

  w.document.body.append(w.document.createElement('bank-assistant'));
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(Array.from(page.portal.state.events.mtrans), ['input'], 'the note is used once');
});

test('a stale note is ignored', async (t) => {
  const { w, el, page } = await setup(t, { routed: false });
  const card = { kind: 'prefill', form: 'single_transfer', target: 'transfer', path: '/transfer', title: 'T', summary: 'S', beneficiary: null, amount: null, doubleCheck: null, button: 'Go',
    fields: [{ field: 'amount', dom: ['mtrans'], label: 'Amount', value: '1', display: '1' }] };
  w.dom.window.sessionStorage.setItem('bank-assistant:prefill', JSON.stringify({ at: Date.now() - 120_000, card }));
  page.portal = mountPortalForm(w.document, 'single_transfer');
  el.remove();
  w.document.body.append(w.document.createElement('bank-assistant'));
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(page.portal.input('mtrans').value, '');
});

test('in French the card and banners are French', async (t) => {
  const { w, open } = await setup(t, { message: `Comment envoyer 5000 à ${WALLET} pour le loyer ?`, params: { destination: WALLET, amount: 5000, narrative: 'loyer' } });
  assert.equal(w.q('action-card').querySelector('button').textContent, 'Cliquez ici pour envoyer de l’argent');
  assert.match(w.q('action-card').querySelector('[data-role="double-check"]').textContent, /sont-ils corrects/);
  await open();
  assert.match(w.qa('assistant-filled')[0].textContent, /Rempli par l’assistant/);
});
