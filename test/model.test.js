import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startService } from './harness/start-service.js';
import { startFakeProvider } from './harness/fake-provider.js';
import { chatTurn } from './harness/sse.js';
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
