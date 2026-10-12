import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService } from './harness/start-service.js';
import { createFakeModel } from './harness/fake-model.js';
import { openWidget } from './harness/open-widget.js';

test('disclaimer is visible on load, outside the transcript, and states the PIN/OTP rule', async (t) => {
  const svc = await startService();
  t.after(svc.close);
  const w = await openWidget(svc.baseUrl);

  const disclaimer = w.q('disclaimer');
  assert.ok(disclaimer);
  assert.equal(disclaimer.hidden, false);
  assert.match(disclaimer.textContent, /automated/i);
  assert.match(disclaimer.textContent, /PIN/);
  assert.match(disclaimer.textContent, /OTP/);
  assert.equal(w.q('messages').contains(disclaimer), false);
});

test('a sent message shows a thinking state, then the streamed reply', async (t) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const svc = await startService({ model: createFakeModel([['Go to ', 'Transfers.']], { gate }) });
  t.after(svc.close);
  const w = await openWidget(svc.baseUrl);

  await w.send('How do I send money?');
  await w.until(() => w.q('thinking') && w.q('thinking').hidden === false);
  assert.equal(w.qa('message').find((m) => m.dataset.from === 'user').textContent, 'How do I send money?');

  release();
  await w.until(() => w.qa('message').some((m) => m.dataset.from === 'assistant' && m.textContent === 'Go to Transfers.'));
  assert.equal(w.q('thinking').hidden, true);
});

test('the disclaimer switches language with the latest message and keeps the PIN/OTP rule', async (t) => {
  const svc = await startService();
  t.after(svc.close);
  const w = await openWidget(svc.baseUrl);

  await w.send('Comment faire un virement vers un autre compte ?');
  await w.until(() => /automatique/i.test(w.q('disclaimer').textContent));
  assert.match(w.q('disclaimer').textContent, /PIN/);
  assert.match(w.q('disclaimer').textContent, /OTP/);

  await w.send('ok thanks, and how do I pay a bill?');
  await w.until(() => /automated/i.test(w.q('disclaimer').textContent));
});
