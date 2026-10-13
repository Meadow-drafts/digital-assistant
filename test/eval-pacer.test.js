import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPacer, DailyLimitError } from '../eval/pacer.js';
import { createFakeModel } from './harness/fake-model.js';

// A clock whose sleep moves time forward, so pacing is observable without waiting.
function world() {
  let t = Date.parse('2026-10-13T10:00:00Z');
  const slept = [];
  return { clock: { now: () => t }, sleep: async (ms) => { slept.push(ms); t += ms; }, slept, advance: (ms) => { t += ms; } };
}
const run = async (model, purpose = 'route', text = 'x'.repeat(300)) => {
  let out = '';
  for await (const part of model.chat({ purpose, messages: [{ role: 'user', content: text }], language: 'en' })) out += part;
  return out;
};

test('calls inside the token budget pass straight through', async () => {
  const w = world();
  const pacer = createPacer({ tokensPerMinute: 5000, requestsPerDay: 100, ...w });
  const model = pacer.wrap(createFakeModel(['hello']));
  assert.equal(await run(model), 'hello');
  assert.equal(await run(model), 'hello');
  assert.deepEqual(w.slept, []);
});

test('a call that would exceed the minute budget waits until the earlier tokens leave the window', async () => {
  const w = world();
  // each call is estimated at ~100 prompt tokens plus the reserve for its purpose, so two do not fit in 500
  const pacer = createPacer({ tokensPerMinute: 500, requestsPerDay: 100, reserve: { route: 200, answer: 200 }, ...w });
  const model = pacer.wrap(createFakeModel(['ok']));
  await run(model);
  await run(model);
  assert.equal(w.slept.length, 1);
  assert.ok(w.slept[0] > 55_000 && w.slept[0] <= 61_000, `slept ${w.slept[0]}`);
});

test('a 429 before any text waits and retries; it is not an error', async () => {
  const w = world();
  const pacer = createPacer({ tokensPerMinute: 8000, requestsPerDay: 100, rateLimitWaitMs: 20_000, ...w });
  const model = pacer.wrap(createFakeModel([new Error('provider returned 429'), 'fine']));
  assert.equal(await run(model), 'fine');
  assert.deepEqual(w.slept, [20_000]);
});

test('a 503 (provider overloaded) waits and retries too, and counts every attempt', async () => {
  const w = world();
  const usage = { day: null, count: 0 };
  const pacer = createPacer({ tokensPerMinute: 8000, requestsPerDay: 100, rateLimitWaitMs: 20_000, usage, ...w });
  const model = pacer.wrap(createFakeModel([new Error('provider returned 503: {"status":"UNAVAILABLE"}'), 'fine']));
  assert.equal(await run(model), 'fine');
  assert.deepEqual(w.slept, [20_000]);
  assert.equal(usage.count, 2);
});

test('a status number inside another error body does not trigger a retry', async () => {
  const w = world();
  const pacer = createPacer({ tokensPerMinute: 8000, requestsPerDay: 100, ...w });
  const model = pacer.wrap(createFakeModel([new Error('provider returned 400: quota 429 words')]));
  await assert.rejects(run(model), /400/);
  assert.deepEqual(w.slept, []);
});

test('other provider errors are passed on', async () => {
  const w = world();
  const pacer = createPacer({ tokensPerMinute: 8000, requestsPerDay: 100, ...w });
  const model = pacer.wrap(createFakeModel([new Error('provider returned 413')]));
  await assert.rejects(run(model), /413/);
});

test('the daily request cap stops the run with DailyLimitError and counts every attempt', async () => {
  const w = world();
  const usage = { day: '2026-10-13', count: 0 };
  const saved = [];
  const pacer = createPacer({ tokensPerMinute: 8000, requestsPerDay: 2, usage, onUsage: (u) => saved.push({ ...u }), ...w });
  const model = pacer.wrap(createFakeModel(['a']));
  await run(model);
  await run(model);
  await assert.rejects(run(model), DailyLimitError);
  assert.equal(usage.count, 2);
  assert.deepEqual(saved.at(-1), { day: '2026-10-13', count: 2 });
});

test('a new UTC day resets the daily count', async () => {
  const w = world();
  const usage = { day: '2026-10-12', count: 2 };
  const pacer = createPacer({ tokensPerMinute: 8000, requestsPerDay: 2, usage, ...w });
  assert.equal(await run(pacer.wrap(createFakeModel(['a']))), 'a');
  assert.deepEqual(usage, { day: '2026-10-13', count: 1 });
});

test('after the daily cap the pacer reports it was halted, so the runner can stop instead of recording errors', async () => {
  const w = world();
  const pacer = createPacer({ tokensPerMinute: 8000, requestsPerDay: 1, ...w });
  const model = pacer.wrap(createFakeModel(['a']));
  await run(model);
  assert.equal(pacer.halted, null);
  await assert.rejects(run(model), DailyLimitError);
  assert.ok(pacer.halted instanceof DailyLimitError);
});

test('a requests-per-minute limit makes the next call wait for the window even when tokens fit', async () => {
  const w = world();
  const pacer = createPacer({ tokensPerMinute: 1_000_000, requestsPerMinute: 2, requestsPerDay: 100, ...w });
  const model = pacer.wrap(createFakeModel(['ok']));
  await run(model);
  await run(model);
  assert.deepEqual(w.slept, []);
  await run(model);
  assert.equal(w.slept.length, 1);
  assert.ok(w.slept[0] > 55_000 && w.slept[0] <= 61_000, `slept ${w.slept[0]}`);
});
