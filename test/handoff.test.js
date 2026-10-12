import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService } from './harness/start-service.js';
import { createFakeModel } from './harness/fake-model.js';
import { customer } from './harness/cases.js';

test('a customer click opens a waiting case with a reference, told we will update within 24 hours, never a resolution', async (t) => {
  const svc = await startService({ model: createFakeModel(['Open Transfers.']) });
  t.after(svc.close);
  const c = await customer(svc.baseUrl);

  const res = await c.handoff();

  assert.equal(res.status, 200);
  assert.equal(res.body.state, 'waiting');
  assert.match(res.body.ref, /^C-\d{4,}$/);
  assert.equal(res.body.conversationId, c.conversationId);
  assert.match(res.body.notice, /we will update you within 24 hours/i);
  assert.doesNotMatch(res.body.notice, /resolv|solved|fixed/i);
});

test('opening a handoff pages the on-call agent by email with only a link and the conversation id', async (t) => {
  const svc = await startService({ model: createFakeModel(['Open Transfers.']) });
  t.after(svc.close);
  const c = await customer(svc.baseUrl, 'test-token', 'I sent 25000 to the wrong person, please reverse it');

  const { body } = await c.handoff();

  assert.equal(svc.mailer.outbox.length, 1);
  const [mail] = svc.mailer.outbox;
  assert.equal(mail.to, 'aline@bank.test');
  assert.match(mail.subject, new RegExp(body.ref));
  assert.match(mail.body, new RegExp(c.conversationId));
  assert.match(mail.body, /https:\/\/support\.bank\.test\/console/);
  assert.doesNotMatch(`${mail.subject}\n${mail.body}`, /wrong person|25000|reverse/i, 'no message content travels by email');
});

test('the customer sees the case reference and elapsed waiting time, from the controllable clock', async (t) => {
  const svc = await startService({ model: createFakeModel(['ok']) });
  t.after(svc.close);
  const c = await customer(svc.baseUrl);
  const opened = await c.handoff();

  await svc.clock.advance(125_000);
  const { status, body } = await c.status();

  assert.equal(status, 200);
  assert.equal(body.state, 'waiting');
  assert.equal(body.ref, opened.body.ref);
  assert.equal(body.elapsedSeconds, 125);
  assert.match(body.notice, /within 24 hours/i);
});

test('a conversation with no case is in the bot state', async (t) => {
  const svc = await startService({ model: createFakeModel(['ok']) });
  t.after(svc.close);
  const c = await customer(svc.baseUrl);

  const { body } = await c.status();

  assert.equal(body.state, 'bot');
  assert.equal(body.ref, null);
});

test('another customer cannot see, cancel or open a case on someone else\'s conversation', async (t) => {
  const svc = await startService({ model: createFakeModel(['ok']) });
  t.after(svc.close);
  const owner = await customer(svc.baseUrl, 'token-one');
  await owner.handoff();
  const { call } = await import('./harness/cases.js');
  const intruder = { token: 'token-two' };

  const seen = await call(svc.baseUrl, 'GET', `/case?conversationId=${owner.conversationId}`, intruder);
  const cancelled = await call(svc.baseUrl, 'POST', '/case/cancel', { ...intruder, body: { conversationId: owner.conversationId } });
  const opened = await call(svc.baseUrl, 'POST', '/handoff', { ...intruder, body: { conversationId: owner.conversationId } });

  assert.deepEqual([seen.status, cancelled.status, opened.status], [404, 404, 404]);
  assert.equal((await owner.status()).body.state, 'waiting', 'the owner\'s case is untouched');
  assert.equal(svc.mailer.outbox.length, 1, 'the intruder paged nobody');
});

