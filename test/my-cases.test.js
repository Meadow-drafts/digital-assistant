import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeModel } from './harness/fake-model.js';
import { AGENTS, agentLogin, call } from './harness/cases.js';
import { alice, bob, open, say, start, TENANT } from './harness/t1-helpers.js';
import { makeToken } from './harness/token.js';
import { rawFetch } from './harness/session-fetch.js';

const MIN = 60_000;
const HOUR = 60 * MIN;

// Two customers with verified sessions. Each can open cases and list their own with the token alone.
async function twoCustomers(t, extra = {}) {
  const [a, b] = [alice(), bob()];
  const svc = await start({ customers: [a, b], model: createFakeModel(['ok']), ...extra });
  t.after(svc.close);
  const who = async (c) => {
    const { conversationId } = await open(svc, c);
    return {
      conversationId, token: c.token, sub: c.sub,
      handoff: () => call(svc.baseUrl, 'POST', '/handoff', { token: c.token, body: { conversationId, tenant: TENANT } }),
      cancel: () => call(svc.baseUrl, 'POST', '/case/cancel', { token: c.token, body: { conversationId } }),
      feedback: (solved) => call(svc.baseUrl, 'POST', '/case/feedback', { token: c.token, body: { conversationId, solved } }),
      mine: () => call(svc.baseUrl, 'GET', '/case/mine', { token: c.token }),
      detail: (ref) => call(svc.baseUrl, 'GET', `/case/mine/${ref}`, { token: c.token }),
    };
  };
  return { svc, a: await who(a), b: await who(b) };
}

test('User A lists only A\'s cases and User B only B\'s: the owner comes from the token, never from a parameter', async (t) => {
  const { a, b } = await twoCustomers(t);
  const refA = (await a.handoff()).body.ref;
  const refB = (await b.handoff()).body.ref;

  const listA = (await a.mine()).body.cases.map((c) => c.ref);
  const listB = (await b.mine()).body.cases.map((c) => c.ref);

  assert.deepEqual(listA, [refA]);
  assert.deepEqual(listB, [refB]);
});

const LONG_SESSION = { ...AGENTS, sessionMs: 1000 * HOUR };
const iso = (svc) => new Date(svc.clock.now()).toISOString();
const entry = async (who, ref) => (await who.mine()).body.cases.find((c) => c.ref === ref);

test('each case shows the state the customer sees, matching the real handoff state through claim, transfer, resolve, reopen and cancel', async (t) => {
  const { svc, a } = await twoCustomers(t, { agents: LONG_SESSION });
  const aline = await agentLogin(svc.baseUrl, 'aline');
  const paul = await agentLogin(svc.baseUrl, 'paul');
  const openedAt = iso(svc);
  const ref = (await a.handoff()).body.ref;

  assert.deepEqual(await entry(a, ref), { ref, state: 'waiting', openedAt, updatedAt: openedAt });

  await svc.clock.advance(2 * MIN);
  await aline.claim(ref);
  assert.deepEqual(await entry(a, ref), { ref, state: 'with_agent', openedAt, updatedAt: iso(svc) });

  await svc.clock.advance(MIN);
  await aline.transfer(ref, 'paul');
  assert.equal((await entry(a, ref)).state, 'with_agent', 'a transfer keeps the case with an agent');
  assert.equal((await entry(a, ref)).updatedAt, iso(svc), 'the neutral transfer notice is an update');

  await svc.clock.advance(MIN);
  await paul.resolve(ref);
  assert.deepEqual(await entry(a, ref), { ref, state: 'resolved', openedAt, updatedAt: iso(svc) });

  await svc.clock.advance(MIN);
  await a.feedback(false); // "No" inside the window reopens the same case
  assert.deepEqual(await entry(a, ref), { ref, state: 'with_agent', openedAt, updatedAt: iso(svc) });
  assert.equal((await a.mine()).body.cases.length, 1, 'the same case, not a second one');
});

test('a case the customer cancelled is shown as cancelled, and an automatic resolution as resolved', async (t) => {
  const { svc, a, b } = await twoCustomers(t, { agents: LONG_SESSION });
  const cancelled = (await a.handoff()).body.ref;
  await a.cancel();
  assert.equal((await entry(a, cancelled)).state, 'cancelled');

  const ref = (await b.handoff()).body.ref;
  await (await agentLogin(svc.baseUrl, 'aline')).claim(ref);
  await svc.clock.advance(24 * HOUR);
  assert.equal((await entry(b, ref)).state, 'resolved');
});

async function resolvedThen(t, wait) {
  const ctx = await twoCustomers(t, { agents: LONG_SESSION });
  const aline = await agentLogin(ctx.svc.baseUrl, 'aline');
  const first = (await ctx.a.handoff()).body.ref;
  await aline.claim(first);
  await aline.resolve(first);
  await ctx.svc.clock.advance(wait);
  return { ...ctx, first, answer: (await ctx.a.feedback(false)).body.ref };
}

