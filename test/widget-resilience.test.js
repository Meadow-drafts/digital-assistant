import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService } from './harness/start-service.js';
import { createFakeModel } from './harness/fake-model.js';
import { createFakeClock } from './harness/fake-clock.js';
import { openWidget } from './harness/open-widget.js';

// Ticket 50 (story 107): the widget on a poor connection. Offline, slow and dropped streams are simulated by the
// harness network; every wait is the controllable clock, so nothing here sleeps.

async function open(t, script = [['Go to ', 'Transfers.']]) {
  const svc = await startService({ model: createFakeModel(script) });
  t.after(svc.close);
  const clock = createFakeClock();
  const delays = [];
  const timed = { ...clock, setTimeout: (fn, ms) => { delays.push(ms); return clock.setTimeout(fn, ms); } };
  const w = await openWidget(svc.baseUrl, '/', { clock: timed });
  return { svc, w, clock, delays };
}
const bubbles = (w, from) => w.qa('message').filter((m) => m.dataset.from === from);
const status = (w) => w.q('connection');
const shown = (w) => status(w) && !status(w).hidden;

test('offline: the message is queued, the status says Reconnecting, and it is sent once when the connection returns', async (t) => {
  const { svc, w } = await open(t);
  w.net.setOffline(true, w.dom.window);

  await w.send('How do I send money?');
  await w.until(() => shown(w));
  assert.match(status(w).textContent, /Reconnecting/);
  assert.equal(bubbles(w, 'user').length, 1);
  assert.equal(bubbles(w, 'user')[0].dataset.state, 'queued');
  assert.equal(w.net.requests.length, 0, 'nothing is sent while the browser is offline');

  w.net.setOffline(false, w.dom.window);
  w.dom.window.dispatchEvent(new w.dom.window.Event('online'));
  await w.until(() => bubbles(w, 'assistant').some((m) => m.textContent === 'Go to Transfers.'));

  assert.equal(svc.model.calls.length, 1);
  assert.equal(bubbles(w, 'user').length, 1);
  assert.equal(bubbles(w, 'user')[0].dataset.state, undefined);
  assert.equal(shown(w), false);
});

test('messages typed offline are sent in order, each once', async (t) => {
  const { svc, w } = await open(t, ['first answer', 'second answer']);
  w.net.setOffline(true, w.dom.window);
  await w.send('one');
  await w.send('two');
  assert.equal(bubbles(w, 'user').length, 2);

  w.net.setOffline(false, w.dom.window);
  w.dom.window.dispatchEvent(new w.dom.window.Event('online'));
  await w.until(() => bubbles(w, 'assistant').length === 2 && w.q('thinking').hidden);

  assert.deepEqual(w.net.requests.map((r) => r.message), ['one', 'two']);
  assert.deepEqual(bubbles(w, 'assistant').map((m) => m.textContent), ['first answer', 'second answer']);
  assert.equal(svc.model.calls.length, 2);
});

test('a failing connection is retried with growing delays, then the reply arrives once', async (t) => {
  const { svc, w, clock, delays } = await open(t);
  w.net.offline = true; // fetch fails although the browser still believes it is online

  await w.send('How do I send money?');
  await w.until(() => shown(w) && delays.includes(1000));
  await clock.advance(1000);
  await w.until(() => delays.includes(2000));
  await clock.advance(2000);
  await w.until(() => delays.includes(4000));
  assert.match(status(w).textContent, /Reconnecting/);

  w.net.offline = false;
  await clock.advance(4000);
  await w.until(() => bubbles(w, 'assistant').some((m) => m.textContent === 'Go to Transfers.'));

  assert.deepEqual(delays.filter((d) => [1000, 2000, 4000].includes(d)), [1000, 2000, 4000]);
  assert.equal(svc.model.calls.length, 1);
  assert.equal(bubbles(w, 'user').length, 1);
  assert.equal(shown(w), false);
});

