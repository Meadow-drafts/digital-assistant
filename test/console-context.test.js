import { test } from 'node:test';
import assert from 'node:assert/strict';
import { row } from './harness/bank-fixtures.js';
import { createFakeModel } from './harness/fake-model.js';
import { agentLogin, call } from './harness/cases.js';
import { alice, bob, begin, say, start } from './harness/t1-helpers.js';

const SUMMARY = 'The customer says a transfer of 15000 XAF went to the wrong person and wants help.';

// Routes the router call to "no guide", writes summaries from a script, answers everything else with a short reply.
function model({ summaries = [SUMMARY] } = {}) {
  let i = 0;
  const m = createFakeModel((request) => {
    if (request.purpose === 'summary') return summaries[Math.min(i++, summaries.length - 1)];
    if (request.purpose === 'route') return '[]';
    return 'Here is some general help.';
  });
  m.summaryCalls = () => m.calls.filter((c) => c.purpose === 'summary');
  return m;
}

const wrongTransfer = (c) => row(c, { clientReferenceId: 'REF-0001', sta: '100', mtrans: 15000, partnerlib: 'Jean Paul Mbarga', telop: '237677000999' });

// A customer who told the assistant about a wrong transfer, then clicked "Talk to a human agent".
async function handoff(t, { text = 'I sent 15000 to the wrong person by mistake, reference REF-0001', m = model(), over = {} } = {}) {
  const a = alice();
  a.rows = [wrongTransfer(a), row(a, { clientReferenceId: 'REF-0002', ntrans: 'N0002', mtrans: 2500, partnerlib: 'Marie Ngo' })];
  const svc = await start({ customers: [a], model: m, ...over });
  t.after(svc.close);
  const conversationId = await begin(svc, a);
  await say(svc, a, text, conversationId);
  const open = () => call(svc.baseUrl, 'POST', '/handoff', { token: a.token, body: { conversationId } });
  return { a, svc, m, conversationId, open, say: (msg) => say(svc, a, msg, conversationId) };
}

test('a claiming agent sees the draft, an AI summary labelled "may be wrong", masked recent transactions and the transcript', async (t) => {
  const { svc, open, conversationId } = await handoff(t);
  const { body: { ref } } = await open();
  const aline = await agentLogin(svc.baseUrl, 'aline');
  await aline.claim(ref);

  const { status, body } = await aline.open(ref);

  assert.equal(status, 200);
  assert.equal(body.summary.text, SUMMARY);
  assert.match(body.summary.label, /may be wrong/i);
  assert.equal(body.records.length, 2);
  assert.deepEqual(body.records[0], {
    reference: 'REF-0001', date: '2026-10-10', amount: 15000, currency: 'XAF', direction: 'out', nature: { code: 'TRINC', en: 'TRINC', fr: 'TRINC' }, type: null, status: 'failed', account: '****8901', counterparty: 'J. P. M.',
  });
  assert.ok(body.transcript.some((m) => m.from === 'customer' && /wrong person/.test(m.text)), 'the raw transcript is there');
  assert.doesNotMatch(JSON.stringify(body), /12345678901|Jean|Paul Mbarga|Marie|Ngo|237677000999/);
  assert.equal(body.conversationId, conversationId);
});

test('the draft the customer confirmed is shown on its own, apart from the transcript', async (t) => {
  const { svc, a, conversationId } = await handoff(t);
  const post = (path, body) => call(svc.baseUrl, 'POST', path, { token: a.token, body: { conversationId, ...body } });
  const { body: draft } = await post('/draft', { reference: 'REF-0001' });
  const edited = 'Please help me, I sent 15000 to the wrong person.';
  const { body: shown } = await post('/draft/preview', { draftId: draft.draftId, text: edited, destination: 'chat' });
  const { body: sent } = await post('/draft/confirm', { draftId: draft.draftId, previewToken: shown.previewToken });
  const aline = await agentLogin(svc.baseUrl, 'aline');
  await aline.claim(sent.ref);

  const { body } = await aline.open(sent.ref);

  assert.ok(body.draft.includes(edited));
  assert.match(body.draft, /Transaction id: REF-0001/);
  assert.equal(body.transcript[0].text, body.draft, 'and it is also the first line of the transcript');
  assert.equal(body.summary.text, SUMMARY);
});

