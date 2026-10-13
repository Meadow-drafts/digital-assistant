// Rules-based pre-check for the one pre-fill request that is unmistakable: "send 5000 to 237677000555" (EN/FR).
// The model sometimes read it as a request to execute and refused (or answered "no verified steps"), so the proposal
// is built here instead. It is only a proposal: the service validates every value against what the customer wrote,
// the page and package rules apply, and the form only opens for the customer to review and submit themselves.
// Deliberately narrow: a short message, a verb, an amount, and a recipient number. Anything that asks the assistant
// to confirm, approve or complete it is left to the model, which refuses.
const norm = (text) => text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/['’`]/g, ' ');

// True when the customer asks the assistant itself to complete, confirm or approve something (never done, whatever the wording).
export const asksToComplete = (text) => typeof text === 'string' && COMPLETE_IT.test(norm(text));

const MAX_WORDS = 12;
const COMPLETE_IT = /\b(confirm\w*|approv\w*|validat\w*|execut\w*|go ahead|do it|for me|fais le|vas y|valide\w*|approuve\w*|a ma place|pour moi)\b/;
const VERB = '(?:send|transfer|wire|pay|envoie|envoyer|envoi|vire|virer|transfere|transferer|transferez)';
const AMOUNT = '(\\d{1,3}(?:[ .,]\\d{3})+|\\d+)';
const CURRENCY = '(?:xaf|fcfa|cfa|f)?';
const NUMBER = '(\\+?\\d(?:[ ]?\\d){8,14})';
const PATTERN = new RegExp(`^(?:please |svp |s il vous plait )?${VERB} ${AMOUNT} ?${CURRENCY} (?:to|a|au|vers|pour) ${NUMBER}$`);

// Returns { form, raw } for validatePrefill, or null.
export function prefillIntent(text) {
  if (typeof text !== 'string') return null;
  const t = norm(text).replace(/\s+/g, ' ').replace(/[.!?]+$/, '').trim();
  if (t.split(/\s+/).length > MAX_WORDS || COMPLETE_IT.test(t)) return null;
  const m = PATTERN.exec(t);
  if (!m) return null;
  const amount = Number(m[1].replace(/\D/g, ''));
  const destination = m[2].replace(/\D/g, '');
  if (!Number.isSafeInteger(amount) || amount <= 0 || destination.length < 9) return null;
  return { form: 'single_transfer', raw: JSON.stringify({ destination, amount }) };
}

// Said when the ask is clear but no account session is connected (it failed to start, or the token ended): the form
// cannot be validated, and the model would only guess.
export const NO_SESSION_FOR_FORM = {
  en: 'I could not connect to your account just now, so I cannot prepare the transfer form. Please try again in a moment, or reload the page.',
  fr: "Je n'ai pas pu me connecter à votre compte à l'instant, donc je ne peux pas préparer le formulaire de virement. Réessayez dans un instant, ou rechargez la page.",
};

// Fixed wording (never model-written): what the card is, and that the customer still reviews and submits.
export const PREFILL_BY_RULE = {
  en: 'I cannot send money for you, but I can open the transfer form with these details. Open it, check everything and submit it yourself.',
  fr: "Je ne peux pas envoyer l'argent à votre place, mais je peux ouvrir le formulaire de virement avec ces informations. Ouvrez-le, vérifiez tout et validez-le vous-même.",
};
