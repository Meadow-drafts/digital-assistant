import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService } from './harness/start-service.js';
import { startFakeProvider } from './harness/fake-provider.js';
import { chatTurn } from './harness/sse.js';
import { createFakeClock } from './harness/fake-clock.js';
import { createModel, loadModelConfig } from '../src/model.js';

const replyOf = (events) => events.filter((e) => e.type === 'delta').map((e) => e.text).join('');

test('the primary model answers, and switching model is a config change only', async (t) => {
  const groq = await startFakeProvider([['Hello', ' from A']]);
  const other = await startFakeProvider([['Hello from B']]);
  t.after(groq.close);
  t.after(other.close);

  const configA = { primary: { baseUrl: groq.baseUrl, model: 'model-a', apiKey: 'key-a' } };
  const configB = { primary: { baseUrl: other.baseUrl, model: 'model-b', apiKey: 'key-b' } };

  const svcA = await startService({ model: createModel(configA) });
  t.after(svcA.close);
  const a = await chatTurn(svcA.baseUrl, { message: 'Hi', tenant: 'demo' });
  assert.equal(replyOf(a.events), 'Hello from A');
  assert.equal(a.events.at(-1).model, 'model-a');
  assert.equal(groq.requests[0].body.model, 'model-a');
  assert.equal(groq.requests[0].authorization, 'Bearer key-a');

  const svcB = await startService({ model: createModel(configB) });
  t.after(svcB.close);
  const b = await chatTurn(svcB.baseUrl, { message: 'Hi', tenant: 'demo' });
  assert.equal(replyOf(b.events), 'Hello from B');
  assert.equal(b.events.at(-1).model, 'model-b');
  assert.equal(other.requests[0].body.model, 'model-b');
});

for (const [label, failure] of [['a rate limit', { status: 429 }], ['an outage', { status: 503 }]]) {
  test(`primary failing with ${label} falls back automatically, visible at the API and in the audit`, async (t) => {
    const primary = await startFakeProvider([failure]);
    const fallback = await startFakeProvider([['Fallback answer']]);
    t.after(primary.close);
    t.after(fallback.close);
    const svc = await startService({
      model: createModel({
        primary: { baseUrl: primary.baseUrl, model: 'primary-m', apiKey: 'k1' },
        fallback: { baseUrl: fallback.baseUrl, model: 'fallback-m', apiKey: 'k2' },
      }),
    });
    t.after(svc.close);

    const { events } = await chatTurn(svc.baseUrl, { message: 'Hi', tenant: 'demo' });

    assert.equal(replyOf(events), 'Fallback answer');
    assert.equal(events.at(-1).type, 'done');
    assert.equal(events.at(-1).model, 'fallback-m');
    assert.equal(svc.audit.records[0].model, 'fallback-m');
  });
}

test('an unreachable primary falls back too', async (t) => {
  const fallback = await startFakeProvider([['Fallback answer']]);
  t.after(fallback.close);
  const svc = await startService({
    model: createModel({
      primary: { baseUrl: 'http://127.0.0.1:1/v1', model: 'primary-m', apiKey: 'k1' },
      fallback: { baseUrl: fallback.baseUrl, model: 'fallback-m', apiKey: 'k2' },
    }),
  });
  t.after(svc.close);
  const { events } = await chatTurn(svc.baseUrl, { message: 'Hi', tenant: 'demo' });
  assert.equal(events.at(-1).model, 'fallback-m');
});

test('when primary and fallback are down the offline model answers in English only and says so, even to French', async (t) => {
  const down = await startFakeProvider([{ status: 503 }]);
  const offline = await startFakeProvider([['Here are the steps.']]);
  t.after(down.close);
  t.after(offline.close);
  const svc = await startService({
    model: createModel({
      primary: { baseUrl: down.baseUrl, model: 'primary-m', apiKey: 'k1' },
      fallback: { baseUrl: down.baseUrl, model: 'fallback-m', apiKey: 'k2' },
      offline: { baseUrl: offline.baseUrl, model: 'local-m' },
    }),
  });
  t.after(svc.close);

  const { events } = await chatTurn(svc.baseUrl, { message: 'Comment faire un virement vers un autre compte ?', tenant: 'demo' });

  const done = events.at(-1);
  assert.equal(done.type, 'done');
  assert.equal(done.model, 'local-m');
  assert.equal(done.offline, true);
  assert.equal(done.language, 'en');
  assert.equal(
    replyOf(events),
    'I am in offline mode and can only reply in English right now. Here are the steps.',
  );
  assert.equal(svc.audit.records[0].model, 'local-m');
});

