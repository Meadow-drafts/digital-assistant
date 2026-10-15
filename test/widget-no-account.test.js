import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alice, start } from './harness/t1-helpers.js';
import { createGuideModel } from './harness/guide-model.js';
import { openWidget } from './harness/open-widget.js';

async function setup(t, { getCli }) {
  const a = alice();
  const svc = await start({ customers: [a], model: createGuideModel({ picks: ['transfer-single'], answer: ['Steps.'] }) });
  t.after(svc.close);
  const w = await openWidget(svc.baseUrl);
  const el = w.document.querySelector('bank-assistant');
  el.setAttribute('token', a.token);
  el.setAttribute('tenant', 'demo');
  if (getCli) el.getCli = getCli;
  return { w, el };
}

test('a host that supplies a customer id but gives none: the widget says it is not connected, once', async (t) => {
  const { w } = await setup(t, { getCli: () => '' });

  await w.send('How do I send money?');
  await w.send('And fees?');

  const notes = w.qa('case-note').filter((n) => /not connected to your account/.test(n.textContent));
  assert.equal(notes.length, 1);
});

test('no note on the standalone how-to page (no host customer id), and none when the id is there', async (t) => {
  const standalone = await setup(t, { getCli: null });
  await standalone.w.send('How do I send money?');
  assert.equal(standalone.w.qa('case-note').length, 0);
});
