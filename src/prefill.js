// Pre-fill action cards (T2, stories 35-42). The model only proposes a form id and values; the service checks them
// against the registry (exactly which fields each form may have), against what the customer said and their own
// history, and builds the card itself. The widget fills the portal form from the card; nothing is ever submitted.
import { readFileSync } from 'node:fs';
import { validateProposal } from './navigate.js';
import { shield } from './shield.js';
import { maskAccount, maskPhone } from './t1.js';

// Whatever the config says, a field with a name like this is never listed: PIN, OTP, passwords, vouchers and codes.
const SECRET_NAME = /pin|otp|pass|voucher|code|cvv|token|secret|mdp/i;
const PLAIN_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const TYPES = new Set(['beneficiary', 'amount', 'text', 'choice', 'reference', 'account_index', 'currency']);
const CHECKS = new Set(['newBeneficiary', 'largeAmount']);
const bilingual = (v) => typeof v?.en === 'string' && typeof v?.fr === 'string' && v.en && v.fr;

export function parseRegistry(config, navigation) {
  const fail = (where, why) => { throw new Error(`prefill config: ${where}: ${why}`); };
  const currencies = config.currencies;
  if (!Array.isArray(currencies) || currencies.length === 0 || !currencies.every((c) => /^[A-Z]{3}$/.test(c))) fail('currencies', 'a list of currency codes is needed');
  const dc = config.doubleCheck ?? {};
  for (const key of ['largeAmount', 'usualMultiple', 'minHistory']) if (!(dc[key] > 0)) fail(`doubleCheck.${key}`, 'a positive number is needed');
  if (!bilingual(dc.text)) fail('doubleCheck.text', 'text is needed in English and French');
  const forms = new Map();
  for (const [id, form] of Object.entries(config.forms ?? {})) {
    if (!/^[a-z_]{1,32}$/.test(id)) fail(id, 'form ids are lowercase words');
    if (!navigation.routes.has(form?.route)) fail(id, 'route must be a page from the navigate config');
    if (!bilingual(form.summary)) fail(id, 'summary is needed in English and French');
    if (form.directions !== undefined && !bilingual(form.directions)) fail(id, 'directions need text in English and French');
    if (form.mode !== undefined && !['fill', 'directions'].includes(form.mode)) fail(id, 'mode is "fill" or "directions"');
    if (form.mode === 'directions' && !bilingual(form.directions)) fail(id, 'directions mode needs directions text in English and French');
    if (form.waitSeconds !== undefined && !(Number.isInteger(form.waitSeconds) && form.waitSeconds >= 1 && form.waitSeconds <= 300)) fail(id, 'waitSeconds is a whole number from 1 to 300');
    const checks = form.checks ?? [];
    if (!Array.isArray(checks) || checks.some((c) => !CHECKS.has(c))) fail(id, 'unknown check');
    const fields = new Map();
    for (const [name, field] of Object.entries(form.fields ?? {})) {
      const where = `${id}.${name}`;
      const names = [name, ...(field?.dom ?? [])];
      if (names.some((n) => SECRET_NAME.test(n))) fail(where, 'PIN, OTP, password, voucher and code fields are never filled');
      if (!PLAIN_NAME.test(name)) fail(where, 'field names are plain words');
      if (!TYPES.has(field?.type)) fail(where, `unknown type ${field?.type}`);
      if (field.dom !== null && !(Array.isArray(field.dom) && field.dom.length > 0 && field.dom.every((n) => PLAIN_NAME.test(n)))) fail(where, 'dom is a list of input names, or null');
      if (!bilingual(field.label)) fail(where, 'label is needed in English and French');
      fields.set(name, { name, type: field.type, dom: field.dom, max: field.max ?? 100, label: field.label });
    }
    if (fields.size === 0) fail(id, 'a form needs fields');
    forms.set(id, { id, route: form.route, summary: form.summary, directions: form.directions ?? null, mode: form.mode ?? 'fill', waitSeconds: form.waitSeconds ?? null, checks, fields });
  }
  return { forms, currencies, doubleCheck: dc };
}

