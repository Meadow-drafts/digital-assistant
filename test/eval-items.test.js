import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ITEMS } from '../eval/items.js';
import { createRig } from '../eval/rig.js';
import { scoreItem } from '../eval/score.js';
import { createFakeModel } from './harness/fake-model.js';

const byId = Object.fromEntries(ITEMS.map((i) => [i.id, i]));
const SESSIONS = ['none', 'locked', 'unlocked', 'secondary'];

test('every item has an unique id, both prompts, a group, a valid session and lines of its own', () => {
  assert.equal(new Set(ITEMS.map((i) => i.id)).size, ITEMS.length);
  for (const item of ITEMS) {
    assert.ok(item.group, item.id);
    for (const lang of ['en', 'fr']) {
      assert.ok(item.prompts[lang]?.trim(), `${item.id}.${lang}`);
      assert.ok(item.prompts[lang].length <= 1000, `${item.id}.${lang} is over the message length limit`);
    }
    assert.ok(SESSIONS.includes(item.session ?? 'locked'), item.id);
    assert.ok(item.lines.length >= 1, `${item.id} has no expected-behaviour line of its own`);
    for (const line of item.lines) assert.equal(typeof line.check, 'function', `${item.id}: ${line.text}`);
  }
});

test('the original set is all there: 12 how-to, 4 out of guide, 4 do-it-for-me, 4 injection, 2 dispute, 7 own-data', () => {
  const ids = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);
  for (const id of [...ids('H', 12), ...ids('O', 4), ...ids('T', 4), ...ids('I', 4), ...ids('D', 2), ...ids('R', 7)]) assert.ok(byId[id], `missing ${id}`);
});

test('the features built since are covered, each by several items', () => {
  const count = (group) => ITEMS.filter((i) => i.group === group).length;
  for (const [group, min] of [['own-data', 12], ['explain-failure', 4], ['where-do-i-go', 5], ['scam', 3], ['secret-in-chat', 3], ['human-chip', 5]]) {
    assert.ok(count(group) >= min, `${group}: ${count(group)} items, wanted ${min}`);
  }
});

test('own-data phrasings are run with a started session and without one', () => {
  for (const id of ['R1', 'R4', 'R6']) assert.equal(byId[`${id}n`]?.session, 'none', `${id}n`);
  assert.equal(byId.R1u.session, 'unlocked');
});

test('pre-fill is gone: no pre-fill item, and "send X to Y" is tested as refused (execute)', () => {
  assert.equal(ITEMS.filter((i) => /pre-?fill/i.test(JSON.stringify(i.lines.map((l) => l.text)) + i.id)).length, 0);
  assert.match(byId.T5.prompts.en, /^Send \d+ to \d+/);
  assert.ok(byId.T5.lines.some((l) => l.text === 'Refuses, tagged execute'));
});

test('every item runs through the real service without a service error (scripted model)', async (t) => {
  const rig = await createRig({ model: createFakeModel((r) => (r.purpose === 'route' ? '[]' : 'ok')) });
  t.after(rig.close);
  for (const item of ITEMS) {
    for (const lang of ['en', 'fr']) {
      const turn = await rig.run(item, lang);
      assert.equal(turn.error, false, `${item.id}.${lang}`);
      assert.equal(scoreItem(item, turn, lang).error, undefined);
    }
  }
});
