import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService } from './harness/start-service.js';
import { createFakeModel } from './harness/fake-model.js';
import { customer } from './harness/cases.js';

const MIN = 60_000;
const mails = (svc) => svc.mailer.outbox.map((m) => m.to);

test('a waiting case pages only the on-call agent until 5 minutes pass, then the whole pool', async (t) => {
  const svc = await startService({ model: createFakeModel(['ok']) });
  t.after(svc.close);
  const c = await customer(svc.baseUrl);
  const { ref } = (await c.handoff()).body;
  assert.deepEqual(mails(svc), ['aline@bank.test']);

  await svc.clock.advance(5 * MIN - 1000);
  assert.deepEqual(mails(svc), ['aline@bank.test'], 'nothing before 5 minutes');

  await svc.clock.advance(1000);
  assert.deepEqual(mails(svc).sort(), ['aline@bank.test', 'aline@bank.test', 'paul@bank.test']);
  for (const mail of svc.mailer.outbox.slice(1)) {
    assert.match(mail.subject, new RegExp(ref));
    assert.match(mail.body, new RegExp(c.conversationId));
    assert.match(mail.body, /https:\/\/support\.bank\.test\/console/);
  }
});

test('a case claimed or cancelled inside 5 minutes is never broadcast', async (t) => {
  const svc = await startService({ model: createFakeModel(['ok']) });
  t.after(svc.close);
  const { agentLogin } = await import('./harness/cases.js');
  const claimed = await customer(svc.baseUrl, 'token-one');
  const cancelled = await customer(svc.baseUrl, 'token-two');
  const a = (await claimed.handoff()).body.ref;
  await cancelled.handoff();
  await (await agentLogin(svc.baseUrl, 'paul')).claim(a);
  await cancelled.cancel();
  const before = svc.mailer.outbox.length;

  await svc.clock.advance(20 * MIN);

  assert.equal(svc.mailer.outbox.length, before, 'no further pages for a taken or cancelled case');
});

test('after 15 minutes unclaimed the customer is told the case is queued and they will be emailed', async (t) => {
  const svc = await startService({ model: createFakeModel(['ok']) });
  t.after(svc.close);
  const c = await customer(svc.baseUrl);
  await c.handoff();

  await svc.clock.advance(15 * MIN - 1000);
  const early = (await c.status()).body;
  await svc.clock.advance(1000);
  const late = (await c.status()).body;

  assert.equal(early.queued, undefined);
  assert.equal(late.state, 'waiting', 'the case stays open');
  assert.equal(late.queued, true);
  assert.match(late.queuedNotice, /queued/i);
  assert.match(late.queuedNotice, /email/i);
});

