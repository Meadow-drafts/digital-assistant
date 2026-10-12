import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alice, start } from './harness/t1-helpers.js';
import { createGuideModel } from './harness/guide-model.js';
import { openWidget } from './harness/open-widget.js';

// Widget on the demo host page, service on a fake model and fake gateway.
async function setup(t, { answer, message = 'How do I send money?' } = {}) {
  const a = alice();
  const svc = await start({ customers: [a], model: createGuideModel({ picks: ['transfer-single'], answer: [answer] }) });
  t.after(svc.close);
  const w = await openWidget(svc.baseUrl);
  const el = w.document.querySelector('bank-assistant');
  el.setAttribute('token', a.token);
  el.setAttribute('cli', a.cli);
  el.setAttribute('tenant', 'demo');
  el.setAttribute('gating', JSON.stringify({ usePackages: false }));
  const sent = [];
  const realFetch = w.dom.window.fetch;
  w.dom.window.fetch = (url, init) => { sent.push(String(url).replace(/^.*\//, '')); return realFetch(url, init); };
  const navigations = [];
  w.document.addEventListener('bank-assistant:navigate', (e) => { e.preventDefault(); navigations.push({ ...e.detail }); });
  await w.send(message);
  return { a, svc, w, sent, navigations };
}

test('the card shows the portal page name and an Open and review button, drawn from the validated data', async (t) => {
  const { w } = await setup(t, { answer: '[[navigate:transfer]]Open the Transfers page. <b>Pay now</b>' });
  await w.until(() => w.q('action-card'));

  const card = w.q('action-card');
  assert.equal(card.dataset.kind, 'navigate');
  assert.equal(card.dataset.target, 'transfer');
  assert.equal(card.querySelector('[data-role="action-label"]').textContent, 'Transfer');
  assert.equal(card.querySelector('button').textContent, 'Open and review');
  assert.equal(card.querySelector('b'), null, 'model text is never rendered as markup');
});

test('Open and review only asks the host to navigate to the validated path: nothing is sent to the service', async (t) => {
  const { w, sent, navigations } = await setup(t, { answer: '[[navigate:transfer]]Open the Transfers page.' });
  await w.until(() => w.q('action-card'));
  const before = [...sent];

  w.q('action-card').querySelector('button').click();

  assert.deepEqual(navigations, [{ path: '/transfer', target: 'transfer' }]);
  assert.deepEqual(sent, before, 'no chat, session or other request is made by the click');
});

test('a card with a path that is not a plain portal path is not rendered', async (t) => {
  const { w } = await setup(t, { answer: 'Open the Transfers page.' });
  const el = w.document.querySelector('bank-assistant');

  for (const path of ['https://evil.example/', '//evil.example/', 'javascript:alert(1)', '/transfer?x=1']) {
    el.addActionCard({ kind: 'navigate', target: 'transfer', path, label: 'Transfer', button: 'Open and review' });
  }

  assert.equal(w.qa('action-card').length, 0);
});