test('the summary is made once at handoff and is not regenerated on claim when the bot said nothing more', async (t) => {
  const { svc, m, open } = await handoff(t, { m: model({ summaries: ['first summary', 'second summary'] }) });
  const { body: { ref } } = await open();
  const aline = await agentLogin(svc.baseUrl, 'aline');
  await aline.claim(ref);

  const { body } = await aline.open(ref);

  assert.equal(m.summaryCalls().length, 1);
  assert.equal(body.summary.text, 'first summary');
  assert.equal(body.summary.regenerated, false);
});

test('when the bot kept chatting while the case waited, the summary is regenerated on claim and covers the new messages', async (t) => {
  const { svc, m, open, say: chat } = await handoff(t, { m: model({ summaries: ['first summary', 'second summary'] }) });
  const { body: { ref } } = await open();
  await chat('What are the fees for a transfer?');
  const aline = await agentLogin(svc.baseUrl, 'aline');
  assert.equal((await aline.open(ref)).body.summary.text, 'first summary', 'until someone claims, the handoff summary stands');

  await aline.claim(ref);
  const { body } = await aline.open(ref);

  assert.equal(m.summaryCalls().length, 2);
  assert.equal(body.summary.text, 'second summary');
  assert.equal(body.summary.regenerated, true);
  assert.match(JSON.stringify(m.summaryCalls()[1].messages), /fees for a transfer/);
  assert.doesNotMatch(JSON.stringify(m.summaryCalls()[0].messages), /fees for a transfer/);

  await aline.open(ref);
  assert.equal(m.summaryCalls().length, 2, 'reading the case again does not call the model');
});

test('the summary is written from the masked transcript only and nothing secret survives in it', async (t) => {
  const risky = 'The customer used PIN 4821 and the token Bearer eyJhbGciOi.eyJzdWIiOiIx.abc123 and account 12345678901, OTP is 987654.';
  const { svc, m, open, a } = await handoff(t, { m: model({ summaries: [risky] }), text: 'I sent 15000 from account 12345678901 to the wrong person' });
  const { body: { ref } } = await open();
  const aline = await agentLogin(svc.baseUrl, 'aline');
  await aline.claim(ref);

  const { body } = await aline.open(ref);

  const seen = JSON.stringify(m.summaryCalls().map((c) => c.messages));
  assert.doesNotMatch(seen, /12345678901/, 'the model only saw the masked transcript');
  assert.match(seen, /\*\*\*\*8901/);
  assert.doesNotMatch(seen, new RegExp(a.token.slice(0, 20)));
  assert.doesNotMatch(body.summary.text, /4821|987654|eyJ|Bearer|12345678901/);
});

test('if the model cannot write a summary the case still opens, with no summary and the transcript intact', async (t) => {
  const m = createFakeModel((request) => (request.purpose === 'summary' ? new Error('down') : request.purpose === 'route' ? '[]' : 'ok'));
  const { svc, open } = await handoff(t, { m });
  const { status, body: { ref } } = await open();
  const aline = await agentLogin(svc.baseUrl, 'aline');
  await aline.claim(ref);

  const { body } = await aline.open(ref);

  assert.equal(status, 200);
  assert.equal(body.summary, null);
  assert.ok(body.transcript.length >= 2);
});

// ---- Priority: wrong-transfer cases ----
import { createFakeClock } from './harness/fake-clock.js';
import { TENANT } from './harness/t1-helpers.js';

const pages = (svc) => svc.mailer.outbox.filter((m) => /New chat case/.test(m.subject));

test('a wrong-transfer case carries a priority flag; an ordinary case does not', async (t) => {
  const wrong = await handoff(t);
  const plain = await handoff(t, { text: 'How do I change my settings?' });
  const { body: w } = await wrong.open();
  const { body: p } = await plain.open();
  const aline = await agentLogin(wrong.svc.baseUrl, 'aline');

  assert.equal((await aline.open(w.ref)).body.priority, true);
  assert.equal((await aline.list()).body.cases.find((c) => c.ref === w.ref).priority, true);
  const other = await agentLogin(plain.svc.baseUrl, 'aline');
  assert.equal((await other.open(p.ref)).body.priority, false);
});

