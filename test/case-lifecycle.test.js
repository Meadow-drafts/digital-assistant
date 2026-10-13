import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService } from './harness/start-service.js';
import { createFakeModel } from './harness/fake-model.js';
import { AGENTS, agentLogin, call, customer } from './harness/cases.js';
import { loadSupport } from '../src/support.js';
import { row } from './harness/bank-fixtures.js';
import { alice, begin, say, start } from './harness/t1-helpers.js';

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
// Days pass in these tests, so the demo agents stay logged in for longer than the shipped 8 hours.
const LONG_SESSION = { ...AGENTS, sessionMs: 1000 * HOUR };

// A claimed case: the customer asked for a person, Aline took it.
async function claimed(t, { over = {}, first } = {}) {
  const svc = await startService({ model: createFakeModel(['ok']), agents: LONG_SESSION, ...over });
  t.after(svc.close);
  const c = await customer(svc.baseUrl, 'test-token', first);
  const { ref } = (await c.handoff()).body;
  const aline = await agentLogin(svc.baseUrl, 'aline');
  await aline.claim(ref);
  return { svc, c, ref, aline };
}
const notices = async (c) => (await c.status()).body.messages.filter((m) => m.from === 'system').map((m) => m.text);

test('10 minutes of agent silence after the claim: the customer gets a soft "still working on it", not a second before', async (t) => {
  const { svc, c } = await claimed(t);

  await svc.clock.advance(10 * MIN - SEC);
  assert.deepEqual(await notices(c), []);
  await svc.clock.advance(SEC);

  const [soft] = await notices(c);
  assert.match(soft, /still working on it/i);
  assert.equal((await c.status()).body.state, 'with_agent', 'the case stays with the agent');
});

test('the soft message is in the customer\'s language', async (t) => {
  const { svc, c } = await claimed(t, { first: 'Comment envoyer de l\'argent ?' });
  await svc.clock.advance(10 * MIN);
  assert.match((await notices(c))[0], /nous y travaillons/i);
});

test('an agent reply stops the silence clock; the next customer message starts it again from that moment', async (t) => {
  const { svc, c, ref, aline } = await claimed(t);
  await svc.clock.advance(5 * MIN);
  await aline.reply(ref, 'Looking into it.');
  await svc.clock.advance(20 * MIN);
  assert.deepEqual(await notices(c), [], 'the agent spoke, nobody is overdue');

  await c.say('Any news?');
  await svc.clock.advance(10 * MIN - SEC);
  assert.deepEqual(await notices(c), []);
  await svc.clock.advance(SEC);
  assert.match((await notices(c))[0], /still working on it/i);
});

test('30 minutes of silence re-broadcasts to the pool with a link only, and offers email follow-up to the customer', async (t) => {
  const { svc, c, ref } = await claimed(t);
  const before = svc.mailer.outbox.length;

  await svc.clock.advance(30 * MIN - SEC);
  assert.equal(svc.mailer.outbox.length, before, 'no page before 30 minutes');
  assert.equal((await c.status()).body.emailFollowUp, undefined);
  await svc.clock.advance(SEC);

  const pages = svc.mailer.outbox.slice(before);
  assert.deepEqual(pages.map((m) => m.to).sort(), ['aline@bank.test', 'paul@bank.test']);
  for (const mail of pages) {
    assert.match(mail.subject, new RegExp(ref));
    assert.match(mail.body, new RegExp(c.conversationId));
    assert.doesNotMatch(mail.body, /How do I send money/);
  }
  const { body } = await c.status();
  assert.equal(body.emailFollowUp, true);
  const texts = await notices(c);
  assert.equal(texts.length, 2, 'the soft message at 10 minutes, then the follow-up offer');
  assert.match(texts[1], /email/i);
  assert.equal(svc.audit.records.filter((r) => r.outcome === 'case_rebroadcast' && r.caseRef === ref).length, 2, 'one audit row per page, like the 5 minute broadcast');
});

test('a case resolved before the timers run never sends a soft message or a re-broadcast', async (t) => {
  const { svc, c, ref, aline } = await claimed(t);
  const before = svc.mailer.outbox.length;
  await aline.resolve(ref);

  await svc.clock.advance(2 * HOUR);

  assert.equal(svc.mailer.outbox.length, before);
  assert.deepEqual(await notices(c), []);
});

