import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService } from './harness/start-service.js';
import { createFakeModel } from './harness/fake-model.js';
import { AGENTS, agentLogin, customer } from './harness/cases.js';
import { chatTurn } from './harness/sse.js';

const MIN = 60_000;
const LONG_SESSION = { ...AGENTS, sessionMs: 1000 * 60 * MIN };
const DRAFTS = ['Hello, I am looking at your transfer now.', 'Could you confirm the date of the transfer?', 'Thank you for your patience, I will update you shortly.'];
const NONE = 'No suggestions available';

// The suggest call answers from `script`; every other call (router, answer, summary) gets a short fixed reply.
function modelFor(script) {
  const m = createFakeModel((request) => {
    if (request.purpose === 'suggest') return typeof script === 'function' ? script(request) : script;
    return request.purpose === 'route' ? '[]' : 'ok';
  });
  m.suggestCalls = () => m.calls.filter((c) => c.purpose === 'suggest');
  return m;
}

async function held(t, { script = JSON.stringify(DRAFTS), first = 'I sent 15000 from account 12345678901 to the wrong person', ...over } = {}) {
  const model = modelFor(script);
  const svc = await startService({ model, agents: LONG_SESSION, ...over });
  t.after(svc.close);
  const c = await customer(svc.baseUrl, 'test-token', first);
  const { ref } = (await c.handoff()).body;
  const aline = await agentLogin(svc.baseUrl, 'aline');
  const paul = await agentLogin(svc.baseUrl, 'paul');
  await aline.claim(ref);
  return { svc, model, c, ref, aline, paul };
}

test('the agent asks for 1 to 3 drafts, written by the model from the masked transcript', async (t) => {
  const { model, ref, aline } = await held(t);

  const { status, body } = await aline.suggest(ref, 3);

  assert.equal(status, 200);
  assert.deepEqual(body.suggestions, DRAFTS);
  const [call] = model.suggestCalls();
  const seen = JSON.stringify(call.messages);
  assert.match(seen, /wrong person/);
  assert.match(seen, /\*\*\*\*8901/, 'the model saw the masked transcript');
  assert.doesNotMatch(seen, /12345678901/);
  assert.match(seen, /\b3\b/, 'and was told how many drafts to write');
});

test('the number asked for is honoured, defaults to 3, and anything outside 1 to 3 is refused', async (t) => {
  const { model, ref, aline } = await held(t);

  assert.deepEqual((await aline.suggest(ref, 1)).body.suggestions, DRAFTS.slice(0, 1));
  assert.deepEqual((await aline.suggest(ref, 2)).body.suggestions, DRAFTS.slice(0, 2));
  assert.equal((await aline.suggest(ref)).body.suggestions.length, 3);
  const calls = model.suggestCalls().length;
  for (const bad of [0, 4, -1, 1.5, '2', null]) assert.equal((await aline.suggest(ref, bad)).status, 400, `count ${JSON.stringify(bad)}`);
  assert.equal(model.suggestCalls().length, calls, 'a refused request does not reach the model');
});

test('numbered lines are accepted when the model does not answer in JSON', async (t) => {
  const { ref, aline } = await held(t, { script: '1. First draft reply.\n2. Second draft reply.\n3) Third draft reply.' });

  assert.deepEqual((await aline.suggest(ref, 3)).body.suggestions, ['First draft reply.', 'Second draft reply.', 'Third draft reply.']);
});

test('suggestions are drafts only: nothing is added to the case, sent to the customer or emailed', async (t) => {
  const { svc, c, ref, aline } = await held(t);
  const before = (await aline.open(ref)).body.transcript.length;
  const mails = svc.mailer.outbox.length;

  await aline.suggest(ref, 3);

  assert.equal((await aline.open(ref)).body.transcript.length, before);
  assert.deepEqual((await c.status()).body.messages.filter((m) => m.from === 'agent'), []);
  assert.equal(svc.mailer.outbox.length, mails);
  assert.equal(svc.audit.records.filter((r) => r.outcome === 'suggestions_requested').length, 1, 'the request is audited');
});

test('only the agent who holds the case can ask, and only while the customer is with an agent', async (t) => {
  const { svc, model, c, ref, paul } = await held(t);
  assert.equal((await paul.suggest(ref, 2)).status, 403);
  const waiting = (await customer(svc.baseUrl, 'other-token', 'hello')).handoff;
  const { ref: waitingRef } = (await waiting()).body;
  assert.equal((await (await agentLogin(svc.baseUrl, 'aline')).suggest(waitingRef, 2)).status, 409);
  assert.equal(model.suggestCalls().length, 0);
  assert.equal((await fetch(`${svc.baseUrl}/agent/cases/${ref}/suggestions`, { method: 'POST' })).status, 401);
  assert.ok(c);
});

test('suggestions use the metered model path: their tokens and requests count against the budgets', async (t) => {
  const script = () => [JSON.stringify(DRAFTS), { usage: { totalTokens: 600 } }];
  const { svc, ref, aline } = await held(t, { script, limits: { tokensPerDay: 500, tokensPerMinute: 1_000_000 } });
  // Another customer's bot chat (the case's own customer is muted while an agent has it).
  const bystander = (message) => chatTurn(svc.baseUrl, { message, tenant: 'demo' }, { token: 'bystander' });
  assert.equal((await bystander('hello')).events.some((e) => e.type === 'busy'), false, 'the chat is under the budget before the suggestion');

  const first = await aline.suggest(ref, 3);
  assert.equal(first.body.suggestions.length, 3);

  const chat = await bystander('hello again');
  assert.ok(chat.events.some((e) => e.type === 'busy' && e.limit === 'daily_token_budget'), 'the customer chat is now busy: the suggestion tokens were counted');
});

