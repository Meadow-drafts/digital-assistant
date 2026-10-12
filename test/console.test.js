import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService } from './harness/start-service.js';
import { createFakeModel } from './harness/fake-model.js';
import { openWidget } from './harness/open-widget.js';
import { AGENTS, customer } from './harness/cases.js';

async function openConsole(svc, t, path = '/console') {
  const w = await openWidget(svc.baseUrl, path);
  t.after(() => w.dom.window.close()); // the console polls: stop it with the test
  w.document.body.dataset.pollMs = '20';
  return w;
}
async function signIn(w, id = 'aline') {
  w.q('agent-id').value = id;
  w.q('agent-password').value = AGENTS.list.find((a) => a.id === id).password;
  w.q('login-form').dispatchEvent(new w.dom.window.Event('submit', { cancelable: true, bubbles: true }));
  await w.until(() => w.q('console') && !w.q('console').hidden);
}
const row = (w, ref) => w.qa('case-row').find((r) => r.dataset.ref === ref);

test('the console asks for an agent login first and shows no case until the agent is in', async (t) => {
  const svc = await startService({ model: createFakeModel(['ok']) });
  t.after(svc.close);
  const c = await customer(svc.baseUrl, 'test-token', 'secret story about my transfer');
  const { ref } = (await c.handoff()).body;
  const w = await openConsole(svc, t);

  assert.equal(w.q('login-form').hidden, false);
  assert.equal(w.q('console').hidden, true);
  assert.doesNotMatch(w.document.body.textContent, new RegExp(ref));
  assert.doesNotMatch(w.document.body.textContent, /secret story/);

  w.q('agent-id').value = 'aline';
  w.q('agent-password').value = 'wrong';
  w.q('login-form').dispatchEvent(new w.dom.window.Event('submit', { cancelable: true, bubbles: true }));
  await w.until(() => w.q('login-error').textContent !== '');
  assert.equal(w.q('console').hidden, true);

  await signIn(w);
  await w.until(() => row(w, ref));
  assert.match(row(w, ref).textContent, /waiting/i);
});

test('an agent claims, reads the masked transcript, chats with the customer and resolves', async (t) => {
  const svc = await startService({ model: createFakeModel(['Open Transfers.']) });
  t.after(svc.close);
  const c = await customer(svc.baseUrl, 'test-token', 'I sent money from 12345678901 by mistake');
  const { ref } = (await c.handoff()).body;
  const w = await openConsole(svc, t);
  await signIn(w);
  await w.until(() => row(w, ref));

  row(w, ref).click();
  await w.until(() => w.q('detail-ref')?.textContent.includes(ref));
  await w.until(() => w.qa('line').length >= 3);
  const shown = w.qa('line').map((l) => l.textContent).join('\n');
  assert.match(shown, /I sent money from \*\*\*\*8901 by mistake/);
  assert.doesNotMatch(shown, /12345678901/);
  assert.equal(w.q('reply-send').disabled, true, 'nothing to say before the case is claimed');

  w.q('claim').click();
  await w.until(() => /with you|aline/i.test(w.q('detail-state').textContent) && !w.q('reply-send').disabled);
  assert.equal((await c.status()).body.agent.firstName, 'Aline');

  w.q('reply-input').value = 'Hello, I am looking at your transfer now.';
  w.q('reply-form').dispatchEvent(new w.dom.window.Event('submit', { cancelable: true, bubbles: true }));
  await w.until(() => w.qa('line').some((l) => l.dataset.from === 'agent'));
  assert.deepEqual((await c.status()).body.messages.map((m) => m.text), ['Hello, I am looking at your transfer now.']);

  await c.say('Thank you');
  await w.until(() => w.qa('line').some((l) => l.textContent.includes('Thank you')));

  w.q('resolve').click();
  await w.until(() => /resolved/i.test(w.q('detail-state').textContent));
  assert.equal((await c.status()).body.state, 'resolved');
  assert.equal(w.q('reply-send').disabled, true);
});

test('when another agent got there first, the console says so and shows who has the case', async (t) => {
  const svc = await startService({ model: createFakeModel(['ok']) });
  t.after(svc.close);
  const c = await customer(svc.baseUrl);
  const { ref } = (await c.handoff()).body;
  const w = await openConsole(svc, t);
  await signIn(w, 'aline');
  await w.until(() => row(w, ref));
  row(w, ref).click();
  await w.until(() => w.q('detail-ref')?.textContent.includes(ref));
  const { agentLogin } = await import('./harness/cases.js');
  await (await agentLogin(svc.baseUrl, 'paul')).claim(ref); // Paul is quicker

  w.q('claim').click();
  await w.until(() => w.q('claim-error').textContent !== '');

  assert.match(w.q('claim-error').textContent, /already/i);
  await w.until(() => /Paul/.test(w.q('detail-claimed-by').textContent));
});

test('the page link from the paging email opens that case after login', async (t) => {
  const svc = await startService({ model: createFakeModel(['ok']) });
  t.after(svc.close);
  const c = await customer(svc.baseUrl, 'test-token', 'Hello there');
  const { ref } = (await c.handoff()).body;
  const w = await openConsole(svc, t, `/console?case=${ref}`);

  await signIn(w);

  await w.until(() => w.q('detail-ref')?.textContent.includes(ref));
  await w.until(() => w.qa('line').some((l) => l.textContent.includes('Hello there')));
});

test('an agent transfers the case from the console to a colleague, who then sees it', async (t) => {
  const svc = await startService({ model: createFakeModel(['ok']) });
  t.after(svc.close);
  const c = await customer(svc.baseUrl);
  const { ref } = (await c.handoff()).body;
  const w = await openConsole(svc, t);
  await signIn(w);
  await w.until(() => row(w, ref));
  row(w, ref).click();
  await w.until(() => w.q('detail-ref')?.textContent.includes(ref));
  assert.equal(w.q('transfer').disabled, true, 'nothing to transfer before the case is yours');

  w.q('claim').click();
  await w.until(() => !w.q('transfer').disabled);
  assert.deepEqual([...w.q('transfer-to').options].map((o) => o.textContent), ['Paul Etoga'], 'only colleagues are offered');
  w.q('transfer').click();

  await w.until(() => /paul/i.test(w.q('detail-state').textContent));
  assert.equal(w.q('transfer').disabled, true, 'it is no longer yours');
  assert.equal((await c.status()).body.agent.firstName, 'Paul');
});
