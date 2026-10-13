import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NAVIGATION, PREFILL, alice, begin, say, start } from './harness/t1-helpers.js';
import { createGuideModel } from './harness/guide-model.js';
import { openWidget } from './harness/open-widget.js';
import { mountPortalForm } from './harness/portal-forms.js';
import { loadNavigation } from '../src/navigate.js';
import { loadPrefill } from '../src/prefill.js';

const WALLET = '237677000555';
const tag = (form, params) => `[[prefill:${form} ${JSON.stringify(params)}]]`;
const withConfig = (edit) => {
  const config = JSON.parse(readFileSync(PREFILL, 'utf8'));
  edit(config);
  return loadPrefill(config, loadNavigation(NAVIGATION));
};

// ---- service: the card carries fixed directions and the wait ----

test('the single-transfer card is in directions mode with fixed directions (EN and FR); other forms are in fill mode with none', async (t) => {
  const a = alice();
  const answer = tag('single_transfer', { destination: WALLET, amount: 5000 });
  const svc = await start({ customers: [a], model: createGuideModel({ picks: ['transfer-single'], answer: [answer] }) });
  t.after(svc.close);
  const id = await begin(svc, a);

  const en = (await say(svc, a, `Send 5000 to ${WALLET}`, id)).events.find((e) => e.type === 'action_card');
  assert.match(en.directions, /Single Transfer/);
  assert.match(en.directions, /click Next yourself/);
  assert.equal(en.mode, 'directions');
  assert.equal(en.waitMs, null);

  const fr = (await say(svc, a, `Envoie 5000 au ${WALLET}`, id)).events.find((e) => e.type === 'action_card');
  assert.match(fr.directions, /Transfert unique/);

  const airtime = await start({ customers: [a], model: createGuideModel({ picks: ['airtime'], answer: [tag('airtime', { number: WALLET, amount: 1000 })] }) });
  t.after(airtime.close);
  const card = (await say(airtime, a, `Top up 1000 on ${WALLET}`, await begin(airtime, a))).events.find((e) => e.type === 'action_card');
  assert.equal(card.directions, null);
  assert.equal(card.mode, 'fill');
});

test('the wait and the directions are validated at load', () => {
  assert.throws(() => withConfig((c) => { c.forms.single_transfer.waitSeconds = 0; }), /waitSeconds/);
  assert.throws(() => withConfig((c) => { c.forms.single_transfer.waitSeconds = 9999; }), /waitSeconds/);
  assert.throws(() => withConfig((c) => { c.forms.single_transfer.directions = { en: 'only English' }; }), /directions/);
  assert.throws(() => withConfig((c) => { delete c.forms.single_transfer.directions; }), /directions mode needs/);
  assert.throws(() => withConfig((c) => { c.forms.single_transfer.mode = 'magic'; }), /mode is/);
  assert.doesNotThrow(() => withConfig((c) => { c.forms.single_transfer.mode = 'fill'; delete c.forms.single_transfer.directions; }));
});

// ---- widget: the wait ----

// Host like the portal's router, but the form's inputs only appear when the "customer" has made their choices.
async function setup(t, { waitSeconds = 2 } = {}) {
  const a = alice();
  const prefill = withConfig((c) => { c.forms.single_transfer.mode = 'fill'; c.forms.single_transfer.waitSeconds = waitSeconds; });
  const svc = await start({ customers: [a], prefill, model: createGuideModel({ picks: ['transfer-single'], answer: [tag('single_transfer', { destination: WALLET, amount: 5000 })] }) });
  t.after(svc.close);
  const w = await openWidget(svc.baseUrl);
  const el = w.document.querySelector('bank-assistant');
  for (const [k, v] of Object.entries({ token: a.token, cli: a.cli, tenant: 'demo', gating: JSON.stringify({ usePackages: false }) })) el.setAttribute(k, v);
  w.document.addEventListener('bank-assistant:navigate', (e) => e.preventDefault()); // the host routes; the form comes later
  await w.send(`Send 5000 to ${WALLET}`);
  await w.until(() => w.q('action-card'));
  return { w, el, mount: () => mountPortalForm(w.document, 'single_transfer') };
}

