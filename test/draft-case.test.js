import { test } from 'node:test';
import assert from 'node:assert/strict';
import { row } from './harness/bank-fixtures.js';
import { loadSupport } from '../src/support.js';
import { agentLogin, call } from './harness/cases.js';
import { alice, bob, begin, say, start, toolModel } from './harness/t1-helpers.js';

const SUPPORT_TO = 'help@bank.test';
const support = () => {
  const s = loadSupport(new URL('../config/support.json', import.meta.url));
  return { ...s, mail: { ...s.mail, supportAddress: SUPPORT_TO } };
};

// A customer with one failed transfer who has told the assistant it went to the wrong person.
const wrongTransfer = (c) => row(c, { clientReferenceId: 'REF-0001', sta: '100', mtrans: 15000, partnerlib: 'Jean Paul Mbarga', telop: '237677000999' });

async function dispute(t, { model = toolModel('Hello.'), customers, over } = {}) {
  const a = alice();
  a.rows = [wrongTransfer(a)];
  const svc = await start({ customers: customers?.(a) ?? [a], model, support: support(), ...over });
  t.after(svc.close);
  const conversationId = await begin(svc, a);
  await say(svc, a, 'I sent 15000 to the wrong person by mistake, reference REF-0001', conversationId);
  const post = (path, body) => call(svc.baseUrl, 'POST', path, { token: a.token, body: { conversationId, ...body } });
  return { a, svc, conversationId, post };
}

test('a draft is written from the customer\'s own words and masked details of the transaction, and nothing is sent', async (t) => {
  const { svc, post } = await dispute(t);
  const before = svc.mailer.outbox.length;

  const res = await post('/draft', { reference: 'REF-0001' });

  assert.equal(res.status, 200);
  assert.match(res.body.text, /sent 15000 to the wrong person by mistake/, 'the customer\'s own words');
  const details = Object.fromEntries(res.body.details.map((d) => [d.key, d.value]));
  assert.deepEqual(details, {
    reference: 'REF-0001', amount: '15000 XAF', date: '2026-10-10', account: '****8901', counterparty: 'J. P. M.', status: 'failed',
  });
  assert.doesNotMatch(JSON.stringify(res.body), /12345678901|Jean|Mbarga|237677000999/);
  assert.equal(svc.mailer.outbox.length, before, 'no email');
  const aline = await agentLogin(svc.baseUrl, 'aline');
  assert.deepEqual((await aline.list()).body.cases, [], 'no case');
});

test('the preview shows the exact email (support address from config, case reference in the subject) and the exact chat message, and sends nothing', async (t) => {
  const { svc, post } = await dispute(t);
  const { body: draft } = await post('/draft', { reference: 'REF-0001' });
  const before = svc.mailer.outbox.length;

  const edited = 'Hello, I sent 15000 to the wrong person. Please help me.';
  const both = await post('/draft/preview', { draftId: draft.draftId, text: edited, destination: 'both' });
  const emailOnly = await post('/draft/preview', { draftId: draft.draftId, text: edited, destination: 'email' });
  const chatOnly = await post('/draft/preview', { draftId: draft.draftId, text: edited, destination: 'chat' });

  assert.equal(both.status, 200);
  assert.equal(both.body.email.to, SUPPORT_TO);
  assert.match(both.body.email.subject, /^\[C-\d+\] /);
  assert.ok(both.body.email.body.includes(edited), 'the customer\'s edit, word for word');
  assert.match(both.body.email.body, /Transaction id: REF-0001/);
  assert.match(both.body.email.body, /Amount: 15000 XAF/);
  assert.equal(both.body.chat.text, both.body.email.body.slice(both.body.email.body.indexOf(edited)), 'chat carries the same words and details as the email body');
  assert.equal(emailOnly.body.chat, undefined);
  assert.equal(chatOnly.body.email, undefined);
  assert.equal(svc.mailer.outbox.length, before, 'previewing sends nothing');
  const aline = await agentLogin(svc.baseUrl, 'aline');
  assert.deepEqual((await aline.list()).body.cases, [], 'and opens nothing');
});

// Draft, edit, preview: the exact content the customer is about to confirm.
async function previewed(t, destination, { text = 'I sent 15000 to the wrong person. Please help me.', ...opts } = {}) {
  const ctx = await dispute(t, opts);
  const { body: draft } = await ctx.post('/draft', { reference: 'REF-0001' });
  const { body: shown } = await ctx.post('/draft/preview', { draftId: draft.draftId, text, destination });
  const confirm = (over = {}) => ctx.post('/draft/confirm', { draftId: draft.draftId, previewToken: shown.previewToken, ...over });
  return { ...ctx, draft, shown, confirm };
}

