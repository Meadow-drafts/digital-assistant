import { test } from 'node:test';
import assert from 'node:assert/strict';
import { row } from './harness/bank-fixtures.js';
import { startService } from './harness/start-service.js';
import { createFakeModel } from './harness/fake-model.js';
import { openWidget } from './harness/open-widget.js';
import { AGENTS, agentLogin, customer } from './harness/cases.js';
import { alice, begin, say, start } from './harness/t1-helpers.js';

const MIN = 60_000;
const LONG_SESSION = { ...AGENTS, sessionMs: 1000 * 60 * MIN };
const DRAFTS = ['Hello, I am looking at your transfer now.', 'Could you confirm the date of the transfer?', 'Thank you for your patience.'];

const modelFor = (suggest = JSON.stringify(DRAFTS)) => createFakeModel((request) => {
  if (request.purpose === 'suggest') return suggest;
  return request.purpose === 'route' ? '[]' : 'ok';
});

async function consolePage(svc, t, id, path = '/console') {
  const w = await openWidget(svc.baseUrl, path);
  t.after(() => w.dom.window.close()); // the console polls: stop it with the test
  w.document.body.dataset.pollMs = '20';
  w.q('agent-id').value = id;
  w.q('agent-password').value = AGENTS.list.find((x) => x.id === id).password;
  w.q('login-form').dispatchEvent(new w.dom.window.Event('submit', { cancelable: true, bubbles: true }));
  await w.until(() => w.q('console') && !w.q('console').hidden);
  return w;
}
const submit = (w, role) => w.q(role).dispatchEvent(new w.dom.window.Event('submit', { cancelable: true, bubbles: true }));
const rowOf = (w, ref) => w.qa('case-row').find((r) => r.dataset.ref === ref);

// A customer with a case claimed by Aline, shown in Aline's console.
async function claimed(t, { suggest, first = 'I sent money to the wrong person' } = {}) {
  const model = modelFor(suggest);
  const svc = await startService({ model, agents: LONG_SESSION });
  t.after(svc.close);
  const c = await customer(svc.baseUrl, 'test-token', first);
  const { ref } = (await c.handoff()).body;
  const w = await consolePage(svc, t, 'aline', `/console?case=${ref}`);
  await w.until(() => w.q('detail-ref')?.textContent.includes(ref));
  w.q('claim').click();
  await w.until(() => !w.q('reply-send').disabled);
  return { svc, model, c, ref, w };
}