test('the queue lists priority cases ahead of older ordinary ones', async (t) => {
  const a = alice();
  const b = bob();
  const svc = await start({ customers: [a, b], model: model() });
  t.after(svc.close);
  const urgent = await begin(svc, a);
  await say(svc, a, 'I sent money to the wrong person by mistake', urgent);
  const ordinary = await begin(svc, b);
  await say(svc, b, 'How do I change my settings?', ordinary);
  const first = (await call(svc.baseUrl, 'POST', '/handoff', { token: a.token, body: { conversationId: urgent } })).body.ref;
  const second = (await call(svc.baseUrl, 'POST', '/handoff', { token: b.token, body: { conversationId: ordinary } })).body.ref;
  const aline = await agentLogin(svc.baseUrl, 'aline');

  assert.deepEqual((await aline.list()).body.cases.map((c) => c.ref), [first, second], 'the older priority case is above the newer ordinary one');
});

test('the page for a wrong-transfer case says PRIORITY and still carries only a link and the conversation id', async (t) => {
  const { svc, open } = await handoff(t);
  const { body } = await open();

  const [page] = pages(svc);

  assert.match(page.subject, new RegExp(`^\\[${body.ref}\\] PRIORITY`));
  assert.doesNotMatch(page.subject + page.body, /wrong|mistake|15000|REF-0001/i);
});

test('after hours, when the shift starts, wrong-transfer cases are paged before the ordinary cases that queued earlier', async (t) => {
  const a = alice();
  const b = bob();
  const svc = await start({ customers: [a, b], model: model(), clock: createFakeClock(Date.parse('2026-10-16T17:30:00Z')) });
  t.after(svc.close);
  const ordinary = await begin(svc, b);
  await say(svc, b, 'How do I change my settings?', ordinary);
  const urgent = await begin(svc, a);
  await say(svc, a, 'I sent money to the wrong person by mistake', urgent);
  const first = (await call(svc.baseUrl, 'POST', '/handoff', { token: b.token, body: { conversationId: ordinary, tenant: TENANT } })).body.ref;
  const second = (await call(svc.baseUrl, 'POST', '/handoff', { token: a.token, body: { conversationId: urgent, tenant: TENANT } })).body.ref;
  assert.equal(pages(svc).length, 0, 'closed: nobody paged yet');

  await svc.clock.advance(Date.parse('2026-10-19T07:00:00Z') - svc.clock.now());

  assert.deepEqual(pages(svc).map((m) => /^\[(C-\d+)\]/.exec(m.subject)[1]), [second, first]);
});

// ---- Who can see a case ----
test('a second agent cannot open a case another agent has claimed, and learns only who has it', async (t) => {
  const { svc, open } = await handoff(t);
  const { body: { ref } } = await open();
  const aline = await agentLogin(svc.baseUrl, 'aline');
  const paul = await agentLogin(svc.baseUrl, 'paul');
  await aline.claim(ref);

  const denied = await paul.open(ref);

  assert.equal(denied.status, 403);
  assert.deepEqual(denied.body, { error: 'not_your_case', claimedBy: 'Aline Mbarga' });
  assert.doesNotMatch(JSON.stringify(denied.body), /wrong person|summary|REF-0001|transcript/);
  assert.equal((await aline.open(ref)).status, 200, 'the agent who has it still sees it');
  const listed = (await paul.list()).body.cases.find((c) => c.ref === ref);
  assert.deepEqual(Object.keys(listed).sort(), ['claimedBy', 'closeReason', 'priority', 'ref', 'state', 'waitingSeconds'], 'the queue row carries no content');
});

test('a resolved case stays with the agent who handled it', async (t) => {
  const { svc, open } = await handoff(t);
  const { body: { ref } } = await open();
  const aline = await agentLogin(svc.baseUrl, 'aline');
  await aline.claim(ref);
  await aline.resolve(ref);

  assert.equal((await (await agentLogin(svc.baseUrl, 'paul')).open(ref)).status, 403);
  assert.equal((await aline.open(ref)).status, 200);
});

