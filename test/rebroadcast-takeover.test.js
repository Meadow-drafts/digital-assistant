import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService } from './harness/start-service.js';
import { createFakeModel } from './harness/fake-model.js';
import { AGENTS, agentLogin, customer } from './harness/cases.js';

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const LONG_SESSION = { ...AGENTS, sessionMs: 1000 * HOUR };

// Aline holds the case; the customer wrote "wrong person" so the case carries a draft-free history and a priority flag.
async function held(t, { first = 'I sent money to the wrong person' } = {}) {
  const svc = await startService({ model: createFakeModel(['ok']), agents: LONG_SESSION });
  t.after(svc.close);
  const c = await customer(svc.baseUrl, 'test-token', first);
  const { ref } = (await c.handoff()).body;
  const aline = await agentLogin(svc.baseUrl, 'aline');
  const paul = await agentLogin(svc.baseUrl, 'paul');
  await aline.claim(ref);
  return { svc, c, ref, aline, paul };
}

test('before the 30-minute re-broadcast a held case is closed to every agent except the holder', async (t) => {
  const { svc, ref, paul } = await held(t);
  await svc.clock.advance(30 * MIN - SEC);

  const denied = await paul.open(ref);
  assert.equal(denied.status, 403);
  assert.deepEqual(denied.body, { error: 'not_your_case', claimedBy: 'Aline Mbarga' });
  assert.equal((await paul.claim(ref)).status, 409, 'and cannot be claimed either');
  assert.equal((await paul.list()).body.cases.find((x) => x.ref === ref).claimable, false);
});

test('the 30-minute boundary: closed at -1 s, open exactly at 30 minutes, still open at +1 s', async (t) => {
  const { svc, ref, paul } = await held(t);

  await svc.clock.advance(30 * MIN - SEC);
  assert.equal((await paul.open(ref)).status, 403);
  await svc.clock.advance(SEC);
  assert.equal((await paul.open(ref)).status, 200, 'exactly 30 minutes');
  await svc.clock.advance(SEC);
  assert.equal((await paul.open(ref)).status, 200, '30 minutes and a second');
});

test('after the re-broadcast any other agent can open the case and the list marks it claimable', async (t) => {
  const { svc, c, ref, aline, paul } = await held(t);
  await c.say('More detail about the transfer');
  await svc.clock.advance(30 * MIN);

  const { status, body } = await paul.open(ref);
  assert.equal(status, 200);
  assert.ok(body.transcript.some((m) => m.text === 'More detail about the transfer'));
  assert.equal(body.priority, true);
  const listed = (await paul.list()).body.cases.find((x) => x.ref === ref);
  assert.equal(listed.claimable, true);
  assert.equal(listed.claimedBy, 'Aline Mbarga');
  assert.equal((await aline.list()).body.cases.find((x) => x.ref === ref).claimable, false, 'the holder already has it');
});

test('the first agent to claim a re-broadcast case wins: the holder loses access, history and flags stay', async (t) => {
  const { svc, c, ref, aline, paul } = await held(t);
  await aline.reply(ref, 'Checking.');
  await c.say('Still nothing');
  await svc.clock.advance(30 * MIN);

  const res = await paul.claim(ref);

  assert.equal(res.status, 200);
  assert.equal(res.body.claimedBy, 'Paul Etoga');
  assert.equal((await aline.open(ref)).status, 403);
  assert.equal((await aline.reply(ref, 'still mine?')).status, 403);
  assert.equal((await aline.resolve(ref)).status, 403);
  assert.equal((await aline.transfer(ref, 'paul')).status, 403);
  const { body } = await paul.open(ref);
  const said = body.transcript.map((m) => m.text);
  assert.ok(said.includes('Checking.') && said.includes('Still nothing'));
  assert.equal(body.priority, true);
  assert.equal((await paul.reply(ref, 'I have your case.')).status, 200);
  assert.equal((await paul.list()).body.cases.find((x) => x.ref === ref).claimable, false, 'no longer open to the pool');
  assert.equal((await aline.claim(ref)).status, 409, 'and it cannot be taken back');
  const rows = svc.audit.records.filter((r) => r.caseRef === ref && r.outcome === 'case_claimed_after_rebroadcast');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].fromAgent, 'aline');
  assert.equal(rows[0].toAgent, 'paul');
});