test('the agent console API needs an agent login: no session, a customer token or a wrong password get nothing', async (t) => {
  const svc = await startService({ model: createFakeModel(['ok']) });
  t.after(svc.close);
  const c = await customer(svc.baseUrl);
  const { ref } = (await c.handoff()).body;
  const { call, AGENTS } = await import('./harness/cases.js');

  const anonymous = await call(svc.baseUrl, 'GET', '/agent/cases');
  const asCustomer = await call(svc.baseUrl, 'GET', '/agent/cases', { token: 'test-token' });
  const openAnonymous = await call(svc.baseUrl, 'GET', `/agent/cases/${ref}`);
  const claimAnonymous = await call(svc.baseUrl, 'POST', `/agent/cases/${ref}/claim`);
  const wrong = await call(svc.baseUrl, 'POST', '/agent/login', { body: { id: 'aline', password: 'nope' } });
  const unknown = await call(svc.baseUrl, 'POST', '/agent/login', { body: { id: 'mallory', password: AGENTS.list[0].password } });

  assert.deepEqual([anonymous.status, asCustomer.status, openAnonymous.status, claimAnonymous.status, wrong.status, unknown.status], [401, 401, 401, 401, 401, 401]);
  assert.equal(JSON.stringify([anonymous.body, wrong.body, unknown.body]).includes(ref), false);
});

test('a logged-in agent sees the waiting case in the queue, unclaimed', async (t) => {
  const svc = await startService({ model: createFakeModel(['ok']) });
  t.after(svc.close);
  const c = await customer(svc.baseUrl);
  const { ref } = (await c.handoff()).body;
  const { agentLogin } = await import('./harness/cases.js');
  const aline = await agentLogin(svc.baseUrl, 'aline');

  const { status, body } = await aline.list();

  assert.equal(status, 200);
  assert.deepEqual(body.cases.map((x) => [x.ref, x.state, x.claimedBy]), [[ref, 'waiting', null]]);
});

test('an agent login lapses after the configured session length', async (t) => {
  const svc = await startService({ model: createFakeModel(['ok']), agents: { ...(await import('./harness/cases.js')).AGENTS, sessionMs: 60_000 } });
  t.after(svc.close);
  const { agentLogin } = await import('./harness/cases.js');
  const aline = await agentLogin(svc.baseUrl, 'aline');
  assert.equal((await aline.list()).status, 200);

  await svc.clock.advance(61_000);

  assert.equal((await aline.list()).status, 401);
});

test('two agents claiming the same case at the same moment: exactly one wins, the other is told it is taken', async (t) => {
  const svc = await startService({ model: createFakeModel(['ok']) });
  t.after(svc.close);
  const c = await customer(svc.baseUrl);
  const { ref } = (await c.handoff()).body;
  const { agentLogin } = await import('./harness/cases.js');
  const aline = await agentLogin(svc.baseUrl, 'aline');
  const paul = await agentLogin(svc.baseUrl, 'paul');

  const results = await Promise.all([aline.claim(ref), paul.claim(ref)]);

  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, [200, 409]);
  const loser = results.find((r) => r.status === 409);
  assert.equal(loser.body.error, 'already_claimed');
  const winnerName = results.find((r) => r.status === 200).body.claimedBy;
  assert.equal((await aline.list()).body.cases[0].claimedBy, winnerName);
  const audited = svc.audit.records.filter((e) => e.outcome === 'case_claimed');
  assert.equal(audited.length, 1, 'one claim, one audit record');
});

test('many simultaneous claims still produce exactly one winner', async (t) => {
  const svc = await startService({ model: createFakeModel(['ok']) });
  t.after(svc.close);
  const c = await customer(svc.baseUrl);
  const { ref } = (await c.handoff()).body;
  const { agentLogin } = await import('./harness/cases.js');
  const aline = await agentLogin(svc.baseUrl, 'aline');
  const paul = await agentLogin(svc.baseUrl, 'paul');

  const results = await Promise.all([aline, paul, aline, paul, aline, paul].map((a) => a.claim(ref)));

  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal(results.filter((r) => r.status === 409).length, 5);
});

test('once claimed, the customer sees the agent\'s first name only, as a human agent', async (t) => {
  const svc = await startService({ model: createFakeModel(['ok']) });
  t.after(svc.close);
  const c = await customer(svc.baseUrl);
  await c.handoff();
  const { ref } = (await c.status()).body;
  const { agentLogin } = await import('./harness/cases.js');
  const aline = await agentLogin(svc.baseUrl, 'aline');

  await aline.claim(ref);
  const { body } = await c.status();

  assert.equal(body.state, 'with_agent');
  assert.deepEqual(body.agent, { firstName: 'Aline', human: true });
  assert.doesNotMatch(JSON.stringify(body), /Mbarga|aline@bank\.test|aline-pass/);
  assert.equal(body.elapsedSeconds, undefined, 'the waiting clock stops at the claim');
});

