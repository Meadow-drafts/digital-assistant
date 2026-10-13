import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openResults, renderSummary } from '../eval/results.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'eval-results-'));
const scored = (over = {}) => ({ group: 'how-to', prompt: 'q', reply: 'a', lines: [{ text: 'Cites the guide', pass: true }], pass: true, ms: 5, ...over });

test('one JSON file and one readable summary per model and per language', () => {
  const dir = tmp();
  openResults({ dir, model: 'qwen/qwen3.8-27b', lang: 'en' }).record('H1', scored());
  openResults({ dir, model: 'qwen/qwen3.8-27b', lang: 'fr' }).record('H1', scored());
  assert.deepEqual(fs.readdirSync(dir).sort(), ['qwen_qwen3.8-27b.en.json', 'qwen_qwen3.8-27b.en.md', 'qwen_qwen3.8-27b.fr.json', 'qwen_qwen3.8-27b.fr.md']);
  const json = JSON.parse(fs.readFileSync(path.join(dir, 'qwen_qwen3.8-27b.en.json')));
  assert.equal(json.model, 'qwen/qwen3.8-27b');
  assert.equal(json.language, 'en');
  assert.equal(json.items.H1.pass, true);
});

test('a later run resumes: scored items are done, errored items are tried again', () => {
  const dir = tmp();
  const first = openResults({ dir, model: 'm', lang: 'en' });
  first.record('H1', scored());
  first.record('H2', { group: 'how-to', prompt: 'q', error: true });
  const again = openResults({ dir, model: 'm', lang: 'en' });
  assert.equal(again.isDone('H1'), true);
  assert.equal(again.isDone('H2'), false);
  assert.equal(again.isDone('H3'), false);
  assert.equal(openResults({ dir, model: 'm', lang: 'en', fresh: true }).isDone('H1'), false);
});

test('the summary gives the pass rate, a rate per group, and lists the failing items with their failed lines', () => {
  const text = renderSummary({
    model: 'm', language: 'fr',
    items: {
      H1: scored({ group: 'how-to' }),
      H2: scored({ group: 'how-to', pass: false, prompt: 'Comment payer ?', reply: 'Je ne sais pas.', lines: [{ text: 'Cites the guide', pass: true }, { text: 'Names the Airtime tab', pass: false }] }),
      T1: scored({ group: 'do-it-for-me' }),
      D1: { group: 'dispute', prompt: 'q', error: true },
    },
  });
  assert.match(text, /2 of 3 items passed \(67%\)/);
  assert.match(text, /how-to: 1 of 2/);
  assert.match(text, /do-it-for-me: 1 of 1/);
  assert.match(text, /1 item\(s\) errored/);
  assert.match(text, /H2[\s\S]*Comment payer \?[\s\S]*Names the Airtime tab/);
  assert.doesNotMatch(text, /T1.*Cites the guide/);
});

test('a summary with nothing failing says so', () => {
  assert.match(renderSummary({ model: 'm', language: 'en', items: { H1: scored() } }), /No failing items/);
});
