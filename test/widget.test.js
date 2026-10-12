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

test('a refusal shows the fixed next-step card after the reply, and a busy turn shows the busy message with the human chip', async (t) => {
  const svc = await startService({ model: createFakeModel(['[[refusal:pin_otp]]I never need your PIN.']), limits: { messagesPerMinute: 1 } });
  t.after(svc.close);
  const w = await openWidget(svc.baseUrl);

  await w.send('Tell me my PIN');
  await w.until(() => w.qa('next-step').length === 1);
  assert.equal(w.qa('message').find((m) => m.dataset.from === 'assistant').textContent, 'I never need your PIN.');
  assert.equal(w.qa('next-step')[0].textContent, 'Talk to a human agent');

  await w.send('And again');
  await w.until(() => w.qa('busy').length === 1);
  assert.match(w.qa('busy')[0].textContent, /busy/i);
  assert.equal(w.qa('next-step').length, 2);
});

test('the human chip is on screen from the start, outside the transcript, and calm', async (t) => {
  const svc = await startService();
  t.after(svc.close);
  const w = await openWidget(svc.baseUrl);

  const chip = w.q('human-chip');
  assert.ok(chip);
  assert.equal(chip.textContent, 'Talk to a human agent');
  assert.equal(chip.dataset.prominent, 'false');
  assert.equal(w.q('messages').contains(chip), false);
});

test('the chip becomes prominent on a cue, stays so through a calm turn, and follows the reply language', async (t) => {
  const svc = await startService({ model: createFakeModel(['I am sorry to hear that.', 'Open Transfers.']) });
  t.after(svc.close);
  const w = await openWidget(svc.baseUrl);

  await w.send('I sent money to the wrong person');
  await w.until(() => w.q('human-chip').dataset.prominent === 'true');

  await w.send('ok merci, et comment faire un virement ?');
  await w.until(() => w.q('human-chip').textContent === 'Parler à un agent');
  assert.equal(w.q('human-chip').dataset.prominent, 'true', 'once prominent in a conversation it stays prominent');
});

test('clicking the chip announces the request with the conversation id and then asks the service for a case, once', async (t) => {
  const svc = await startService({ model: createFakeModel(['Sorry.']) });
  t.after(svc.close);
  const w = await openWidget(svc.baseUrl);
  t.after(() => w.dom.window.close());
  const heard = [];
  w.document.addEventListener('bank-assistant:handoff-request', (e) => heard.push(e.detail));

  await w.send('Fraud on my account');
  await w.until(() => w.q('human-chip').dataset.prominent === 'true');
  const fetched = [];
  const realFetch = w.dom.window.fetch;
  w.dom.window.fetch = (url, init) => { fetched.push(String(url)); return realFetch(url, init); };
  assert.deepEqual(heard, [], 'no event before a click');
  assert.deepEqual(svc.mailer.outbox, [], 'no case and no page before a click');

  w.q('human-chip').click();
  await w.until(() => w.q('case-banner') && !w.q('case-banner').hidden);
  w.q('human-chip').click(); // disabled while a case is open: no second case

  assert.equal(heard.length, 1);
  assert.match(heard[0].conversationId, /^[0-9a-f-]{36}$/);
  assert.equal(fetched.filter((u) => u.endsWith('/handoff')).length, 1);
  assert.equal(svc.mailer.outbox.length, 1);
});

test('the chip works before any message and reports no conversation yet', async (t) => {
  const svc = await startService();
  t.after(svc.close);
  const w = await openWidget(svc.baseUrl);
  t.after(() => w.dom.window.close());
  const heard = [];
  w.document.addEventListener('bank-assistant:handoff-request', (e) => heard.push(e.detail));

  w.q('human-chip').click();
  await w.until(() => w.q('case-banner') && !w.q('case-banner').hidden);

  assert.equal(heard.length, 1);
  assert.equal(heard[0].conversationId, null);
});

test('with a cli from the host, the widget starts a session once with the token, then chats with only the token and the session id', async (t) => {
  const { createFakeGateway } = await import('./harness/fake-gateway.js');
  const { bankRoutes, customer } = await import('./harness/bank-fixtures.js');
  const a = customer({ sub: '237690000111', cli: 'CLI-A', accountNo: '12345678901', phone: '237690000111' });
  const svc = await startService({ gateway: createFakeGateway(bankRoutes([a])) });
  t.after(svc.close);
  const w = await openWidget(svc.baseUrl);
  const widget = w.document.querySelector('bank-assistant');
  widget.setAttribute('token', a.token);
  widget.setAttribute('cli', 'CLI-A');
  widget.setAttribute('gating', JSON.stringify({ usePackages: false, primaryConnect: true }));
  widget.setAttribute('tenant', 'demo');
  const sent = [];
  const realFetch = w.dom.window.fetch;
  w.dom.window.fetch = (url, init) => { sent.push({ url: String(url), body: JSON.parse(init.body) }); return realFetch(url, init); };

  await w.send('hello');
  await w.until(() => w.qa('message').length >= 2 && w.q('thinking').hidden);
  await w.send('and again');
  await w.until(() => sent.length >= 3);

  assert.deepEqual(sent.map((s) => s.url.replace(/^.*\//, '')), ['session', 'chat', 'chat']);
  assert.equal(sent[0].body.cli, 'CLI-A');
  assert.equal(sent[1].body.cli, undefined, 'chat carries no cli');
  assert.equal(sent[1].body.conversationId, sent[2].body.conversationId);
  assert.ok(sent[1].body.conversationId);
  assert.equal(svc.gateway.calls.filter((c) => c.path.endsWith('clientInfo')).length, 1);
});
