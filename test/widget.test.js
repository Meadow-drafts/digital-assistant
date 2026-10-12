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

test('the answer shows a "what I used" chip naming the guide, in the reply language', async (t) => {
  const { createGuideModel } = await import('./harness/guide-model.js');
  const { loadGuides } = await import('../src/guides.js');
  const svc = await startService({
    guides: loadGuides(new URL('../guides/', import.meta.url)),
    model: createGuideModel({ picks: ['transfer-single'] }),
  });
  t.after(svc.close);
  const w = await openWidget(svc.baseUrl);

  await w.send('How do I send money to another account?');
  await w.until(() => w.q('guides-used'));
  assert.equal(w.q('guides-used').textContent, 'What I used: Send a single transfer');

  await w.send('Comment envoyer de l\'argent à une autre personne ?');
  await w.until(() => w.qa('guides-used').length === 2);
  assert.equal(w.qa('guides-used')[1].textContent, 'Ce que j\'ai utilisé : Effectuer un transfert unique');
});

test('no chip is shown when no guide was used', async (t) => {
  const { createGuideModel } = await import('./harness/guide-model.js');
  const { loadGuides } = await import('../src/guides.js');
  const svc = await startService({ guides: loadGuides(new URL('../guides/', import.meta.url)), model: createGuideModel({ picks: [] }) });
  t.after(svc.close);
  const w = await openWidget(svc.baseUrl);

  await w.send('How do I trade stocks?');
  await w.until(() => w.qa('message').some((m) => m.dataset.from === 'assistant' && /no verified steps/i.test(m.textContent)));
  assert.equal(w.q('guides-used'), null);
});

test('a secret-like message shows the fixed warning in the transcript, in the customer language', async (t) => {
  const svc = await startService();
  t.after(svc.close);
  const w = await openWidget(svc.baseUrl);

  await w.send('mon code pin est 4821, mon virement échoue');
  await w.until(() => w.qa('warning').length === 1);

  assert.match(w.q('warning').textContent, /Ne partagez jamais votre PIN, pas même avec la banque/);
  assert.equal(w.q('messages').contains(w.q('warning')), true);
});
