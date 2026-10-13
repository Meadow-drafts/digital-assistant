// `npm run eval -- --model qwen/qwen3.8-27b [--limit 2] [--lang fr] [--items H1,T2] [--fresh]`
// Runs the EN/FR eval set through the real assistant service against one model. NOT part of `npm test` or CI: it calls
// a real model. Keys are read from GROQ_API_KEY / GEMINI_API_KEY only. Results: eval/results/<model>.<lang>.json and .md.
import fs from 'node:fs';
import { createModel } from '../src/model.js';
import { GROQ_BASE_URL, parseArgs, runEval, usageFileName } from './run.js';
import { createRig } from './rig.js';
import { createPacer } from './pacer.js';
import { ITEMS } from './items.js';

const RESULTS = new URL('./results/', import.meta.url);
// Groq free plan: 8,000 tokens per minute and 1,000 requests per day. Stay a little under both.
const GROQ_LIMITS = { tokensPerMinute: 7000, requestsPerDay: 950 };

// A model call that has not finished in two minutes is recorded as an error instead of stalling the run.
const REQUEST_TIMEOUT_MS = 120_000;

let options;
try { options = parseArgs(process.argv.slice(2), process.env); } catch (e) { console.error(e.message); process.exit(1); }

const dir = RESULTS.pathname;
fs.mkdirSync(dir, { recursive: true });
const usageFile = new URL(usageFileName(options.baseUrl, options.model), RESULTS);
const readUsage = () => { try { return JSON.parse(fs.readFileSync(usageFile, 'utf8')); } catch { return { day: null, count: 0 }; } };

// One model, no fallback chain: the run must measure the model it was asked to measure.
const model = createModel({ primary: { baseUrl: options.baseUrl, model: options.model, apiKey: options.apiKey, timeoutMs: REQUEST_TIMEOUT_MS } });
const onGroq = options.baseUrl === GROQ_BASE_URL;
const pacer = createPacer({
  ...(onGroq ? GROQ_LIMITS : { tokensPerMinute: Infinity, requestsPerDay: Infinity }),
  ...options.limits,
  clock: { now: () => Date.now() },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  usage: readUsage(),
  onUsage: (u) => fs.writeFileSync(usageFile, JSON.stringify(u)),
  log: console.log,
});
const rig = await createRig({ model: pacer.wrap(model) });
console.log(`eval: ${options.model} (${options.langs.join(', ')}), ${ITEMS.length} items in the set${options.limit ? `, at most ${options.limit} new item(s) this run` : ''}`);
try {
  const report = await runEval({ items: ITEMS, rig, dir, modelName: options.model, langs: options.langs, limit: options.limit, only: options.only, fresh: options.fresh, pacer });
  console.log(`done: ${report.ran} prompt(s) run for ${report.items} item(s), ${report.skipped} item(s) already done${report.stopped ? `, stopped: ${report.stopped}` : ''}`);
  console.log(`results: ${dir}`);
} finally {
  await rig.close();
}
