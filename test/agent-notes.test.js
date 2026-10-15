import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService } from './harness/start-service.js';
import { createFakeModel } from './harness/fake-model.js';
import { AGENTS, agentLogin, call, customer } from './harness/cases.js';

const MIN = 60_000;
const LONG_SESSION = { ...AGENTS, sessionMs: 1000 * 60 * MIN };

async function held(t) {
  const svc = await startService({ model: createFakeModel(['ok']), agents: LONG_SESSION });
  t.after(svc.close);
  const c = await customer(svc.baseUrl, 'test-token', 'I sent money to the wrong person');
  const { ref } = (await c.handoff()).body;
  const aline = await agentLogin(svc.baseUrl, 'aline');
  const paul = await agentLogin(svc.baseUrl, 'paul');
  await aline.claim(ref);
  return { svc, c, ref, aline, paul };
}

test('an agent adds an internal note; it is listed with its author and time, apart from the transcript', async (t) => {
  const { svc, ref, aline } = await held(t);
  await svc.clock.advance(2 * MIN);

  const added = await aline.note(ref, 'Customer called the branch too; check REF-0001 first.');
  const { body } = await aline.open(ref);

  assert.equal(added.status, 200);
  assert.equal(body.notes.length, 1);
  assert.deepEqual({ ...body.notes[0], id: typeof body.notes[0].id, at: typeof body.notes[0].at }, { id: 'string', agent: 'Aline Mbarga', agentId: 'aline', text: 'Customer called the branch too; check REF-0001 first.', at: 'number' });
  assert.equal(body.notes[0].at, svc.clock.now());
  assert.ok(!body.transcript.some((m) => /branch too/.test(m.text)), 'a note is not a chat line');
});

test('a note is never visible to the customer: not in the chat, the case status or "my cases", and no email carries it', async (t) => {
  const { svc, c, ref, aline } = await held(t);
  await aline.note(ref, 'SECRET-INTERNAL-REMARK about this customer');
  await aline.reply(ref, 'Hello, I am on it.');
  await svc.clock.advance(5 * MIN); // the customer is "gone": an email is sent for the reply

  const status = await c.status();
  const mine = await call(svc.baseUrl, 'GET', '/case/mine', { token: c.token });

  assert.doesNotMatch(JSON.stringify(status.body), /SECRET-INTERNAL/);
  assert.doesNotMatch(JSON.stringify(mine.body), /SECRET-INTERNAL/);
  assert.doesNotMatch(JSON.stringify(svc.mailer.outbox), /SECRET-INTERNAL/);
  assert.equal(status.body.messages.filter((m) => /SECRET/.test(m.text)).length, 0);
});

test('a note is stored masked: long numbers show their last four and a PIN, OTP or token is removed', async (t) => {
  const { ref, aline } = await held(t);

  await aline.note(ref, 'Account 12345678901, customer said PIN 4821 and OTP is 987654, token Bearer eyJhbGciOi.eyJzdWIiOiIx.abc123');
  const { body } = await aline.open(ref);

  const text = body.notes[0].text;
  assert.match(text, /\*\*\*\*8901/);
  assert.doesNotMatch(text, /12345678901|4821|987654|eyJ/);
});

test('a note is written to the audit log (masked) with the case, the agent and the note id', async (t) => {
  const { svc, c, ref, aline } = await held(t);

  const { body: { note } } = await aline.note(ref, 'Account 12345678901 looks fine, PIN 4821');

  const rec = svc.audit.records.find((r) => r.outcome === 'case_note_added');
  assert.ok(rec, 'audited');
  assert.equal(rec.caseRef, ref);
  assert.equal(rec.agent, 'aline');
  assert.equal(rec.noteId, note.id);
  assert.match(rec.noteText, /\*\*\*\*8901/);
  assert.doesNotMatch(JSON.stringify(rec), /12345678901|4821/);
  assert.ok(rec.conversationId && rec.time, 'with the usual audit fields');
  assert.ok(c);
});

test('another agent who can open the case sees the notes and can add their own; one who cannot open it gets nothing', async (t) => {
  const { svc, ref, aline, paul } = await held(t);
  await aline.note(ref, 'First note from Aline.');

  assert.equal((await paul.open(ref)).status, 403, 'closed to a colleague while Aline holds it');
  const denied = await paul.note(ref, 'sneaky');
  assert.equal(denied.status, 403);
  assert.deepEqual(denied.body, { error: 'not_your_case', claimedBy: 'Aline Mbarga' });

  await svc.clock.advance(30 * MIN); // the re-broadcast opens it to the pool
  const opened = await paul.open(ref);
  assert.equal(opened.status, 200);
  assert.deepEqual(opened.body.notes.map((n) => [n.agent, n.text]), [['Aline Mbarga', 'First note from Aline.']]);
  assert.equal((await paul.note(ref, 'Paul looked at it too.')).status, 200);
  assert.deepEqual((await aline.open(ref)).body.notes.map((n) => n.agent), ['Aline Mbarga', 'Paul Etoga']);
});

test('notes stay with the case on a transfer: the colleague sees them, the previous holder loses the case', async (t) => {
  const { ref, aline, paul } = await held(t);
  await aline.note(ref, 'Check the beneficiary name before replying.');

  assert.equal((await aline.transfer(ref, 'paul')).status, 200);

  const { status, body } = await paul.open(ref);
  assert.equal(status, 200);
  assert.deepEqual(body.notes.map((n) => [n.agent, n.text]), [['Aline Mbarga', 'Check the beneficiary name before replying.']]);
  assert.equal((await paul.note(ref, 'Done, waiting for the customer.')).status, 200);
  assert.equal((await aline.open(ref)).status, 403);
});

test('notes also stay with the case when a colleague takes it over after the re-broadcast', async (t) => {
  const { svc, ref, aline, paul } = await held(t);
  await aline.note(ref, 'Holder note.');
  await svc.clock.advance(30 * MIN);

  assert.equal((await paul.claim(ref)).status, 200);

  assert.deepEqual((await paul.open(ref)).body.notes.map((n) => n.text), ['Holder note.']);
});

test('a note can be added to a case still waiting for an agent, and after it is resolved by its holder', async (t) => {
  const svc = await startService({ model: createFakeModel(['ok']), agents: LONG_SESSION });
  t.after(svc.close);
  const { ref } = (await (await customer(svc.baseUrl, 'tok', 'hello')).handoff()).body;
  const aline = await agentLogin(svc.baseUrl, 'aline');

  assert.equal((await aline.note(ref, 'Seen in the queue, looks routine.')).status, 200);
  await aline.claim(ref);
  await aline.resolve(ref);
  assert.equal((await aline.note(ref, 'Wrap-up: solved by phone.')).status, 200);
  assert.deepEqual((await aline.open(ref)).body.notes.map((n) => n.text), ['Seen in the queue, looks routine.', 'Wrap-up: solved by phone.']);
});

test('a note must be 1 to 1000 characters, the case must exist and the agent must be logged in', async (t) => {
  const { svc, ref, aline } = await held(t);

  for (const bad of ['', '   ', 'x'.repeat(1001), undefined, 42]) assert.equal((await aline.note(ref, bad)).status, 400, `text ${JSON.stringify(bad)?.slice(0, 20)}`);
  assert.equal((await aline.note(ref, 'x'.repeat(1000))).status, 200);
  assert.equal((await aline.note('C-9999', 'hello')).status, 404);
  assert.equal((await call(svc.baseUrl, 'POST', `/agent/cases/${ref}/notes`, { body: { text: 'hi' } })).status, 401);
});
