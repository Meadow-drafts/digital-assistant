import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService } from './harness/start-service.js';
import { createFakeModel } from './harness/fake-model.js';
import { openWidget } from './harness/open-widget.js';
import { agentLogin } from './harness/cases.js';

const WRONG = 'I sent 15000 to the wrong person by mistake on account 12345678901';
const SUPPORT_TO = 'support@example.test'; // config/support.json

// A customer describes a wrong transfer: the human chip turns prominent, and a click on it starts the draft.
async function disputed(svc, t, message = WRONG) {
  const w = await openWidget(svc.baseUrl);
  t.after(() => w.dom.window.close());
  w.document.querySelector('bank-assistant').setAttribute('poll-ms', '20');
  await w.send(message);
  await w.until(() => w.q('human-chip').dataset.prominent === 'true' && w.qa('message').some((m) => m.dataset.from === 'assistant'));
  return w;
}
const visible = (w, role) => Boolean(w.q(role) && !w.q(role).hidden);
const pickDestination = (w, name) => { w.q(`dest-${name}`).checked = true; };
const cases = async (svc) => (await (await agentLogin(svc.baseUrl, 'aline')).list()).body.cases;

test('a dispute-like chat: the chip click opens the draft for review and opens no case', async (t) => {
  const svc = await startService({ model: createFakeModel(['I am sorry to hear that.']) });
  t.after(svc.close);
  const w = await disputed(svc, t);

  w.q('human-chip').click();
  await w.until(() => visible(w, 'draft-panel'));

  assert.match(w.q('draft-text').value, /wrong person by mistake/, 'drafted from the customer\'s own words');
  assert.equal(w.q('draft-text').value.includes('12345678901'), true, 'it is their own text, and they can edit it');
  assert.equal(w.q('case-banner').hidden, true, 'no handoff yet');
  assert.deepEqual(await cases(svc), []);
  assert.deepEqual(svc.mailer.outbox, []);
  assert.ok(w.q('dest-chat') && w.q('dest-email') && w.q('dest-both'), 'chat, email or both');
});

test('the confirm screen shows the exact email; nothing is sent until Confirm, then support gets exactly that and the customer sees the reference', async (t) => {
  const svc = await startService({ model: createFakeModel(['I am sorry to hear that.']) });
  t.after(svc.close);
  const w = await disputed(svc, t);
  w.q('human-chip').click();
  await w.until(() => visible(w, 'draft-panel'));

  w.q('draft-text').value = 'Please help: I sent money to the wrong person, account 12345678901.';
  pickDestination(w, 'email');
  w.q('draft-review').click();
  await w.until(() => visible(w, 'draft-confirm-screen'));

  assert.equal(w.q('preview-email-to').textContent, SUPPORT_TO);
  const subject = w.q('preview-email-subject').textContent;
  assert.match(subject, /^\[C-\d+\] /);
  const body = w.q('preview-email-body').textContent;
  assert.match(body, /Please help: I sent money to the wrong person, account \*\*\*\*8901\./, 'the masked text, as it will be sent');
  assert.doesNotMatch(body, /12345678901/);
  assert.equal(visible(w, 'preview-chat-box'), false, 'email only: no chat message');
  assert.deepEqual(svc.mailer.outbox, [], 'still nothing sent');

  w.q('draft-send').click();
  await w.until(() => w.qa('case-note').some((n) => /C-\d+/.test(n.textContent)));

  assert.equal(svc.mailer.outbox.length, 1);
  assert.deepEqual({ to: svc.mailer.outbox[0].to, subject: svc.mailer.outbox[0].subject, body: svc.mailer.outbox[0].body }, { to: SUPPORT_TO, subject, body }, 'sent content equals what the confirm screen showed');
  assert.match(w.qa('case-note').at(-1).textContent, new RegExp(`${/C-\d+/.exec(subject)[0]}.*within 24 hours`, 's'));
  assert.equal(visible(w, 'draft-panel'), false);
  assert.equal(w.q('case-banner').hidden, true, 'email only does not put the customer in a queue');
});

test('chat: the confirmed draft is the opening message of the handoff and the banner shows the case', async (t) => {
  const svc = await startService({ model: createFakeModel(['I am sorry to hear that.']) });
  t.after(svc.close);
  const w = await disputed(svc, t);
  w.q('human-chip').click();
  await w.until(() => visible(w, 'draft-panel'));

  pickDestination(w, 'chat');
  w.q('draft-review').click();
  await w.until(() => visible(w, 'draft-confirm-screen'));
  const shown = w.q('preview-chat').textContent;
  assert.equal(visible(w, 'preview-email-box'), false);
  assert.deepEqual(await cases(svc), [], 'not opened by reviewing');
  w.q('draft-send').click();
  await w.until(() => !w.q('case-banner').hidden);

  const [only] = await cases(svc);
  assert.equal(only.state, 'waiting');
  const aline = await agentLogin(svc.baseUrl, 'aline');
  assert.equal((await aline.open(only.ref)).body.transcript[0].text, shown);
  assert.match(w.q('case-ref').textContent, new RegExp(only.ref));
});

test('Back returns to editing and Discard closes the draft, both sending nothing; the customer can still open the chat without a message', async (t) => {
  const svc = await startService({ model: createFakeModel(['I am sorry to hear that.']) });
  t.after(svc.close);
  const w = await disputed(svc, t);
  w.q('human-chip').click();
  await w.until(() => visible(w, 'draft-panel'));
  w.q('draft-review').click();
  await w.until(() => visible(w, 'draft-confirm-screen'));

  w.q('draft-back').click();
  assert.equal(visible(w, 'draft-confirm-screen'), false);
  assert.equal(visible(w, 'draft-text'), true);
  w.q('draft-discard').click();
  assert.equal(visible(w, 'draft-panel'), false);
  assert.deepEqual(svc.mailer.outbox, []);
  assert.deepEqual(await cases(svc), []);

  w.q('human-chip').click();
  await w.until(() => visible(w, 'draft-panel'));
  w.q('draft-skip').click();
  await w.until(() => !w.q('case-banner').hidden);
  assert.equal((await cases(svc)).length, 1, 'a person is always reachable without writing a message');
});

test('without a dispute-like cue the chip still opens the handoff directly, as before', async (t) => {
  const svc = await startService({ model: createFakeModel(['Hi there.']) });
  t.after(svc.close);
  const w = await openWidget(svc.baseUrl);
  t.after(() => w.dom.window.close());
  await w.send('Hello');
  await w.until(() => w.qa('message').some((m) => m.dataset.from === 'assistant'));

  w.q('human-chip').click();
  await w.until(() => !w.q('case-banner').hidden);

  assert.equal(visible(w, 'draft-panel'), false);
});

test('the draft review follows the reply language', async (t) => {
  const svc = await startService({ model: createFakeModel(['Je suis désolé.']) });
  t.after(svc.close);
  const w = await disputed(svc, t, "J'ai envoyé 15000 à la mauvaise personne par erreur");
  await w.until(() => w.q('human-chip').textContent === 'Parler à un agent');

  w.q('human-chip').click();
  await w.until(() => visible(w, 'draft-panel'));
  pickDestination(w, 'email');
  w.q('draft-review').click();
  await w.until(() => visible(w, 'draft-confirm-screen'));

  assert.match(w.q('draft-review').textContent, /Vérifier|Relire/);
  assert.match(w.q('preview-email-subject').textContent, /Message du client/);
  assert.match(w.q('draft-confirm-note').textContent, /Rien n'a encore été envoyé/);
});
