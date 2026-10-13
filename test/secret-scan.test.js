import { test } from 'node:test';
import assert from 'node:assert/strict';
import { row, sha512 } from './harness/bank-fixtures.js';
import { createFakeModel } from './harness/fake-model.js';
import { createFakeMailer } from './harness/fake-mailer.js';
import { AGENTS, agentLogin, call } from './harness/cases.js';
import { makeToken } from './harness/token.js';
import { TENANT, alice, begin, say, start } from './harness/t1-helpers.js';
import { createMailer } from '../src/mailer.js';
import { loadScamCues } from '../src/scam.js';

// The scan: one conversation that keeps handing the assistant a PIN, an OTP, a card number and a token, through every
// feature built so far, then a search of everything the service wrote or sent for those values.
const MIN = 60_000;
const PIN = '4821';
const OTP = '987654';
const CARD = '4111 1111 1111 1111';
const PASTED_JWT = makeToken('somebody-else', '-pasted');
const PASTED_BEARER = 'abcDEF123456xyz789';
const ACCOUNT = '12345678901'; // alice's full account number, typed by her once
const BOX_PIN = '1234'; // the PIN she keys into the widget's own box; only its hash travels

// Not preceded or followed by a word character or hyphen, so a group of a random UUID that happens to read 4821 is no leak.
const alone = (value) => new RegExp(`(?<![\\w-])${value}(?![\\w-])`);
const LEAK = [
  ['the PIN', alone(PIN)],
  ['the OTP', alone(OTP)],
  ['a card number', /4111[ -]?1111[ -]?1111[ -]?1111/],
  ['a token pasted as a JWT', new RegExp(PASTED_JWT.replace(/[.]/g, '\\.'))],
  ['a pasted bearer value', new RegExp(PASTED_BEARER)],
  ['the PIN box hash', new RegExp(sha512(BOX_PIN))],
  ['the hash of the typed PIN', new RegExp(sha512(PIN))],
];

function route(request) {
  if (request.purpose === 'summary') return 'The customer asks for help with a transfer to the wrong person.';
  if (request.purpose === 'route') {
    const asked = request.messages.at(-1).content;
    if (/last transactions/.test(asked)) return '[[tool:last_transactions {"count":3}]]';
    if (/status of REF-0001/.test(asked)) return '[[tool:transfer_status {"reference":"REF-0001"}]]';
    if (/why did REF-0001 fail/.test(asked)) return '[[tool:explain_failure {"reference":"REF-0001"}]]';
    if (/fees and limits/.test(asked)) return '[[tool:fees_limits {}]]';
    if (/my balance/.test(asked)) return '[[tool:balance {}]]';
    if (/wire the money/.test(asked)) return '[[refusal:execute]]';
    if (/something unknown/.test(asked)) return '[]';
    return '["transfer-single"]';
  }
  const asked = request.messages.at(-1).content;
  if (/Send 5000/.test(asked)) return '[[prefill:single_transfer {"destination":"237677000555","amount":5000,"narrative":"rent"}]]I filled the form.';
  if (/How do I send money/.test(asked)) return '[[navigate:transfer]]Open Transfers.';
  return 'Here is what I found.';
}