test('claiming a case that does not exist, or one already resolved, is refused', async (t) => {
  const svc = await startService({ model: createFakeModel(['ok']) });
  t.after(svc.close);
  const { agentLogin } = await import('./harness/cases.js');
  const aline = await agentLogin(svc.baseUrl, 'aline');

  assert.equal((await aline.claim('C-9999')).status, 404);
});

async function claimedCase(svc, { first = 'How do I send money?', agent = 'aline' } = {}) {
  const { agentLogin } = await import('./harness/cases.js');
  const c = await customer(svc.baseUrl, 'test-token', first);
  const { ref } = (await c.handoff()).body;
  const who = await agentLogin(svc.baseUrl, agent);
  await who.claim(ref);
  return { c, ref, who };
}

test('once an agent has the case the bot is muted: the customer\'s message reaches the agent and the model is not called', async (t) => {
  const model = createFakeModel(['bot answer']);
  const svc = await startService({ model });
  t.after(svc.close);
  const { c, ref, who } = await claimedCase(svc);
  const before = model.calls.length;

  const { events } = await c.say('Hello, are you there?');

  assert.equal(model.calls.length, before, 'no model call while an agent has the case');
  assert.deepEqual(events.filter((e) => e.type === 'delta'), []);
  assert.equal(events.find((e) => e.type === 'case').state, 'with_agent');
  const seen = (await who.open(ref)).body.transcript;
  assert.equal(seen.at(-1).from, 'customer');
  assert.equal(seen.at(-1).text, 'Hello, are you there?');
});

test('the agent chats back in the same session and the customer receives it with a cursor', async (t) => {
  const svc = await startService({ model: createFakeModel(['ok']) });
  t.after(svc.close);
  const { c, ref, who } = await claimedCase(svc);

  const sent = await who.reply(ref, 'Hello, I am looking at your transfer now.');
  const first = await c.status();
  await who.reply(ref, 'Can you confirm the amount?');
  const later = await c.status(first.body.next);

  assert.equal(sent.status, 200);
  assert.deepEqual(first.body.messages.map((m) => [m.from, m.text]), [['agent', 'Hello, I am looking at your transfer now.']]);
  assert.deepEqual(later.body.messages.map((m) => m.text), ['Can you confirm the amount?'], 'only what is new since the cursor');
  assert.deepEqual((await c.status(later.body.next)).body.messages, []);
});

test('only the agent who claimed a case can write to it, and only while they have it', async (t) => {
  const svc = await startService({ model: createFakeModel(['ok']) });
  t.after(svc.close);
  const { ref, who } = await claimedCase(svc);
  const { agentLogin, call } = await import('./harness/cases.js');
  const paul = await agentLogin(svc.baseUrl, 'paul');
  const c2 = await customer(svc.baseUrl, 'other-customer');
  const waiting = (await c2.handoff()).body.ref;

  assert.equal((await paul.reply(ref, 'I will take over')).status, 403);
  assert.equal((await who.reply(waiting, 'not mine yet')).status, 409);
  assert.equal((await paul.resolve(ref)).status, 403);
  assert.equal((await call(svc.baseUrl, 'POST', `/agent/cases/${ref}/messages`, { token: 'test-token', body: { text: 'x' } })).status, 401);
});

test('a PIN-like message to the agent is redacted before it is stored, with the fixed warning', async (t) => {
  const svc = await startService({ model: createFakeModel(['ok']) });
  t.after(svc.close);
  const { c, ref, who } = await claimedCase(svc);

  const { events } = await c.say('my pin is 4821 please fix it');

  assert.ok(events.some((e) => e.type === 'warning' && e.code === 'secret_input'));
  const text = JSON.stringify((await who.open(ref)).body);
  assert.doesNotMatch(text, /4821/);
  assert.doesNotMatch(JSON.stringify(svc.audit.records), /4821/);
});

