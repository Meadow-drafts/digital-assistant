import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alice, bob, start, toolModel } from './harness/t1-helpers.js';
import { openWidget } from './harness/open-widget.js';

// Widget on the demo host page, service on a fake model and fake gateway.
async function setup(t, { flag, tel, gating = { usePackages: false } } = {}) {
  const a = alice();
  const svc = await start({ customers: [a], model: toolModel('[[tool:balance {}]]') });
  t.after(svc.close);
  const w = await openWidget(svc.baseUrl);
  const el = w.document.querySelector('bank-assistant');
  el.setAttribute('token', a.token);
  el.setAttribute('cli', a.cli);
  el.setAttribute('tenant', 'demo');
  el.setAttribute('gating', JSON.stringify(gating));
  const store = w.dom.window.sessionStorage;
  if (flag !== undefined) store.setItem('isBalancePinVerified', flag);
  if (tel !== undefined) store.setItem('isBalancePinVerified:tel', tel);
  const sent = [];
  const realFetch = w.dom.window.fetch;
  w.dom.window.fetch = (url, init) => { sent.push({ url: String(url).replace(/^.*\//, ''), body: init?.body ? JSON.parse(init.body) : null }); return realFetch(url, init); };
  const transcript = () => w.qa('message').map((m) => m.textContent).join('\n');
  const box = () => w.q('pin-box');
  return { a, svc, w, sent, transcript, box };
}

test('flag "1" for this phone: the balance shows with no PIN box and no PIN check', async (t) => {
  const { a, svc, w, sent, box, transcript } = await setup(t, { flag: '1', tel: alice().sub });

  await w.send('what is my balance?');
  await w.until(() => transcript().includes('Here is what I found'));

  assert.equal(box().hidden, true);
  assert.deepEqual(sent.map((s) => s.url), ['session', 'unlock', 'chat']);
  assert.deepEqual(sent[1].body.portalFlag, { verified: '1', tel: a.sub });
  assert.equal(svc.gateway.calls.filter((c) => c.path.endsWith('checkPin')).length, 0);
});

test('flag missing: the PIN box opens outside the transcript, and the PIN is hashed, cleared and never shown or sent in clear', async (t) => {
  const { a, svc, w, sent, box, transcript } = await setup(t);

  await w.send('what is my balance?');
  await w.until(() => box().hidden === false);

  assert.equal(w.q('messages').contains(box()), false, 'the PIN box is not part of the transcript');
  w.q('pin-input').value = '1234';
  w.q('pin-box').dispatchEvent(new w.dom.window.Event('submit', { cancelable: true, bubbles: true }));
  assert.equal(w.q('pin-input').value, '', 'the field is cleared at once');
  await w.until(() => transcript().split('Here is what I found').length > 2 || (box().hidden && transcript().includes('Here is what I found')));

  const unlock = sent.find((s) => s.url === 'unlock' && s.body.pinHash);
  assert.match(unlock.body.pinHash, /^[0-9a-f]{128}$/);
  assert.deepEqual(Object.keys(unlock.body).sort(), ['conversationId', 'pinHash']);
  assert.equal(box().hidden, true);
  assert.doesNotMatch(JSON.stringify(sent) + transcript(), /"1234"|\b1234\b/, 'no clear PIN in any request or in the chat');
  assert.deepEqual(svc.gateway.calls.find((c) => c.path.endsWith('checkPin')).body.tel, a.sub);
  assert.doesNotMatch(JSON.stringify(svc.model.calls) + JSON.stringify(svc.audit.records), new RegExp(unlock.body.pinHash));
});

test('flag for a different phone, or not "1": the PIN box is used', async (t) => {
  for (const setupOpts of [{ flag: '1', tel: bob().sub }, { flag: '0', tel: alice().sub }, { flag: '1' }]) {
    const { w, box } = await setup(t, setupOpts);
    await w.send('what is my balance?');
    await w.until(() => box().hidden === false);
    assert.equal(box().hidden, false, JSON.stringify(setupOpts));
  }
});

test('a wrong PIN stays in the box with the attempts left, and the chat shows no PIN', async (t) => {
  const { w, box, transcript } = await setup(t);
  await w.send('what is my balance?');
  await w.until(() => box().hidden === false);

  w.q('pin-input').value = '0000';
  w.q('pin-box').dispatchEvent(new w.dom.window.Event('submit', { cancelable: true, bubbles: true }));
  await w.until(() => /attempts left/.test(w.q('pin-note').textContent));

  assert.equal(box().hidden, false);
  assert.match(w.q('pin-note').textContent, /Wrong PIN\. 2 attempts left\./);
  assert.doesNotMatch(transcript(), /0000/);
});