test('the masked recent transactions sit beside the chat, in the same row as the transcript and the reply box', async (t) => {
  const a = alice();
  a.rows = [row(a, { clientReferenceId: 'REF-0001', sta: '100', mtrans: 15000, partnerlib: 'Jean Paul Mbarga', telop: '237677000999' })];
  const svc = await start({ customers: [a], model: modelFor() });
  t.after(svc.close);
  const conversationId = await begin(svc, a);
  await say(svc, a, 'I sent 15000 to the wrong person by mistake', conversationId);
  const { ref } = (await (await fetch(`${svc.baseUrl}/handoff`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${a.token}` }, body: JSON.stringify({ conversationId }) })).json());
  const w = await consolePage(svc, t, 'aline', `/console?case=${ref}`);
  await w.until(() => w.q('detail-ref')?.textContent.includes(ref));
  w.q('claim').click();
  await w.until(() => !w.q('records-box').hidden);

  const workspace = w.q('workspace');
  assert.equal(w.q('chat').parentElement, workspace);
  assert.equal(w.q('side').parentElement, workspace, 'the side column is the chat column\'s neighbour');
  assert.equal(w.q('records-box').parentElement, w.q('side'));
  assert.ok(w.q('chat').contains(w.q('transcript-box')) && w.q('chat').contains(w.q('reply-form')), 'the chat column holds the transcript and the reply box');
  assert.match(w.qa('record')[0].textContent, /REF-0001.*15000 XAF.*\*\*\*\*8901.*J\. P\. M\./);
});

test('"Suggest replies" fills the choices; picking one puts it in the reply box for editing and sends nothing', async (t) => {
  const { svc, c, ref, w } = await claimed(t);
  const before = (await (await agentLogin(svc.baseUrl)).open(ref)).body.transcript.length;

  w.q('suggest').click();
  await w.until(() => w.qa('suggestion').length === 3);
  assert.deepEqual(w.qa('suggestion').map((b) => b.textContent), DRAFTS);
  assert.equal(w.q('reply-input').value, '', 'nothing is put in the reply box until the agent picks one');

  w.qa('suggestion')[1].click();
  assert.equal(w.q('reply-input').value, DRAFTS[1]);
  assert.equal(w.document.activeElement, w.q('reply-input'), 'ready to edit');
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual((await c.status()).body.messages.filter((m) => m.from === 'agent'), [], 'never sent automatically');
  assert.equal((await (await agentLogin(svc.baseUrl)).open(ref)).body.transcript.length, before);
});

test('the agent chooses how many drafts to ask for (1 to 3)', async (t) => {
  const { model, w } = await claimed(t);
  assert.deepEqual([...w.q('suggest-count').options].map((o) => o.value), ['1', '2', '3']);

  w.q('suggest-count').value = '2';
  w.q('suggest').click();
  await w.until(() => w.qa('suggestion').length === 2);

  assert.match(JSON.stringify(model.calls.find((call) => call.purpose === 'suggest').messages), /\b2\b/);
});

test('when the model cannot help the console just says "No suggestions available"', async (t) => {
  const { w } = await claimed(t, { suggest: 'Your PIN is 4821.' });

  w.q('suggest').click();
  await w.until(() => /No suggestions available/.test(w.q('suggestions-message').textContent));

  assert.equal(w.qa('suggestion').length, 0);
  assert.equal(w.q('claim-error').textContent, '', 'and no error is raised');
  assert.equal(w.q('reply-send').disabled, false, 'the agent carries on typing');
});

test('drafts for one case are not left on screen when the agent opens another', async (t) => {
  const { svc, w } = await claimed(t);
  const other = (await (await customer(svc.baseUrl, 'second-token', 'hello')).handoff()).body.ref;
  w.q('suggest').click();
  await w.until(() => w.qa('suggestion').length === 3);

  await w.until(() => rowOf(w, other));
  rowOf(w, other).click();
  await w.until(() => w.q('detail-ref').textContent.includes(other));

  assert.equal(w.qa('suggestion').length, 0);
  assert.equal(w.q('suggest').disabled, true, 'and a case that is not yours cannot be asked about');
});

test('an internal note is added from the console, shown with its author, and stays out of the chat lines', async (t) => {
  const { ref, svc, w } = await claimed(t);

  w.q('note-input').value = 'Customer called the branch too. Account 12345678901.';
  submit(w, 'note-form');
  await w.until(() => w.qa('note').length === 1);

  assert.match(w.qa('note')[0].textContent, /Aline Mbarga/);
  assert.match(w.qa('note')[0].textContent, /Customer called the branch too\. Account \*\*\*\*8901\./);
  assert.equal(w.q('note-input').value, '');
  assert.ok(!w.qa('line').some((l) => /branch too/.test(l.textContent)));
  assert.doesNotMatch(w.document.body.textContent, /12345678901/);
  const paul = await agentLogin(svc.baseUrl, 'paul');
  await svc.clock.advance(30 * MIN);
  assert.equal((await paul.open(ref)).body.notes.length, 1, 'and a colleague who can open the case sees it');
});

test('a colleague who cannot open the case sees no notes and cannot add one', async (t) => {
  const { svc, ref } = await claimed(t);
  await (await agentLogin(svc.baseUrl, 'aline')).note(ref, 'Private to the holder until re-broadcast.');
  const paul = await consolePage(svc, t, 'paul', `/console?case=${ref}`);

  await paul.until(() => /Aline/.test(paul.q('detail-claimed-by').textContent));

  assert.equal(paul.qa('note').length, 0);
  assert.equal(paul.q('note-add').disabled, true);
  assert.doesNotMatch(paul.document.body.textContent, /Private to the holder/);
});

test('the queue shows the waiting time of every case, highest priority and longest wait first, and updates without a reload', async (t) => {
  const svc = await startService({ model: modelFor(), agents: LONG_SESSION });
  t.after(svc.close);
  const first = (await (await customer(svc.baseUrl, 'a', 'hello')).handoff()).body.ref;
  await svc.clock.advance(2 * MIN);
  const w = await consolePage(svc, t, 'aline');
  await w.until(() => rowOf(w, first));
  assert.match(rowOf(w, first).textContent, /waiting 2:00/);
  assert.equal(rowOf(w, first).dataset.level, 'normal');

  await svc.clock.advance(3 * MIN); // exactly the 5 minute broadcast timer
  await w.until(() => /waiting 5:00/.test(rowOf(w, first).textContent));
  assert.equal(rowOf(w, first).dataset.level, 'warning');

  const urgent = (await (await customer(svc.baseUrl, 'b', 'I sent it to the wrong person')).handoff()).body.ref;
  const newer = (await (await customer(svc.baseUrl, 'c', 'hello again')).handoff()).body.ref;
  await w.until(() => rowOf(w, urgent) && rowOf(w, newer));
  assert.deepEqual(w.qa('case-row').map((r) => r.dataset.ref), [urgent, first, newer], 'priority first, then the longest waiting');

  await svc.clock.advance(10 * MIN); // the first case is now at 15 minutes: the "queued" timer
  await w.until(() => rowOf(w, first).dataset.level === 'urgent');
  assert.match(rowOf(w, first).textContent, /waiting 15:00/);
});

test('the console explains the colours with the thresholds the service reads from config', async (t) => {
  const timers = { broadcastMs: 2 * MIN, queuedNoticeMs: 4 * MIN, absentMs: 120_000, agentSilenceMs: 3 * MIN, agentFollowUpMs: 6 * MIN, autoResolveMs: 86_400_000, reopenWindowMs: 259_200_000 };
  const { loadSupport } = await import('../src/support.js');
  const real = loadSupport(new URL('../config/support.json', import.meta.url));
  const svc = await startService({ model: modelFor(), agents: LONG_SESSION, support: { ...real, timers } });
  t.after(svc.close);
  const w = await consolePage(svc, t, 'aline');

  await w.until(() => w.q('queue-thresholds').textContent !== '');

  const text = w.q('queue-thresholds').textContent;
  assert.match(text, /2:00/);
  assert.match(text, /4:00/);
  assert.match(text, /3:00/);
  assert.match(text, /6:00/);
});