async function drive(t) {
  const a = alice();
  a.rows = [row(a, { clientReferenceId: 'REF-0001', sta: '100' })];
  // The real log-only mailer runs behind the fake, so the lines it would log are scanned too.
  const mailLog = [];
  const outbox = createFakeMailer();
  const logOnly = createMailer({ mode: 'log' }, { log: (line) => mailLog.push(line) });
  const mailer = { outbox: outbox.outbox, async send(m) { await outbox.send(m); await logOnly.send(m); } };
  const svc = await start({ customers: [a], model: createFakeModel(route), mailer, limits: { messagesPerMinute: 1000, tokensPerMinute: 1e9 }, scamCues: loadScamCues(new URL('../config/scam-cues.json', import.meta.url)), agents: { ...AGENTS, sessionMs: 1000 * 60 * MIN } });
  t.after(svc.close);

  const logged = [];
  const methods = ['log', 'info', 'warn', 'error', 'debug'];
  const originals = Object.fromEntries(methods.map((m) => [m, console[m]]));
  for (const m of methods) console[m] = (...args) => logged.push(args.map(String).join(' '));
  t.after(() => { for (const m of methods) console[m] = originals[m]; });

  const id = await begin(svc, a);
  const events = [];
  const say_ = async (message) => { events.push(...(await say(svc, a, message, id)).events); };
  const unlock = (payload) => fetch(`${svc.baseUrl}/unlock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${a.token}` },
    body: JSON.stringify({ conversationId: id, tenant: TENANT, ...payload }),
  });
  const post = async (path, body) => { const res = await call(svc.baseUrl, 'POST', path, { token: a.token, body: { conversationId: id, tenant: TENANT, ...body } }); events.push(res.body); return res; };

  // how-to, scam shield, refusal, PIN/OTP shield, pasted tokens
  await say_(`How do I send money? my pin is ${PIN}, otp ${OTP}, card ${CARD}`);
  await say_(`my token is ${PASTED_JWT} and Authorization: Bearer ${PASTED_BEARER}`);
  await say_(`my account is ${ACCOUNT}. A caller from the bank asked for my otp ${OTP}, he is from the bank`);
  await say_(`wire the money for me, my pin is ${PIN}`);
  // own-data reads, explain my failure, balance behind the PIN box
  await say_(`show my last transactions, pin ${PIN}`);
  await say_(`status of REF-0001, otp ${OTP}`);
  await say_(`why did REF-0001 fail? card ${CARD.replaceAll(' ', '')}`);
  await say_(`what are the fees and limits, pin ${PIN}`);
  await say_(`my balance please, pin ${PIN}`);
  events.push(await (await unlock({ pinHash: sha512(BOX_PIN) })).json());
  await say_(`my balance please, pin ${PIN}`);
  // navigate and pre-fill, a question no guide covers
  await say_(`Send 5000 to 237677000555 for rent, pin ${PIN}`);
  await say_(`something unknown, otp ${OTP}`);
  // drafted case message to chat and email
  await say_(`I sent money to the wrong person, REF-0001, my pin is ${PIN}`);
  const { body: draft } = await post('/draft', { reference: 'REF-0001' });
  const { body: shown } = await post('/draft/preview', { draftId: draft.draftId, destination: 'both', text: `Wrong person. My pin ${PIN}, otp ${OTP}, card ${CARD}, token ${PASTED_JWT}` });
  await post('/draft/confirm', { draftId: draft.draftId, previewToken: shown.previewToken });
  // handoff: paging, claim, agent chat, timers, absent customer, summary
  const aline = await agentLogin(svc.baseUrl, 'aline');
  const { body: status } = await call(svc.baseUrl, 'GET', `/case?conversationId=${id}`, { token: a.token });
  const ref = status.ref;
  await svc.clock.advance(6 * MIN); // the pool is paged
  events.push((await aline.claim(ref)).body);
  await say_(`here is my otp ${OTP} for the agent`);
  await svc.clock.advance(11 * MIN); // soft "still working on it"
  await svc.clock.advance(20 * MIN); // re-broadcast
  events.push((await aline.reply(ref, 'Thank you, I am looking into it.')).body);
  await svc.clock.advance(5 * MIN); // the customer has left: an agent reply emails them
  events.push((await aline.reply(ref, 'Any news from your side?')).body);
  const detail = await aline.open(ref);
  const audited = await call(svc.baseUrl, 'GET', '/agent/audit?limit=500', { token: aline.token });
  // The export files, downloaded by the same reader: they must hold no more than the reader shows.
  const file = (format) => fetch(`${svc.baseUrl}/agent/audit/export?format=${format}`, { headers: { authorization: `Bearer ${aline.token}` } }).then((r) => r.text());
  const exportedJson = await file('json');
  const exportedCsv = await file('csv');

  return {
    svc, ref, audited, exportedJson, exportedCsv,
    surfaces: {
      'the audit log': JSON.stringify(svc.audit.records),
      'the audit reader': JSON.stringify(audited.body),
      'the audit export (JSON)': exportedJson,
      'the audit export (CSV)': exportedCsv,
      'the logs': [...logged, ...mailLog].join('\n'),
      'the failed-question log': JSON.stringify(svc.failedQuestions.records),
      'the model input': JSON.stringify(svc.model.calls),
      'the email bodies': JSON.stringify(svc.mailer.outbox),
      'what the customer sees': JSON.stringify(events),
      'the agent console': JSON.stringify(detail.body),
    },
  };
}

