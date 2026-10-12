import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService } from './harness/start-service.js';
import { createFakeModel } from './harness/fake-model.js';
import { openWidget } from './harness/open-widget.js';
import { agentLogin } from './harness/cases.js';

// Opens the demo page with a fast poll, says hello and clicks the human chip.
async function askForAgent(svc, t, { message = 'Hello' } = {}) {
  const w = await openWidget(svc.baseUrl);
  t.after(() => w.dom.window.close()); // the widget polls while a case is open: stop it with the test
  w.document.querySelector('bank-assistant').setAttribute('poll-ms', '20');
  await w.send(message);
  await w.until(() => w.qa('message').some((m) => m.dataset.from === 'assistant'));
  w.q('human-chip').click();
  await w.until(() => w.q('case-banner') && !w.q('case-banner').hidden);
  return w;
}
const refOf = (w) => /C-\d+/.exec(w.q('case-ref').textContent)[0];

test('clicking the chip opens a handoff: a banner with the case reference, elapsed time, the 24-hour notice and a cancel button', async (t) => {
  const svc = await startService({ model: createFakeModel(['Hi there.']) });
  t.after(svc.close);

  const w = await askForAgent(svc, t);

  assert.match(w.q('case-state').textContent, /waiting for an agent/i);
  assert.match(w.q('case-ref').textContent, /C-\d+/);
  assert.match(w.q('case-elapsed').textContent, /0:00/);
  assert.match(w.q('case-notice').textContent, /we will update you within 24 hours/i);
  assert.doesNotMatch(w.q('case-notice').textContent, /resolv/i);
  assert.ok(w.q('case-cancel'));
  assert.equal(w.q('human-chip').disabled, true, 'a second click cannot open a second case');

  await svc.clock.advance(125_000);
  await w.until(() => /2:05/.test(w.q('case-elapsed').textContent));
});

test('cancel returns the customer to the assistant and the case closes as cancelled by user', async (t) => {
  const svc = await startService({ model: createFakeModel(['Hi there.']) });
  t.after(svc.close);
  const w = await askForAgent(svc, t);
  const ref = refOf(w);

  w.q('case-cancel').click();
  await w.until(() => w.q('case-banner').hidden);

  assert.equal(w.q('human-chip').disabled, false);
  assert.match(w.qa('case-note').at(-1).textContent, new RegExp(`${ref}.*cancelled by you`, 'i'));
  const aline = await agentLogin(svc.baseUrl, 'aline');
  assert.equal((await aline.list()).body.cases[0].closeReason, 'cancelled_by_user');
});

test('while waiting, assistant replies are labelled as automated replies', async (t) => {
  const svc = await startService({ model: createFakeModel(['Hi there.', 'Open Transfers.']) });
  t.after(svc.close);
  const w = await askForAgent(svc, t);

  await w.send('How do I pay a bill?');
  await w.until(() => w.qa('message').filter((m) => m.dataset.from === 'assistant').length === 2);

  assert.equal(w.qa('automated-label').length, 1);
  assert.match(w.q('automated-label').textContent, /automated reply/i);
  assert.equal(w.q('automated-label').nextElementSibling.textContent, 'Open Transfers.');
});

test('once an agent claims, the banner shows the agent first name and a human agent badge, and the bot is muted', async (t) => {
  const model = createFakeModel(['Hi there.', 'should not be used']);
  const svc = await startService({ model });
  t.after(svc.close);
  const w = await askForAgent(svc, t);
  const aline = await agentLogin(svc.baseUrl, 'aline');

  await aline.claim(refOf(w));
  await w.until(() => w.q('case-agent') && !w.q('case-agent').hidden);

  assert.equal(w.q('case-agent-name').textContent, 'Aline');
  assert.match(w.q('human-badge').textContent, /human agent/i);
  assert.doesNotMatch(w.q('case-banner').textContent, /Mbarga/);
  assert.equal(w.q('case-cancel'), null, 'an agent has the case: nothing left to cancel');
  assert.match(w.q('case-state').textContent, /with an agent/i);

  const before = model.calls.length;
  await w.send('Are you there?');
  let transcript = [];
  for (let i = 0; i < 100 && !transcript.some((m) => m.text === 'Are you there?'); i++) {
    transcript = (await aline.open(refOf(w))).body.transcript;
    await new Promise((r) => setTimeout(r, 10));
  }
  await w.until(() => w.q('thinking').hidden); // the turn has fully ended
  assert.ok(transcript.some((m) => m.from === 'customer' && m.text === 'Are you there?'), 'the agent received it');
  assert.equal(model.calls.length, before, 'and the model was never asked');
});

