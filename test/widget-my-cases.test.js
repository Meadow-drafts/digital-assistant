import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeModel } from './harness/fake-model.js';
import { openWidget } from './harness/open-widget.js';
import { AGENTS, agentLogin, call } from './harness/cases.js';
import { alice, bob, open, start, TENANT } from './harness/t1-helpers.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const LONG_SESSION = { ...AGENTS, sessionMs: 1000 * HOUR };

// Alice (the widget's customer) and Bob, both with verified sessions on a service with fake model, gateway and mailer.
async function world(t, extra = {}) {
  const [a, b] = [alice(), bob()];
  const svc = await start({ customers: [a, b], model: createFakeModel(['ok']), agents: LONG_SESSION, ...extra });
  t.after(svc.close);
  // A case for a customer, opened through the API on a session of their own.
  const caseFor = async (c) => {
    const { conversationId } = await open(svc, c);
    const opened = await call(svc.baseUrl, 'POST', '/handoff', { token: c.token, body: { conversationId, tenant: TENANT } });
    return { ref: opened.body.ref, conversationId, cancel: () => call(svc.baseUrl, 'POST', '/case/cancel', { token: c.token, body: { conversationId } }) };
  };
  // A case the customer only emailed to support (draft sent by email).
  const emailedFor = async (c) => {
    const { conversationId } = await open(svc, c);
    const post = (path, body) => call(svc.baseUrl, 'POST', path, { token: c.token, body: { conversationId, ...body } });
    const draft = (await post('/draft', {})).body;
    const shown = (await post('/draft/preview', { draftId: draft.draftId, text: 'Please look into my payment.', destination: 'email' })).body;
    return (await post('/draft/confirm', { draftId: draft.draftId, previewToken: shown.previewToken })).body.ref;
  };
  return { svc, a, b, caseFor, emailedFor };
}

// The widget on the demo host page, signed in as `c`.
async function widgetFor(svc, t, c, { lang, withCli = true } = {}) {
  const w = await openWidget(svc.baseUrl);
  t.after(() => w.dom.window.close());
  const el = w.document.querySelector('bank-assistant');
  el.setAttribute('token', c.token);
  if (withCli) el.setAttribute('cli', c.cli);
  el.setAttribute('tenant', TENANT);
  el.setAttribute('gating', JSON.stringify({ usePackages: false }));
  el.setAttribute('poll-ms', '20');
  if (lang) { el.setAttribute('lang', lang); el.render(); }
  const sent = [];
  const real = w.dom.window.fetch;
  w.dom.window.fetch = (url, init) => { sent.push({ url: String(url), headers: init?.headers ?? {} }); return real(url, init); };
  w.sent = sent;
  return w;
}
const rows = (w) => w.qa('my-case');
const openList = async (w) => { w.q('my-cases-button').click(); await w.until(() => !w.q('my-cases-panel').hidden && !w.q('my-cases-loading').textContent); };

test('"My cases" lists the customer\'s own cases newest first: reference, opened date, state and last update; nobody else\'s', async (t) => {
  const { svc, a, b, caseFor } = await world(t);
  const first = await caseFor(a);
  await (await agentLogin(svc.baseUrl, 'aline')).claim(first.ref);
  await svc.clock.advance(5 * MIN);
  await caseFor(b);
  const second = await caseFor(a);
  const w = await widgetFor(svc, t, a);

  await openList(w);

  assert.equal(rows(w).length, 2, 'only the two cases of this customer');
  assert.match(rows(w)[0].textContent, new RegExp(second.ref));
  assert.match(rows(w)[0].textContent, /waiting for an agent/i);
  assert.match(rows(w)[1].textContent, new RegExp(first.ref));
  assert.match(rows(w)[1].textContent, /with an agent/i);
  const [opened, updated] = rows(w)[1].querySelectorAll('time');
  assert.equal(opened.getAttribute('datetime'), '2026-10-12T09:00:00.000Z');
  assert.equal(updated.getAttribute('datetime'), '2026-10-12T09:00:00.000Z', 'claimed at the moment it opened');
});

test('the widget sends the signed session id it was given on the list call, and it is not the token', async (t) => {
  const { svc, a } = await world(t);
  const w = await widgetFor(svc, t, a);

  await openList(w);

  const list = w.sent.find((s) => s.url.endsWith('/case/mine'));
  assert.match(list.headers['x-assistant-session'], /^[\w-]+\.[\w-]+$/);
  assert.ok(!list.headers['x-assistant-session'].includes(a.token));
});

test('with no cases the list says so', async (t) => {
  const { svc, a } = await world(t);
  const w = await widgetFor(svc, t, a);

  await openList(w);

  assert.equal(rows(w).length, 0);
  assert.match(w.q('my-cases-empty').textContent, /no cases/i);
});