test('the agent resolves the case: the customer is asked "Was this solved?" and the agent can no longer write', async (t) => {
  const svc = await startService({ model: createFakeModel(['ok']) });
  t.after(svc.close);
  const { c, ref, who } = await claimedCase(svc);

  const resolved = await who.resolve(ref);
  const { body } = await c.status();

  assert.equal(resolved.status, 200);
  assert.equal(body.state, 'resolved');
  assert.equal(body.ref, ref);
  assert.equal(body.askSolved, true);
  assert.equal((await who.reply(ref, 'one more thing')).status, 409);
  assert.equal(svc.audit.records.filter((e) => e.outcome === 'case_resolved' && e.caseRef === ref).length, 1);
});

test('the customer answers "Was this solved?" once the case is resolved, and not before', async (t) => {
  const svc = await startService({ model: createFakeModel(['ok']) });
  t.after(svc.close);
  const { c, ref, who } = await claimedCase(svc);

  assert.equal((await c.feedback(true)).status, 409, 'not while the agent still has it');
  await who.resolve(ref);
  assert.equal((await c.feedback('maybe')).status, 400);
  assert.equal((await c.feedback(false)).status, 200);

  const answered = svc.audit.records.filter((e) => e.outcome === 'case_feedback');
  assert.deepEqual(answered.map((e) => [e.caseRef, e.solved]), [[ref, false]]);
  assert.equal((await c.status()).body.askSolved, false, 'the prompt goes away once answered');
});

test('after resolution the customer is back with the assistant', async (t) => {
  const model = createFakeModel(['bot is back']);
  const svc = await startService({ model });
  t.after(svc.close);
  const { c, ref, who } = await claimedCase(svc);
  await who.resolve(ref);
  const before = model.calls.length;

  const { events } = await c.say('Thanks, one more question: how do I pay a bill?');

  assert.equal(model.calls.length, before + 1);
  assert.equal(events.filter((e) => e.type === 'delta').map((e) => e.text).join(''), 'bot is back');
});

test('cancelling a waiting case returns the customer to the bot and closes it as cancelled by user', async (t) => {
  const model = createFakeModel(['bot again']);
  const svc = await startService({ model });
  t.after(svc.close);
  const c = await customer(svc.baseUrl);
  const { ref } = (await c.handoff()).body;
  const { agentLogin } = await import('./harness/cases.js');
  const aline = await agentLogin(svc.baseUrl, 'aline');

  const cancelled = await c.cancel();

  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.state, 'bot');
  assert.equal((await c.status()).body.state, 'bot');
  const row = (await aline.list()).body.cases.find((x) => x.ref === ref);
  assert.equal(row.state, 'resolved');
  assert.equal(row.closeReason, 'cancelled_by_user');
  assert.equal(svc.audit.records.filter((e) => e.outcome === 'case_cancelled' && e.caseRef === ref).length, 1);
  const { events } = await c.say('How do I pay a bill?');
  assert.equal(events.filter((e) => e.type === 'delta').map((e) => e.text).join(''), 'bot again');
});

test('a cancelled case cannot be claimed, and a claimed case cannot be cancelled', async (t) => {
  const svc = await startService({ model: createFakeModel(['ok']) });
  t.after(svc.close);
  const { agentLogin } = await import('./harness/cases.js');
  const aline = await agentLogin(svc.baseUrl, 'aline');
  const gone = await customer(svc.baseUrl, 'token-gone');
  const goneRef = (await gone.handoff()).body.ref;
  await gone.cancel();
  const kept = await customer(svc.baseUrl, 'token-kept');
  const keptRef = (await kept.handoff()).body.ref;
  await aline.claim(keptRef);

  assert.equal((await aline.claim(goneRef)).status, 409);
  assert.equal((await kept.cancel()).status, 409);
  assert.equal((await kept.status()).body.state, 'with_agent');
  assert.equal((await gone.cancel()).status, 409, 'nothing left to cancel');
});

test('after cancelling, the customer can ask for a person again and gets a new reference', async (t) => {
  const svc = await startService({ model: createFakeModel(['ok']) });
  t.after(svc.close);
  const c = await customer(svc.baseUrl);
  const first = (await c.handoff()).body.ref;
  await c.cancel();

  const second = (await c.handoff()).body;

  assert.notEqual(second.ref, first);
  assert.equal(second.state, 'waiting');
});