test('the agent\'s messages arrive in the same chat, marked as the human agent', async (t) => {
  const svc = await startService({ model: createFakeModel(['Hi there.']) });
  t.after(svc.close);
  const w = await askForAgent(svc, t);
  const aline = await agentLogin(svc.baseUrl, 'aline');
  await aline.claim(refOf(w));

  await aline.reply(refOf(w), 'Hello, I am looking at your transfer now.');
  await w.until(() => w.qa('message').some((m) => m.dataset.from === 'agent'));

  const message = w.qa('message').find((m) => m.dataset.from === 'agent');
  assert.equal(message.textContent, 'Hello, I am looking at your transfer now.');
  assert.equal(w.qa('message').filter((m) => m.dataset.from === 'agent').length, 1, 'each message shown once, not on every poll');
});

test('after resolution the customer sees "Was this solved?" and can answer', async (t) => {
  const svc = await startService({ model: createFakeModel(['Hi there.']) });
  t.after(svc.close);
  const w = await askForAgent(svc, t);
  const ref = refOf(w);
  const aline = await agentLogin(svc.baseUrl, 'aline');
  await aline.claim(ref);

  await aline.resolve(ref);
  await w.until(() => w.q('solved-prompt') && !w.q('solved-prompt').hidden);

  assert.match(w.q('solved-prompt').textContent, /was this solved\?/i);
  assert.equal(w.q('case-banner').hidden, true);
  assert.equal(w.q('human-chip').disabled, false);

  w.q('solved-yes').click();
  await w.until(() => w.q('solved-prompt').hidden);
  assert.deepEqual(svc.audit.records.filter((e) => e.outcome === 'case_feedback').map((e) => e.solved), [true]);
});

test('in French the banner, notice and prompt are French', async (t) => {
  const svc = await startService({ model: createFakeModel(['Bonjour.']) });
  t.after(svc.close);
  const w = await askForAgent(svc, t, { message: 'Bonjour, comment faire un virement vers un autre compte ?' });

  assert.match(w.q('case-state').textContent, /en attente d.un agent/i);
  assert.match(w.q('case-notice').textContent, /dans les 24 heures/i);
  assert.match(w.q('case-cancel').textContent, /annuler/i);
  const aline = await agentLogin(svc.baseUrl, 'aline');
  const ref = refOf(w);
  await aline.claim(ref);
  await aline.resolve(ref);
  await w.until(() => w.q('solved-prompt') && !w.q('solved-prompt').hidden);
  assert.match(w.q('solved-prompt').textContent, /résolu/i);
});

test('the chip click still announces the request to the host page, and then asks the service for a case', async (t) => {
  const svc = await startService({ model: createFakeModel(['Hi there.']) });
  t.after(svc.close);
  const w = await openWidget(svc.baseUrl);
  t.after(() => w.dom.window.close());
  const heard = [];
  w.document.addEventListener('bank-assistant:handoff-request', (e) => heard.push(e.detail));

  assert.deepEqual(heard, [], 'no event, and no case, before a click');
  w.q('human-chip').click();
  await w.until(() => w.q('case-banner') && !w.q('case-banner').hidden);

  assert.equal(heard.length, 1);
  assert.equal(heard[0].conversationId, null);
  assert.match(w.q('case-ref').textContent, /C-\d+/, 'a customer can ask for a person before saying anything');
});

test('after 15 minutes unclaimed the banner tells the customer the case is queued and they will be emailed', async (t) => {
  const svc = await startService({ model: createFakeModel(['Hi there.']) });
  t.after(svc.close);
  const w = await askForAgent(svc, t);
  assert.doesNotMatch(w.q('case-notice').textContent, /queued/i);

  await svc.clock.advance(15 * 60_000);
  await w.until(() => /queued/i.test(w.q('case-notice').textContent));

  assert.match(w.q('case-notice').textContent, /email/i);
  assert.match(w.q('case-notice').textContent, /within 24 hours/i, 'the honest expectation stays');
  assert.ok(w.q('case-cancel'), 'the case is still open and can be cancelled');
});

test('the soft "still working on it" and the transfer notice show as notes, not as agent messages', async (t) => {
  const svc = await startService({ model: createFakeModel(['Hi there.']) });
  t.after(svc.close);
  const w = await askForAgent(svc, t);
  const aline = await agentLogin(svc.baseUrl, 'aline');
  await aline.claim(refOf(w));
  await w.until(() => /with an agent/i.test(w.q('case-state').textContent));

  await svc.clock.advance(10 * 60_000);
  await w.until(() => w.qa('case-note').some((n) => /still working on it/i.test(n.textContent)));
  await aline.transfer(refOf(w), 'paul');
  await w.until(() => w.qa('case-note').some((n) => /colleague/i.test(n.textContent)));

  assert.equal(w.qa('message').filter((m) => m.dataset.from === 'agent').length, 0, 'no agent bubble was invented');
  assert.doesNotMatch(w.document.body.textContent, /Aline Mbarga|Paul Etoga/);
});