test('the queued notice is in the customer\'s language', async (t) => {
  const svc = await startService({ model: createFakeModel(['ok']) });
  t.after(svc.close);
  const c = await customer(svc.baseUrl, 'test-token', 'Comment envoyer de l\'argent ?');
  await c.handoff();

  await svc.clock.advance(15 * MIN);

  assert.match((await c.status()).body.queuedNotice, /file d'attente|mis en attente/i);
});

test('a case claimed before 15 minutes is not announced as queued', async (t) => {
  const svc = await startService({ model: createFakeModel(['ok']) });
  t.after(svc.close);
  const { agentLogin } = await import('./harness/cases.js');
  const c = await customer(svc.baseUrl);
  const { ref } = (await c.handoff()).body;
  await svc.clock.advance(10 * MIN);
  await (await agentLogin(svc.baseUrl, 'paul')).claim(ref);

  await svc.clock.advance(10 * MIN);

  assert.equal((await c.status()).body.queued, undefined);
});

test('the timers come from configuration: other values fire at other times', async (t) => {
  const { loadSupport } = await import('../src/support.js');
  const base = loadSupport(new URL('../config/support.json', import.meta.url));
  const svc = await startService({ model: createFakeModel(['ok']), support: { ...base, timers: { ...base.timers, broadcastMs: 60_000, queuedNoticeMs: 120_000 } } });
  t.after(svc.close);
  const c = await customer(svc.baseUrl);
  await c.handoff();

  await svc.clock.advance(MIN);
  assert.ok(mails(svc).includes('paul@bank.test'), 'broadcast at the configured 1 minute');
  await svc.clock.advance(MIN);
  assert.equal((await c.status()).body.queued, true, 'queued notice at the configured 2 minutes');
});

// ---- After hours (placeholder hours: Monday-Friday 08:00-17:00 at UTC+1; the fake clock starts Monday 10:00 local) ----
import { start, open, alice, TENANT } from './harness/t1-helpers.js';
import { createFakeClock } from './harness/fake-clock.js';

const at = (iso) => createFakeClock(Date.parse(iso));
const FRIDAY_EVENING = '2026-10-16T17:30:00Z'; // 18:30 local, Friday
const MONDAY_SHIFT_START = Date.parse('2026-10-19T07:00:00Z'); // 08:00 local, Monday

async function afterHoursCase(t, iso = FRIDAY_EVENING, extra = {}) {
  const cust = alice();
  const svc = await start({ customers: [cust], model: createFakeModel(['ok']), clock: at(iso), ...extra });
  t.after(svc.close);
  const { conversationId } = await open(svc, cust);
  const { call } = await import('./harness/cases.js');
  const opened = await call(svc.baseUrl, 'POST', '/handoff', { token: cust.token, body: { conversationId, tenant: TENANT } });
  const status = () => call(svc.baseUrl, 'GET', `/case?conversationId=${conversationId}`, { token: cust.token });
  return { svc, cust, conversationId, opened, status };
}

test('after hours: the case is queued at once, the customer is emailed a confirmation and nobody is paged yet', async (t) => {
  const { svc, cust, opened } = await afterHoursCase(t);

  assert.equal(opened.body.state, 'waiting');
  assert.equal(opened.body.queued, true);
  assert.match(opened.body.queuedNotice, /closed.*queued.*email/i);
  assert.deepEqual(mails(svc), [`${cust.sub}@mail.test`]);
  const [mail] = svc.mailer.outbox;
  assert.match(mail.subject, new RegExp(opened.body.ref));
  assert.match(mail.body, /next shift/i);
  assert.match(mail.body, /within 24 hours/i);
  assert.doesNotMatch(mail.body, /wrong|reverse|\d{5}/i, 'no message content in the email');
});

test('after hours: the on-call agent is paged at the start of the next shift, over the weekend, and not before', async (t) => {
  const { svc, opened, conversationId } = await afterHoursCase(t);
  svc.mailer.outbox.length = 0;

  await svc.clock.advance(MONDAY_SHIFT_START - svc.clock.now() - 1000);
  assert.deepEqual(mails(svc), [], 'still closed: nobody paged');

  await svc.clock.advance(1000);
  assert.deepEqual(mails(svc), ['aline@bank.test']);
  assert.match(svc.mailer.outbox[0].subject, new RegExp(opened.body.ref));
  assert.match(svc.mailer.outbox[0].body, new RegExp(conversationId));
});

test('after hours: once the shift starts the normal 5 minute broadcast applies and the case is no longer "closed"', async (t) => {
  const { svc, status } = await afterHoursCase(t);
  await svc.clock.advance(MONDAY_SHIFT_START - svc.clock.now());
  svc.mailer.outbox.length = 0;

  await svc.clock.advance(5 * MIN);
  assert.ok(mails(svc).includes('paul@bank.test'), 'pool paged 5 minutes after the shift start');
  const body = (await status()).body;
  assert.doesNotMatch(body.queuedNotice ?? '', /closed/i);
});

test('after hours follows the configured hours: a weekday evening is open when the configured close is later', async (t) => {
  const { loadSupport } = await import('../src/support.js');
  const base = loadSupport(new URL('../config/support.json', import.meta.url));
  const { opened, svc } = await afterHoursCase(t, FRIDAY_EVENING, { support: { ...base, hours: { ...base.hours, close: '20:00' } } });

  assert.equal(opened.body.queued, undefined);
  assert.deepEqual(mails(svc), ['aline@bank.test'], 'open by config: paged straight away');
});

test('after hours without a known customer email still queues and pages at the shift start', async (t) => {
  const svc = await startService({ model: createFakeModel(['ok']), clock: at(FRIDAY_EVENING) });
  t.after(svc.close);
  const c = await customer(svc.baseUrl);

  const { body } = await c.handoff();
  assert.equal(body.queued, true);
  assert.deepEqual(mails(svc), []);
  await svc.clock.advance(MONDAY_SHIFT_START - svc.clock.now());
  assert.deepEqual(mails(svc), ['aline@bank.test']);
});

test('opening hours are validated at load: a bad config fails loudly', async () => {
  const { loadSupport } = await import('../src/support.js');
  const { writeFileSync, mkdtempSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const good = JSON.parse(readFileSync(new URL('../config/support.json', import.meta.url), 'utf8'));
  const dir = mkdtempSync(`${tmpdir()}/support-`);
  const bad = `${dir}/bad.json`;
  writeFileSync(bad, JSON.stringify({ ...good, hours: { ...good.hours, open: '18:00', close: '08:00' } }));
  assert.throws(() => loadSupport(bad), /hours/);
});

// ---- Someone leaves mid-chat ----
async function withAgentCase(t, extra = {}) {
  const ctx = await afterHoursCase(t, '2026-10-12T09:00:00Z', extra);
  const { agentLogin, call } = await import('./harness/cases.js');
  const aline = await agentLogin(ctx.svc.baseUrl, 'aline');
  const ref = ctx.opened.body.ref;
  await aline.claim(ref);
  ctx.svc.mailer.outbox.length = 0;
  const say = (message) => import('./harness/sse.js').then(({ chatTurn }) => chatTurn(ctx.svc.baseUrl, { message, tenant: TENANT, conversationId: ctx.conversationId }, { token: ctx.cust.token }));
  return { ...ctx, aline, ref, say, call };
}

test('the customer left: the agent\'s reply is kept and the customer is emailed, with no message content', async (t) => {
  const { svc, cust, aline, ref, status } = await withAgentCase(t);
  await svc.clock.advance(3 * MIN); // the customer closes the tab: no polling, no messages

  await aline.reply(ref, 'Your transfer of 25000 was reversed');

  assert.deepEqual(mails(svc), [`${cust.sub}@mail.test`]);
  const [mail] = svc.mailer.outbox;
  assert.match(mail.subject, new RegExp(ref));
  assert.doesNotMatch(`${mail.subject}\n${mail.body}`, /25000|transfer|reversed/i);
  const queued = (await status()).body.messages;
  assert.deepEqual(queued.map((m) => m.text), ['Your transfer of 25000 was reversed'], 'the message waits for them');
});

test('a customer who is still around is not emailed, and one email covers a run of replies', async (t) => {
  const { svc, aline, ref, status } = await withAgentCase(t);
  await svc.clock.advance(MIN);
  await status(); // customer's chat polls
  await aline.reply(ref, 'one');
  assert.deepEqual(mails(svc), [], 'present: no email');

  await svc.clock.advance(3 * MIN);
  await aline.reply(ref, 'two');
  await aline.reply(ref, 'three');
  assert.equal(svc.mailer.outbox.length, 1, 'absent: one email, not one per reply');

  await status(); // they come back
  await svc.clock.advance(3 * MIN);
  await aline.reply(ref, 'four');
  assert.equal(svc.mailer.outbox.length, 2, 'absent again after returning: emailed again');
});

test('the agent left: the customer\'s message is kept and the agent is emailed a link and the conversation id only', async (t) => {
  const { svc, aline, ref, say, conversationId } = await withAgentCase(t);
  await svc.clock.advance(3 * MIN); // the agent closes the console

  await say('My secret detail 987654 please help');

  assert.deepEqual(mails(svc), ['aline@bank.test'], 'the agent who has the case, not the pool');
  const [mail] = svc.mailer.outbox;
  assert.match(mail.subject, new RegExp(ref));
  assert.match(mail.body, new RegExp(conversationId));
  assert.match(mail.body, /https:\/\/support\.bank\.test\/console/);
  assert.doesNotMatch(`${mail.subject}\n${mail.body}`, /secret|987654|help/i);
  const detail = (await aline.open(ref)).body;
  assert.ok(detail.transcript.some((m) => m.from === 'customer' && /help/.test(m.text)), 'the message is waiting in the transcript');
});

test('an agent who is working (console open) is not emailed', async (t) => {
  const { svc, aline, ref, say } = await withAgentCase(t);
  await svc.clock.advance(MIN);
  await aline.open(ref); // the console refreshes the case
  await svc.clock.advance(MIN);

  await say('Are you there?');

  assert.deepEqual(mails(svc), []);
});

test('how long counts as "gone" is configuration', async (t) => {
  const { loadSupport } = await import('../src/support.js');
  const base = loadSupport(new URL('../config/support.json', import.meta.url));
  const { svc, aline, ref } = await withAgentCase(t, { support: { ...base, timers: { ...base.timers, absentMs: 30_000 } } });
  await svc.clock.advance(45_000);

  await aline.reply(ref, 'hello');

  assert.equal(svc.mailer.outbox.length, 1);
});
