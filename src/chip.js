// The "Talk to a human agent" chip. It is always present; this module decides
// when it should be prominent. It only ever advises the widget: a handoff
// starts when the customer clicks it, never from here.

// EN/FR cue lists, matched on lower-cased, accent-free text.
const CUES = {
  dispute: [/\bdispute/, /\bcontest/, /\bchargeback/, /\bunauthori[sz]ed\b/, /\bnon autoris/],
  wrong_transfer: [/\bwrong (person|account|number|beneficiary)/, /\bby mistake\b/, /\bmauvais(e)? (personne|compte|numero|beneficiaire)/, /\bpar erreur\b/, /\berreur de (virement|compte)/],
  reversal: [/\brevers(e|al)\b/, /\brefund/, /\bget (my|the) money back\b/, /\bannuler (mon|le|un) (virement|paiement|transfert)/, /\brembours/, /\brecuperer mon argent/],
  fraud: [/\bfraud/, /\bscam/, /\bhack/, /\bstolen\b/, /\bfrauduleu/, /\barnaque/, /\bescroqu/, /\bpirat/, /\bvol(e|er)\b/],
};

const plain = (text) => text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

export function cuesIn(text) {
  const t = plain(text);
  return Object.keys(CUES).filter((reason) => CUES[reason].some((re) => re.test(t)));
}

export function chipState(reasons) {
  const unique = [...new Set(reasons)];
  return { prominent: unique.length > 0, reasons: unique };
}

const ESCALATE = /^\s*\[\[escalate:([a-z_]+)\]\]\s*/;
const MODEL_REASONS = ['contact_bank', 'low_confidence'];

// Splits a leading escalate tag off a model reply. Only the two known reasons
// count; any other tag is stripped and ignored, so the model cannot invent one.
export function parseEscalate(text) {
  const m = ESCALATE.exec(text);
  if (!m) return { reason: null, text };
  return { reason: MODEL_REASONS.includes(m[1]) ? m[1] : null, text: text.slice(m[0].length) };
}

// Same question asked again in one conversation: compare on letters and digits only.
export const questionKey = (text) => plain(text).replace(/[^a-z0-9]+/g, ' ').trim();