test('with every model down the customer gets an error event and the turn is audited', async (t) => {
  const down = await startFakeProvider([{ status: 503 }]);
  t.after(down.close);
  const svc = await startService({
    model: createModel({
      primary: { baseUrl: down.baseUrl, model: 'primary-m' },
      offline: { baseUrl: down.baseUrl, model: 'local-m' },
    }),
  });
  t.after(svc.close);
  const { events } = await chatTurn(svc.baseUrl, { message: 'Hi', tenant: 'demo' });
  assert.equal(events.at(-1).type, 'error');
  assert.equal(svc.audit.records[0].outcome, 'error');
});

test('API keys never reach the audit log or the customer, even when every provider fails', async (t) => {
  const down = await startFakeProvider([{ status: 401 }]);
  t.after(down.close);
  const svc = await startService({
    model: createModel({
      primary: { baseUrl: down.baseUrl, model: 'primary-m', apiKey: 'gsk_PRIMARY_SECRET' },
      fallback: { baseUrl: down.baseUrl, model: 'fallback-m', apiKey: 'gsk_FALLBACK_SECRET' },
    }),
  });
  t.after(svc.close);
  const logged = [];
  const origError = console.error;
  const origLog = console.log;
  console.error = console.log = (...args) => logged.push(args.join(' '));
  let events;
  try { ({ events } = await chatTurn(svc.baseUrl, { message: 'Hi', tenant: 'demo' })); } finally { console.error = origError; console.log = origLog; }

  const everything = JSON.stringify([events, svc.audit.records, logged]);
  assert.ok(!everything.includes('SECRET'));
});

test('model chain is built from environment config only', () => {
  const env = {
    MODEL_PRIMARY_BASE_URL: 'https://api.example/v1',
    MODEL_PRIMARY_NAME: 'big-model',
    MODEL_PRIMARY_API_KEY: 'k1',
    MODEL_FALLBACK_BASE_URL: 'https://api.example/v1',
    MODEL_FALLBACK_NAME: 'second-model',
    MODEL_FALLBACK_API_KEY: 'k2',
    MODEL_OFFLINE_BASE_URL: 'http://localhost:11434/v1',
    MODEL_OFFLINE_NAME: 'local-model',
  };
  assert.deepEqual(loadModelConfig(env), {
    primary: { baseUrl: 'https://api.example/v1', model: 'big-model', apiKey: 'k1' },
    fallback: { baseUrl: 'https://api.example/v1', model: 'second-model', apiKey: 'k2' },
    offline: { baseUrl: 'http://localhost:11434/v1', model: 'local-model', apiKey: undefined },
  });
  assert.equal(loadModelConfig({}), null);
});

test('a role on the Gemini endpoint takes GEMINI_API_KEY from the environment; an explicit key wins', () => {
  const base = 'https://generativelanguage.googleapis.com/v1beta/openai/';
  const cfg = loadModelConfig({ MODEL_PRIMARY_BASE_URL: base, MODEL_PRIMARY_NAME: 'gemini-3.8-flash', GEMINI_API_KEY: 'g' });
  assert.equal(cfg.primary.apiKey, 'g');
  assert.equal(loadModelConfig({ MODEL_PRIMARY_BASE_URL: base, MODEL_PRIMARY_NAME: 'x', MODEL_PRIMARY_API_KEY: 'own', GEMINI_API_KEY: 'g' }).primary.apiKey, 'own');
  assert.equal(loadModelConfig({ MODEL_PRIMARY_BASE_URL: 'https://api.example/v1', MODEL_PRIMARY_NAME: 'x', GEMINI_API_KEY: 'g' }).primary.apiKey, undefined);
});