test('confirming a chat draft opens the handoff with the draft as its opening message; the page to agents carries no content', async (t) => {
  const { svc, shown, confirm } = await previewed(t, 'chat');

  const res = await confirm();

  assert.equal(res.status, 200);
  assert.equal(res.body.state, 'waiting');
  assert.equal(res.body.ref, shown.ref, 'the reference the customer was shown');
  assert.match(res.body.notice, /within 24 hours/i);
  const aline = await agentLogin(svc.baseUrl, 'aline');
  const opened = (await aline.open(shown.ref)).body;
  assert.deepEqual({ from: opened.transcript[0].from, text: opened.transcript[0].text }, { from: 'customer', text: shown.chat.text }, 'the first message of the case is the confirmed draft, word for word');
  assert.deepEqual(svc.mailer.outbox.map((m) => m.to), ['aline@bank.test'], 'only the on-call page, nothing to the support address');
  assert.doesNotMatch(JSON.stringify(svc.mailer.outbox), /wrong person|15000|REF-0001/);
});

test('confirming an email draft sends exactly the previewed email to support, pages nobody, leaves the customer with the assistant, and confirms with the reference', async (t) => {
  const { svc, a, conversationId, shown, confirm } = await previewed(t, 'email');
  assert.deepEqual(svc.mailer.outbox, [], 'nothing sent before the confirm');

  const res = await confirm();

  assert.equal(res.status, 200);
  assert.deepEqual(svc.mailer.outbox, [shown.email], 'the support mail is the previewed email, field for field');
  assert.match(shown.email.subject, new RegExp(`^\\[${shown.ref}\\]`));
  assert.match(res.body.confirmation, new RegExp(shown.ref));
  assert.match(res.body.confirmation, /within 24 hours/i);
  assert.doesNotMatch(res.body.confirmation, /revers|refund|will be returned/i, 'no promise of a reversal');
  assert.equal(res.body.state, 'bot');
  const own = await call(svc.baseUrl, 'GET', `/case?conversationId=${conversationId}`, { token: a.token });
  assert.equal(own.body.state, 'bot', 'no waiting banner for an email-only message');
  const aline = await agentLogin(svc.baseUrl, 'aline');
  const [filed] = (await aline.list()).body.cases;
  assert.equal(filed.ref, shown.ref, 'the reference leads to a recorded case');
  assert.notEqual(filed.state, 'waiting', 'but nobody is paged');
});

test('"both" opens the handoff and emails support under the same case reference, each carrying exactly the previewed content', async (t) => {
  const { svc, shown, confirm } = await previewed(t, 'both');

  const res = await confirm();

  assert.equal(res.status, 200);
  assert.equal(res.body.state, 'waiting');
  assert.equal(res.body.ref, shown.ref);
  const supportMail = svc.mailer.outbox.filter((m) => m.to === SUPPORT_TO);
  assert.deepEqual(supportMail, [shown.email]);
  assert.match(supportMail[0].subject, new RegExp(`^\\[${res.body.ref}\\]`));
  const aline = await agentLogin(svc.baseUrl, 'aline');
  assert.equal((await aline.open(shown.ref)).body.transcript[0].text, shown.chat.text);
  assert.deepEqual(svc.mailer.outbox.filter((m) => m.to !== SUPPORT_TO).map((m) => m.to), ['aline@bank.test'], 'the agent page still goes out, without content');
});

test('the email never carries a full account number, phone number or the counterparty\'s name, even when the customer typed them', async (t) => {
  const typed = 'I sent 15000 from account 12345678901 to Jean Paul Mbarga on 237677000999 by mistake. My other number is +237 690 000 111.';
  const { svc, shown, confirm } = await previewed(t, 'email', { text: typed });

  await confirm();

  const [mail] = svc.mailer.outbox;
  assert.doesNotMatch(mail.subject + mail.body, /12345678901|237677000999|237690000111|690 000 111|Jean|Paul|Mbarga/i);
  assert.match(mail.body, /account \*\*\*\*8901 to J\. P\. M\. on \*\*\*\*0999/, 'masked in place so the sentence still reads');
  assert.match(mail.body, /Account: \*\*\*\*8901/);
  assert.match(mail.body, /Counterparty: J\. P\. M\./);
  assert.match(mail.body, /Amount: 15000 XAF/, 'amounts and dates stay real');
  assert.match(mail.body, /Date: 2026-10-10/);
  assert.deepEqual(mail, shown.email, 'and the screen showed the same masked text');
});

