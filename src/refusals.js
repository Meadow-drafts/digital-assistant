// Refusals. The model words a refusal in the customer's language but must
// open its reply with a category tag; the service strips the tag and appends
// a fixed next-step card, so a refusal is never a dead end.
export const CATEGORIES = ['execute', 'approve_validate', 'other_user_data', 'pin_otp', 'off_topic'];
export const FALLBACK_CATEGORY = 'off_topic';

const TAG = /^\s*\[\[refusal:([a-z_]+)\]\]\s*/;

const HUMAN = { kind: 'human_agent', text: { en: 'Talk to a human agent', fr: 'Parler à un agent' } };
const CARDS = {
  execute: { kind: 'navigate', target: 'transfer', text: { en: 'Open the transfer form', fr: 'Ouvrir le formulaire de virement' } },
  approve_validate: HUMAN,
  other_user_data: HUMAN,
  pin_otp: HUMAN,
  off_topic: HUMAN,
};

// Anything that is not a known category collapses to the fallback, so the
// model can never invent a category (or a card).
const normalise = (name) => (CATEGORIES.includes(name) ? name : FALLBACK_CATEGORY);

// Splits a leading refusal tag off `text`. Only a tag at the very start counts.
export function parseRefusal(text) {
  const m = TAG.exec(text);
  if (!m) return { category: null, text };
  return { category: normalise(m[1]), text: text.slice(m[0].length) };
}

export function refusalCard(category, language) {
  const { text, ...card } = CARDS[normalise(category)];
  return { ...card, text: text[language] ?? text.en };
}
