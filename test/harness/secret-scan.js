// The ticket 33 secret scan, as a module: one conversation that keeps handing the assistant secrets through every feature.
import { row, sha512 } from './bank-fixtures.js';
import { createFakeModel } from './fake-model.js';
import { createFakeMailer } from './fake-mailer.js';
import { AGENTS, agentLogin, call } from './cases.js';
import { makeToken } from './token.js';
import { TENANT, alice, begin, say, start } from './t1-helpers.js';
import { createMailer } from '../../src/mailer.js';
import { loadScamCues } from '../../src/scam.js';

// The scan: one conversation that keeps handing the assistant a PIN, an OTP, a card number and a token, through every
// feature built so far, then a search of everything the service wrote or sent for those values.
export const MIN = 60_000;
export const PIN = '4821';
export const OTP = '987654';
export const CARD = '4111 1111 1111 1111';
export const PASTED_JWT = makeToken('somebody-else', '-pasted');
export const PASTED_BEARER = 'abcDEF123456xyz789';
export const ACCOUNT = '12345678901'; // alice's full account number, typed by her once
export const BOX_PIN = '1234'; // the PIN she keys into the widget's own box; only its hash travels

// Not preceded or followed by a word character or hyphen, so a group of a random UUID that happens to read 4821 is no leak.
const alone = (value) => new RegExp(`(?<![\\w-])${value}(?![\\w-])`);
export const LEAK = [
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

export async function drive(t, extra = {}) {
  const a = alice();
  a.rows = [row(a, { clientReferenceId: 'REF-0001', sta: '100' })];
  // The real log-only mailer runs behind the fake, so the lines it would log are scanned too.
  const mailLog = [];
  const outbox = createFakeMailer();
  const logOnly = createMailer({ mode: 'log' }, { log: (line) => mailLog.push(line) });
  const mailer = { outbox: outbox.outbox, async send(m) { await outbox.send(m); await logOnly.send(m); } };
  const svc = await start({ customers: [a], model: createFakeModel(route), mailer, limits: { messagesPerMinute: 1000, tokensPerMinute: 1e9 }, scamCues: loadScamCues(new URL('../../config/scam-cues.json', import.meta.url)), agents: { ...AGENTS, sessionMs: 1000 * 60 * MIN }, ...extra });
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