test('routing is asked for with temperature 0 and answers with a low one, so the same message is routed the same way', async (t) => {
  const provider = await startFakeProvider([['ok']]);
  t.after(provider.close);
  const model = createModel({ primary: { baseUrl: provider.baseUrl, model: 'm', apiKey: 'k' } });

  for (const purpose of ['route', 'answer']) {
    for await (const _ of model.chat({ purpose, messages: [{ role: 'user', content: 'hi' }], language: 'en' })) { /* drain */ }
  }

  assert.equal(provider.requests[0].body.temperature, 0);
  assert.ok(provider.requests[1].body.temperature > 0 && provider.requests[1].body.temperature <= 0.5);
});

test('a provider error carries a short piece of its own explanation, with the key removed', async (t) => {
  const http = await import('node:http');
  const server = http.createServer((req, res) => { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":{"message":"bad request, key sk-SECRET-123 rejected"}}'); });
  await new Promise((r) => server.listen(0, r));
  t.after(() => server.close());
  const model = createModel({ primary: { baseUrl: `http://localhost:${server.address().port}/v1`, model: 'm', apiKey: 'sk-SECRET-123' } });
  await assert.rejects(async () => { for await (const _ of model.chat({ messages: [], language: 'en' })); }, (e) => /provider returned 400: .*bad request/.test(e.message) && !/sk-SECRET-123/.test(e.message));
});

test('a call that outlasts timeoutMs is aborted instead of hanging', async (t) => {
  const http = await import('node:http');
  const server = http.createServer(() => {});
  await new Promise((r) => server.listen(0, r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const model = createModel({ primary: { baseUrl: `http://localhost:${server.address().port}/v1`, model: 'm', timeoutMs: 100 } });
  await assert.rejects(async () => { for await (const _ of model.chat({ messages: [], language: 'en' })); }, /timeout|abort/i);
});

const DAILY_429 = { status: 429, message: 'Rate limit reached for model `m` in organization `org` on tokens per day (TPD): Limit 100000, Used 99990, Requested 500. Please try again in 14m3.2s.' };

test('the real token count from the provider feeds the daily token budget', async (t) => {
  const provider = await startFakeProvider([['Hello', { usage: { prompt_tokens: 60, completion_tokens: 40, total_tokens: 100 } }]]);
  t.after(provider.close);
  const svc = await startService({ model: createModel({ primary: { baseUrl: provider.baseUrl, model: 'm', apiKey: 'k' } }), limits: { tokensPerDay: 100, tokensPerMinute: 1_000_000 } });
  t.after(svc.close);

  const first = await chatTurn(svc.baseUrl, { message: 'Hi', tenant: 'demo' });
  const second = await chatTurn(svc.baseUrl, { message: 'Hi again', tenant: 'demo' }, { token: 'someone-else' });

  assert.equal(replyOf(first.events), 'Hello', 'the usage chunk is not shown to the customer');
  assert.equal(provider.requests[0].body.stream_options.include_usage, true);
  assert.equal(second.events.find((e) => e.type === 'busy')?.limit, 'daily_token_budget');
});

test('a daily-token 429 moves to the next model, and later turns do not try the exhausted model again until its window has passed', async (t) => {
  const primary = await startFakeProvider([DAILY_429, DAILY_429, DAILY_429]);
  const fallback = await startFakeProvider([['Fallback answer']]);
  t.after(primary.close);
  t.after(fallback.close);
  const clock = createFakeClock();
  const svc = await startService({
    clock,
    limits: { messagesPerMinute: 100 },
    model: createModel({
      primary: { baseUrl: primary.baseUrl, model: 'primary-m', apiKey: 'k1' },
      fallback: { baseUrl: fallback.baseUrl, model: 'fallback-m', apiKey: 'k2' },
      clock,
    }),
  });
  t.after(svc.close);

  const first = await chatTurn(svc.baseUrl, { message: 'Hi', tenant: 'demo' });
  const askedFirst = primary.requests.length;
  const second = await chatTurn(svc.baseUrl, { message: 'Hi again', tenant: 'demo', conversationId: first.events.at(-1).conversationId });

  assert.equal(first.events.at(-1).model, 'fallback-m');
  assert.equal(second.events.at(-1).model, 'fallback-m');
  assert.equal(primary.requests.length, askedFirst, 'the exhausted model is not asked again');

  await clock.advance(14 * 60_000 + 4_000); // the provider said "try again in 14m3.2s"
  await chatTurn(svc.baseUrl, { message: 'Hi once more', tenant: 'demo', conversationId: first.events.at(-1).conversationId });
  assert.ok(primary.requests.length > askedFirst, 'after the stated wait the primary is tried again');
});

test('a per-minute 429 only falls back for that call; the model is tried again on the next', async (t) => {
  const primary = await startFakeProvider([{ status: 429, message: 'Rate limit reached on tokens per minute (TPM). Please try again in 3s.' }, ['Primary answer']]);
  const fallback = await startFakeProvider([['Fallback answer']]);
  t.after(primary.close);
  t.after(fallback.close);
  const svc = await startService({
    model: createModel({
      primary: { baseUrl: primary.baseUrl, model: 'primary-m', apiKey: 'k1' },
      fallback: { baseUrl: fallback.baseUrl, model: 'fallback-m', apiKey: 'k2' },
    }),
  });
  t.after(svc.close);

  const first = await chatTurn(svc.baseUrl, { message: 'Hi', tenant: 'demo' });
  const second = await chatTurn(svc.baseUrl, { message: 'Hi again', tenant: 'demo', conversationId: first.events.at(-1).conversationId });

  assert.equal(first.events.at(-1).model, 'fallback-m');
  assert.equal(second.events.at(-1).model, 'primary-m');
});

test('a daily-token 429 with a tiny retry-after still keeps the model out until its requested tokens would fit again', async (t) => {
  // Limit 100000 a day, 99000 used, 5000 asked for: 4000 tokens must come back, which at 100000 per 24 hours is 3456 s, though the provider says 2 s.
  const tiny = { status: 429, message: 'Rate limit reached for model `m` on tokens per day (TPD): Limit 100000, Used 99000, Requested 5000. Please try again in 2s.' };
  const primary = await startFakeProvider([tiny, ['Primary answer']]);
  const fallback = await startFakeProvider([['Fallback answer']]);
  t.after(primary.close);
  t.after(fallback.close);
  const clock = createFakeClock();
  const svc = await startService({
    clock,
    limits: { messagesPerMinute: 1000 },
    model: createModel({ primary: { baseUrl: primary.baseUrl, model: 'primary-m', apiKey: 'k1' }, fallback: { baseUrl: fallback.baseUrl, model: 'fallback-m', apiKey: 'k2' }, clock }),
  });
  t.after(svc.close);
  const turn = async () => (await chatTurn(svc.baseUrl, { message: 'Hi', tenant: 'demo' })).events.at(-1).model;

  assert.equal(await turn(), 'fallback-m');
  await clock.advance(3_000); // past the stated 2 s
  assert.equal(await turn(), 'fallback-m');
  await clock.advance(3_450_000 - 3_000); // 3,450 s in: the tokens would still not fit
  assert.equal(await turn(), 'fallback-m');
  assert.equal(primary.requests.length, 1, 'the primary was asked once, and left alone after that');
  await clock.advance(7_000); // past 3,456 s
  assert.equal(await turn(), 'primary-m');
});

test('when every model is exhausted for the day the customer gets the unavailable error, not a hang', async (t) => {
  const primary = await startFakeProvider([DAILY_429]);
  t.after(primary.close);
  const svc = await startService({ model: createModel({ primary: { baseUrl: primary.baseUrl, model: 'primary-m', apiKey: 'k1' } }) });
  t.after(svc.close);

  const first = await chatTurn(svc.baseUrl, { message: 'Hi', tenant: 'demo' });
  const second = await chatTurn(svc.baseUrl, { message: 'Hi', tenant: 'demo' });

  assert.equal(first.events.find((e) => e.type === 'error')?.code, 'model_unavailable');
  assert.equal(second.events.find((e) => e.type === 'error')?.code, 'model_unavailable');
});