// `source` is a file path or URL, or an already parsed config object (tests).
export const loadPrefill = (source, navigation) => parseRegistry(typeof source === 'object' && !(source instanceof URL) ? source : JSON.parse(readFileSync(source, 'utf8')), navigation);

const TAG = /\[\[prefill:([^\s\]]*)[ \t]*([\s\S]*?)\]\]/gi;

// Takes every pre-fill tag out of a model reply. Only the first proposal counts.
export function parsePrefill(text) {
  const found = [...text.matchAll(TAG)].map((m) => ({ form: m[1].trim(), raw: m[2].trim() }));
  return { proposal: found[0] ?? null, text: text.replace(TAG, '').replace(/^\s+/, '') };
}

const HINT = {
  beneficiary: 'digits exactly as the customer typed them, or {"history":"<reference of one of their own past outgoing transfers>"}',
  amount: 'whole number exactly as the customer stated it',
  text: 'short text from the customer\'s own words',
  choice: 'short name the customer gave',
  reference: 'the number exactly as the customer typed it',
  account_index: 'index of their own account (0 is the first), only if they chose one',
  currency: 'currency code',
};

// The forms this customer may be offered, for the model's list. Same page rules as validatePrefill.
export function offeredForms(registry, navigation, language, entitlements) {
  return [...registry.forms.values()]
    .filter((form) => validateProposal(navigation, form.route, language, entitlements, { forPrefill: true }).ok)
    .map((form) => ({ id: form.id, fields: [...form.fields.values()].map((f) => `${f.name}: ${HINT[f.type]}`) }));
}

