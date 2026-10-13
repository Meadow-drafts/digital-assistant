import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService } from './harness/start-service.js';
import { createFakeModel } from './harness/fake-model.js';
import { chatTurn } from './harness/sse.js';
import { agentLogin, call } from './harness/cases.js';
import { alice, begin, say as sayAs, start as startWithBank } from './harness/t1-helpers.js';

const busyOf = (events) => events.find((e) => e.type === 'busy');
const replyOf = (events) => events.filter((e) => e.type === 'delta').map((e) => e.text).join('');
const HUMAN_CHIP = { kind: 'human_agent', text: 'Talk to a human agent' };
const say = (svc, message, token = 'user-a', conversationId) => chatTurn(svc.baseUrl, { message, conversationId, tenant: 'demo' }, { token });
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

async function start(t, limits, model = createFakeModel(['ok'])) {
  const svc = await startService({ model, limits });
  t.after(svc.close);
  return svc;
}

test('past the per-minute message limit the customer gets the busy message and the human chip, and the model is not called', async (t) => {
  const svc = await start(t, { messagesPerMinute: 2 });

  await say(svc, 'one');
  await say(svc, 'two');
  const third = await say(svc, 'three');

  assert.deepEqual(busyOf(third.events), { type: 'busy', limit: 'messages_per_minute', text: 'The assistant is busy right now. Please try again in a moment, or talk to a human agent.', card: HUMAN_CHIP });
  assert.equal(replyOf(third.events), '');
  assert.equal(third.events.at(-1).type, 'done');
  assert.equal(svc.model.calls.length, 2);
  const rec = svc.audit.records.at(-1);
  assert.deepEqual([rec.outcome, rec.limit], ['limited', 'messages_per_minute']);
  assert.ok(!JSON.stringify(rec).includes('three'), 'the model never saw it, so the audit does not keep it');

  await svc.clock.advance(MINUTE);
  const later = await say(svc, 'four');
  assert.equal(busyOf(later.events), undefined);
});

test('the per-minute limit is per customer', async (t) => {
  const svc = await start(t, { messagesPerMinute: 1 });

  await say(svc, 'one', 'user-a');
  const other = await say(svc, 'one', 'user-b');
  const again = await say(svc, 'two', 'user-a');

  assert.equal(busyOf(other.events), undefined);
  assert.equal(busyOf(again.events).limit, 'messages_per_minute');
});

test('the default per-minute limit is 10 messages', async (t) => {
  const svc = await startService({ model: createFakeModel(['ok']) });
  t.after(svc.close);

  const results = [];
  for (let i = 0; i < 11; i++) results.push(await say(svc, `message ${i}`));

  assert.deepEqual(results.map((r) => Boolean(busyOf(r.events))), [...Array(10).fill(false), true]);
});

test('past the daily message cap the customer is busy until the next day', async (t) => {
  const svc = await start(t, { messagesPerDay: 2 });

  await say(svc, 'one');
  await svc.clock.advance(2 * MINUTE);
  await say(svc, 'two');
  await svc.clock.advance(2 * MINUTE);
  const third = await say(svc, 'three');

  assert.equal(busyOf(third.events).limit, 'messages_per_day');

  await svc.clock.advance(DAY);
  assert.equal(busyOf((await say(svc, 'four')).events), undefined);
});

test('a message over the length limit is refused as busy before the model sees it; the limit itself is allowed', async (t) => {
  const svc = await start(t, { maxMessageChars: 20 });

  const ok = await say(svc, 'x'.repeat(20));
  const tooLong = await say(svc, 'y'.repeat(21));

  assert.equal(busyOf(ok.events), undefined);
  assert.equal(busyOf(tooLong.events).limit, 'message_length');
  assert.equal(svc.model.calls.length, 1);
  assert.ok(!JSON.stringify(svc.audit.records).includes('yyyy'));
});

test('the default message length limit is 1,000 characters', async (t) => {
  const svc = await startService({ model: createFakeModel(['ok']) });
  t.after(svc.close);

  assert.equal(busyOf((await say(svc, 'a'.repeat(1000))).events), undefined);
  assert.equal(busyOf((await say(svc, 'a'.repeat(1001), 'user-b')).events).limit, 'message_length');
});

test('more tool calls than allowed in one turn ends the turn as busy and shows nothing from it', async (t) => {
  const call = { toolCall: { name: 'balance' } };
  const model = createFakeModel([['Here you go. ', call, call, call, call, 'Done.']]);
  const svc = await start(t, { maxToolCallsPerTurn: 3 }, model);

  const { events } = await say(svc, 'look everything up');

  assert.equal(busyOf(events).limit, 'tool_calls');
  assert.equal(replyOf(events), '');
  assert.equal(svc.audit.records[0].outcome, 'limited');
});

test('exactly the allowed number of tool calls is fine', async (t) => {
  const call = { toolCall: { name: 'balance' } };
  const svc = await start(t, { maxToolCallsPerTurn: 3 }, createFakeModel([['Ok. ', call, call, call, 'Done.']]));

  const { events } = await say(svc, 'look up');

  assert.equal(busyOf(events), undefined);
  assert.equal(replyOf(events), 'Ok. Done.');
});

