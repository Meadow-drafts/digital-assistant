// T1 reads: the only data the assistant reads about the customer. Fixed named
// tools, ids fixed once per conversation from the client-info endpoint with the
// customer's own token, masking at one point, entitlement gating in code.
// Read-only: every gateway call below is a lookup.
import { UnknownTenantError } from './gateway.js';
import { subjectOf } from './identity.js';
import { classify } from './explain.js';

const ETAB = '001';
const MAX_ROWS = 20;
const REFERENCE = /^[A-Za-z0-9._-]{4,64}$/;
export const UNLOCK_MS = 5 * 60_000;
const PIN_HASH = /^[0-9a-f]{128}$/;
const STATUS = { 1: 'success', 100: 'failed', 1000: 'pending' };

export const MESSAGES = {
  session_expired: {
    en: 'Your session has expired. Please sign in again, then ask me again.',
    fr: 'Votre session a expiré. Veuillez vous reconnecter, puis me poser à nouveau la question.',
  },
  not_in_package: {
    en: 'That is not included in your package, so I will not look it up.',
    fr: "Cela n'est pas inclus dans votre forfait, donc je ne vais pas le consulter.",
  },
  rejected: {
    en: 'I can only look up your last transactions, the status of a transfer by its reference, and fees and limits.',
    fr: "Je peux seulement consulter vos dernières transactions, l'état d'un transfert grâce à sa référence, ainsi que les frais et limites.",
  },
  unavailable: {
    en: 'I cannot reach your bank data right now. Please try again in a moment, or talk to a human agent.',
    fr: 'Je ne peux pas accéder à vos données bancaires pour le moment. Réessayez dans un instant, ou parlez à un agent.',
  },
  pin_required: {
    en: 'To show your balance I need your PIN. Please enter it in the PIN box, never in this chat.',
    fr: 'Pour afficher votre solde, j\'ai besoin de votre PIN. Saisissez-le dans la zone PIN, jamais dans ce chat.',
  },
  primary_only: {
    en: 'Account history is for the primary connect only, so I can show only the transactions of this wallet.',
    fr: "L'historique du compte est réservé à la connexion principale, je ne peux donc afficher que les transactions de ce portefeuille.",
  },
};

// ---- masking: the single point where identifiers are hidden ----
const digits = (v) => String(v ?? '').replace(/\D/g, '');
export const maskAccount = (v) => (digits(v).length >= 4 ? `****${digits(v).slice(-4)}` : null);
export const maskPhone = (v) => (digits(v).length >= 4 ? `******${digits(v).slice(-3)}` : null);
export const initials = (name) => String(name ?? '').trim().split(/\s+/).filter(Boolean).map((w) => `${[...w][0].toUpperCase()}.`).join(' ') || null;

function dateOf(v) {
  if (typeof v === 'number') return new Date(v).toISOString().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}/.exec(String(v ?? ''))?.[0] ?? null;
}

// Leg statuses are StatusCode strings in the backend: 01 success, 100 failed, 1000 pending, 200 not started.
const LEG = { '01': 'success', 100: 'failed', 1000: 'pending', 200: 'not_started' };
const leg = (v) => (v == null || v === '' ? null : LEG[String(v)] ?? 'other');

// The status record for the "explain my failure" read: the outcome fields only. Free text from the backend
// (msg) is capped and has long digit runs masked; who reversed or re-debited it is never passed on.
function statusDetail(r) {
  const msg = String(r.msg ?? '').replace(/\d{6,}/g, (d) => `****${d.slice(-4)}`).trim().slice(0, 200);
  return {
    msg: msg || null,
    msgCode: /^[A-Za-z0-9_.-]{1,20}$/.test(String(r.msgCode ?? '')) ? String(r.msgCode) : null,
    legs: { digitalBank: leg(r.digitalBankStatus), makeOperation: leg(r.makeOperationStatus), fees: leg(r.statusFees) },
    reDebited: r.reDebited === true,
    reversing: r.reversing === true,
    reversedAt: r.reversedAt ? dateOf(r.reversedAt) : null,
  };
}

const involves = (r, wallet) => r?.codewaldo === wallet || r?.codewalop === wallet;

// The table shows ntrans or nhis, not clientReferenceId, so any of the three finds a row.
const withReference = (rows, reference) => {
  const wanted = reference.toLowerCase();
  return rows.find((r) => [r.clientReferenceId, r.ntrans, r.nhis].some((id) => String(id ?? '').toLowerCase() === wanted));
};

