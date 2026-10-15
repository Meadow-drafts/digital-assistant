import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeModel } from './harness/fake-model.js';
import { rawFetch } from './harness/session-fetch.js';
import { call } from './harness/cases.js';
import { makeToken } from './harness/token.js';
import { alice, bob, open, start, TENANT } from './harness/t1-helpers.js';
import { ownerOf } from '../src/identity.js';

const HOUR = 60 * 60_000;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

// Alice has a verified session, a conversation and an open case. Everything below tries to reach them as someone else.
async function world(t, extra = {}) {
  const [a, b] = [alice(), bob()];
  const svc = await start({ customers: [a, b], model: createFakeModel(['ok']), ...extra });
  t.after(svc.close);
  const sa = await open(svc, a);
  const sb = await open(svc, b);
  const handoff = await call(svc.baseUrl, 'POST', '/handoff', { token: a.token, body: { conversationId: sa.conversationId, tenant: TENANT } });
  return { svc, a, b, sa, sb, ref: handoff.body.ref };
}

// A request that carries exactly the headers given: no automatic session id.
async function raw(svc, method, path, { token, session, body } = {}) {
  const res = await rawFetch(`${svc.baseUrl}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(session ? { 'x-assistant-session': session } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, text: await res.text() };
}

// Every customer route, aimed at Alice's conversation, case and draft.
const routes = (w) => [
  ['POST', '/chat', { message: 'hello', conversationId: w.sa.conversationId, tenant: TENANT }],
  ['POST', '/unlock', { conversationId: w.sa.conversationId, pinHash: 'a'.repeat(128) }],
  ['POST', '/handoff', { conversationId: w.sa.conversationId }],
  ['GET', `/case?conversationId=${w.sa.conversationId}`],
  ['POST', '/case/cancel', { conversationId: w.sa.conversationId }],
  ['POST', '/case/feedback', { conversationId: w.sa.conversationId, solved: false }],
  ['POST', '/draft', { conversationId: w.sa.conversationId }],
  ['POST', '/draft/preview', { conversationId: w.sa.conversationId, draftId: 'x', text: 'hi', destination: 'chat' }],
  ['POST', '/draft/confirm', { conversationId: w.sa.conversationId, draftId: 'x', previewToken: 'x' }],
  ['GET', '/case/mine'],
  ['GET', `/case/mine/${w.ref}`],
  ['POST', '/session', { cli: 'CLI-A', tenant: TENANT, conversationId: w.sa.conversationId }],
];

// Ways to pretend to be Alice (or anyone) without having been through the gateway check.
const impostors = (w) => {
  const forged = makeToken(w.a.sub, '-forged'); // names Alice's subject, but the gateway does not know it
  const [payload] = w.sa.sessionId.split('.');
  return {
    'a forged token naming Alice, no session id': { token: forged },
    'no token and no session id': {},
    'a forged token with a made-up session id': { token: forged, session: 'not-a-session' },
    'Alice\'s session id with Bob\'s real token': { token: w.b.token, session: w.sa.sessionId },
    'Alice\'s payload with Bob\'s signature': { token: forged, session: `${payload}.${w.sb.sessionId.split('.')[1]}` },
    'a payload edited to name Alice, signature kept': { token: w.b.token, session: `${b64({ o: ownerOf(w.a.token), e: Date.now() + 99 * HOUR })}.${w.sb.sessionId.split('.')[1]}` },
    'Bob\'s own session on Alice\'s ids': { token: w.b.token, session: w.sb.sessionId },
  };
};

test('the session start returns a signed session id that is not the token', async (t) => {
  const { a, sa } = await world(t);

  assert.equal(typeof sa.sessionId, 'string');
  assert.ok(sa.sessionId.length > 40);
  assert.ok(!sa.sessionId.includes(a.token));
  assert.ok(!sa.sessionId.includes(a.sub), 'the raw subject is not in it');
});

test('no customer route lets an impostor reach Alice\'s conversation, case or draft, whatever they forge', async (t) => {
  const w = await world(t);
  const attempts = [];

  for (const [who, creds] of Object.entries(impostors(w))) {
    for (const [method, path, body] of routes(w)) {
      // Bob's own session may open Bob's things, but never Alice's: it must not read, change or reveal hers.
      const res = await raw(w.svc, method, path, { ...creds, body });
      attempts.push({ who, method, path, status: res.status });
      // Bob's own valid session may read Bob's own (empty) list; that is not Alice's.
      const fine = [401, 403, 404, ...(who.startsWith('Bob\'s own') && path === '/case/mine' ? [200] : [])];
      assert.ok(fine.includes(res.status), `${who}: ${method} ${path} answered ${res.status}`);
      assert.doesNotMatch(res.text, new RegExp(`${w.ref}|${w.a.sub}|CLI-A`), `${who}: ${method} ${path} leaked something of Alice's`);
    }
  }

  assert.ok(attempts.length >= 7 * 12);
  // Nothing of hers moved: still one open case, still waiting, and no case appeared for anyone else.
  const mine = await call(w.svc.baseUrl, 'GET', '/case/mine', { token: w.a.token });
  assert.deepEqual(mine.body.cases.map((c) => [c.ref, c.state]), [[w.ref, 'waiting']]);
  assert.deepEqual((await call(w.svc.baseUrl, 'GET', '/case/mine', { token: w.b.token })).body.cases, []);
});