test('the global token budget per minute makes everyone busy until the window passes', async (t) => {
  const svc = await start(t, { tokensPerMinute: 100 }, createFakeModel(['z'.repeat(400)]));

  const first = await say(svc, 'hello', 'user-a');
  const second = await say(svc, 'hello', 'user-b');

  assert.equal(busyOf(first.events), undefined);
  assert.equal(busyOf(second.events).limit, 'token_budget');

  await svc.clock.advance(MINUTE);
  assert.equal(busyOf((await say(svc, 'hello', 'user-b')).events), undefined);
});

test('the global daily request budget makes everyone busy until the next day', async (t) => {
  const svc = await start(t, { requestsPerDay: 2, messagesPerMinute: 100 });

  await say(svc, 'one', 'user-a');
  await say(svc, 'two', 'user-b');
  const third = await say(svc, 'three', 'user-c');

  assert.equal(busyOf(third.events).limit, 'requests_per_day');

  await svc.clock.advance(DAY);
  assert.equal(busyOf((await say(svc, 'four', 'user-c')).events), undefined);
});

// A model that reports the tokens the provider says it used, as the real adapter does after its last chunk.
const usingModel = (totalTokens, text = 'ok') => createFakeModel([[text, { usage: { totalTokens } }]]);

test('the global daily token budget counts the tokens the provider reports, and makes everyone busy with the reason in the audit', async (t) => {
  const svc = await start(t, { tokensPerDay: 100, tokensPerMinute: 1_000_000 }, usingModel(100));

  const first = await say(svc, 'hello', 'user-a');
  const calls = svc.model.calls.length;
  const second = await say(svc, 'hello', 'user-b');

  assert.equal(busyOf(first.events), undefined);
  assert.deepEqual(busyOf(second.events), { type: 'busy', limit: 'daily_token_budget', text: 'The assistant is busy right now. Please try again in a moment, or talk to a human agent.', card: HUMAN_CHIP });
  assert.equal(svc.model.calls.length, calls, 'the model is not called once the budget is reached');
  const rec = svc.audit.records.at(-1);
  assert.deepEqual([rec.outcome, rec.limit], ['limited', 'daily_token_budget']);
});

test('the daily token budget is not reached while the reported usage stays under it', async (t) => {
  const svc = await start(t, { tokensPerDay: 1000, tokensPerMinute: 1_000_000 }, usingModel(1));

  await say(svc, 'one', 'user-a');
  assert.equal(busyOf((await say(svc, 'two', 'user-b')).events), undefined);
});

for (const [label, offset, busy] of [['1 s before 24 hours', -1000, true], ['exactly 24 hours', 0, false], ['1 s after 24 hours', 1000, false]]) {
  test(`daily token budget, rolling window: ${label} after the tokens were used, the customer is ${busy ? 'still busy' : 'served again'}`, async (t) => {
    const svc = await start(t, { tokensPerDay: 100, tokensPerMinute: 1_000_000 }, usingModel(100));
    await say(svc, 'hello', 'user-a');

    await svc.clock.advance(DAY + offset);
    const later = await say(svc, 'hello again', 'user-b');

    assert.equal(busyOf(later.events)?.limit, busy ? 'daily_token_budget' : undefined);
  });
}

test('the window rolls: tokens used at different times are released one by one', async (t) => {
  const svc = await start(t, { tokensPerDay: 150, tokensPerMinute: 1_000_000 }, usingModel(100));
  await say(svc, 'one', 'user-a'); // 100 at t0
  await svc.clock.advance(12 * 60 * MINUTE);
  await say(svc, 'two', 'user-b'); // 200 in the window: over the budget from now on

  await svc.clock.advance(12 * 60 * MINUTE); // the first 100 has just left
  assert.equal(busyOf((await say(svc, 'three', 'user-c')).events), undefined);
  assert.equal(busyOf((await say(svc, 'four', 'user-d')).events)?.limit, 'daily_token_budget', 'the second 100 plus the third is over again');
});

test('the agent summary written at handoff counts toward the daily token budget', async (t) => {
  const model = createFakeModel((request) => [request.purpose === 'summary' ? 'Short summary.' : 'ok', { usage: { totalTokens: request.purpose === 'summary' ? 500 : 1 } }]);
  const a = alice();
  const svc = await startWithBank({ customers: [a], model, limits: { tokensPerDay: 500, tokensPerMinute: 1_000_000 } });
  t.after(svc.close);
  const conversationId = await begin(svc, a);
  assert.equal(busyOf((await sayAs(svc, a, 'hello', conversationId)).events), undefined, 'the chat itself is far under the budget');

  await call(svc.baseUrl, 'POST', '/handoff', { token: a.token, body: { conversationId } });
  for (let i = 0; i < 100 && !model.calls.some((c) => c.purpose === 'summary'); i++) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 20)); // let the summary call finish and be counted

  const after = await sayAs(svc, a, 'still there?', conversationId);
  assert.equal(busyOf(after.events)?.limit, 'daily_token_budget');
});

