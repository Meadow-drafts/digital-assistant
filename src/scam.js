// Scam cue warnings. A rules-based EN/FR cue list (config/scam-cues.json, which
// the bank may extend) decides; the model never judges scam risk and never
// words the warning. Each matched category yields a fixed warning.
import { readFileSync } from 'node:fs';

const WARNINGS = {
  impersonation_call: {
    en: 'Warning: the bank will never call you to ask you to install an app, move money or share codes. If someone claiming to be the bank contacted you, hang up and do not follow their instructions.',
    fr: "Attention : la banque ne vous appellera jamais pour vous demander d'installer une application, de déplacer de l'argent ou de partager des codes. Si quelqu'un se présentant comme la banque vous a contacté, raccrochez et ne suivez pas ses instructions.",
  },
  otp_request: {
    en: 'Warning: never share an OTP, PIN or any code you receive, not even with someone who says they are from the bank. Anyone who asks for it is trying to steal your money.',
    fr: "Attention : ne partagez jamais un OTP, un PIN ni aucun code reçu, même avec quelqu'un qui dit être de la banque. Toute personne qui vous le demande cherche à vous voler.",
  },
  prize_or_fee_pressure: {
    en: 'Warning: a real prize never asks you to pay a fee first. Do not send money to claim a prize, a gift or a release of funds.',
    fr: "Attention : un vrai gain ne vous demande jamais de payer des frais d'abord. N'envoyez pas d'argent pour recevoir un lot, un cadeau ou le déblocage de fonds.",
  },
  reverse_by_sending_more: {
    en: 'Warning: you never need to send more money to reverse or cancel a transfer. Anyone who tells you to is a scammer; stop and do not send anything.',
    fr: "Attention : vous n'avez jamais besoin d'envoyer plus d'argent pour annuler ou rembourser un virement. Quiconque vous le demande est un escroc ; arrêtez et n'envoyez rien.",
  },
};
const GENERIC = {
  en: 'Warning: this looks like a common scam. Do not send money, share codes or follow instructions from someone who contacted you. Talk to a human agent if you are unsure.',
  fr: "Attention : cela ressemble à une arnaque courante. N'envoyez pas d'argent, ne partagez aucun code et ne suivez pas les instructions de quelqu'un qui vous a contacté. Parlez à un agent si vous avez un doute.",
};

const LANGS = ['en', 'fr'];
const plain = (text) => ` ${text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()} `;

const isStrings = (v) => Array.isArray(v) && v.every((p) => typeof p === 'string' && p.trim());

export function loadScamCues(file) {
  const config = JSON.parse(readFileSync(file, 'utf8'));
  const rules = [];
  for (const [category, def] of Object.entries(config.categories ?? {})) {
    for (const lang of LANGS) {
      if (def[lang] !== undefined && !isStrings(def[lang])) throw new Error(`scam cues: category "${category}" ${lang} must be a list of non-empty phrases`);
    }
    for (const lang of LANGS) {
      if (def.warning?.[lang] !== undefined && typeof def.warning[lang] !== 'string') throw new Error(`scam cues: category "${category}" warning ${lang} must be text`);
    }
    const phrases = LANGS.flatMap((lang) => def[lang] ?? []).map(plain);
    rules.push({ category, phrases, warning: def.warning });
  }
  return {
    categories: () => rules.map((r) => r.category),
    match: (text) => {
      const t = plain(text);
      return rules.filter((r) => r.phrases.some((p) => t.includes(p))).map((r) => r.category);
    },
    warning: (category, language) => {
      const custom = rules.find((r) => r.category === category)?.warning;
      const set = custom ?? WARNINGS[category] ?? GENERIC;
      return set[language] ?? set.en ?? GENERIC[language] ?? GENERIC.en;
    },
  };
}
