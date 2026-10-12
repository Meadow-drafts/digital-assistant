// Output filter. Rules-based, no judge model: a reply that carries a URL, email
// or phone number outside the configured allowlist, or that repeats the system
// prompt, is replaced by a fixed message. Everything is blocked unless allowed.
export const BLOCKED = {
  en: 'Sorry, I could not give that answer. Please use "Talk to a human agent" and they can help.',
  fr: "Désolé, je ne peux pas donner cette réponse. Utilisez « Parler à un agent » et il pourra vous aider.",
};

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const URL_ = /(?:https?:\/\/|www\.)[^\s<>"')\]]+/gi;
// 9+ digits with single separators; a figure followed by a currency is an amount, not a phone number.
const PHONE = /\+?\d(?:[ .\-()]?\d){8,}(?!\d)(?!\s*(?:XAF|FCFA|XOF|EUR|USD|€|\$))/gi;
const ECHO_WORDS = 6;

const words = (text) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);
const digits = (s) => s.replace(/\D/g, '');
const hostOf = (url) => /^(?:https?:\/\/)?([^/:?#\s]+)/i.exec(url)?.[1].toLowerCase().replace(/^www\./, '') ?? '';

export function createOutputFilter({ allowlist = {}, protectedTexts = [] } = {}) {
  const { urlHosts = [], emails = [], phones = [] } = allowlist;
  const okHosts = new Set(urlHosts.map((h) => h.toLowerCase().replace(/^www\./, '')));
  const okEmails = new Set(emails.map((e) => e.toLowerCase()));
  const okPhones = new Set(phones.map(digits));
  const shingles = new Set();
  for (const text of protectedTexts) {
    const w = words(text);
    for (let i = 0; i + ECHO_WORDS <= w.length; i++) shingles.add(w.slice(i, i + ECHO_WORDS).join(' '));
  }

  // Returns the first reason the text is blocked, or null when it is clean.
  return function check(text) {
    const urls = text.match(URL_) ?? [];
    if (urls.some((u) => !okHosts.has(hostOf(u)))) return 'url';
    let rest = text.replace(URL_, ' ');
    const found = rest.match(EMAIL) ?? [];
    if (found.some((e) => !okEmails.has(e.toLowerCase()))) return 'email';
    rest = rest.replace(EMAIL, ' ');
    if ((rest.match(PHONE) ?? []).some((p) => !okPhones.has(digits(p)))) return 'phone';
    const w = words(text);
    for (let i = 0; i + ECHO_WORDS <= w.length; i++) if (shingles.has(w.slice(i, i + ECHO_WORDS).join(' '))) return 'prompt_echo';
    return null;
  };
}
