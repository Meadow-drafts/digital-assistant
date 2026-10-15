import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkGuidePairs, loadGuides } from '../src/guides.js';

const GUIDES = new URL('../guides/', import.meta.url);

function guide(id, title, extra = '') {
  return `---\nid: ${id}\naudience: individual\nroute: /x\npackage: none\n---\n# ${title}\n\n## Steps\n1. Click **Go**${extra}.\n\n## Talk to a human if\nIt breaks.\n`;
}
function dirWith(files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'guides-'));
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
  return dir;
}

test('every shipped guide exists in both English and French', () => {
  assert.deepEqual(checkGuidePairs(GUIDES), []);
});

// Story 7's task list. Each task is covered by a guide pair or by an entry in
// guides/UNSUPPORTED.md (matched by its bold title), never by neither.
const STORY_7_TASKS = {
  'domestic transfers': { guides: ['transfer-single'] },
  'international transfers': { unsupported: 'International transfer' },
  beneficiaries: { unsupported: 'Saved beneficiaries' },
  'bill payment': { guides: ['bill-payment'] },
  'merchant payment': { guides: ['merchant-payment'] },
  airtime: { guides: ['airtime'] },
  'request to pay': { guides: ['request-to-pay'] },
  'cardless withdrawal': { guides: ['cardless'] },
  'bulk transfers and validations': { guides: ['transfer-bulk', 'validations'] },
  'history and statements': { guides: ['history-statement'] },
  cards: { guides: ['cards'] },
  'settings and PIN change': { guides: ['settings-connects', 'settings-pin'] },
};

function uncovered(guides, tasks) {
  return Object.entries(tasks)
    .filter(([, { guides: ids = [], unsupported }]) => {
      const guided = ids.length > 0 && ids.every((id) => guides.has(id));
      const declined = unsupported !== undefined && guides.unsupported.includes(`**${unsupported}.**`);
      return !guided && !declined;
    })
    .map(([task]) => task);
}

test('every task in story 7 has a guide pair or an unsupported entry', () => {
  assert.deepEqual(uncovered(loadGuides(GUIDES), STORY_7_TASKS), []);
});

test('a task with neither a guide nor an unsupported entry is reported', () => {
  const dir = dirWith({ 'a.en.md': guide('a', 'A'), 'a.fr.md': guide('a', 'A fr'), 'UNSUPPORTED.md': '- **Gone.** nope\n' });
  const tasks = { covered: { guides: ['a'] }, declined: { unsupported: 'Gone' }, forgotten: { guides: ['missing'] }, unlisted: { unsupported: 'Never listed' } };
  assert.deepEqual(uncovered(loadGuides(dir), tasks), ['forgotten', 'unlisted']);
});

test('a guide present in one language only fails the check and refuses to load', () => {
  const dir = dirWith({ 'a.en.md': guide('a', 'A'), 'a.fr.md': guide('a', 'A fr'), 'b.en.md': guide('b', 'B'), 'c.fr.md': guide('c', 'C') });
  assert.deepEqual(checkGuidePairs(dir).sort(), ['b (missing fr)', 'c (missing en)']);
  assert.throws(() => loadGuides(dir), /b \(missing fr\)/);
});

test('glossary labels are injected by key into every guide, and an unknown key fails the build', () => {
  const files = {
    'a.en.md': guide('a', 'A', ' then {{transfer.proceed}}'),
    'a.fr.md': guide('a', 'A', ' puis {{transfer.proceed}}'),
    'glossary.en.json': JSON.stringify({ 'transfer.proceed': '**Proceed Transfer**' }),
    'glossary.fr.json': JSON.stringify({ 'transfer.proceed': '**Poursuivre le transfert**' }),
  };
  const guides = loadGuides(dirWith(files));
  assert.match(guides.get('a').en.text, /then \*\*Proceed Transfer\*\*/);
  assert.match(guides.get('a').fr.text, /puis \*\*Poursuivre le transfert\*\*/);

  delete files['glossary.fr.json'];
  assert.throws(() => loadGuides(dirWith({ ...files, 'glossary.fr.json': '{}' })), /transfer\.proceed/);
});