test('asking for a person twice while one case is open reuses it and pages nobody again', async (t) => {
  const svc = await startService({ model: createFakeModel(['ok']) });
  t.after(svc.close);
  const c = await customer(svc.baseUrl);

  const a = (await c.handoff()).body;
  const b = (await c.handoff()).body;

  assert.equal(b.ref, a.ref);
  assert.equal(svc.mailer.outbox.length, 1);
});

test('while waiting, the bot keeps answering and each chat turn says the reply is automated', async (t) => {
  const model = createFakeModel(['Open Transfers.']);
  const svc = await startService({ model });
  t.after(svc.close);
  const c = await customer(svc.baseUrl);
  const { ref } = (await c.handoff()).body;
  const before = model.calls.length;

  const { events } = await c.say('How do I pay a bill?');

  assert.equal(model.calls.length, before + 1);
  assert.equal(events.filter((e) => e.type === 'delta').map((e) => e.text).join(''), 'Open Transfers.');
  assert.deepEqual(events.find((e) => e.type === 'case'), { type: 'case', state: 'waiting', ref, automated: true });
});

test('the agent sees the whole conversation: what came before the handoff and the automated replies while waiting', async (t) => {
  const svc = await startService({ model: createFakeModel(['Open Transfers.']) });
  t.after(svc.close);
  const { agentLogin } = await import('./harness/cases.js');
  const c = await customer(svc.baseUrl, 'test-token', 'My transfer failed yesterday');
  const { ref } = (await c.handoff()).body;
  await c.say('How do I pay a bill?');
  const aline = await agentLogin(svc.baseUrl, 'aline');

  const { body } = await aline.open(ref);

  assert.deepEqual(body.transcript.map((m) => [m.from, m.text]), [
    ['customer', 'My transfer failed yesterday'],
    ['bot', 'Open Transfers.'],
    ['system', 'Case opened by the customer.'],
    ['customer', 'How do I pay a bill?'],
    ['bot', 'Open Transfers.'],
  ]);
});

test('account numbers and phone numbers are masked in the console transcript, whoever typed or said them', async (t) => {
  const svc = await startService({ model: createFakeModel(['I see account 12345678901 and 237690000111.']) });
  t.after(svc.close);
  const { agentLogin } = await import('./harness/cases.js');
  const c = await customer(svc.baseUrl, 'test-token', 'I sent money from 12345678901 to +237 690 000 111 by mistake on 2026-10-11 (25000 XAF, ref TX-20481)');
  const { ref } = (await c.handoff()).body;
  const aline = await agentLogin(svc.baseUrl, 'aline');
  await aline.claim(ref);
  await c.say('my number is 690000111');

  const { body } = await aline.open(ref);

  const text = body.transcript.map((m) => m.text).join('\n');
  assert.doesNotMatch(text, /12345678901|690 000 111|237690000111|690000111/);
  assert.match(text, /\*\*\*\*8901/);
  assert.match(text, /\*\*\*\*0111/);
  assert.match(text, /2026-10-11/, 'dates stay readable');
  assert.match(text, /25000 XAF/, 'amounts stay readable');
  assert.match(text, /TX-20481/, 'short references stay readable');
});

test('no turn, however alarming, opens a case or pages anyone: only the click does', async (t) => {
  const svc = await startService({ model: createFakeModel(['[[escalate:contact_bank]]Please contact the bank.']) });
  t.after(svc.close);
  const { agentLogin } = await import('./harness/cases.js');
  const c = await customer(svc.baseUrl, 'test-token', 'Fraud! Someone hacked my account, reverse the wrong transfer');
  await c.say('Fraud! Someone hacked my account, reverse the wrong transfer');
  await c.say('get a human agent now, I want to talk to a person');
  const aline = await agentLogin(svc.baseUrl, 'aline');

  assert.deepEqual((await aline.list()).body.cases, []);
  assert.equal((await c.status()).body.state, 'bot');
  assert.deepEqual(svc.mailer.outbox, []);
});