test('a PIN or OTP typed into the edit is removed before it is shown or sent, and the customer is warned', async (t) => {
  const { svc, shown, confirm } = await previewed(t, 'both', { text: 'They asked for my pin 4821 so I sent the money.' });

  assert.ok(shown.warning, 'the customer is warned');
  assert.doesNotMatch(JSON.stringify(shown), /4821/);
  await confirm();
  assert.doesNotMatch(JSON.stringify(svc.mailer.outbox), /4821/);
});

test('nothing is sent unless the confirm carries the token of the content last shown: an edit after the preview, a missing token or a second confirm send nothing', async (t) => {
  const { svc, draft, shown, post, confirm } = await previewed(t, 'both');

  assert.equal((await confirm({ previewToken: undefined })).status, 409);
  assert.equal((await confirm({ previewToken: 'f'.repeat(64) })).status, 409);
  // the customer edits again: the earlier token no longer matches what they are looking at
  const again = await post('/draft/preview', { draftId: draft.draftId, text: 'A different message.', destination: 'both' });
  assert.equal((await confirm()).status, 409, 'the old token is dead');
  assert.deepEqual(svc.mailer.outbox, [], 'still nothing sent');

  assert.equal((await confirm({ previewToken: again.body.previewToken })).status, 200);
  const sent = svc.mailer.outbox.length;
  assert.equal((await confirm({ previewToken: again.body.previewToken })).status, 409, 'a second confirm');
  assert.equal(svc.mailer.outbox.length, sent, 'sends nothing more');
  assert.notEqual(again.body.previewToken, shown.previewToken);
});

test('another customer cannot preview or confirm a draft that is not theirs', async (t) => {
  const b = bob();
  const { svc, conversationId, draft, shown } = await previewed(t, 'email', { customers: (a) => [a, b] });
  const asBob = (path, body) => call(svc.baseUrl, 'POST', path, { token: b.token, body: { conversationId, draftId: draft.draftId, ...body } });

  assert.equal((await asBob('/draft', {})).status, 404);
  assert.equal((await asBob('/draft/preview', { text: 'x', destination: 'email' })).status, 404);
  assert.equal((await asBob('/draft/confirm', { previewToken: shown.previewToken })).status, 404);
  assert.deepEqual(svc.mailer.outbox, []);
});

test('if the support mailbox cannot be reached nothing else happens: no case, no chat, the customer is told and the same draft can be sent again', async (t) => {
  const { svc, shown, confirm } = await previewed(t, 'both');
  const send = svc.mailer.send;
  svc.mailer.send = async () => { throw new Error('smtp down'); };

  const failed = await confirm();

  assert.equal(failed.status, 502);
  assert.equal(failed.body.error, 'email_failed');
  const aline = await agentLogin(svc.baseUrl, 'aline');
  assert.deepEqual((await aline.list()).body.cases, [], 'the chat was not opened without the email');
  svc.mailer.send = send;
  const retried = await confirm();
  assert.equal(retried.status, 200);
  assert.equal(retried.body.ref, shown.ref);
  assert.deepEqual(svc.mailer.outbox.filter((m) => m.to === SUPPORT_TO), [shown.email]);
});

test('with no reference named, the draft uses the transaction the assistant just looked up for the customer', async (t) => {
  const model = toolModel('[[tool:explain_failure {"reference":"REF-0001"}]]', ['[[next:human]]It failed.']);
  const { post } = await dispute(t, { model });
  // the dispute() helper's chat turn already routed to explain_failure for REF-0001
  const res = await post('/draft', {});

  assert.equal(res.body.detailsFound, true);
  assert.equal(res.body.details.find((d) => d.key === 'reference').value, 'REF-0001');
});

test('details are never invented: a reference that is not the customer\'s own, or an unreadable history, gives a draft with their words only', async (t) => {
  const b = bob();
  b.rows = [row(b, { clientReferenceId: 'REF-BOB', mtrans: 777 })];
  const { post, svc } = await dispute(t, { customers: (a) => [a, b] });

  const other = await post('/draft', { reference: 'REF-BOB' });
  const unknown = await post('/draft', { reference: 'REF-9999' });
  const nothing = await post('/draft', {});

  for (const res of [other, unknown, nothing]) {
    assert.equal(res.status, 200);
    assert.equal(res.body.detailsFound, false);
    assert.deepEqual(res.body.details, []);
    assert.match(res.body.text, /wrong person/);
    assert.doesNotMatch(JSON.stringify(res.body), /777|REF-BOB/);
  }
  assert.deepEqual(svc.mailer.outbox, []);
});