test('the lifecycle timers are configuration, not hardcoded', async (t) => {
  const support = loadSupport(new URL('../config/support.json', import.meta.url));
  const { svc, c } = await claimed(t, { over: { support: { ...support, timers: { ...support.timers, agentSilenceMs: 2 * MIN, agentFollowUpMs: 3 * MIN } } } });

  await svc.clock.advance(2 * MIN);
  assert.equal((await notices(c)).length, 1, 'fires at the configured 2 minutes');
  await svc.clock.advance(MIN);
  assert.equal((await notices(c)).length, 2, 'and the follow-up at the configured 3');
});

test('the shipped config holds the ticket 07 placeholders, and a missing or inconsistent lifecycle timer fails loudly at load', async () => {
  const { writeFileSync, mkdtempSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const good = JSON.parse(readFileSync(new URL('../config/support.json', import.meta.url), 'utf8'));
  const dir = mkdtempSync(`${tmpdir()}/lifecycle-`);
  const withTimers = (name, timers) => { const path = `${dir}/${name}.json`; writeFileSync(path, JSON.stringify({ ...good, timers })); return path; };

  const loaded = loadSupport(new URL('../config/support.json', import.meta.url));
  assert.equal(loaded.timers.agentSilenceMs, 10 * MIN);
  assert.equal(loaded.timers.agentFollowUpMs, 30 * MIN);
  assert.equal(loaded.timers.autoResolveMs, 24 * HOUR);
  assert.equal(loaded.timers.reopenWindowMs, 72 * HOUR);
  for (const key of ['agentSilenceMs', 'agentFollowUpMs', 'autoResolveMs', 'reopenWindowMs']) {
    const { [key]: _gone, ...rest } = good.timers;
    assert.throws(() => loadSupport(withTimers(`no-${key}`, rest)), new RegExp(key));
  }
  assert.throws(() => loadSupport(withTimers('order', { ...good.timers, agentSilenceMs: 30 * MIN, agentFollowUpMs: 10 * MIN })), /agentFollowUpMs/);
});

test('inactive cases auto-resolve at 24 hours exactly, not a second before', async (t) => {
  const { svc, c, ref, aline } = await claimed(t);

  await svc.clock.advance(24 * HOUR - SEC);
  assert.equal((await c.status()).body.state, 'with_agent');
  await svc.clock.advance(SEC);

  const { body } = await c.status();
  assert.equal(body.state, 'resolved');
  assert.equal((await aline.list()).body.cases.find((r) => r.ref === ref).closeReason, 'auto_resolved');
  assert.equal(svc.audit.records.filter((r) => r.outcome === 'case_auto_resolved' && r.caseRef === ref).length, 1);
  assert.equal((await aline.reply(ref, 'late')).status, 409, 'the agent can no longer write');
});

test('a message from either side counts as activity and moves the 24 hour mark', async (t) => {
  const { svc, c, ref, aline } = await claimed(t);

  await svc.clock.advance(23 * HOUR);
  await c.say('Still waiting for news');
  await svc.clock.advance(23 * HOUR);
  assert.equal((await c.status()).body.state, 'with_agent', '46 hours in, but only 23 since the customer wrote');
  await aline.reply(ref, 'Sorry for the delay.');
  await svc.clock.advance(24 * HOUR - SEC);
  assert.equal((await c.status()).body.state, 'with_agent');
  await svc.clock.advance(SEC);
  assert.equal((await c.status()).body.state, 'resolved');
});

test('the customer polling the case is not activity', async (t) => {
  const { svc, c } = await claimed(t);
  for (let i = 0; i < 24; i += 1) { await svc.clock.advance(HOUR); await c.status(); }
  assert.equal((await c.status()).body.state, 'resolved');
});

test('an auto-resolved case does not ask "Was this solved?" because nobody resolved it', async (t) => {
  const { svc, c } = await claimed(t);
  await svc.clock.advance(24 * HOUR);
  const { body } = await c.status();
  assert.equal(body.state, 'resolved');
  assert.equal(body.askSolved, false);
  assert.equal((await c.feedback(true)).status, 409);
});

// ---- the 72 hour reopen window ----

async function resolvedCase(t, opts) {
  const ctx = await claimed(t, opts);
  await ctx.aline.resolve(ctx.ref);
  return ctx;
}

test('asking for a person 72 hours minus one second after resolution reopens the same case with the same agent', async (t) => {
  const { svc, c, ref, aline } = await resolvedCase(t);
  await svc.clock.advance(72 * HOUR - SEC);
  const mails = svc.mailer.outbox.length;

  const { body } = await c.handoff();

  assert.equal(body.ref, ref);
  assert.equal(body.state, 'with_agent');
  assert.deepEqual(body.agent, { firstName: 'Aline', human: true });
  const detail = (await aline.open(ref)).body;
  assert.equal(detail.state, 'with_agent');
  assert.equal(detail.claimedBy, 'Aline Mbarga');
  assert.equal(svc.audit.records.filter((r) => r.outcome === 'case_reopened' && r.caseRef === ref).length, 1);
  const [page] = svc.mailer.outbox.slice(mails);
  assert.equal(page.to, 'aline@bank.test', 'the agent who had it is told, with a link and the conversation id only');
  assert.match(page.body, new RegExp(c.conversationId));
});

test('exactly 72 hours after resolution still counts as within the window', async (t) => {
  const { svc, c, ref } = await resolvedCase(t);
  await svc.clock.advance(72 * HOUR);
  assert.equal((await c.handoff()).body.ref, ref);
});

test('72 hours plus one second after resolution opens a new case, linked to the old one', async (t) => {
  const { svc, c, ref, aline } = await resolvedCase(t);
  await svc.clock.advance(72 * HOUR + SEC);

  const { body } = await c.handoff();

  assert.notEqual(body.ref, ref);
  assert.equal(body.state, 'waiting');
  const detail = (await aline.open(body.ref)).body;
  assert.equal(detail.linkedTo, ref);
  assert.equal((await aline.open(ref)).body.state, 'resolved', 'the old case stays closed');
});

test('the 72 hours run from the moment of auto-resolution when nobody resolved it', async (t) => {
  const { svc, c, ref } = await claimed(t);
  await svc.clock.advance(24 * HOUR);
  await svc.clock.advance(72 * HOUR - SEC);
  assert.equal((await c.handoff()).body.ref, ref);
});

test('the window length is configuration', async (t) => {
  const support = loadSupport(new URL('../config/support.json', import.meta.url));
  const { svc, c, ref, aline } = await claimed(t, { over: { support: { ...support, timers: { ...support.timers, reopenWindowMs: HOUR } } } });
  await aline.resolve(ref);
  await svc.clock.advance(HOUR + SEC);
  assert.notEqual((await c.handoff()).body.ref, ref);
});

test('a case the customer cancelled is never reopened, and a first case has no link', async (t) => {
  const svc = await startService({ model: createFakeModel(['ok']) });
  t.after(svc.close);
  const c = await customer(svc.baseUrl);
  const first = (await c.handoff()).body.ref;
  await c.cancel();

  const second = (await c.handoff()).body.ref;

  assert.notEqual(second, first);
  const aline = await agentLogin(svc.baseUrl, 'aline');
  assert.equal((await aline.open(second)).body.linkedTo ?? null, null);
});

test('a reopened case keeps its history and can be resolved and reopened again', async (t) => {
  const { svc, c, ref, aline } = await resolvedCase(t);
  await svc.clock.advance(HOUR);
  await c.handoff();
  await aline.reply(ref, 'Back again, how can I help?');
  await aline.resolve(ref);
  await svc.clock.advance(HOUR);

  assert.equal((await c.handoff()).body.ref, ref);
  const { transcript } = (await aline.open(ref)).body;
  assert.ok(transcript.some((m) => m.text === 'Back again, how can I help?'));
  assert.ok(transcript.some((m) => m.from === 'system' && /reopened/i.test(m.text)));
});

// ---- answering "No" to "Was this solved?" (ticket 55) ----

test('"No" 72 hours minus one second after resolution reopens the same case, with the agent state and silence clock reset', async (t) => {
  const { svc, c, ref, aline } = await resolvedCase(t);
  await svc.clock.advance(72 * HOUR - SEC);
  const mails = svc.mailer.outbox.length;

  const res = await c.feedback(false);

  assert.equal(res.status, 200);
  assert.equal(res.body.ref, ref);
  assert.equal(res.body.state, 'with_agent');
  assert.deepEqual(res.body.agent, { firstName: 'Aline', human: true });
  const status = (await c.status()).body;
  assert.equal(status.state, 'with_agent');
  assert.notEqual(status.askSolved, true);
  assert.equal((await aline.open(ref)).body.state, 'with_agent');
  assert.deepEqual(svc.audit.records.filter((r) => r.outcome === 'case_feedback').map((r) => [r.caseRef, r.solved]), [[ref, false]]);
  assert.equal(svc.audit.records.filter((r) => r.outcome === 'case_reopened' && r.caseRef === ref).length, 1);
  assert.equal(svc.mailer.outbox.slice(mails)[0].to, 'aline@bank.test', 'the agent who had it is told, like a chip click');
  // The silence clock restarted at the reopen.
  const before = (await notices(c)).length;
  await svc.clock.advance(10 * MIN - SEC);
  assert.equal((await notices(c)).length, before);
  await svc.clock.advance(SEC);
  assert.match((await notices(c)).at(-1), /still working on it/i);
});

test('"No" exactly 72 hours after resolution still reopens the same case (the boundary is the chip\'s)', async (t) => {
  const { svc, c, ref } = await resolvedCase(t);
  await svc.clock.advance(72 * HOUR);
  assert.equal((await c.feedback(false)).body.ref, ref);
});

test('"No" 72 hours plus one second after resolution opens a new case linked to the old one', async (t) => {
  const { svc, c, ref, aline } = await resolvedCase(t);
  await svc.clock.advance(72 * HOUR + SEC);

  const res = await c.feedback(false);

  assert.equal(res.status, 200);
  assert.notEqual(res.body.ref, ref);
  assert.equal(res.body.state, 'waiting');
  assert.equal((await aline.open(res.body.ref)).body.linkedTo, ref);
  assert.equal((await aline.open(ref)).body.state, 'resolved', 'the old case stays closed');
});

test('"Yes" keeps the case resolved, at any time', async (t) => {
  const { svc, c, ref, aline } = await resolvedCase(t);
  await svc.clock.advance(HOUR);

  assert.equal((await c.feedback(true)).status, 200);

  assert.equal((await c.status()).body.state, 'resolved');
  assert.equal((await aline.open(ref)).body.state, 'resolved');
  assert.equal(svc.audit.records.filter((r) => r.outcome === 'case_reopened').length, 0);
});

test('a plain chat message inside the window goes to the bot and does not reopen the case', async (t) => {
  const { svc, c, ref, aline } = await resolvedCase(t);
  await svc.clock.advance(HOUR);

  await c.say('you did not fix it');

  assert.equal((await c.status()).body.state, 'resolved');
  assert.equal((await aline.open(ref)).body.state, 'resolved');
  assert.equal(svc.audit.records.filter((r) => r.outcome === 'case_reopened').length, 0);
});

test('"No" never reopens a case the customer cancelled', async (t) => {
  const svc = await startService({ model: createFakeModel(['ok']) });
  t.after(svc.close);
  const c = await customer(svc.baseUrl);
  const ref = (await c.handoff()).body.ref;
  await c.cancel();

  assert.equal((await c.feedback(false)).status, 409);

  assert.equal((await c.status()).body.state, 'bot');
  const aline = await agentLogin(svc.baseUrl, 'aline');
  assert.equal((await aline.open(ref)).body.state, 'resolved');
});

// ---- transfer ----

test('an agent transfers a case to a colleague: the colleague gets the whole case, the first agent is out', async (t) => {
  const { svc, c, ref, aline } = await claimed(t);
  await c.say('Here is more detail');
  await aline.reply(ref, 'I will check.');
  const paul = await agentLogin(svc.baseUrl, 'paul');
  assert.equal((await paul.open(ref)).status, 403);

  const res = await aline.transfer(ref, 'paul');

  assert.equal(res.status, 200);
  const { body, status } = await paul.open(ref);
  assert.equal(status, 200);
  assert.equal(body.claimedBy, 'Paul Etoga');
  const said = body.transcript.map((m) => m.text);
  assert.ok(said.includes('Here is more detail'));
  assert.ok(said.includes('I will check.'));
  assert.ok(body.transcript.some((m) => m.from === 'system' && /Aline Mbarga/.test(m.text) && /Paul Etoga/.test(m.text)), 'the agents see who handed it to whom');
  assert.equal((await aline.open(ref)).status, 403);
  assert.equal((await aline.reply(ref, 'still mine?')).status, 403);
  assert.equal((await paul.reply(ref, 'Hello, I have your case.')).status, 200);
  assert.equal(svc.audit.records.filter((r) => r.outcome === 'case_transferred' && r.caseRef === ref).length, 1);
});

test('the customer sees the transfer in neutral wording and then the colleague\'s first name, nothing more', async (t) => {
  const { svc, c, ref, aline } = await claimed(t);
  await aline.transfer(ref, 'paul');

  const { body } = await c.status();

  assert.deepEqual(body.agent, { firstName: 'Paul', human: true });
  const [notice] = body.messages.filter((m) => m.from === 'system');
  assert.match(notice.text, /colleague/i);
  assert.doesNotMatch(JSON.stringify(body), /Aline|Mbarga|Etoga|aline@|paul@|transfer(r)?ed from/i);
  assert.equal(body.messages.some((m) => m.from === 'agent'), false);
  assert.equal(svc.audit.records.filter((r) => r.outcome === 'case_transferred').length, 1);
});

test('the transfer notice is in the customer\'s language', async (t) => {
  const { c, ref, aline } = await claimed(t, { first: 'Comment envoyer de l\'argent ?' });
  await aline.transfer(ref, 'paul');
  assert.match((await notices(c))[0], /collègue/i);
});

test('the colleague is paged by email with a link and the conversation id only', async (t) => {
  const { svc, c, ref, aline } = await claimed(t);
  const before = svc.mailer.outbox.length;

  await aline.transfer(ref, 'paul');

  const pages = svc.mailer.outbox.slice(before);
  assert.deepEqual(pages.map((m) => m.to), ['paul@bank.test']);
  assert.match(pages[0].subject, new RegExp(ref));
  assert.match(pages[0].body, new RegExp(c.conversationId));
  assert.doesNotMatch(pages[0].body, /How do I send money/);
});

test('only the agent who holds a case can transfer it, only to a different known agent, only while it is with an agent', async (t) => {
  const { svc, ref, aline, c } = await claimed(t);
  const paul = await agentLogin(svc.baseUrl, 'paul');

  assert.equal((await paul.transfer(ref, 'aline')).status, 403, 'a colleague cannot take it by transferring');
  assert.equal((await aline.transfer(ref, 'aline')).status, 400, 'not to yourself');
  assert.equal((await aline.transfer(ref, 'nobody')).status, 400, 'not to someone who is not on the roster');
  assert.equal((await aline.transfer(ref, undefined)).status, 400);
  assert.equal((await aline.transfer('C-9999', 'paul')).status, 404);
  assert.equal((await call(svc.baseUrl, 'POST', `/agent/cases/${ref}/transfer`, { body: { to: 'paul' } })).status, 401);
  assert.equal((await call(svc.baseUrl, 'POST', `/agent/cases/${ref}/transfer`, { token: c.token, body: { to: 'paul' } })).status, 401, 'a customer token is not an agent');
  assert.equal((await aline.open(ref)).body.claimedBy, 'Aline Mbarga', 'nothing above changed the holder');

  await aline.resolve(ref);
  assert.equal((await aline.transfer(ref, 'paul')).status, 409, 'a resolved case is not transferred');
});

test('a waiting case cannot be transferred: it is claimed, not handed over', async (t) => {
  const svc = await startService({ model: createFakeModel(['ok']) });
  t.after(svc.close);
  const c = await customer(svc.baseUrl);
  const { ref } = (await c.handoff()).body;
  const aline = await agentLogin(svc.baseUrl, 'aline');
  assert.equal((await aline.transfer(ref, 'paul')).status, 409);
});

test('a transfer gives the colleague a fresh silence clock and a fresh 24 hours', async (t) => {
  const { svc, c, ref, aline } = await claimed(t);
  await svc.clock.advance(9 * MIN);

  await aline.transfer(ref, 'paul');
  await svc.clock.advance(MIN);
  assert.deepEqual((await notices(c)).filter((x) => /still working/i.test(x)), [], 'the old agent\'s clock does not run on the colleague');
  await svc.clock.advance(9 * MIN);
  assert.equal((await notices(c)).filter((x) => /still working/i.test(x)).length, 1);

  await svc.clock.advance(23 * HOUR + 40 * MIN);
  assert.equal((await c.status()).body.state, 'with_agent');
  await svc.clock.advance(20 * MIN);
  assert.equal((await c.status()).body.state, 'resolved');
});

// ---- waiting-state bot replies ----

test('while the case waits, every bot reply carries the automated label, also after the queued notice', async (t) => {
  const svc = await startService({ model: createFakeModel(['Open Transfers.']) });
  t.after(svc.close);
  const c = await customer(svc.baseUrl);
  const { ref } = (await c.handoff()).body;

  for (const wait of [0, 15 * MIN]) {
    await svc.clock.advance(wait);
    const { events } = await c.say('How do I pay a bill?');
    assert.deepEqual(events.find((e) => e.type === 'case'), { type: 'case', state: 'waiting', ref, automated: true });
  }
});

// ---- interaction with tickets 31 (draft) and 32 (summary, priority, records) ----

const SUMMARY = 'The customer says a transfer of 15000 XAF went to the wrong person.';
async function wrongTransferCase(t) {
  const a = alice();
  a.rows = [row(a, { clientReferenceId: 'REF-0001', sta: '100', mtrans: 15000, partnerlib: 'Jean Paul Mbarga', telop: '237677000999' })];
  const m = createFakeModel((request) => (request.purpose === 'summary' ? SUMMARY : request.purpose === 'route' ? '[]' : 'General help.'));
  const svc = await start({ customers: [a], model: m, agents: LONG_SESSION });
  t.after(svc.close);
  const conversationId = await begin(svc, a);
  await say(svc, a, 'I sent 15000 to the wrong person by mistake, reference REF-0001', conversationId);
  const post = (path, body) => call(svc.baseUrl, 'POST', path, { token: a.token, body: { conversationId, ...body } });
  const { body: draft } = await post('/draft', { reference: 'REF-0001' });
  const { body: shown } = await post('/draft/preview', { draftId: draft.draftId, text: 'Please help, I sent 15000 to the wrong person.', destination: 'chat' });
  const { body: sent } = await post('/draft/confirm', { draftId: draft.draftId, previewToken: shown.previewToken });
  const aline = await agentLogin(svc.baseUrl, 'aline');
  await aline.claim(sent.ref);
  return { svc, a, m, ref: sent.ref, aline, handoff: () => post('/handoff', {}) };
}
const context = (body) => ({ draft: body.draft, summary: body.summary, priority: body.priority, records: body.records });

test('a transferred case keeps its drafted message, summary, masked records and priority flag', async (t) => {
  const { svc, m, ref, aline } = await wrongTransferCase(t);
  const before = (await aline.open(ref)).body;
  assert.equal(before.priority, true);
  assert.match(before.draft, /REF-0001/);
  assert.equal(before.summary.text, SUMMARY);
  assert.ok(before.records?.length);
  const summaries = m.calls.filter((c) => c.purpose === 'summary').length;

  await aline.transfer(ref, 'paul');
  const paul = await agentLogin(svc.baseUrl, 'paul');
  const after = (await paul.open(ref)).body;

  assert.deepEqual(context(after), context(before));
  assert.equal(after.transcript[0].text, after.draft, 'the draft is still the first line of the transcript');
  assert.equal(m.calls.filter((c) => c.purpose === 'summary').length, summaries, 'a transfer does not call the model again');
  assert.ok((await paul.list()).body.cases.find((r) => r.ref === ref).priority, 'and the queue row keeps the flag');
});

test('a reopened case keeps its drafted message, summary, masked records and priority flag', async (t) => {
  const { svc, ref, aline, handoff } = await wrongTransferCase(t);
  const before = (await aline.open(ref)).body;
  await aline.resolve(ref);
  await svc.clock.advance(48 * HOUR);

  const reopened = await handoff();
  const after = (await aline.open(ref)).body;

  assert.equal(reopened.body.ref, ref);
  assert.equal(after.state, 'with_agent');
  assert.deepEqual(context(after), context(before));
});

test('a confirmed chat draft within the window reopens the same case and joins its transcript', async (t) => {
  const { svc, a, ref, aline } = await wrongTransferCase(t);
  const conversationId = (await aline.open(ref)).body.conversationId;
  await aline.resolve(ref);
  await svc.clock.advance(HOUR);
  const post = (path, body) => call(svc.baseUrl, 'POST', path, { token: a.token, body: { conversationId, ...body } });
  const { body: draft } = await post('/draft', { reference: 'REF-0001' });
  const { body: shown } = await post('/draft/preview', { draftId: draft.draftId, text: 'It happened again with another payment.', destination: 'chat' });

  const { body: sent } = await post('/draft/confirm', { draftId: draft.draftId, previewToken: shown.previewToken });

  assert.equal(sent.ref, ref);
  const detail = (await aline.open(ref)).body;
  assert.equal(detail.state, 'with_agent');
  assert.ok(detail.transcript.some((m) => /It happened again/.test(m.text)));
});