test('no PIN, OTP, card number, token or PIN hash appears in the audit, the logs, the model input or any email, through every feature', async (t) => {
  const { surfaces, svc } = await drive(t);

  for (const [surface, text] of Object.entries(surfaces)) {
    for (const [name, pattern] of LEAK) assert.doesNotMatch(text, pattern, `${name} is in ${surface}`);
  }
  // the forwarded token and the full account number never get into what is stored or sent either
  const stored = ['the audit log', 'the audit reader', 'the audit export (JSON)', 'the audit export (CSV)', 'the logs', 'the failed-question log', 'the email bodies', 'the agent console'];
  const a = alice();
  for (const surface of stored) {
    assert.ok(!surfaces[surface].includes(a.token), `the session token is in ${surface}`);
    assert.doesNotMatch(surfaces[surface], new RegExp(ACCOUNT), `the full account number is in ${surface}`);
  }

  // the scan is only worth something if the conversation really went through each feature
  const outcomes = new Set(svc.audit.records.map((r) => r.outcome));
  for (const wanted of ['ok', 'session_started', 'balance_unlocked_pin', 'handoff_opened', 'case_claimed', 'case_paged', 'draft_sent', 'case_still_working', 'case_rebroadcast', 'relayed_to_agent', 'customer_emailed']) {
    assert.ok(outcomes.has(wanted), `the conversation never reached ${wanted}`);
  }
  const used = svc.audit.records;
  assert.ok(used.some((r) => r.refusalCategory === 'execute'), 'refusal');
  assert.ok(used.some((r) => r.scamCues?.length), 'scam cue');
  assert.ok(used.some((r) => r.navigate?.outcome === 'offered'), 'navigate card');
  assert.ok(used.some((r) => r.prefill?.outcome === 'offered'), 'pre-fill card');
  assert.deepEqual(['last_transactions', 'transfer_status', 'explain_failure', 'fees_limits', 'balance'].filter((n) => !used.some((r) => r.tool === n)), [], 'every read tool');
  assert.ok(svc.failedQuestions.records.length >= 1, 'failed question');
  assert.ok(svc.model.calls.some((c) => c.purpose === 'summary'), 'summary');
  assert.ok(svc.mailer.outbox.length >= 3, 'paging and customer emails were sent');
});

test('the audit export files from the scan conversation are real, carry the reader\'s records, and hold none of the secrets', async (t) => {
  const { audited, exportedJson, exportedCsv } = await drive(t);

  const records = JSON.parse(exportedJson);
  assert.ok(records.length > 20, 'the export is not an empty file that trivially passes the search');
  assert.ok(records.length <= 500, 'small enough for the reader to show it all');
  assert.deepEqual(records, audited.body.records, 'same masked records as the reader');
  assert.match(exportedCsv.split('\r\n')[0], /^time,user,tenant,conversationId,outcome,/);
  assert.ok(exportedCsv.split('\r\n').length > records.length, 'one CSV row per record');
  for (const [name, pattern] of LEAK) {
    assert.doesNotMatch(exportedJson, pattern, `${name} is in the JSON export`);
    assert.doesNotMatch(exportedCsv, pattern, `${name} is in the CSV export`);
  }
});