test('a customer who already has a case open adds the confirmed draft to that case, and an email carries that case\'s reference', async (t) => {
  const { svc, conversationId, a, post } = await dispute(t);
  const opened = await call(svc.baseUrl, 'POST', '/handoff', { token: a.token, body: { conversationId } });
  const { body: draft } = await post('/draft', { reference: 'REF-0001' });
  const { body: shown } = await post('/draft/preview', { draftId: draft.draftId, text: 'More detail: it was today.', destination: 'both' });

  const res = await post('/draft/confirm', { draftId: draft.draftId, previewToken: shown.previewToken });

  assert.equal(shown.ref, opened.body.ref, 'the same case, not a new reference');
  assert.equal(res.status, 200);
  const aline = await agentLogin(svc.baseUrl, 'aline');
  const cases = (await aline.list()).body.cases;
  assert.equal(cases.length, 1);
  assert.equal((await aline.open(opened.body.ref)).body.transcript.at(-1).text, shown.chat.text);
  assert.match(svc.mailer.outbox.find((m) => m.to === SUPPORT_TO).subject, new RegExp(`^\\[${opened.body.ref}\\]`));
});

test('if a case was opened after the preview, the old preview is refused instead of sending under a different reference', async (t) => {
  const { svc, conversationId, a, shown, confirm } = await previewed(t, 'email');
  await call(svc.baseUrl, 'POST', '/handoff', { token: a.token, body: { conversationId } });
  const sent = svc.mailer.outbox.length;

  const res = await confirm();

  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'case_changed');
  assert.equal(svc.mailer.outbox.length, sent);
  assert.ok(shown.email.subject.includes(shown.ref));
});

test('a French conversation gets a French draft, French labels and a French subject', async (t) => {
  const a = alice();
  a.rows = [wrongTransfer(a)];
  const svc = await start({ customers: [a], model: toolModel('Bonjour.'), support: support() });
  t.after(svc.close);
  const conversationId = await begin(svc, a);
  await say(svc, a, "J'ai envoyé 15000 à la mauvaise personne par erreur, référence REF-0001", conversationId);
  const post = (path, body) => call(svc.baseUrl, 'POST', path, { token: a.token, body: { conversationId, ...body } });

  const { body: draft } = await post('/draft', { reference: 'REF-0001' });
  const { body: shown } = await post('/draft/preview', { draftId: draft.draftId, text: draft.text, destination: 'email' });

  assert.equal(draft.language, 'fr');
  assert.match(draft.text, /mauvaise personne/);
  assert.equal(draft.details.find((d) => d.key === 'amount').label, 'Montant');
  assert.match(shown.email.subject, /^\[C-\d+\] Message du client/);
  assert.match(shown.email.body, /Identifiant de la transaction: REF-0001/);
  const res = await post('/draft/confirm', { draftId: draft.draftId, previewToken: shown.previewToken });
  assert.match(res.body.confirmation, /Votre référence de dossier est C-\d+/);
  assert.match(res.body.confirmation, /dans les 24 heures/);
});

test('the audit log records that a draft was sent, where and under which case, but never its content', async (t) => {
  const { svc, shown, confirm } = await previewed(t, 'both', { text: 'Secret-looking narrative: sent to the wrong person.' });
  await confirm();

  const sent = svc.audit.records.find((r) => r.outcome === 'draft_sent');
  assert.equal(sent.caseRef, shown.ref);
  assert.equal(sent.destination, 'both');
  assert.equal(sent.userText, '');
  assert.equal(sent.replyText, '');
  assert.doesNotMatch(JSON.stringify(svc.audit.records.filter((r) => /^draft_/.test(r.outcome))), /Secret-looking|REF-0001|15000/);
});

test('the support email address is configuration: a missing or malformed one fails loudly at load, and the shipped config is log-only', async () => {
  const { writeFileSync, mkdtempSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const good = JSON.parse(readFileSync(new URL('../config/support.json', import.meta.url), 'utf8'));
  const dir = mkdtempSync(`${tmpdir()}/support-`);
  const withAddress = (supportAddress) => {
    const path = `${dir}/${String(supportAddress).replace(/\W/g, '_')}.json`;
    writeFileSync(path, JSON.stringify({ ...good, mail: { ...good.mail, supportAddress } }));
    return path;
  };

  assert.throws(() => loadSupport(withAddress(undefined)), /supportAddress/);
  assert.throws(() => loadSupport(withAddress('not an address')), /supportAddress/);
  assert.equal(loadSupport(withAddress('team@bank.test')).mail.supportAddress, 'team@bank.test');
  assert.equal(good.mail.mode, 'log', 'nothing is really sent unless the bank switches the mailer on');
});