test('the card shows the directions as a plain line', async (t) => {
  const { w } = await setup(t);
  assert.match(w.q('action-card').querySelector('[data-role="action-directions"]').textContent, /Choose the region/);
});

test('the inputs appear after the customer made their choices: the widget fills them then, once, with banners', async (t) => {
  const { w, mount } = await setup(t);
  w.q('action-card').querySelector('button').click();
  await new Promise((r) => setTimeout(r, 700)); // the customer is still choosing: nothing is filled, nothing is shown yet
  assert.equal(w.qa('assistant-filled').length, 0);
  assert.equal(w.q('copy-values'), null);

  const form = mount();
  await w.until(() => w.qa('assistant-filled').length === 2, 3000);

  assert.deepEqual(w.qa('assistant-filled').map((b) => b.dataset.field).sort(), ['amount', 'destination']);
  assert.equal(form.state.values.account, WALLET);
  assert.equal(form.state.values.mtrans, '5000');
  assert.equal(w.q('copy-values'), null);
});

test('if the form never appears within the wait, the values are listed to copy', async (t) => {
  const { w } = await setup(t, { waitSeconds: 1 });
  w.q('action-card').querySelector('button').click();
  await w.until(() => w.q('copy-values'), 4000);
  assert.deepEqual([...w.q('copy-values').querySelectorAll('li')].map((li) => li.dataset.field), ['destination', 'amount']);
});

test('sending another message ends the wait: a form that appears later is not filled, and no copy list appears', async (t) => {
  const { w, mount } = await setup(t);
  w.q('action-card').querySelector('button').click();
  await new Promise((r) => setTimeout(r, 300));

  await w.send('thanks');
  mount();
  await new Promise((r) => setTimeout(r, 900));

  assert.equal(w.qa('assistant-filled').length, 0);
  assert.equal(w.q('copy-values'), null);
});

test('leaving the page ends the wait', async (t) => {
  const { w, mount } = await setup(t);
  w.q('action-card').querySelector('button').click();
  await new Promise((r) => setTimeout(r, 300));

  w.dom.window.history.pushState({}, '', '/somewhere-else');
  mount();
  await new Promise((r) => setTimeout(r, 900));

  assert.equal(w.qa('assistant-filled').length, 0);
  assert.equal(w.q('copy-values'), null);
});

// ---- widget: directions mode ----

test('directions mode: Open sends the customer to the page, fills nothing, waits for nothing and lists the values to enter', async (t) => {
  const a = alice();
  const svc = await start({ customers: [a], model: createGuideModel({ picks: ['transfer-single'], answer: [tag('single_transfer', { destination: WALLET, amount: 5000 })] }) });
  t.after(svc.close);
  const w = await openWidget(svc.baseUrl);
  const el = w.document.querySelector('bank-assistant');
  for (const [k, v] of Object.entries({ token: a.token, cli: a.cli, tenant: 'demo', gating: JSON.stringify({ usePackages: false }) })) el.setAttribute(k, v);
  const navigations = [];
  const prefills = [];
  w.document.addEventListener('bank-assistant:navigate', (e) => { e.preventDefault(); navigations.push(e.detail); });
  w.document.addEventListener('bank-assistant:prefill', (e) => prefills.push(e.detail));
  await w.send(`Send 5000 to ${WALLET}`);
  await w.until(() => w.q('action-card'));
  assert.match(w.q('action-card').querySelector('[data-role="action-directions"]').textContent, /click Next yourself/);
  assert.equal(w.q('copy-values'), null, 'the values are listed after the customer opens the page, not before');

  w.q('action-card').querySelector('button').click();
  await w.until(() => w.q('copy-values'), 1000);

  assert.deepEqual(navigations.map((n) => n.path), ['/transfer']);
  assert.deepEqual(prefills, [], 'no fill is attempted, so the host is not asked to take one over either');
  assert.equal(w.qa('assistant-filled').length, 0);
  const rows = Object.fromEntries([...w.q('copy-values').querySelectorAll('li')].map((li) => [li.dataset.field, li.textContent]));
  assert.match(rows.destination, new RegExp(WALLET));
  assert.match(rows.amount, /5000/);
});
