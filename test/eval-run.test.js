import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, runEval } from '../eval/run.js';
import { createRig } from '../eval/rig.js';
import { createPacer } from '../eval/pacer.js';
import { cites } from '../eval/checks.js';
import { createFakeModel } from './harness/fake-model.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'eval-run-'));
const ITEMS = ['A', 'B', 'C'].map((id) => ({
  id, group: 'how-to', prompts: { en: 'How do I send money to another person?', fr: "Comment envoyer de l'argent à une autre personne ?" },
  lines: [cites('transfer-single')],
}));
const model = () => createFakeModel((r) => (r.purpose === 'route' ? '["transfer-single"]' : 'Open Transfers, then Single Transfer.'));
const read = (dir, file) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));

async function go(t, opts = {}) {
  const dir = opts.dir ?? tmp();
  const m = opts.model ?? model();
  const rig = await createRig({ model: opts.pacer ? opts.pacer.wrap(m) : m });
  t.after(rig.close);
  const report = await runEval({ items: ITEMS, rig, dir, modelName: 'fake/model', langs: ['en', 'fr'], log: () => {}, ...opts });
  return { dir, m, report };
}

test('runs every item in both languages through the service and writes a result file per language', async (t) => {
  const { dir, report } = await go(t);
  assert.equal(report.ran, 6);
  for (const lang of ['en', 'fr']) {
    const json = read(dir, `fake_model.${lang}.json`);
    assert.deepEqual(Object.keys(json.items), ['A', 'B', 'C']);
    assert.equal(json.items.A.pass, true);
    assert.equal(json.items.A.lines.find((l) => l.text.startsWith('Cites')).pass, true);
    assert.equal(json.items.A.guides[0], 'transfer-single');
  }
  assert.match(fs.readFileSync(path.join(dir, 'fake_model.fr.md'), 'utf8'), /3 of 3 items passed/);
});

test('--limit runs only that many items, and the next run carries on with the rest (resume)', async (t) => {
  const dir = tmp();
  const first = await go(t, { dir, limit: 2 });
  assert.equal(first.report.items, 2);
  assert.deepEqual(Object.keys(read(dir, 'fake_model.en.json').items), ['A', 'B']);
  const second = await go(t, { dir, limit: 2 });
  assert.equal(second.report.items, 1);
  assert.deepEqual(Object.keys(read(dir, 'fake_model.en.json').items), ['A', 'B', 'C']);
  assert.equal(second.m.calls.length, 4, 'only item C was sent to the model (router + answer, both languages)');
});

test('--items and --lang narrow the run', async (t) => {
  const { dir, report } = await go(t, { only: ['B'], langs: ['fr'] });
  assert.equal(report.ran, 1);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['fake_model.fr.json', 'fake_model.fr.md']);
});

test('a failing line is recorded as a failed item with its line', async (t) => {
  const wrong = createFakeModel((r) => (r.purpose === 'route' ? '["airtime"]' : 'Open Airtime.'));
  const { dir } = await go(t, { model: wrong, only: ['A'], langs: ['en'] });
  const a = read(dir, 'fake_model.en.json').items.A;
  assert.equal(a.pass, false);
  assert.deepEqual(a.lines.filter((l) => !l.pass).map((l) => l.text), ['Cites the guide used (transfer-single)']);
});

test('hitting the daily cap stops the run cleanly: finished items are kept, the interrupted one is not recorded', async (t) => {
  const usage = { day: null, count: 0 };
  const pacer = createPacer({ tokensPerMinute: 1e9, requestsPerDay: 5, clock: { now: () => Date.now() }, sleep: async () => {}, usage });
  const { dir, report } = await go(t, { pacer, langs: ['en'] });
  assert.equal(report.stopped, 'daily_limit');
  // 2 calls per item: A and B done (4 calls), C's router is call 5, its answer call is refused
  assert.deepEqual(Object.keys(read(dir, 'fake_model.en.json').items), ['A', 'B']);
});

test('parseArgs: model and limit, Groq key from the environment only', () => {
  const o = parseArgs(['--model', 'qwen/qwen3.8-27b', '--limit', '2'], { GROQ_API_KEY: 'k' });
  assert.equal(o.model, 'qwen/qwen3.8-27b');
  assert.equal(o.limit, 2);
  assert.equal(o.baseUrl, 'https://api.groq.com/openai/v1');
  assert.equal(o.apiKey, 'k');
  assert.deepEqual(o.langs, ['en', 'fr']);
});

test('parseArgs: language, item ids and fresh', () => {
  const o = parseArgs(['--model', 'm', '--lang', 'fr', '--items', 'H1,T2', '--fresh'], { GROQ_API_KEY: 'k' });
  assert.deepEqual(o.langs, ['fr']);
  assert.deepEqual(o.only, ['H1', 'T2']);
  assert.equal(o.fresh, true);
});

test('parseArgs: a missing model or a missing Groq key is a clear error that never prints a key', () => {
  assert.throws(() => parseArgs([], { GROQ_API_KEY: 'k' }), /--model/);
  assert.throws(() => parseArgs(['--model', 'm'], {}), /GROQ_API_KEY/);
  assert.throws(() => parseArgs(['--model', 'm', '--lang', 'de'], { GROQ_API_KEY: 'secret-key' }), (e) => /--lang/.test(e.message) && !/secret-key/.test(e.message));
});

test('parseArgs: a local Ollama base URL needs no key', () => {
  const o = parseArgs(['--model', 'qwen2.5:7b', '--base-url', 'http://localhost:11434/v1'], {});
  assert.equal(o.apiKey, undefined);
});

test('npm run eval is a separate command: not under test/, and it refuses to start without a model or a key', async () => {
  const { execFileSync } = await import('node:child_process');
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts.eval, 'node eval/cli.js');
  assert.doesNotMatch(pkg.scripts.test, /eval/);
  const run = (args, env) => { try { execFileSync('node', ['eval/cli.js', ...args], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8', stdio: 'pipe' }); return { code: 0 }; } catch (e) { return { code: e.status, err: e.stderr }; } };
  assert.match(run([], {}).err, /--model is required/);
  const noKey = run(['--model', 'qwen/qwen3.8-27b'], {});
  assert.equal(noKey.code, 1);
  assert.match(noKey.err, /GROQ_API_KEY is not set/);
});