test('a turn that takes the budget over it is allowed to finish, and the audit records by how much; turns that stay under record nothing', async (t) => {
  const model = createFakeModel((request) => ['ok', { usage: { totalTokens: request.purpose === 'answer' ? 150 : 0 } }]);
  const svc = await start(t, { tokensPerDay: 100, tokensPerMinute: 1_000_000 }, model);

  const crossing = await say(svc, 'hello', 'user-a');
  assert.equal(replyOf(crossing.events), 'ok', 'the customer still gets the answer');
  assert.equal(svc.audit.records[0].tokenOvershoot, 50);

  const blocked = await say(svc, 'hello', 'user-b');
  assert.equal(busyOf(blocked.events)?.limit, 'daily_token_budget');
  assert.equal(svc.audit.records.at(-1).tokenOvershoot, undefined);
});

test('a turn that stays under the daily budget has no overshoot in the audit', async (t) => {
  const svc = await start(t, { tokensPerDay: 1000, tokensPerMinute: 1_000_000 }, usingModel(1));
  await say(svc, 'hello', 'user-a');
  assert.equal(svc.audit.records[0].tokenOvershoot, undefined);
});

test('at the daily budget a handoff still opens, the summary is still attempted and counted, and the agent sees it', async (t) => {
  const model = createFakeModel((request) => [request.purpose === 'summary' ? 'Customer needs help.' : 'ok', { usage: { totalTokens: 1000 } }]);
  const a = alice();
  const svc = await startWithBank({ customers: [a], model, limits: { tokensPerDay: 500, tokensPerMinute: 1_000_000 } });
  t.after(svc.close);
  const conversationId = await begin(svc, a);
  await sayAs(svc, a, 'hello', conversationId); // takes the budget over
  assert.equal(busyOf((await sayAs(svc, a, 'hello again', conversationId)).events)?.limit, 'daily_token_budget');

  const { status, body } = await call(svc.baseUrl, 'POST', '/handoff', { token: a.token, body: { conversationId } });
  const aline = await agentLogin(svc.baseUrl, 'aline');
  await aline.claim(body.ref);
  const opened = await aline.open(body.ref);

  assert.equal(status, 200);
  assert.equal(opened.body.summary.text, 'Customer needs help.');
  assert.ok(model.calls.some((c) => c.purpose === 'summary'));
});

test('without a usage figure from the provider the tokens are estimated from the text', async (t) => {
  const svc = await start(t, { tokensPerDay: 100, tokensPerMinute: 1_000_000 }, createFakeModel(['z'.repeat(800)]));

  await say(svc, 'hello', 'user-a');

  assert.equal(busyOf((await say(svc, 'hello', 'user-b')).events)?.limit, 'daily_token_budget');
});

test('the daily token budget defaults to 200,000 and can be set from the environment', async () => {
  const { DEFAULT_LIMITS, loadLimits } = await import('../src/limits.js');

  assert.equal(DEFAULT_LIMITS.tokensPerDay, 200000);
  assert.deepEqual(loadLimits({ LIMIT_TOKENS_PER_DAY: '50000' }), { tokensPerDay: 50000 });
  assert.deepEqual(loadLimits({ LIMIT_TOKENS_PER_DAY: 'lots' }), {});
});

test('the busy message and chip follow the customer language', async (t) => {
  const svc = await start(t, { messagesPerMinute: 1 });
  const first = await say(svc, "Comment faire un virement vers un autre compte, s'il vous plaît ?");
  const second = await say(svc, 'Et pour payer une facture, comment faire ?', 'user-a', first.events.at(-1).conversationId);

  assert.match(busyOf(second.events).text, /assistant est occupé/i);
  assert.equal(busyOf(second.events).card.text, 'Parler à un agent');
});

test('a turn the limits stopped does not enter the conversation history', async (t) => {
  const svc = await start(t, { messagesPerMinute: 1 });
  const first = await say(svc, 'first question');
  await say(svc, 'blocked question', 'user-a', first.events.at(-1).conversationId);
  await svc.clock.advance(MINUTE);
  await say(svc, 'third question', 'user-a', first.events.at(-1).conversationId);

  assert.doesNotMatch(JSON.stringify(svc.model.calls.at(-1).messages), /blocked question/);
});

test('every limit can be set from the environment, and bad values keep the default', async () => {
  const { loadLimits } = await import('../src/limits.js');

  assert.deepEqual(
    loadLimits({ LIMIT_MESSAGES_PER_MINUTE: '3', LIMIT_TOKENS_PER_MINUTE: '500', LIMIT_REQUESTS_PER_DAY: 'lots', LIMIT_MAX_MESSAGE_CHARS: '200', LIMIT_MAX_TOOL_CALLS_PER_TURN: '1', LIMIT_MESSAGES_PER_DAY: '9' }),
    { messagesPerMinute: 3, tokensPerMinute: 500, maxMessageChars: 200, maxToolCallsPerTurn: 1, messagesPerDay: 9 },
  );
});