test('the 72-hour rule: "No" at exactly 72 h still reopens the same case', async (t) => {
  const { a, first, answer } = await resolvedThen(t, 72 * HOUR);

  assert.equal(answer, first);
  assert.deepEqual((await a.mine()).body.cases.map((c) => [c.ref, c.state]), [[first, 'with_agent']]);
});

test('the 72-hour rule: 1 s later a new linked case opens, listed first, and the old one stays resolved', async (t) => {
  const { a, first, answer } = await resolvedThen(t, 72 * HOUR + 1000);

  assert.notEqual(answer, first);
  const list = (await a.mine()).body.cases;
  assert.deepEqual(list.map((c) => [c.ref, c.state]), [[answer, 'waiting'], [first, 'resolved']], 'newest first');
});

test('User B cannot open or learn about User A\'s case: same 404 as a case that does not exist, whatever parameters B adds', async (t) => {
  const { svc, a, b } = await twoCustomers(t);
  const refA = (await a.handoff()).body.ref;

  const asB = await b.detail(refA);
  const nothing = await b.detail('C-9999');

  assert.equal(asB.status, 404);
  assert.deepEqual(asB.body, nothing.body, 'no hint that the reference exists');
  assert.equal((await b.detail(refA)).body.conversationId, undefined);
  // The owner is never read from the request: owner, user, cli and conversation parameters change nothing.
  for (const extra of [`owner=${a.sub}`, `user=${a.sub}`, `cli=CLI-A`, `conversationId=${a.conversationId}`]) {
    const list = await call(svc.baseUrl, 'GET', `/case/mine?${extra}`, { token: b.token });
    assert.deepEqual(list.body.cases, [], `?${extra}`);
    assert.equal((await call(svc.baseUrl, 'GET', `/case/mine/${refA}?${extra}`, { token: b.token })).status, 404, `?${extra}`);
  }
  assert.equal((await call(svc.baseUrl, 'POST', '/case/mine', { token: b.token, body: { owner: a.sub } })).status, 404);
});

test('without a session there is no list and no detail (no token, or a token alone), and a customer with no cases gets an empty list', async (t) => {
  const { svc, a, b } = await twoCustomers(t);
  const ref = (await a.handoff()).body.ref;

  for (const path of ['/case/mine', `/case/mine/${ref}`]) {
    assert.equal((await rawFetch(`${svc.baseUrl}${path}`)).status, 401, `${path} with nothing`);
    assert.equal((await rawFetch(`${svc.baseUrl}${path}`, { headers: { authorization: `Bearer ${a.token}` } })).status, 401, `${path} with the token alone`);
  }
  assert.deepEqual((await b.mine()).body, { cases: [] });
});

// A draft sent by email only: a reference and a recorded case, no chat.
async function emailOnly(who, text = 'Please look into my payment.') {
  const post = (path, body) => call(who.baseUrl, 'POST', path, { token: who.token, body: { conversationId: who.conversationId, ...body } });
  const draft = (await post('/draft', {})).body;
  const shown = (await post('/draft/preview', { draftId: draft.draftId, text, destination: 'email' })).body;
  return (await post('/draft/confirm', { draftId: draft.draftId, previewToken: shown.previewToken })).body.ref;
}

test('an email-only case is listed as emailed with its reference and date, no chat to go back to, and the customer gets no extra email', async (t) => {
  const { svc, a } = await twoCustomers(t);
  a.baseUrl = svc.baseUrl;
  const sentBefore = svc.mailer.outbox.length;
  const ref = await emailOnly(a);

  const [listed] = (await a.mine()).body.cases;
  assert.deepEqual(listed, { ref, state: 'emailed', openedAt: iso(svc), updatedAt: iso(svc) });
  const detail = (await a.detail(ref)).body;
  assert.equal(detail.state, 'emailed');
  assert.equal(detail.conversationId, undefined);
  assert.deepEqual(svc.mailer.outbox.slice(sentBefore).map((m) => m.to), ['support@example.test'], 'only the support mail of ticket 31');
});

test('an email-only case belongs to its owner and expires with the retention period like a closed case', async (t) => {
  const DAY = 24 * HOUR;
  const { svc, a, b } = await twoCustomers(t, { retention: { ms: 30 * DAY } });
  a.baseUrl = svc.baseUrl;
  const ref = await emailOnly(a);

  assert.deepEqual((await b.mine()).body.cases, []);
  assert.equal((await b.detail(ref)).status, 404);
  await svc.clock.advance(30 * DAY);
  assert.equal((await a.mine()).body.cases.length, 1);
  await svc.clock.advance(1000);
  assert.deepEqual((await a.mine()).body.cases, []);
});

test('selecting an open case returns the chat to go back to; a closed one shows its status only', async (t) => {
  const { svc, a } = await twoCustomers(t, { agents: LONG_SESSION });
  const ref = (await a.handoff()).body.ref;

  const open = (await a.detail(ref)).body;
  assert.equal(open.ref, ref);
  assert.equal(open.state, 'waiting');
  assert.equal(open.conversationId, a.conversationId);
  // That conversation is the customer's own, so the existing chat-side status call continues from it.
  assert.equal((await call(svc.baseUrl, 'GET', `/case?conversationId=${open.conversationId}`, { token: a.token })).body.ref, ref);

  await a.cancel();
  const closed = (await a.detail(ref)).body;
  assert.equal(closed.state, 'cancelled');
  assert.equal(closed.conversationId, undefined);
});

