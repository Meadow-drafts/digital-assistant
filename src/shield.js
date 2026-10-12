// PIN/OTP shield. Runs on every chat message before anything else sees it:
// the model, the history, the audit log and the failed-question log only ever
// get the redacted text. False positives are accepted by design.
export const PLACEHOLDER = '[REDACTED]';

export const WARNING = {
  en: 'Please never share your PIN, not even with the bank. I removed what looked like a secret from your message and did not keep it.',
  fr: "Ne partagez jamais votre PIN, pas même avec la banque. J'ai retiré de votre message ce qui ressemblait à un secret et je ne l'ai pas conservé.",
};

// Cue words that make nearby digits a likely secret ("code" is too common to flag alone).
const CUE = '(?:pin|otp|cvv|mdp|passcode|password|mot\\s+de\\s+passe|code\\s+secret|code)';
// Cue words that warn on their own, with nothing secret in the message.
const BARE_CUE = /\b(?:pin|otp|cvv|mdp|passcode|password|mot\s+de\s+passe|code\s+secret)\b/i;

const CARD = /\b(?:\d[ -]?){15}\d\b/g;
// "pin 4821", "otp is 98 76 54": 4-6 digits shortly after a cue word.
const DIGITS_AFTER_CUE = new RegExp(`(\\b${CUE}\\b[^\\d]{0,25}?)\\b(\\d{4,6}|\\d{2}(?: \\d{2}){1,2})\\b`, 'gi');
// "mot de passe est Soleil2024!", "password: abc": whatever follows an assignment.
const VALUE_AFTER_CUE = new RegExp(`(\\b${CUE}\\s*(?:is|est|=|:)\\s*)(\\S+)`, 'gi');

export function shield(text) {
  let flagged = BARE_CUE.test(text);
  const mark = (replacement) => (...m) => { flagged = true; return typeof replacement === 'function' ? replacement(...m) : replacement; };
  const redacted = text
    .replace(CARD, mark(PLACEHOLDER))
    .replace(DIGITS_AFTER_CUE, mark((_, lead) => `${lead}${PLACEHOLDER}`))
    .replace(VALUE_AFTER_CUE, mark((_, lead, value) => (value.startsWith(PLACEHOLDER) ? _ : `${lead}${PLACEHOLDER}`)));
  return { text: redacted, flagged };
}