test('at the budget the model is not asked and the answer is quietly "No suggestions available"', async (t) => {
  const script = () => [JSON.stringify(DRAFTS), { usage: { totalTokens: 900 } }];
  const { model, ref, aline } = await held(t, { script, limits: { tokensPerDay: 500, tokensPerMinute: 1_000_000 } });
  await aline.suggest(ref, 3); // takes the budget over
  const calls = model.suggestCalls().length;

  const { status, body } = await aline.suggest(ref, 3);

  assert.equal(status, 200);
  assert.deepEqual(body, { suggestions: [], message: NONE });
  assert.equal(model.suggestCalls().length, calls);
});

test('suggestions count as requests against the daily request budget', async (t) => {
  // The customer's own chat turn and the router call are metered requests too, so count them with a dry run first.
  const dry = await held(t, { limits: { tokensPerMinute: 1_000_000 } });
  const used = dry.model.calls.filter((c) => c.purpose !== 'summary').length;
  const { model, ref, aline } = await held(t, { limits: { requestsPerDay: used + 2, tokensPerMinute: 1_000_000 } });
  assert.equal((await aline.suggest(ref, 1)).body.suggestions.length, 1);
  assert.equal((await aline.suggest(ref, 1)).body.suggestions.length, 1);

  assert.deepEqual((await aline.suggest(ref, 1)).body, { suggestions: [], message: NONE });
  assert.equal(model.suggestCalls().length, 2);
});

for (const [label, failure] of [
  ['the model is out of daily tokens', Object.assign(new Error('provider returned 429'), { status: 429, detail: 'Rate limit reached on tokens per day (TPD): Limit 100000, Used 99999, Requested 500. Please try again in 14m3.2s' })],
  ['the model is down', new Error('down')],
]) {
  test(`fails quietly when ${label}: no error, no suggestions, the case untouched`, async (t) => {
    const { c, ref, aline } = await held(t, { script: () => failure });
    const before = (await aline.open(ref)).body.transcript.length;

    const { status, body } = await aline.suggest(ref, 3);

    assert.equal(status, 200);
    assert.deepEqual(body, { suggestions: [], message: NONE });
    assert.equal((await aline.open(ref)).body.transcript.length, before);
    assert.equal((await c.status()).body.state, 'with_agent');
  });
}

test('with no model at all the answer is the same quiet "No suggestions available"', async (t) => {
  const svc = await startService({ model: undefined, agents: LONG_SESSION });
  t.after(svc.close);
  const { ref } = (await (await customer(svc.baseUrl, 'tok', 'hello')).handoff()).body;
  const aline = await agentLogin(svc.baseUrl, 'aline');
  await aline.claim(ref);

  assert.deepEqual((await aline.suggest(ref, 2)).body, { suggestions: [], message: NONE });
});

test('a draft never carries a PIN, OTP, token or full account number: such drafts are dropped, clean ones stay', async (t) => {
  const risky = [
    'Please send me your PIN 4821 so I can check.',
    'Your OTP is 987654, enter it now.',
    'Use this token Bearer eyJhbGciOi.eyJzdWIiOiIx.abc123 to log in.',
    'The money left account 12345678901 yesterday.',
    'Your card 4111 1111 1111 1111 was used.',
    'Please never share your PIN with anyone, I will check the transfer for you.',
  ];
  const { ref, aline } = await held(t, { script: JSON.stringify(risky) });

  const { body } = await aline.suggest(ref, 3);

  assert.deepEqual(body.suggestions, ['Please never share your PIN with anyone, I will check the transfer for you.']);
  assert.doesNotMatch(JSON.stringify(body), /4821|987654|eyJ|12345678901|4111/);
});

test('drafts go through the output filter: a link, an email address or a phone number outside the allowlist is dropped', async (t) => {
  const { ref, aline } = await held(t, { script: JSON.stringify(['See https://evil.example/pay now.', 'Write to boss@evil.example please.', 'Call me on +237 677 000 999.', 'I am checking your transfer now.']) });

  assert.deepEqual((await aline.suggest(ref, 3)).body.suggestions, ['I am checking your transfer now.']);
});

test('if every draft is dropped the answer is "No suggestions available"', async (t) => {
  const { ref, aline } = await held(t, { script: JSON.stringify(['Your PIN is 4821.']) });

  assert.deepEqual((await aline.suggest(ref, 3)).body, { suggestions: [], message: NONE });
});

test('the transcript is sent to the model as untrusted data, and an agent note never reaches it', async (t) => {
  const { model, ref, aline } = await held(t);
  await aline.note(ref, 'INTERNAL: customer sounds like a repeat complainer');

  await aline.suggest(ref, 2);

  const seen = JSON.stringify(model.suggestCalls()[0].messages);
  assert.match(seen, /untrusted/i);
  assert.doesNotMatch(seen, /repeat complainer/);
});