function maskTransaction(r, wallet) {
  const out = r.codewaldo === wallet;
  return {
    reference: r.clientReferenceId ?? r.ntrans ?? null,
    date: dateOf(r.dop),
    amount: r.mtrans ?? null,
    currency: r.dev ?? null,
    direction: out ? 'out' : 'in',
    type: r.nat ?? r.top ?? null,
    status: STATUS[Number(r.sta)] ?? 'unknown',
    account: maskAccount(out ? r.dcpt : r.ccpt),
    counterparty: r.partnerlib ? initials(r.partnerlib) : maskPhone(out ? r.telop : r.teldo),
  };
}

// ---- the fixed tool list. Each takes enumerated arguments only. ----
const TOOLS = {
  last_transactions: {
    packages: ['HIST'],
    args(a) {
      const count = a.count ?? 10;
      return Number.isInteger(count) && count >= 1 && count <= MAX_ROWS ? { count } : null;
    },
    allowed: ['count'],
  },
  transfer_status: {
    allowed: ['reference'],
    args: (a) => (typeof a.reference === 'string' && REFERENCE.test(a.reference) ? { reference: a.reference } : null),
  },
  explain_failure: {
    allowed: ['reference'],
    args: (a) => (typeof a.reference === 'string' && REFERENCE.test(a.reference) ? { reference: a.reference } : null),
  },
  fees_limits: { allowed: [], args: () => ({}) },
  balance: {
    packages: ['SOLDE', 'BALA'],
    needsUnlock: true,
    allowed: ['account', 'kind'],
    args(a) {
      const account = a.account ?? 0;
      const kind = a.kind ?? 'available';
      return Number.isInteger(account) && account >= 0 && account < MAX_ROWS && ['available', 'ledger'].includes(kind) ? { account, kind } : null;
    },
  },
};

// Tool prompt text lives here beside the list it describes.
export const TOOL_RULES = 'If the user asks about their own recent transactions, the status of one transfer by its reference, or fees and limits, ' +
  'reply with ONLY one tool tag instead of guide ids: [[tool:last_transactions {"count":5}]] (count 1-20, optional), ' +
  '[[tool:transfer_status {"reference":"<reference the user gave>"}]], ' +
  '[[tool:explain_failure {"reference":"<reference the user gave>"}]] (instead of transfer_status when they ask WHY that transfer failed or did not arrive), or [[tool:fees_limits {}]], or [[tool:balance {}]] for the account balance ("kind":"ledger" only if the user asks for the ledger balance). ' +
  'Examples that need a tool tag: "what is my balance", "how much do I have", "show my balance", "quel est mon solde", "combien j\'ai sur mon compte" -> [[tool:balance {}]]; ' +
  '"my last transactions", "show my recent transactions", "mes dernières transactions" -> [[tool:last_transactions {}]]; "what are the fees and limits", "quels sont les frais et plafonds" -> [[tool:fees_limits {}]]. ' +
  'Never put account numbers, phone numbers or other ids in a tool tag.';

const TAG = /^\s*\[\[tool:([^\s\]]*)(?:\s+([\s\S]*?))?\s*\]\]/;

// Reads a leading tool tag off the router reply. Null when there is none.
export function parseToolCall(raw) {
  const m = TAG.exec(raw);
  return m ? { name: m[1], rawArgs: m[2] ?? '' } : null;
}

// Validates a call against the fixed list. Returns the clean arguments, or the reason it is rejected.
function validate(call) {
  const def = Object.hasOwn(TOOLS, call.name) ? TOOLS[call.name] : null;
  if (!def) return { reason: 'unknown_tool' };
  let args;
  try { args = call.rawArgs ? JSON.parse(call.rawArgs) : {}; } catch { return { reason: 'bad_arguments' }; }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { reason: 'bad_arguments' };
  if (Object.keys(args).some((k) => !def.allowed.includes(k))) return { reason: 'unexpected_argument' };
  const clean = def.args(args);
  return clean ? { def, args: clean } : { reason: 'bad_arguments' };
}

const CLI = /^[A-Za-z0-9._-]{1,64}$/;

class SessionExpired extends Error {}
class Rejected extends Error {}
class SessionRefused extends Error {}
class Unavailable extends Error {}

// Diagnostic for the audit when a read fails: the result code and the field NAMES only, never values.
const shape = (body) => {
  const code = body && typeof body === 'object' ? String(body.success ?? body.status ?? body.statut ?? '-').slice(0, 8) : typeof body;
  const keys = body && typeof body === 'object' ? [...Object.keys(body), ...Object.keys(body.solde && typeof body.solde === 'object' ? body.solde : {}).map((k) => `solde.${k}`)] : [];
  return `code=${code} keys=${keys.join(',')}`.replace(/[^A-Za-z0-9_.,= -]/g, '').slice(0, 160);
};

