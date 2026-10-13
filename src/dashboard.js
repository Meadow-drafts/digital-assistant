import { safeFreeText } from './audit.js';
import { questionKey } from './chip.js';

// Staff dashboard figures (ticket 46). Everything is computed from the audit records and the failed-question log
// handed in, nothing else, and the result holds counts, guide ids, tool names and masked text only: no user id,
// conversation id, tenant, case reference or raw message text ever leaves this function.
export const SMALL_NUMBER_BELOW = 20;
const TEXT_MAX = 80;
const NOT_AN_ANSWER = new Set(['error', 'limited', 'filtered']);

// A chat turn is a record the chat route wrote: it has a language and the list of guides used (session, case and
// export records have neither).
const isTurn = (r) => typeof r.language === 'string' && Array.isArray(r.guideIds);
// What answered a turn: the tool when one ran and succeeded, otherwise the guides it used. Refusals, refused tool
// calls and "no verified steps" turns have neither.
const answeredBy = (r) => {
  if (r.tool && r.toolOutcome === 'ok') return [{ kind: 'tool', id: String(r.tool) }];
  return r.guideIds.map((id) => ({ kind: 'guide', id: String(id) }));
};

const percent = (count, of) => (of === 0 ? null : Math.round((count / of) * 1000) / 10);
const figure = (count, of) => ({ count, of, percent: percent(count, of), small: of < SMALL_NUMBER_BELOW });

// Failed questions reach a human reader cut at TEXT_MAX and masked again, whatever was stored (older entries predate masking at write time).
const safeText = (text) => safeFreeText(text, TEXT_MAX);

export function computeDashboard({ records, failedQuestions, language = 'all' }) {
  const wanted = (lang) => language === 'all' || lang === language;
  const turns = records.filter(isTurn).sort((a, b) => Date.parse(a.time) - Date.parse(b.time));

  // A conversation belongs to the language of its first turn in the range.
  const conversations = new Map();
  for (const r of turns) {
    if (!conversations.has(r.conversationId)) conversations.set(r.conversationId, { language: r.language, turns: [] });
    conversations.get(r.conversationId).turns.push(r);
  }
  const inScope = [...conversations].filter(([, c]) => wanted(c.language));
  const opened = new Set(records.filter((r) => r.outcome === 'handoff_opened').map((r) => r.conversationId));
  const failedAt = (id) => failedQuestions.filter((f) => f.conversationId === id).map((f) => Date.parse(f.time));

  let handoffs = 0;
  let resolved = 0;
  for (const [id, c] of inScope) {
    if (opened.has(id)) { handoffs += 1; continue; }
    const last = c.turns.at(-1);
    const end = Date.parse(last.time);
    // The failed-question entry is written while the turn runs: between its start and the audit record at its end.
    const noVerifiedSteps = failedAt(id).some((t) => t >= end - (last.latencyMs ?? 0) && t <= end);
    // A model error, a "busy" message and a blocked reply are not an answer either.
    if (!last.refusalCategory && !noVerifiedSteps && !NOT_AN_ANSWER.has(last.outcome)) resolved += 1;
  }

  // Top questions: answered turns by guide or tool, in the turn's own language.
  const groups = new Map();
  for (const r of turns) {
    if (!wanted(r.language)) continue;
    for (const by of answeredBy(r)) {
      const key = `${by.kind}:${by.id}`;
      const g = groups.get(key) ?? { ...by, turns: 0, ids: new Set() };
      g.turns += 1;
      g.ids.add(r.conversationId);
      groups.set(key, g);
    }
  }
  const topQuestions = [...groups.values()]
    .map((g) => ({ kind: g.kind, id: g.id, turns: g.turns, conversations: g.ids.size, small: g.ids.size < SMALL_NUMBER_BELOW }))
    .sort((a, b) => b.turns - a.turns || a.id.localeCompare(b.id));

  // Unresolved topics: failed questions grouped by language and wording (case and punctuation ignored).
  const topics = new Map();
  for (const f of failedQuestions.filter((q) => wanted(q.language)).sort((a, b) => Date.parse(a.time) - Date.parse(b.time))) {
    const key = `${f.language}|${questionKey(safeText(f.question))}`;
    const t = topics.get(key) ?? { language: f.language, count: 0, ids: new Set() };
    t.count += 1;
    t.ids.add(f.conversationId);
    t.text = safeText(f.question); // the most recent wording
    topics.set(key, t);
  }
  const unresolved = [...topics.values()]
    .map((t) => ({ text: t.text, language: t.language, count: t.count, conversations: t.ids.size, small: t.ids.size < SMALL_NUMBER_BELOW }))
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text));

  return {
    language,
    smallNumberBelow: SMALL_NUMBER_BELOW,
    conversations: { count: inScope.length, small: inScope.length < SMALL_NUMBER_BELOW },
    handoffRate: figure(handoffs, inScope.length),
    assistantResolved: figure(resolved, inScope.length),
    topQuestions,
    unresolved,
  };
}