test('only cases inside the retention period are listed: exactly the period is still in, 1 s later it is out; open cases stay', async (t) => {
  const DAY = 24 * HOUR;
  const { svc, a, b } = await twoCustomers(t, { retention: { ms: 30 * DAY } });
  const closed = (await a.handoff()).body.ref;
  await a.cancel();
  const live = (await b.handoff()).body.ref;

  await svc.clock.advance(30 * DAY);
  assert.deepEqual((await a.mine()).body.cases.map((c) => c.ref), [closed]);
  assert.equal((await a.detail(closed)).status, 200);

  await svc.clock.advance(1000);
  assert.deepEqual((await a.mine()).body.cases, []);
  assert.equal((await a.detail(closed)).status, 404);
  assert.deepEqual((await b.mine()).body.cases.map((c) => c.ref), [live], 'a case still open is live work');
});

// ---- Emailed confirmation when a case opens ----
const toCustomer = (svc, c) => svc.mailer.outbox.filter((m) => m.to === `${c.sub}@mail.test`);

async function openedWith(t, message, extra = {}) {
  const c = alice();
  const svc = await start({ customers: [c], model: createFakeModel(['ok']), ...extra });
  t.after(svc.close);
  const { conversationId } = await open(svc, c);
  await say(svc, c, message, conversationId);
  const opened = await call(svc.baseUrl, 'POST', '/handoff', { token: c.token, body: { conversationId, tenant: TENANT } });
  return { svc, c, conversationId, opened };
}

test('when a case opens the customer is emailed its reference, with a fixed sentence and none of their words or numbers', async (t) => {
  const { svc, c, opened } = await openedWith(t, 'I sent 15000 to 237677000999 by mistake, account 12345678901');

  const [mail, ...more] = toCustomer(svc, c);
  assert.equal(more.length, 0, 'one confirmation');
  assert.match(mail.subject, new RegExp(opened.body.ref));
  assert.match(mail.body, new RegExp(opened.body.ref));
  assert.match(mail.body, /within 24 hours/i);
  assert.doesNotMatch(JSON.stringify(mail), /mistake|15000|237677000999|12345678901|sent/i, 'no message content');
  assert.ok(svc.audit.records.some((r) => r.outcome === 'case_confirmation_emailed' && r.caseRef === opened.body.ref));
});

test('the confirmation is in the language of the conversation', async (t) => {
  const { svc, c, opened } = await openedWith(t, 'Mon virement est parti vers la mauvaise personne');

  const [mail] = toCustomer(svc, c);
  assert.match(mail.subject, new RegExp(`${opened.body.ref}.*demande`, 'i'));
  assert.match(mail.body, /24 heures/);
});

test('after hours the customer gets one email, not a confirmation on top of the queued notice', async (t) => {
  const { createFakeClock } = await import('./harness/fake-clock.js');
  const { svc, c } = await openedWith(t, 'Hello', { clock: createFakeClock(Date.parse('2026-10-16T17:30:00Z')) });

  assert.equal(toCustomer(svc, c).length, 1);
});

test('a reopened case is not confirmed again; a new linked case is, with its own reference', async (t) => {
  const { svc, c, conversationId, opened } = await openedWith(t, 'Hello', { agents: LONG_SESSION });
  const aline = await agentLogin(svc.baseUrl, 'aline');
  const feedback = (solved) => call(svc.baseUrl, 'POST', '/case/feedback', { token: c.token, body: { conversationId, solved } });
  await aline.claim(opened.body.ref);
  await aline.resolve(opened.body.ref);

  await feedback(false);
  assert.equal(toCustomer(svc, c).length, 1, 'same case: no second confirmation');

  await aline.resolve(opened.body.ref);
  await svc.clock.advance(72 * HOUR + 1000);
  const next = (await feedback(false)).body.ref;
  assert.deepEqual(toCustomer(svc, c).map((m) => m.subject.includes(next)), [false, true]);
});

test('no email address or a failing mailer never stops the case from opening', async (t) => {
  const { svc, opened } = await openedWith(t, 'Hello', { mailer: { async send(m) { if (!m.to.startsWith('aline')) throw new Error('smtp down'); } } });

  assert.equal(opened.body.state, 'waiting');
  assert.ok(svc.audit.records.some((r) => r.outcome === 'case_confirmation_emailed_failed'));

  const bare = await call(svc.baseUrl, 'POST', '/handoff', { token: makeToken('237600000999'), body: {} });
  assert.equal(bare.body.state, 'waiting');
  assert.ok(svc.audit.records.some((r) => r.outcome === 'customer_email_missing' && r.caseRef === bare.body.ref));
});
