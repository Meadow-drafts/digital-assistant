// Explain my failure (stories 31-33). Pure rules: which kind of outcome a transfer-status record shows, how the
// chip reacts, which single next step ends the explanation, and the fixed texts. Only the plain "failed" kind
// is worded by the model, from the failed-transfer guide; everything else is fixed text built from the data.
export const GUIDE_ID = 'failed-transfer';

// status: 'success' | 'failed' | 'pending' | 'unknown' (from the record's sta); detail: see t1.js statusDetail.
// Reversal fields win over the plain status; a debit step marked successful on a failed transfer is the
// "debited but not credited" case the guide sends to a human agent.
export function classify({ status, detail }) {
  if (detail.reversing) return 'reversal_in_progress';
  if (detail.reDebited || detail.reversedAt) return 'reversed';
  if (status === 'failed') return detail.legs.makeOperation === 'success' ? 'debit_without_credit' : 'failed';
  if (status === 'pending') return 'pending';
  if (status === 'success') return 'succeeded';
  return 'unknown';
}

// kind -> the chip reason (dispute-like cases make the human chip prominent) and the fixed next step.
// 'failed' has neither: the model picks retry or human, and human is the default.
export const OUTCOMES = {
  reversal_in_progress: { chip: 'reversal_in_progress', next: 'human' },
  debit_without_credit: { chip: 'debit_without_credit', next: 'human' },
  unknown: { chip: 'unknown_status', next: 'human' },
  reversed: { chip: null, next: 'history' },
  pending: { chip: null, next: 'history' },
  succeeded: { chip: null, next: 'history' },
  not_found: { chip: null, next: 'history' },
};

const NEXT = /^\s*\[\[next:([a-z_]+)\]\]\s*/;
const MODEL_NEXT = ['retry', 'human'];

// Splits a leading next-step tag off a model reply. Only retry and human count; anything else is stripped and ignored.
export function parseNext(text) {
  const m = NEXT.exec(text);
  if (!m) return { next: null, text };
  return { next: MODEL_NEXT.includes(m[1]) ? m[1] : null, text: text.slice(m[0].length) };
}

// "REF (15000 XAF, 2026-10-10)"; parts the record does not have are left out.
// The bank's currency is often a numeric code (001, 59); the portal shows XAF for those, and so does the widget.
const currencyOf = (c) => (c == null ? null : /^[A-Za-z]{3}$/.test(String(c)) ? c : 'XAF');
const label = (t) => {
  const parts = [[t.amount, currencyOf(t.currency)].filter((v) => v != null).join(' '), t.date].filter(Boolean);
  return parts.length ? `${t.reference} (${parts.join(', ')})` : t.reference;
};
const when = (d) => (d.reversedAt ? { en: ` on ${d.reversedAt}`, fr: ` le ${d.reversedAt}` } : { en: '', fr: '' });

// Fixed explanations. Portal labels stay as the guide writes them in each language. The third argument says whether
// the History page is offered to this customer; when it is not, the text must not point to it.
export const TEXT = {
  succeeded: {
    en: (t) => `Transfer ${label(t)} went through: its status is successful, so there is no failure to explain.`,
    fr: (t) => `Le transfert ${label(t)} a abouti : son statut est réussi, il n'y a donc pas d'échec à expliquer.`,
  },
  pending: {
    en: (t, d, history) => `Transfer ${label(t)} is still pending (Payment Pending). Do not retry it${history ? ': check History first' : ''}.`,
    fr: (t, d, history) => `Le transfert ${label(t)} est encore en attente (Paiement en attente). Ne réessayez pas${history ? " : vérifiez d'abord dans Historique" : ''}.`,
  },
  reversed: {
    en: (t, d, history) => `The portal records a reversal on transfer ${label(t)}${when(d).en}.${history ? ' History shows the entries on your account.' : ''}`,
    fr: (t, d, history) => `Le portail enregistre une annulation sur le transfert ${label(t)}${when(d).fr}.${history ? ' Historique affiche les écritures sur votre compte.' : ''}`,
  },
  reversal_in_progress: {
    en: (t) => `A reversal of transfer ${label(t)} is currently in progress. I cannot see more than that, so a human agent is best placed to follow it up with you.`,
    fr: (t) => `Une annulation du transfert ${label(t)} est en cours. Je ne vois rien de plus, un agent est donc le mieux placé pour la suivre avec vous.`,
  },
  debit_without_credit: {
    en: (t) => `Transfer ${label(t)} is marked as failed, but its debit step is marked successful, so you may have been debited without the transfer completing. The guide says to talk to a human agent in that case.`,
    fr: (t) => `Le transfert ${label(t)} est marqué comme échoué, mais son étape de débit est marquée comme réussie : vous avez peut-être été débité sans que le transfert aboutisse. Le guide indique de parler à un agent dans ce cas.`,
  },
  unknown: {
    en: (t) => `I cannot tell the state of transfer ${label(t)} from the data I can read, so I will not guess.`,
    fr: (t) => `Je ne peux pas déterminer l'état du transfert ${label(t)} avec les données que je peux lire, donc je ne vais pas deviner.`,
  },
  not_found: {
    en: (reference) => `I cannot find a transfer with the reference ${reference} on your wallet. Please check the reference.`,
    fr: (reference) => `Je ne trouve aucun transfert avec la référence ${reference} sur votre portefeuille. Veuillez vérifier la référence.`,
  },
};

// The single closing step. `reference` is the one the customer asked about.
export const NEXT_STEP = {
  retry: {
    en: () => 'Next step: correct what the message points to, then try the transfer again.',
    fr: () => 'Prochaine étape : corrigez ce que le message indique, puis réessayez le transfert.',
  },
  history: {
    en: () => 'Next step: open History to check this transfer.',
    fr: () => 'Prochaine étape : ouvrez Historique pour vérifier ce transfert.',
  },
  human: {
    en: (reference) => `Next step: use "Talk to a human agent" and give them the reference ${reference}.`,
    fr: (reference) => `Prochaine étape : utilisez « Parler à un agent » et donnez-lui la référence ${reference}.`,
  },
};
