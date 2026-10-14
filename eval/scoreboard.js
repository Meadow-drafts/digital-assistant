import fs from 'node:fs';
import path from 'node:path';

const ATTEMPTS = [
  { id: 'I1', label: 'Injection' },
  { id: 'I2', label: 'Injection' },
  { id: 'I3', label: 'Injection' },
  { id: 'I4', label: 'Injection' },
  { id: 'T1', label: 'Transfer execution' },
  { id: 'T5', label: 'Transfer execution' },
];
const LANGUAGES = ['en', 'fr'];

function readRecordedResults(resultsDir) {
  return fs.readdirSync(resultsDir)
    .filter((name) => name.endsWith('.json') && !name.startsWith('usage.'))
    .sort()
    .map((name) => ({ name, data: JSON.parse(fs.readFileSync(path.join(resultsDir, name), 'utf8')) }))
    .filter(({ data }) => LANGUAGES.includes(data.language) && data.model && data.items);
}

function verdict(record, id) {
  const item = record?.data.items[id];
  if (!item) return 'NOT RUN';
  if (item.error) return 'ERROR';
  return item.pass ? 'PASS' : 'FAIL';
}

function cell(record, id) {
  const outcome = verdict(record, id);
  if (outcome !== 'FAIL') return outcome;
  const resultName = record.name.replace(/\.json$/, '.md');
  return `[FAIL](eval/results/${resultName}#${id.toLowerCase()})`;
}

// Renders only recorded red-team attempts. It does not run evals or contact a model.
export function renderScoreboard({ resultsDir = new URL('./results/', import.meta.url).pathname } = {}) {
  const records = readRecordedResults(resultsDir);
  const models = new Map();
  for (const record of records) {
    const byLanguage = models.get(record.data.model) ?? new Map();
    byLanguage.set(record.data.language, record);
    models.set(record.data.model, byLanguage);
  }

  const lines = [
    '# Red-team scoreboard',
    '',
    'Built from recorded eval results. FAIL links open the recorded attempt and reply. ERROR and NOT RUN are not scored.',
  ];
  if (models.size === 0) lines.push('', 'No recorded model results found.');

  for (const [model, byLanguage] of models) {
    lines.push('', `## ${model}`, '', '| Attempt | Category | EN | FR |', '| --- | --- | --- | --- |');
    for (const { id, label } of ATTEMPTS) {
      const en = byLanguage.get('en');
      const fr = byLanguage.get('fr');
      lines.push(`| ${id} | ${label} | ${cell(en, id)} | ${cell(fr, id)} |`);
    }
  }
  return `${lines.join('\n')}\n`;
}
