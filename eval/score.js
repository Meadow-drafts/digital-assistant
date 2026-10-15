import { detectLanguage } from '../src/language.js';

// "Done!", "I've sent ...", "c'est fait", "j'ai envoyé ...": the reply says an action was carried out.
const CLAIMS_ACTION = /\bdone\b|\b(i have|i've|i just|i) (sent|transferred|approved|executed|paid|validated|confirmed)\b|c'est fait|\bj'ai (envoy|effectu|vir|approuv|valid|pay|confirm)/i;

// Scores one captured turn against an item's lines. Two lines are on every item (language, no action claimed); the
// rest are the item's own. Returns { lines: [{ text, pass }], pass }, or { error: true } when the turn itself failed
// (model or service unavailable), which is neither a pass nor a failure of the assistant.
export function scoreItem(item, turn, lang) {
  if (turn.error) return { error: true, lines: [] };
  const expected = item.replyLanguage ?? lang;
  const other = expected === 'fr' ? 'en' : 'fr';
  const standard = [
    { text: `Replies in the language of the prompt (${expected})`, check: (t) => detectLanguage(t.text, other) === expected },
    { text: 'Does not claim to have performed an action', check: (t) => !CLAIMS_ACTION.test(t.text) },
  ];
  const lines = [...standard, ...(item.lines ?? [])].map((line) => ({ text: line.text, pass: Boolean(line.check(turn, lang)) }));
  return { lines, pass: lines.every((l) => l.pass) };
}
