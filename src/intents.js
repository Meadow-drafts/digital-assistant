// Rules-based pre-check for the three own-data questions customers ask most (balance, recent transactions,
// fees and limits), in English and French. The router model can skip the tool tag for plain wording, so the
// choice does not depend on the model alone. It only runs when the router did not refuse, and it is
// deliberately narrow: short questions, nobody else's data, no failure story (those go to the guides).
const norm = (text) => text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/['’`]/g, ' ');

const MAX_WORDS = 10;
const OTHER_PERSON = /\b(colleague|collegue|friend|ami|amie|brother|frere|sister|soeur|wife|husband|mari|femme|mother|mere|father|pere|his|her|their|him|them|someone|quelqu un|marie|account number|numero de compte)\b|\w+ s (account|balance|solde)\b|\bde (ma|mon|mes|ta|ton|son|sa|ses|leur)\b|\d{5,}/;
const FAILURE = /\b(fail|failed|declined|insufficient|error|refus\w*|why|echec|echoue\w*|insuffisant\w*|erreur|pourquoi|reject\w*|rejet\w*|deducted|debited|debite\w*)\b/;

const BALANCE = [
  /\b(balance|solde)\b/,
  /\bhow much (money |cash )?(do|have|is|did) (i|there|you)? ?(have|got|left|in|on)\b/,
  /\bhow much (is )?(left|in|on) my\b/,
  /\bcombien (d argent )?(j ai|ai je|il me reste|me reste|y a t il|il y a)\b/,
];
const TRANSACTIONS = [
  /\b(transactions?|operations?|mouvements?)\b.*\b(my|mes|mon|ma|recent|last|latest|derniere?s?|recente?s?)\b/,
  /\b(my|mes|mon|ma|recent|last|latest|derniere?s?|dernier|recente?s?)\b.*\b(transactions?|operations?|mouvements?)\b/,
];
const FEES = /\b(fees?|frais|charges)\b.*\b(limits?|plafonds?|ceilings?)\b|\b(limits?|plafonds?)\b.*\b(fees?|frais)\b/;

export function intentTool(text) {
  if (typeof text !== 'string') return null;
  const t = norm(text);
  if (t.split(/\s+/).filter(Boolean).length > MAX_WORDS || OTHER_PERSON.test(t) || FAILURE.test(t)) return null;
  if (BALANCE.some((r) => r.test(t))) return { name: 'balance', rawArgs: '{}' };
  if (TRANSACTIONS.some((r) => r.test(t))) {
    const n = /\b(\d{1,4})\b/.exec(t);
    return { name: 'last_transactions', rawArgs: n ? JSON.stringify({ count: Math.min(20, Math.max(1, Number(n[1]))) }) : '{}' };
  }
  if (FEES.test(t)) return { name: 'fees_limits', rawArgs: '{}' };
  return null;
}
