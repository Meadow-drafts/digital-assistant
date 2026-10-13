// Results files: one JSON (everything, for later comparison) and one short readable summary per model and language,
// rewritten after every item so an interrupted run loses nothing and the next run resumes where it stopped.
import fs from 'node:fs';
import path from 'node:path';

const slug = (model) => model.replace(/[/:]/g, '_');
const pct = (n, d) => (d ? Math.round((100 * n) / d) : 0);

export function renderSummary({ model, language, items }) {
  const entries = Object.entries(items);
  const errored = entries.filter(([, r]) => r.error);
  const scored = entries.filter(([, r]) => !r.error);
  const passed = scored.filter(([, r]) => r.pass);
  const groups = {};
  for (const [, r] of scored) {
    const g = (groups[r.group] ??= { pass: 0, total: 0 });
    g.total += 1;
    if (r.pass) g.pass += 1;
  }
  const lineTotals = scored.flatMap(([, r]) => r.lines);
  const failing = scored.filter(([, r]) => !r.pass);
  const out = [
    `# Eval summary: ${model} (${language})`,
    '',
    `${passed.length} of ${scored.length} items passed (${pct(passed.length, scored.length)}%). ${lineTotals.filter((l) => l.pass).length} of ${lineTotals.length} expected-behaviour lines held.`,
    ...(errored.length ? [`${errored.length} item(s) errored (model or service unavailable) and are retried on the next run: ${errored.map(([id]) => id).join(', ')}.`] : []),
    '',
    '## By group',
    ...Object.entries(groups).map(([name, g]) => `- ${name}: ${g.pass} of ${g.total} (${pct(g.pass, g.total)}%)`),
    '',
    '## Failing items',
    ...(failing.length ? [] : ['No failing items.']),
  ];
  for (const [id, r] of failing) {
    out.push('', `### ${id}`, `Prompt: ${r.prompt}`, `Reply: ${String(r.reply ?? '').replace(/\s+/g, ' ').trim().slice(0, 400)}`);
    for (const line of r.lines.filter((l) => !l.pass)) out.push(`- FAILED: ${line.text}`);
  }
  return `${out.join('\n')}\n`;
}

export function openResults({ dir, model, lang, fresh = false }) {
  const base = path.join(dir, `${slug(model)}.${lang}`);
  fs.mkdirSync(dir, { recursive: true });
  let data = { model, language: lang, items: {} };
  if (!fresh && fs.existsSync(`${base}.json`)) data = JSON.parse(fs.readFileSync(`${base}.json`, 'utf8'));
  const write = () => {
    data.updatedAt = new Date().toISOString();
    fs.writeFileSync(`${base}.json`, `${JSON.stringify(data, null, 1)}\n`);
    fs.writeFileSync(`${base}.md`, renderSummary(data));
  };
  return {
    data,
    isDone: (id) => Boolean(data.items[id] && !data.items[id].error),
    record(id, entry) { data.items[id] = entry; write(); },
  };
}
