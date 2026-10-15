const ACTION_FOR_TELLER = /\b(?:do|make|fill|complete|execute|process|submit|approve|validate|authorize)\b.{0,60}\b(?:for me|my (?:cash[- ]in|cash[- ]out|transaction|payment)|this (?:cash[- ]in|cash[- ]out|transaction|payment))\b/i;
const ACTION_REQUEST = /\b(?:approve|validate|authorize)\b.{0,40}\b(?:validation|transaction|payment|operation|op[eé]ration)\b/i;
const FRENCH_ACTION_FOR_TELLER = /\b(?:remplir|faire|effectuer|ex[eé]cuter|soumettre|approuver|valider|autoriser)\b.{0,60}\b(?:pour moi|mon (?:d[eé]p[oô]t|retrait|transaction|paiement)|cette (?:op[eé]ration|transaction|paiement))\b/i;

export function classifyAgencyUnsafeRequest(message, secretFlagged = false) {
  if (secretFlagged) return 'secret';
  if (ACTION_FOR_TELLER.test(message) || ACTION_REQUEST.test(message) || FRENCH_ACTION_FOR_TELLER.test(message)) return 'action';
  return null;
}