// ---- what the customer said ----
const numericToken = (raw) => {
  const t = raw.replace(/^[("'«[]+/, '').replace(/[)"'»\]?!,;:.]+$/, '').replace(/^\+/, '');
  if (/^\d+$/.test(t)) return t;
  if (/^\d{1,3}([.,]\d{3})+$/.test(t)) return t.replace(/[.,]/g, '');
  if (/^\d+(-\d+)+$/.test(t)) return t.replace(/-/g, '');
  return null;
};

// Every number the message can be read as: each number token alone, and each run of consecutive number tokens
// joined ("237 677 000 555"). A number inside a longer one ("99237677000555") is not among them.
function numbersIn(message) {
  const found = new Set();
  let run = [];
  const flush = () => {
    for (let i = 0; i < run.length; i++) for (let j = i, joined = ''; j < run.length; j++) { joined += run[j]; found.add(joined); }
    run = [];
  };
  for (const token of message.split(/\s+/)) {
    const n = numericToken(token);
    if (n === null) flush(); else run.push(n);
  }
  flush();
  return found;
}

const wordsIn = (message) => new Set(message.split(/\s+/).map((t) => t.replace(/^[("'«[]+/, '').replace(/[)"'»\]?!,;:.]+$/, '').toLowerCase()));

const digitsOf = (v) => String(v ?? '').replace(/\D/g, '');
// The beneficiary validator accepts at least six digits; compare equal-length identifiers only.
const oneDigitApart = (left, right) => {
  if (left.length !== right.length || left.length < 6) return false;
  let differences = 0;
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i] && ++differences > 1) return false;
  return differences === 1;
};
const recipientDigits = (row) => [row.telop, row.codewalop, row.ccpt].map(digitsOf).filter(Boolean);
const REFERENCE = /^[A-Za-z0-9\-_/.]{3,40}$/;
const HISTORY_REF = /^[A-Za-z0-9._-]{4,64}$/;
const CONTROL = /[\u0000-\u001f\u007f]|\[\[|\]\]/;

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const plainName = (v) => (/^[a-z_]{1,32}$/.test(v) ? v : null);

// Fills a summary template. "[ ... ]" parts are left out when a value in them is missing; a missing value
// outside brackets means there is no sensible summary and the caller falls back to the page name.
function summarise(template, shown) {
  let out = '';
  for (const [, optional, mandatory] of template.matchAll(/\[([^\]]*)\]|([^[]+)/g)) {
    let missing = false;
    const piece = (optional ?? mandatory).replace(/\{(\w+)\}/g, (_, key) => { if (shown[key] === undefined) missing = true; return shown[key] ?? ''; });
    if (missing && optional === undefined) return null;
    if (!missing) out += piece;
  }
  return out.replace(/\s+/g, ' ').trim();
}

// Checks one proposal. `history()` resolves to the customer's own rows, or null when they cannot be read.
// Returns { ok: true, card, audit } or { ok: false, reason, form }.
export async function validatePrefill({ registry, navigation, proposal, language, entitlements, session, message, history }) {
  const form = registry.forms.get(proposal.form);
  const drop = (reason) => ({ ok: false, reason, form: plainName(proposal.form) });
  if (!form) return drop('unknown_form');
  const page = validateProposal(navigation, form.route, language, entitlements, { forPrefill: true });
  if (!page.ok) return drop(page.reason);
  if (!session) return drop('no_session');

  let params;
  try { params = JSON.parse(proposal.raw); } catch { return drop('bad_params'); }
  if (!params || typeof params !== 'object' || Array.isArray(params)) return drop('bad_params');
  if (Object.keys(params).some((k) => !form.fields.has(k))) return drop('field_not_allowed');
  if (Object.keys(params).length === 0) return drop('empty');

  const numbers = numbersIn(message);
  const words = wordsIn(message);
  const wallet = session.wallet;
  let rows;
  const own = async () => { rows ??= { value: await history() }; return rows.value; };
  const outgoing = async () => (await own())?.filter((r) => r.codewaldo === wallet) ?? null;

  const values = new Map(); // field name -> { value (for the form), display (shown), named }
  for (const field of form.fields.values()) {
    if (!Object.hasOwn(params, field.name)) continue;
    const raw = params[field.name];
    switch (field.type) {
      case 'beneficiary': {
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
          if (Object.keys(raw).join() !== 'history' || typeof raw.history !== 'string' || !HISTORY_REF.test(raw.history)) return drop('bad_beneficiary');
          const wanted = raw.history.toLowerCase();
          const row = (await outgoing())?.find((r) => [r.clientReferenceId, r.ntrans, r.nhis].some((id) => String(id ?? '').toLowerCase() === wanted));
          const to = digitsOf(row?.telop ?? row?.codewalop);
          if (!row || !to) return drop('not_in_history');
          values.set(field.name, { value: to, display: maskPhone(to), named: false });
        } else {
          const digits = typeof raw === 'string' || typeof raw === 'number' ? digitsOf(String(raw).replace(/^\+/, '')) : '';
          if (!/^\d{6,20}$/.test(digits) || !/^\+?[\d\s.-]+$/.test(String(raw))) return drop('bad_beneficiary');
          if (!numbers.has(digits)) return drop('not_named');
          values.set(field.name, { value: digits, display: maskPhone(digits), named: true });
        }
        break;
      }
      case 'amount': {
        const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d{1,12}$/.test(raw) ? Number(raw) : NaN;
        if (!Number.isSafeInteger(n) || n < 1 || n > 999_999_999_999) return drop('bad_amount');
        if (!numbers.has(String(n))) return drop('amount_not_stated');
        values.set(field.name, { value: String(n), number: n });
        break;
      }
      case 'text':
      case 'choice': {
        const text = typeof raw === 'string' ? raw.trim() : '';
        const ok = field.type === 'text' ? text.length >= 1 && text.length <= field.max && !CONTROL.test(text) : /^[\p{L}\p{N} .&'_-]{1,40}$/u.test(text);
        if (!ok) return drop('bad_value');
        if (shield(text).flagged) return drop('secret_like_value');
        values.set(field.name, { value: text, display: text });
        break;
      }
      case 'reference': {
        if (typeof raw !== 'string' || !REFERENCE.test(raw)) return drop('bad_value');
        if (shield(raw).flagged) return drop('secret_like_value');
        const digits = /^\d+$/.test(raw) ? raw : null;
        if (!(digits ? numbers.has(digits) : words.has(raw.toLowerCase()))) return drop('not_named');
        values.set(field.name, { value: raw, display: raw });
        break;
      }
      case 'account_index': {
        const account = Number.isInteger(raw) ? session.accounts[raw] : undefined;
        const masked = account && maskAccount(account.accountNo);
        if (!masked) return drop('bad_account');
        values.set(field.name, { value: String(account.accountNo), display: masked, currency: account.dev });
        break;
      }
      case 'currency': {
        if (typeof raw !== 'string' || !registry.currencies.includes(raw)) return drop('bad_currency');
        values.set(field.name, { value: raw, display: raw });
        break;
      }
    }
  }

  const amount = [...values.entries()].find(([name]) => form.fields.get(name).type === 'amount')?.[1];
  const sourceCurrency = [...values.values()].find((v) => v.currency)?.currency;
  const currency = values.get('currency')?.value ?? (registry.currencies.includes(sourceCurrency) ? sourceCurrency : registry.currencies[0]);
  if (amount) amount.display = `${amount.number} ${currency}`;

  // A non-blocking line: only text on the card, never an extra step.
  const named = [...values.entries()].find(([name, v]) => form.fields.get(name).type === 'beneficiary' && v.named)?.[1];
  const cfg = registry.doubleCheck;
  let doubleCheck = false;
  if (named && form.checks.includes('newBeneficiary')) {
    const sent = await outgoing();
    // history that cannot be read cannot vouch that the beneficiary is known
    const known = sent?.some((r) => recipientDigits(r).includes(named.value)) ?? false;
    doubleCheck = sent === null || !known;
    if (!doubleCheck) {
      doubleCheck = sent.some((r) => recipientDigits(r).some((digits) => digits !== named.value && oneDigitApart(named.value, digits)));
    }
  }
  if (amount && form.checks.includes('largeAmount') && !doubleCheck) {
    const sent = await outgoing();
    const repeated = named && (sent ?? []).some((r) => recipientDigits(r).includes(named.value) && Number(r.mtrans) === amount.number);
    if (repeated || amount.number >= cfg.largeAmount) doubleCheck = true;
    else {
      const amounts = (sent ?? []).map((r) => Number(r.mtrans)).filter((n) => n > 0);
      doubleCheck = amounts.length >= cfg.minHistory && amount.number > cfg.usualMultiple * median(amounts);
    }
  }

  const shown = Object.fromEntries([...values].filter(([, v]) => v.display !== undefined).map(([name, v]) => [name, v.display]));
  const beneficiaryField = [...values.keys()].find((name) => form.fields.get(name).type === 'beneficiary');
  const fields = [...values].filter(([name]) => form.fields.get(name).dom !== null).map(([name, v]) => ({
    field: name, dom: form.fields.get(name).dom, label: form.fields.get(name).label[language] ?? form.fields.get(name).label.en,
    value: v.value, display: v.display ?? v.value,
  }));
  const card = {
    kind: 'prefill',
    form: form.id,
    target: form.route,
    path: page.card.path,
    title: page.card.label,
    summary: summarise(form.summary[language] ?? form.summary.en, shown) ?? page.card.label,
    beneficiary: beneficiaryField ? values.get(beneficiaryField).display : null,
    amount: amount ? { value: amount.number, currency } : null,
    doubleCheck: doubleCheck ? cfg.text[language] ?? cfg.text.en : null,
    // Fixed text from the config, for a form behind several choices; and how long the widget waits for its inputs.
    directions: form.directions ? form.directions[language] ?? form.directions.en : null,
    mode: form.mode,
    waitMs: form.waitSeconds ? form.waitSeconds * 1000 : null,
    button: page.card.button,
    fields,
  };
  return { ok: true, card, audit: { outcome: 'offered', form: form.id, fields: [...values.keys()], doubleCheck } };
}
