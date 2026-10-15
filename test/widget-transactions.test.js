import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alice, start, toolModel } from './harness/t1-helpers.js';
import { row } from './harness/bank-fixtures.js';
import { openWidget } from './harness/open-widget.js';

async function setup(t, message) {
  const a = alice();
  a.rows = [row(a, {
    ntrans: 'MTR1', clientReferenceId: '', dop: null, dou1: '2026-09-25T15:43:20', nat: 'TRIB', service: 'GIMAC-EMI', dev: '59',
    codewaldo: ` ${a.sub} `, codewalop: '237671996088', partnerlib: 'ADVANS', partnerid: '11020',
  })];
  const svc = await start({ customers: [a], model: toolModel('[[tool:last_transactions {}]]'), fixtures: { nomenclature: [{ lib1: 'TRIB', lib2: 'Bank transfer', lib6: 'Virement bancaire' }] } });
  t.after(svc.close);
  const w = await openWidget(svc.baseUrl);
  const el = w.document.querySelector('bank-assistant');
  el.setAttribute('token', a.token);
  el.setAttribute('cli', a.cli);
  el.setAttribute('tenant', 'demo');
  el.setAttribute('gating', JSON.stringify({ usePackages: false }));
  await w.send(message);
  await w.until(() => w.q('transactions'));
  return { a, w };
}

const cells = (w) => [...w.q('transactions').querySelectorAll('tr')].map((tr) => [...tr.children].map((c) => c.textContent));

test('last transactions are drawn like the portal History table, with full numbers for the customer\'s own screen', async (t) => {
  const { a, w } = await setup(t, 'my last transactions');

  const [head, first] = cells(w);
  assert.deepEqual(head, ['Date', 'Id', 'From', 'To', 'Member', 'Nature', 'Type', 'Amount', 'Status']);
  assert.deepEqual(first, ['2026-09-25 15:43:20', 'MTR1', a.sub, '237671996088', 'ADVANS [11020]', 'Bank transfer', 'Emission', '15,000 XAF', 'Completed']);
});

test('in French the headings, type, nature and status are French', async (t) => {
  const { w } = await setup(t, 'mes dernières transactions');

  const [head, first] = cells(w);
  assert.deepEqual(head, ['Date', 'Id', 'De', 'Vers', 'Membre', 'Nature', 'Type', 'Montant', 'Statut']);
  assert.equal(first[5], 'Virement bancaire');
  assert.equal(first[6], 'Émission');
  assert.equal(first[8], 'Terminé');
});

test('the table scrolls sideways inside an inner box; the grid item itself is a plain box that cannot widen the panel', async (t) => {
  const { w } = await setup(t, 'my last transactions');

  const outer = w.q('transactions');
  assert.equal(outer.style.overflowX, '');
  assert.equal(outer.style.minWidth, '0px');
  const scroller = outer.querySelector('[data-role="transactions-scroll"]');
  assert.equal(scroller.style.overflowX, 'auto');
  assert.ok(scroller.querySelector('table'));
});
