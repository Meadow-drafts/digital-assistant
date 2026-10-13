import { scoreItem } from './score.js';
import { openResults } from './results.js';

export const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
const LANGS = ['en', 'fr'];

const USAGE = 'Usage: npm run eval -- --model <name> [--limit N] [--lang en|fr] [--items H1,T2] [--fresh] [--base-url URL]';

// Reads the command line. The Groq key comes from the environment only (GROQ_API_KEY), never from an argument, and
// is never put in an error message. A non-Groq base URL (a local Ollama) needs no key.
export function parseArgs(argv, env) {
  const o = { langs: LANGS, baseUrl: GROQ_BASE_URL, fresh: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value. ${USAGE}`);
      return v;
    };
    if (flag === '--model') o.model = value();
    else if (flag === '--limit') {
      o.limit = Number(value());
      if (!Number.isInteger(o.limit) || o.limit < 1) throw new Error(`--limit must be a whole number of 1 or more. ${USAGE}`);
    } else if (flag === '--lang') {
      const v = value();
      if (!LANGS.includes(v)) throw new Error(`--lang must be en or fr. ${USAGE}`);
      o.langs = [v];
    } else if (flag === '--items') o.only = value().split(',').map((s) => s.trim()).filter(Boolean);
    else if (flag === '--base-url') o.baseUrl = value();
    else if (flag === '--fresh') o.fresh = true;
    else throw new Error(`Unknown option ${flag}. ${USAGE}`);
  }
  if (!o.model) throw new Error(`--model is required. ${USAGE}`);
  if (o.baseUrl === GROQ_BASE_URL) {
    if (!env.GROQ_API_KEY) throw new Error('GROQ_API_KEY is not set. Export it in your shell (it is read from the environment only).');
    o.apiKey = env.GROQ_API_KEY;
  }
  return o;
}

const entryOf = (item, lang, turn, scored) => (scored.error
  ? { group: item.group, prompt: item.prompts[lang], error: true }
  : {
    group: item.group,
    prompt: item.prompts[lang],
    reply: turn.text,
    pass: scored.pass,
    lines: scored.lines,
    guides: turn.guides,
    refusal: turn.refusal,
    chip: turn.chip,
    cards: turn.cards.map((c) => c.path),
    tool: turn.tool,
    toolBlocked: turn.toolBlocked,
    warnings: turn.warnings,
    nextSteps: turn.nextSteps,
    model: turn.model,
    ms: turn.ms,
  });

// Runs the items in order, both languages each. `limit` is the most items run in this invocation; items already
// scored in the results files are skipped, so repeating the command resumes where the last run stopped. If the
// pacer reports the daily cap, the run stops there and the interrupted prompt is not recorded.
export async function runEval({ items, rig, dir, modelName, langs = LANGS, limit, only, fresh = false, pacer, log = console.log }) {
  const stores = Object.fromEntries(langs.map((lang) => [lang, openResults({ dir, model: modelName, lang, fresh })]));
  const wanted = items.filter((item) => !only || only.includes(item.id));
  const report = { items: 0, ran: 0, skipped: 0, stopped: null };
  for (const item of wanted) {
    const todo = langs.filter((lang) => !stores[lang].isDone(item.id));
    if (!todo.length) { report.skipped += 1; continue; }
    if (limit !== undefined && report.items >= limit) break;
    report.items += 1;
    for (const lang of todo) {
      const turn = await rig.run(item, lang);
      if (pacer?.halted) { report.stopped = 'daily_limit'; log(pacer.halted.message); return report; }
      const scored = scoreItem(item, turn, lang);
      stores[lang].record(item.id, entryOf(item, lang, turn, scored));
      report.ran += 1;
      log(`${item.id}.${lang}: ${scored.error ? 'ERROR' : scored.pass ? 'pass' : `FAIL (${scored.lines.filter((l) => !l.pass).length} line(s))`} ${turn.ms} ms`);
    }
  }
  return report;
}
