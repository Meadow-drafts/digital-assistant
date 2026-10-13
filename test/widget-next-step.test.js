import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alice, start, toolModel } from './harness/t1-helpers.js';
import { row } from './harness/bank-fixtures.js';
import { openWidget } from './harness/open-widget.js';

// Widget on the demo host page; the service runs on a fake model and gateway. A pending transfer is explained
// from fixed text, so its closing step is the History card (or the human step where History is not offered).
async function setup(t, { gating, message, tool = '[[tool:explain_failure {"reference":"REF-0001"}]]' }) {
  const a = alice();
  a.rows = [row(a, { clientReferenceId: 'REF-0001', sta: '1000', msg: null, digitalBankStatus: '200', makeOperationStatus: '200', statusFees: '200', reDebited: false, reversing: false, reversedAt: null })];
  const svc = await start({ customers: [a], model: toolModel(tool) });
  t.after(svc.close);
  const w = await openWidget(svc.baseUrl);
  const el = w.document.querySelector('bank-assistant');
  el.setAttribute('token', a.token);
  el.setAttribute('cli', a.cli);
  el.setAttribute('tenant', 'demo');
  el.setAttribute('gating', JSON.stringify(gating));
  const navigations = [];
  w.document.addEventListener('bank-assistant:navigate', (e) => { e.preventDefault(); navigations.push({ ...e.detail }); });
  await w.send(message);
  return { w, navigations };
}

const WITH_HIST = { usePackages: true, pack: { natureCodes: ['HIST'] } };
const WITHOUT_HIST = { usePackages: true, pack: { natureCodes: ['TRINC'] } };
const MESSAGE = { en: 'Why did my transfer REF-0001 fail?', fr: 'Pourquoi mon transfert REF-0001 a échoué ?' };
const COPY = {
  en: { label: 'History', button: 'Click here to see your history', human: /"Talk to a human agent"/ },
  fr: { label: 'Historique', button: 'Cliquez ici pour voir votre historique', human: /« Parler à un agent »/ },
};

for (const lang of ['en', 'fr']) {
  test(`${lang.toUpperCase()}: the History next step is drawn as the same action card as any link card, and clicking it only asks the host to navigate`, async (t) => {
    const { w, navigations } = await setup(t, { gating: WITH_HIST, message: MESSAGE[lang] });
    await w.until(() => w.q('action-card'));

    const cards = w.qa('action-card');
    assert.equal(cards.length, 1);
    assert.equal(cards[0].dataset.kind, 'navigate');
    assert.equal(cards[0].dataset.target, 'history');
    assert.equal(cards[0].querySelector('[data-role="action-label"]').textContent, COPY[lang].label);
    assert.equal(cards[0].querySelector('button').textContent, COPY[lang].button);

    cards[0].querySelector('button').click();
    assert.deepEqual(navigations, [{ path: '/history', target: 'history' }]);
  });

  test(`${lang.toUpperCase()}: without the HIST package the widget shows no History card, only the human step in the reply`, async (t) => {
    const { w } = await setup(t, { gating: WITHOUT_HIST, message: MESSAGE[lang] });

    const said = () => w.qa('message').filter((m) => m.dataset.from === 'assistant').map((m) => m.textContent).join('\n');
    await w.until(() => COPY[lang].human.test(said()));
    assert.equal(w.qa('action-card').length, 0);
    assert.match(said(), COPY[lang].human);
    assert.doesNotMatch(said(), /History|Historique/);
  });
}
