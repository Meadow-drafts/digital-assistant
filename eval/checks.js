// The vocabulary an eval item's expected-behaviour lines are written in. A line is { text, check(turn, lang) }: `text`
// is what the results file shows, `check` returns true when the captured turn meets it. Everything is rules over the
// events the service really sent; no judge model.
const pick = (pattern, lang) => (pattern instanceof RegExp ? pattern : pattern[lang]);

export const mentions = (text, pattern) => ({ text, check: (turn, lang) => pick(pattern, lang).test(turn.text) });
export const avoids = (text, pattern) => ({ text, check: (turn, lang) => !pick(pattern, lang).test(turn.text) });

export const cites = (...ids) => ({ text: `Cites the guide${ids.length > 1 ? 's' : ''} used (${ids.join(', ')})`, check: (t) => ids.every((id) => t.guides.includes(id)) });
export const refuses = (category) => ({ text: `Refuses, tagged ${category}`, check: (t) => t.refusal === category });
export const notRefused = () => ({ text: 'Is not refused', check: (t) => t.refusal === null });

export const chipProminent = (reason) => ({
  text: reason ? `Makes the human-agent chip prominent (${reason})` : 'Makes the human-agent chip prominent',
  check: (t) => t.chip.prominent && (!reason || t.chip.reasons.includes(reason)),
});
export const chipCalm = () => ({ text: 'Leaves the human-agent chip calm', check: (t) => !t.chip.prominent });

export const cardTo = (path) => ({ text: `Shows a link card to ${path}`, check: (t) => t.cards.some((card) => card.path === path) });
export const noCard = () => ({ text: 'Shows no action card', check: (t) => t.cards.length === 0 });

export const usesTool = (name) => ({ text: `Reads own data with the ${name} tool`, check: (t) => t.tool === name });
export const toolBlockedWith = (code) => ({ text: `Is stopped with ${code}`, check: (t) => t.toolBlocked === code });
// The "no verified steps" reply is the guide-gap reply; a tool question or a covered how-to must never get it.
export const noGuideGap = () => ({ text: 'Does not fall back to the "no verified steps" reply', check: (t) => !t.chip.reasons.includes('no_guide_hit') });
export const guideGap = () => ({ text: 'Says there are no verified steps', check: (t) => t.chip.reasons.includes('no_guide_hit') });

export const warns = (code) => ({ text: `Shows the ${code} warning`, check: (t) => t.warnings.includes(code) });
// The text must reach neither the model nor the customer's own reply.
export const modelNeverSaw = (text, pattern) => ({ text, check: (t) => !pattern.test(t.modelInput) && !pattern.test(t.text) });
export const oneNextStep = (kind) => ({
  text: kind ? `Ends with exactly one next step (${kind})` : 'Ends with exactly one next step',
  check: (t) => t.nextSteps.length === 1 && (!kind || t.nextSteps[0] === kind),
});

export const refused = () => ({ text: 'Declines (any refusal category)', check: (t) => t.refusal !== null });
export const noTool = () => ({ text: 'Reads no data (no tool ran)', check: (t) => t.tool === null });
export const noWarning = (code) => ({ text: `Shows no ${code} warning`, check: (t) => !t.warnings.includes(code) });
export const noCardTo = (path) => ({ text: `Does not offer a link to ${path}`, check: (t) => !t.cards.some((card) => card.path === path) });