test('a stream dropped mid-reply is resumed: one full reply, the message processed once, same conversation', async (t) => {
  const { svc, w, clock } = await open(t, [['Go to ', 'Transfers.'], 'next']);
  w.net.cutAfterEvent = { type: 'delta', textPrefix: 'Go to ' }; // deliver a partial reply, then drop the stream

  await w.send('How do I send money?');
  await w.until(() => shown(w) && bubbles(w, 'assistant')[0]?.textContent === 'Go to ');
  assert.equal(bubbles(w, 'assistant')[0].dataset.incomplete, 'true');

  await clock.advance(1000);
  await w.until(() => bubbles(w, 'assistant').some((m) => m.textContent === 'Go to Transfers.') && !shown(w));

  assert.equal(bubbles(w, 'assistant').length, 1);
  assert.equal(bubbles(w, 'assistant')[0].dataset.incomplete, undefined);
  assert.equal(bubbles(w, 'user').length, 1);
  assert.equal(svc.model.calls.length, 1);
  assert.equal(svc.audit.records.length, 1);
  assert.equal(new Set(w.net.requests.map((r) => r.messageId)).size, 1, 'both attempts carry the same message id');

  await w.send('and then?');
  await w.until(() => bubbles(w, 'assistant').length === 2 && w.q('thinking').hidden);
  assert.equal(svc.audit.records.length, 2);
  assert.equal(svc.audit.records[0].conversationId, svc.audit.records[1].conversationId);
});

test('when every retry fails the reply is shown as incomplete with a Try again button, and trying again sends nothing twice', async (t) => {
  const { svc, w, clock } = await open(t);
  w.net.cutAfterEvent = { type: 'delta', textPrefix: 'Go to ' }; // deliver a partial reply, then drop the stream
  await w.send('How do I send money?');
  await w.until(() => shown(w) && bubbles(w, 'assistant')[0]?.dataset.incomplete === 'true');
  w.net.offline = true;
  for (let i = 0; i < 8 && !w.q('retry'); i += 1) {
    await clock.advance(30000);
    await new Promise((r) => setTimeout(r, 20));
  }
  await w.until(() => w.q('retry'));

  assert.equal(shown(w), false);
  assert.equal(bubbles(w, 'assistant')[0].dataset.incomplete, 'true');
  assert.match(w.q('incomplete').textContent, /cut off/i);
  assert.equal(w.q('retry').textContent, 'Try again');
  // Reaching the explicit Try again state is the observable signal that automatic retries stopped.

  w.net.offline = false;
  w.q('retry').click();
  await w.until(() => bubbles(w, 'assistant').some((m) => m.textContent === 'Go to Transfers.'));

  assert.equal(w.q('retry'), null);
  assert.equal(bubbles(w, 'assistant').length, 1);
  assert.equal(bubbles(w, 'user').length, 1);
  assert.equal(svc.model.calls.length, 1);
  assert.equal(new Set(w.net.requests.map((r) => r.messageId)).size, 1);
});

test('a slow network shows a status without giving up, and the reply still arrives once', async (t) => {
  const { svc, w, clock } = await open(t);
  w.net.hold = true;

  await w.send('How do I send money?');
  await w.until(() => w.net.requests.length === 1);
  await clock.advance(8000);
  await w.until(() => shown(w));
  assert.match(status(w).textContent, /slow/i);

  w.net.release();
  await w.until(() => bubbles(w, 'assistant').some((m) => m.textContent === 'Go to Transfers.') && !shown(w));
  assert.equal(svc.model.calls.length, 1);
  assert.equal(w.net.requests.length, 1);
});

test('a stalled request is dropped and retried with the same message id; the service runs it once', async (t) => {
  const { svc, w, clock } = await open(t);
  w.net.hold = true;

  await w.send('How do I send money?');
  await w.until(() => w.net.requests.length === 1);
  await clock.advance(30000); // no byte for 30 s: give up on this request
  await w.until(() => status(w)?.dataset.state === 'reconnecting');
  w.net.hold = false;
  await clock.advance(1000);
  assert.equal(w.net.requests.length, 2, 'the aborted request should be retried');
  await w.until(() => bubbles(w, 'assistant').some((m) => m.textContent === 'Go to Transfers.'));

  assert.equal(w.net.requests.length, 2);
  assert.equal(w.net.requests[0].messageId, w.net.requests[1].messageId);
  assert.equal(svc.model.calls.length, 1);
  assert.equal(bubbles(w, 'user').length, 1);
});

test('status and Try again are in French when the customer writes French', async (t) => {
  const { w } = await open(t, ['Allez dans Virements.']);
  await w.send('Comment faire un virement vers un autre compte ?');
  await w.until(() => bubbles(w, 'assistant').length === 1 && w.q('thinking').hidden);

  w.net.setOffline(true, w.dom.window);
  await w.send('et ensuite ?');
  await w.until(() => shown(w));
  assert.match(status(w).textContent, /Reconnexion/);
});