test('without a customer id there is no session: the list asks the customer to sign in and asks the service for nothing', async (t) => {
  const { svc, a } = await world(t);
  const w = await widgetFor(svc, t, a, { withCli: false });

  await openList(w);

  assert.match(w.q('my-cases-error').textContent, /sign in/i);
  assert.equal(rows(w).length, 0);
  assert.equal(w.sent.some((s) => s.url.endsWith('/case/mine')), false);
});

test('when the session has expired the list fails once, and the next click starts a new session and works', async (t) => {
  const { svc, a, caseFor } = await world(t, { sessionTtlMs: HOUR });
  const { ref } = await caseFor(a);
  const w = await widgetFor(svc, t, a);
  await openList(w);
  assert.equal(rows(w).length, 1);

  await svc.clock.advance(2 * HOUR);
  await openList(w);
  assert.match(w.q('my-cases-error').textContent, /could not load/i);

  await openList(w);
  assert.equal(w.q('my-cases-error').textContent, '');
  assert.match(rows(w)[0].textContent, new RegExp(ref));
});

test('selecting an open case shows its status and returns to that chat; the banner is back with the same reference', async (t) => {
  const { svc, a, caseFor } = await world(t);
  const { ref } = await caseFor(a);
  const w = await widgetFor(svc, t, a); // a fresh page: this widget knows nothing about the case yet
  assert.ok(w.q('case-banner').hidden);

  await openList(w);
  rows(w)[0].click();
  await w.until(() => !w.q('my-case-detail').hidden);
  assert.match(w.q('my-case-detail').textContent, new RegExp(ref));
  assert.match(w.q('my-case-detail').textContent, /waiting for an agent/i);
  w.q('my-case-open-chat').click();
  await w.until(() => !w.q('case-banner').hidden);

  assert.match(w.q('case-ref').textContent, new RegExp(ref));
  assert.match(w.q('case-state').textContent, /waiting for an agent/i);
  assert.ok(w.q('my-cases-panel').hidden, 'the list is out of the way');
  // The chat is live again: an agent claiming shows up through the normal poll.
  await (await agentLogin(svc.baseUrl, 'aline')).claim(ref);
  await w.until(() => /with an agent/i.test(w.q('case-state').textContent));
});

test('selecting a closed case shows its status (cancelled) and offers no chat to go back to', async (t) => {
  const { svc, a, caseFor } = await world(t);
  const c = await caseFor(a);
  await c.cancel();
  const w = await widgetFor(svc, t, a);

  await openList(w);
  assert.match(rows(w)[0].textContent, /cancelled/i);
  rows(w)[0].click();
  await w.until(() => !w.q('my-case-detail').hidden);

  assert.match(w.q('my-case-detail').textContent, new RegExp(`${c.ref}.*cancelled|cancelled.*${c.ref}`, 'is'));
  assert.equal(w.q('my-case-open-chat').hidden, true);
  assert.ok(w.q('case-banner').hidden);
});

test('an email-only case is listed as "Emailed to support" with its reference and date, a note that progress cannot be tracked here, and no chat to open', async (t) => {
  const { svc, a, emailedFor } = await world(t);
  const ref = await emailedFor(a);
  const w = await widgetFor(svc, t, a);

  await openList(w);

  assert.equal(rows(w).length, 1);
  assert.match(rows(w)[0].textContent, new RegExp(ref));
  assert.match(rows(w)[0].textContent, /emailed to support/i);
  assert.match(rows(w)[0].textContent, /cannot be tracked here/i);
  assert.equal(rows(w)[0].querySelectorAll('time').length, 1, 'a date to show, but no "last update" that suggests progress');
  assert.equal(rows(w)[0].querySelector('time').getAttribute('datetime'), '2026-10-12T09:00:00.000Z');
  rows(w)[0].click();
  await w.until(() => !w.q('my-case-detail').hidden);
  assert.match(w.q('my-case-detail').textContent, /cannot be tracked here/i);
  assert.equal(w.q('my-case-open-chat').hidden, true);
});

test('the list is in French when the widget is', async (t) => {
  const { svc, a, caseFor, emailedFor } = await world(t);
  await caseFor(a);
  await emailedFor(a);
  const w = await widgetFor(svc, t, a, { lang: 'fr' });

  await openList(w);

  assert.match(w.q('my-cases-button').textContent, /mes dossiers/i);
  assert.match(rows(w)[0].textContent, /e-mail à l'assistance/i);
  assert.match(rows(w)[0].textContent, /ne peut pas être suivi/i);
  assert.match(rows(w)[1].textContent, /en attente d'un agent/i);
});