test('the console shows only the transcript of the case, never another customer\'s', async (t) => {
  const a = alice();
  const b = bob();
  b.rows = [row(b, { clientReferenceId: 'REF-BOB', mtrans: 777, partnerlib: 'Zed Zimmer' })];
  const m = model();
  const svc = await start({ customers: [a, b], model: m });
  t.after(svc.close);
  const ca = await begin(svc, a);
  await say(svc, a, 'I sent money to the wrong person, my secret-alice story', ca);
  const cb = await begin(svc, b);
  await say(svc, b, 'Please explain my secret-bob statement', cb);
  const refA = (await call(svc.baseUrl, 'POST', '/handoff', { token: a.token, body: { conversationId: ca } })).body.ref;
  await call(svc.baseUrl, 'POST', '/handoff', { token: b.token, body: { conversationId: cb } });
  const aline = await agentLogin(svc.baseUrl, 'aline');
  await aline.claim(refA);

  const { body } = await aline.open(refA);

  const everything = JSON.stringify(body);
  assert.match(everything, /secret-alice/);
  assert.doesNotMatch(everything, /secret-bob|REF-BOB|777|Zimmer|\*\*\*\*8788/);
  const sentToModel = JSON.stringify(m.summaryCalls().map((c) => c.messages).filter((msgs) => /secret-alice/.test(JSON.stringify(msgs))));
  assert.ok(sentToModel.length > 2, 'alice\'s summary was requested');
  assert.doesNotMatch(sentToModel, /secret-bob/);
});

// ---- The console page ----
import { openWidget } from './harness/open-widget.js';
import { AGENTS } from './harness/cases.js';

async function consolePage(svc, t, id, path = '/console') {
  const w = await openWidget(svc.baseUrl, path);
  t.after(() => w.dom.window.close());
  w.document.body.dataset.pollMs = '20';
  w.q('agent-id').value = id;
  w.q('agent-password').value = AGENTS.list.find((x) => x.id === id).password;
  w.q('login-form').dispatchEvent(new w.dom.window.Event('submit', { cancelable: true, bubbles: true }));
  await w.until(() => w.q('console') && !w.q('console').hidden);
  return w;
}

test('the console shows the priority flag, summary labelled "may be wrong", masked transactions and the transcript one click away', async (t) => {
  const { svc, open } = await handoff(t);
  const { body: { ref } } = await open();
  const w = await consolePage(svc, t, 'aline', `/console?case=${ref}`);
  await w.until(() => w.q('detail-ref')?.textContent.includes(ref));

  w.q('claim').click();
  await w.until(() => !w.q('reply-send').disabled && !w.q('summary').hidden && w.q('summary-text').textContent !== '');

  assert.equal(w.q('priority').hidden, false);
  assert.match(w.q('priority').textContent, /priority/i);
  assert.equal(w.q('summary-text').textContent, SUMMARY);
  assert.match(w.q('summary-label').textContent, /may be wrong/i);
  const records = w.qa('record').map((r) => r.textContent);
  assert.equal(records.length, 2);
  assert.match(records[0], /REF-0001/);
  assert.match(records[0], /15000 XAF/);
  assert.match(records[0], /\*\*\*\*8901/);
  assert.match(records[0], /J\. P\. M\./);
  assert.doesNotMatch(w.document.body.textContent, /Jean|12345678901/);
  assert.equal(w.q('transcript-box').open, false, 'the raw transcript is collapsed...');
  assert.ok(w.q('transcript-box').querySelector('summary'), '...behind one click');
  assert.ok(w.qa('line').some((l) => /wrong person/.test(l.textContent)));
});

test('the console shows the confirmed draft in its own block', async (t) => {
  const { svc, a, conversationId } = await handoff(t);
  const post = (path, body) => call(svc.baseUrl, 'POST', path, { token: a.token, body: { conversationId, ...body } });
  const { body: draft } = await post('/draft', { reference: 'REF-0001' });
  const { body: shown } = await post('/draft/preview', { draftId: draft.draftId, text: 'Please help, wrong person.', destination: 'chat' });
  const { body: sent } = await post('/draft/confirm', { draftId: draft.draftId, previewToken: shown.previewToken });
  const w = await consolePage(svc, t, 'aline', `/console?case=${sent.ref}`);

  await w.until(() => !w.q('draft').hidden);

  assert.match(w.q('draft-text').textContent, /Please help, wrong person\./);
});

test('on another agent\'s console a claimed case shows who has it and none of its content', async (t) => {
  const { svc, open } = await handoff(t);
  const { body: { ref } } = await open();
  await (await agentLogin(svc.baseUrl, 'aline')).claim(ref);
  const w = await consolePage(svc, t, 'paul', `/console?case=${ref}`);

  await w.until(() => /Aline/.test(w.q('detail-claimed-by').textContent));

  assert.equal(w.q('summary').hidden, true);
  assert.equal(w.q('draft').hidden, true);
  assert.equal(w.qa('record').length, 0);
  assert.equal(w.qa('line').length, 0);
  assert.equal(w.q('claim').disabled, true);
  assert.doesNotMatch(w.document.body.textContent, /wrong person|REF-0001/);
});