test('the customer sees the current agent state without an unsolicited transfer nudge', async (t) => {
  const { svc, c, ref, paul } = await held(t);
  await svc.clock.advance(30 * MIN);
  await paul.claim(ref);

  const { body } = await c.status();

  assert.deepEqual(body.agent, { firstName: 'Paul', human: true });
  assert.deepEqual(body.messages, []);
  assert.doesNotMatch(JSON.stringify(body), /Aline|Mbarga|Etoga|aline@|paul@|taken over|transfer(r)?ed from/i);
  assert.equal(body.emailFollowUp, undefined, 'the colleague starts with a fresh clock');
});

test('a French customer receives no unsolicited transfer nudge', async (t) => {
  const { svc, c, ref, paul } = await held(t, { first: 'Comment envoyer de l\'argent ?' });
  await svc.clock.advance(30 * MIN);
  await paul.claim(ref);
  assert.deepEqual((await c.status()).body.messages, []);
});

test('two agents claiming a re-broadcast case at the same moment: exactly one wins', async (t) => {
  const svc = await startService({ model: createFakeModel(['ok']), agents: LONG_SESSION });
  t.after(svc.close);
  const c = await customer(svc.baseUrl);
  const { ref } = (await c.handoff()).body;
  const aline = await agentLogin(svc.baseUrl, 'aline');
  const paul = await agentLogin(svc.baseUrl, 'paul');
  await aline.claim(ref);
  await svc.clock.advance(30 * MIN);

  const results = await Promise.all([paul.claim(ref), paul.claim(ref), paul.claim(ref)]);

  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409, 409]);
  assert.equal(svc.audit.records.filter((r) => r.outcome === 'case_claimed_after_rebroadcast').length, 1);
});

test('the holder replying before anyone claims ends the open state', async (t) => {
  const { svc, ref, aline, paul } = await held(t);
  await svc.clock.advance(30 * MIN);
  assert.equal((await paul.open(ref)).status, 200);

  await aline.reply(ref, 'Sorry for the wait, I am on it.');

  assert.equal((await paul.open(ref)).status, 403);
  assert.equal((await paul.claim(ref)).status, 409);
  assert.equal((await paul.list()).body.cases.find((x) => x.ref === ref).claimable, false);
  assert.equal((await aline.open(ref)).status, 200);
});

test('the holder transferring the case ends the open state too', async (t) => {
  const { svc, ref, aline, paul } = await held(t);
  await svc.clock.advance(30 * MIN);
  await aline.transfer(ref, 'paul');
  assert.equal((await aline.list()).body.cases.find((x) => x.ref === ref).claimable, false);
  assert.equal((await aline.claim(ref)).status, 409);
});

test('a case resolved by its holder after the re-broadcast is not open to anyone', async (t) => {
  const { svc, ref, aline, paul } = await held(t);
  await svc.clock.advance(30 * MIN);
  await aline.resolve(ref);
  assert.equal((await paul.open(ref)).status, 403);
  assert.equal((await paul.claim(ref)).status, 409);
});

test('only an agent can take over, and a customer message after the re-broadcast does not close the open state', async (t) => {
  const { svc, c, ref, paul } = await held(t);
  await svc.clock.advance(30 * MIN);
  await c.say('Hello? Anyone?');
  assert.equal((await paul.open(ref)).status, 200);
});

test('the re-broadcast page and email carry only a link and the conversation id, never message content', async (t) => {
  const secret = 'my brother lives in Douala';
  const { svc, c, ref } = await held(t, { first: `I sent money to the wrong person, ${secret}` });
  await c.say('Another private detail 5551234');
  const before = svc.mailer.outbox.length;
  await svc.clock.advance(30 * MIN);

  const pages = svc.mailer.outbox.slice(before);
  assert.deepEqual(pages.map((m) => m.to).sort(), ['aline@bank.test', 'paul@bank.test']);
  for (const mail of pages) {
    assert.match(mail.body, new RegExp(c.conversationId));
    assert.match(mail.body, new RegExp(`\\?case=${ref}`));
    assert.doesNotMatch(`${mail.subject}\n${mail.body}`, /wrong person|Douala|private detail|5551234/);
  }
  const paul = await agentLogin(svc.baseUrl, 'paul');
  const queueRow = (await paul.list()).body.cases.find((x) => x.ref === ref);
  assert.doesNotMatch(JSON.stringify(queueRow), /wrong person|Douala/, 'the queue row carries no content');
});