export function createT1({ gateway, clock, etab = ETAB }) {
  // What failed, for the audit: the error's code or name only (ECONNRESET, TimeoutError...), never its message.
  const why = (e) => `gateway ${String(e?.cause?.code ?? e?.code ?? e?.name ?? 'error').replace(/[^A-Za-z0-9_]/g, '').slice(0, 30)}`.trim();

  // Every call is a lookup except the PIN check, which counts attempts and passes `retry: false`. A request that
  // throws at the network level (typically a dropped idle connection) is tried once more; a timeout is not.
  async function call(tenant, token, req, { retry = true } = {}) {
    let res;
    for (let attempt = 1; !res; attempt++) {
      try { res = await gateway.request({ tenant, token, ...req }); } catch (e) {
        if (e instanceof UnknownTenantError) throw new Unavailable('tenant');
        if (!retry || attempt > 1 || e?.name === 'TimeoutError') throw new Unavailable(why(e));
      }
    }
    if (res.status === 401 || res.status === 409) throw new SessionExpired();
    if (res.status !== 200) throw new Unavailable(`http ${res.status} ${shape(res.body)}`);
    return res.body;
  }

  // Starts a session: fixes the customer's ids for the conversation. The widget
  // supplies a cli, but only as a claim. The backend's list of connects under
  // that cli must contain a row for the token's own wallet and that same cli;
  // otherwise the session is refused (fail closed). From that one row only the
  // primary-connect flag is kept: the list also holds other people's wallets,
  // names and contact details, which are dropped here and never leave this function.
  async function verify({ tenant, token, cli }) {
    const sub = token && subjectOf(token);
    if (!sub) throw new SessionExpired();
    if (typeof cli !== 'string' || !CLI.test(cli)) throw new SessionRefused('bad_cli');
    const connects = await call(tenant, token, { method: 'GET', path: `/digitalbank/clients/connects/accounts/${encodeURIComponent(cli)}` });
    if (!Array.isArray(connects?.data)) throw new Unavailable('connects');
    const own = connects.data.find((r) => r?.codewal === sub && r?.cli === cli);
    if (!own) throw new SessionRefused('wallet_mismatch');
    const primaryConnect = own.primaryConnect === true;

    // clientInfo answers { data: { cli, accounts: [...], name, email, telephones, age } }. Only the
    // cli (to compare with the claim) and the account ids are kept; everything else is dropped here.
    const info = (await call(tenant, token, { method: 'POST', path: '/digitalbank/clientInfo', body: { cli } }))?.data;
    if (!info || typeof info !== 'object') throw new Unavailable('client_info');
    if (info.cli !== cli) throw new SessionRefused('cli_mismatch');
    if (!Array.isArray(info.accounts) || info.accounts.length === 0) throw new SessionRefused('no_accounts');
    // ids only (age, accountNo, currency): the balance fields in each entry (accountBalance, availableBalance, soldeDispo,
    // historyBalance, indicativeBalance, sde, sin) and the names are dropped; balances wait for the PIN box (ticket 24)
    const accounts = info.accounts.map((a) => ({ age: a?.age, accountNo: a?.accountNo, dev: a?.dev }));
    // The contact email is kept only to write to the customer about a support case; it never reaches the model.
    const email = typeof info.email === 'string' && /^[^\s@,;<>]+@[^\s@,;<>]+$/.test(info.email) ? info.email : null;
    return Object.freeze({ cli, wallet: sub, etab, tenant, primaryConnect, email, accounts: Object.freeze(accounts) });
  }

  // Never throws: { session } on success, otherwise { code, reason } for the caller to report.
  async function start(input) {
    try { return { session: await verify(input) }; } catch (e) {
      if (e instanceof SessionExpired) return { code: 'session_expired' };
      if (e instanceof SessionRefused) return { code: 'session_refused', reason: e.message };
      return { code: 'unavailable' };
    }
  }

  // The status row for a reference, only if it is this session's wallet's. The backend looks the reference up
  // across everyone, so any other row is treated exactly like a missing one.
  async function ownStatus(session, reference, ctx) {
    const body = await call(ctx.tenant, ctx.token, {
      method: 'GET', path: '/digitalbank/history/transactions',
      query: { cli: session.cli, clientRefId: reference }, // as the portal asks
    });
    return body?.data && involves(body.data, session.wallet) ? body.data : null;
  }

  // The customer's own rows from the wallet-scoped history list, the same list the portal shows.
  async function ownRows(session, ctx) {
    const body = await call(ctx.tenant, ctx.token, {
      method: 'POST', path: '/digitalbank/history/bipay-recent', query: { wallet: session.wallet },
      body: { codewaldo: session.wallet, etab: session.etab },
    });
    if (!Array.isArray(body?.data)) throw new Unavailable('history');
    return body.data.filter((r) => involves(r, session.wallet));
  }

  const reads = {
    async balance(session, { account, kind }, ctx) {
      const acc = session.accounts[account];
      if (!acc) throw new Rejected('bad_arguments');
      const body = await call(ctx.tenant, ctx.token, {
        method: 'POST', path: '/digitalbank/getSolde',
        body: { age: acc.age, cpt: acc.accountNo, etab: session.etab, codewal: session.wallet },
      });
      const amount = body?.solde?.[kind === 'ledger' ? 'accountBalance' : 'availableBalance'];
      if (body?.success !== '01' || typeof amount !== 'number') throw new Unavailable(`balance ${shape(body)} amount=${typeof amount}`);
      return { balances: [{ account: maskAccount(acc.accountNo), kind, amount, currency: acc.dev ?? null }] };
    },
    async last_transactions(session, { count }, ctx) {
      const own = await ownRows(session, ctx);
      own.sort((a, b) => String(dateOf(b.dop)).localeCompare(String(dateOf(a.dop))));
      return { transactions: own.slice(0, count).map((r) => maskTransaction(r, session.wallet)) };
    },
    async transfer_status(session, { reference }, ctx) {
      const found = await ownStatus(session, reference, ctx);
      return found ? { found: true, transaction: maskTransaction(found, session.wallet) } : { found: false, reference };
    },
    async explain_failure(session, { reference }, ctx) {
      // The table shows ntrans or nhis, not clientReferenceId, so any of the three finds it. Only the customer's own
      // list is searched: the by-reference endpoint can take 15 s or more and would answer differently for
      // someone else's reference than for an unknown one.
      const found = withReference(await ownRows(session, ctx), reference);
      if (!found) return { found: false, reference, outcome: 'not_found' };
      const transaction = { ...maskTransaction(found, session.wallet), reference }; // the id the customer can see
      const detail = statusDetail(found);
      return { found: true, reference, transaction, detail, outcome: classify({ status: transaction.status, detail }) };
    },
    async fees_limits(session, _args, ctx) {
      const body = await call(ctx.tenant, ctx.token, { method: 'GET', path: '/digitalbank/plafond/montant', query: { etab: session.etab } });
      const rows = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : null;
      if (!rows) throw new Unavailable('limits');
      const scalar = (r) => Object.fromEntries(Object.entries(r ?? {}).filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v)));
      // bank-wide ceilings per nature, not this customer's own limits
      return { bankLimits: rows.slice(0, MAX_ROWS).map(scalar), scope: 'bank-wide ceilings per transaction nature; not a personal limit' };
    },
  };

  // Runs one tool call for a conversation. Never throws: the outcome is either
  // { kind: 'data', ... } for the model to explain, or { kind: 'fixed', ... },
  // a fixed customer message with the reason it was not run.
  async function run({ call: toolCall, conversation, token, entitlements }) {
    const checked = validate(toolCall);
    if (!checked.def) return { kind: 'fixed', code: 'rejected', reason: checked.reason, name: String(toolCall.name).replace(/[^a-z_]/g, '').slice(0, 40) };
    const { def, args } = checked;
    const required = def.packages;
    if (entitlements?.packages && required && !required.some((p) => entitlements.packages.includes(p))) {
      return { kind: 'fixed', code: 'not_in_package', name: toolCall.name };
    }
    try {
      const { session } = conversation;
      if (!session) throw new SessionExpired(); // no verified session yet: the customer has to start one
      if (def.needsUnlock && !(conversation.unlock?.until > clock.now())) return { kind: 'fixed', code: 'pin_required', name: toolCall.name };
      const result = await reads[toolCall.name](session, args, { tenant: session.tenant, token });
      const notice = toolCall.name === 'last_transactions' && entitlements && !entitlements.primaryConnect ? 'primary_only' : null;
      return { kind: 'data', name: toolCall.name, args, result, notice };
    } catch (e) {
      if (e instanceof Rejected) return { kind: 'fixed', code: 'rejected', reason: e.message, name: toolCall.name };
      if (e instanceof SessionExpired) {
        conversation.session = null; // ids end with the token; a new session needs the refreshed token
        conversation.unlock = null; // and so does any balance unlock
        return { kind: 'fixed', code: 'session_expired', name: toolCall.name };
      }
      return { kind: 'fixed', code: 'unavailable', name: toolCall.name, ...(e instanceof Unavailable ? { reason: e.message } : {}) };
    }
  }

  const grant = (conversation) => { conversation.unlock = { until: clock.now() + UNLOCK_MS }; };

  // Balance unlock, path 1: the portal already checked the PIN after login and keeps the flag
  // isBalancePinVerified = "1" (with isBalancePinVerified:tel) in sessionStorage. The widget passes it on.
  // This is a CLIENT CLAIM only: anyone can set sessionStorage, and the backend returns balances to any
  // valid token. It is a UX safeguard, not a security control. The only check here is that the phone the
  // flag was set for is the session's own wallet.
  function unlockWithPortalFlag(conversation, flag) {
    const ok = flag?.verified === '1' && digits(flag.tel) !== '' && digits(flag.tel) === digits(conversation.session.wallet);
    if (ok) grant(conversation);
    return ok;
  }

  // Balance unlock, path 2: the widget's own PIN box. The widget has already hashed the PIN (SHA-512 hex,
  // as the portal does); the hash goes straight to the PIN-check endpoint for the session's own phone and
  // is not stored, logged or shown to the model. Returns { ok } | { error, attemptsLeft? }.
  async function unlockWithPin(conversation, token, pinHash) {
    if (typeof pinHash !== 'string' || !PIN_HASH.test(pinHash)) return { error: 'bad_request' };
    const { session } = conversation;
    let body;
    try { body = await call(session.tenant, token, { method: 'POST', path: '/digitalbank/checkPin', body: { pin: pinHash, tel: session.wallet } }, { retry: false }); } catch (e) {
      if (e instanceof SessionExpired) { conversation.session = null; conversation.unlock = null; return { error: 'session_expired' }; }
      return { error: 'unavailable' };
    }
    if (body?.success === '01') { grant(conversation); return { ok: true }; }
    if (body?.success === '02') return { error: 'pin_wrong', attemptsLeft: Number.isFinite(Number(body.data)) ? Number(body.data) : null };
    if (body?.success === '101') return { error: 'pin_blocked' };
    return { error: 'unavailable' };
  }

  // The customer's own history rows for the pre-fill checks (known beneficiary, usual amount, a chosen past
  // recipient). The raw rows stay inside the service: never given to the model, the UI or the audit. Null when
  // they cannot be read (no session, package without history, gateway trouble), which the checks treat as unknown.
  async function ownHistory(conversation, token, entitlements) {
    const { session } = conversation;
    if (!session) return null;
    if (entitlements?.packages && !entitlements.packages.includes('HIST')) return null;
    try { return await ownRows(session, { tenant: session.tenant, token }); } catch { return null; }
  }

  // The masked record of one of the customer's own transactions, for a drafted case message, with a `scrub` that
  // hides the counterparty's name wherever the customer typed it. The real name stays in this function: only its
  // initials come out. Null when the reference is not one of the customer's own rows or history is not readable.
  async function caseTransaction(conversation, token, entitlements, reference) {
    if (typeof reference !== 'string' || !REFERENCE.test(reference)) return null;
    const rows = await ownHistory(conversation, token, entitlements);
    const found = rows && withReference(rows, reference);
    if (!found) return null;
    const words = String(found.partnerlib ?? '').split(/\s+/).filter((w) => [...w].length >= 3);
    const named = words.map((w) => new RegExp(`(?<![\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'giu'));
    return {
      transaction: { ...maskTransaction(found, conversation.session.wallet), reference },
      scrub: (text) => named.reduce((out, re) => out.replace(re, (w) => `${[...w][0].toUpperCase()}.`), text),
    };
  }

  // The customer's latest transactions, masked, for the agent who takes their case. Same wallet-scoped list and
  // history gating as every other read; null when history is not readable for this customer.
  async function recentMasked(conversation, token, entitlements, count = 5) {
    const rows = await ownHistory(conversation, token, entitlements);
    return rows ? rows.slice(0, count).map((r) => maskTransaction(r, conversation.session.wallet)) : null;
  }

  return { run, start, ownHistory, recentMasked, caseTransaction, unlockWithPortalFlag, unlockWithPin };
}