test('a missing or forged session id never turns into a guest: it is 401, so the widget starts a new session', async (t) => {
  const w = await world(t);

  for (const session of ['junk', `${w.sa.sessionId}x`, w.sa.sessionId.split('.')[0]]) {
    const res = await raw(w.svc, 'GET', '/case/mine', { token: w.a.token, session });
    assert.equal(res.status, 401, session);
    const chat = await raw(w.svc, 'POST', '/chat', { token: w.a.token, session, body: { message: 'hi' } });
    assert.equal(chat.status, 401, `chat with ${session}`);
  }
});

test('My cases needs a verified session: a guest (token only, no session id) is refused, not shown an empty list', async (t) => {
  const w = await world(t);

  assert.equal((await raw(w.svc, 'GET', '/case/mine', { token: w.a.token })).status, 401);
  assert.equal((await raw(w.svc, 'GET', '/case/mine')).status, 401);
});

test('a guest chat still works for how-to help with a token or none, and cannot be continued by a verified customer or another guest', async (t) => {
  const w = await world(t);
  const guest = await raw(w.svc, 'POST', '/chat', { token: 'guest-token', body: { message: 'How do I send money?' } });
  assert.equal(guest.status, 200);
  const id = /"conversationId":"([^"]+)"/.exec(guest.text)[1];

  const other = await raw(w.svc, 'POST', '/chat', { token: 'other-token', body: { message: 'hi', conversationId: id } });
  const verified = await call(w.svc.baseUrl, 'POST', '/chat', { token: w.a.token, body: { message: 'hi', conversationId: id } });
  const same = await raw(w.svc, 'POST', '/chat', { token: 'guest-token', body: { message: 'again', conversationId: id } });

  assert.equal(other.status, 404);
  assert.equal(verified.status, 404);
  assert.equal(same.status, 200);
});

test('the session id ends with the session: after the configured lifetime (8 hours by default)', async (t) => {
  const w = await world(t, { sessionTtlMs: 8 * HOUR });
  const alive = () => call(w.svc.baseUrl, 'GET', '/case/mine', { token: w.a.token });

  await w.svc.clock.advance(8 * HOUR - 1000);
  assert.equal((await alive()).status, 200);
  await w.svc.clock.advance(1000);
  assert.equal((await alive()).status, 401, 'expired');
});

test('a token with an expiry ends the session at that moment', async (t) => {
  const exp = Math.floor(Date.UTC(2026, 9, 12, 9, 0, 0) / 1000) + 600;
  const sub = '237690000111';
  const token = `${b64({ alg: 'none' })}.${b64({ sub, exp })}.sig`;
  const a = { ...alice(), token };
  const svc = await start({ customers: [a], model: createFakeModel(['ok']) }); // long lifetime: only the token's expiry ends it
  t.after(svc.close);
  await open(svc, a, { token });

  await svc.clock.advance(600_000 - 1000);
  assert.equal((await call(svc.baseUrl, 'GET', '/case/mine', { token })).status, 200);
  await svc.clock.advance(1000);
  assert.equal((await call(svc.baseUrl, 'GET', '/case/mine', { token })).status, 401);
});

test('the same customer with a refreshed token (same subject) keeps their session id', async (t) => {
  const w = await world(t);
  const refreshed = makeToken(w.a.sub, '-refreshed');
  // The gateway fixtures know only the original token, so the refreshed one is checked by the service alone here:
  // the session id was already issued for this subject and must still match it.
  const res = await raw(w.svc, 'GET', '/case/mine', { token: refreshed, session: w.sa.sessionId });
  assert.equal(res.status, 200);
  assert.match(res.text, new RegExp(w.ref));
});

test('a conversation a customer began as a guest is theirs once their session starts, with its cases', async (t) => {
  const a = alice();
  const svc = await start({ customers: [a], model: createFakeModel(['ok']) });
  t.after(svc.close);
  const guest = await rawFetch(`${svc.baseUrl}/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${a.token}` }, body: JSON.stringify({ message: 'Hello' }),
  });
  const id = /"conversationId":"([^"]+)"/.exec(await guest.text())[1];
  const asGuest = await raw(svc, 'POST', '/handoff', { token: a.token, body: { conversationId: id } });
  const ref = JSON.parse(asGuest.text).ref;

  const started = await open(svc, a, { conversationId: id });

  assert.equal(started.conversationId, id);
  const list = await raw(svc, 'GET', '/case/mine', { token: a.token, session: started.sessionId });
  assert.deepEqual(JSON.parse(list.text).cases.map((c) => c.ref), [ref]);
});

test('the service refuses Bob a session on Alice\'s conversation', async (t) => {
  const w = await world(t);

  const res = await open(w.svc, w.b, { conversationId: w.sa.conversationId });

  assert.equal(res.status, 404);
});
