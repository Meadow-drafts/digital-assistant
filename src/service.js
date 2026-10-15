import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { detectLanguage } from './language.js';
import { WARNING, shield } from './shield.js';
import { BUSY, LimitError, createLimiter } from './limits.js';
import { parseRefusal, refusalCard } from './refusals.js';
import { BLOCKED, createOutputFilter } from './filter.js';
import { chipState, cuesIn, parseEscalate, questionKey } from './chip.js';
import { PROTECTED_TEXTS, modelHistory, UNSUPPORTED_ID, answerMessages, dataMessages, explainMessages, routerMessages } from './prompts.js';
import { asksForUnavailable, asksToComplete, intentTool, isNavigationAsk, transferGuideIntent } from './intents.js';
import { offeredPages, parseNavigate, routeIdForPath, stepsOf, validateProposal } from './navigate.js';
import { GUIDE_ID, NEXT_STEP, OUTCOMES, TEXT as EXPLAIN_TEXT, parseNext } from './explain.js';
import { MESSAGES as T1_MESSAGES, TOOL_RULES, UNLOCK_MS, createT1, parseToolCall } from './t1.js';
import { createIdentity, guestOwnerOf, ownerOf, subjectOf, tokenOf } from './identity.js';
import { readJson } from './http.js';
import { createHandoff } from './handoff.js';
import { createConversationStore } from './conversations.js';
import { createDrafts } from './draft.js';
import { createAuditTrail, createFailedQuestionTrail } from './audit.js';
import { createRetention } from './retention.js';
import { asksAboutCurrentPage, verifiedPageContext } from './page-context.js';
import { commonVerifiedStep } from './guides.js';
import { socialKind, socialReply } from './social.js';
import { maskText } from './mask.js';

const PUBLIC = new URL('../public/', import.meta.url);
// Only these files are served; no user-controlled path ever reaches the disk.
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/widget.js': ['widget.js', 'text/javascript; charset=utf-8'],
  '/console': ['console.html', 'text/html; charset=utf-8'],
  '/console.js': ['console.js', 'text/javascript; charset=utf-8'],
};
// Dev only (TEST_TOKEN / TEST_CLI): puts a real test token and cli on the demo page's widget so a session can start.
// Never set in production; the token is written into the page, so the page must stay on localhost.
const attr = (v) => String(v).replace(/[^A-Za-z0-9._~+\/=-]/g, '');
// With portalFlag, it also sets the sessionStorage flags the portal sets after its PIN check at login (the portal's
// storage is on another origin, so the demo page cannot see it). The service still checks the phone against the session.
const devPageHtml = (html, { token, cli, portalFlag }) => {
  const sub = subjectOf(token);
  const flag = portalFlag && sub ? `<script>try{sessionStorage.setItem('isBalancePinVerified','1');sessionStorage.setItem('isBalancePinVerified:tel',${JSON.stringify(sub)})}catch{}</script>` : '';
  return html.replace('token="demo-token"', `token="${attr(token)}" cli="${attr(cli)}"`).replace('<script src="/widget.js">', `${flag}<script src="/widget.js">`);
};
function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// Answer for a session id that is present but bad or expired (never a guest).
const sessionExpired = (res) => res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'session_expired' }));

const MAX_GUIDES = 3;
const MESSAGE_ID = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_TURNS = 500;
const TURN_TTL_MS = 15 * 60_000;
const NO_VERIFIED_STEPS = {
  en: 'I have no verified steps for that in the portal guides, so I will not guess. Please use "Talk to a human agent" and they can help.',
  fr: "Je n'ai pas d'étapes vérifiées pour cela dans les guides du portail, donc je ne vais pas deviner. Utilisez « Parler à un agent » et il pourra vous aider.",
};
const GENERIC_CLOSING = {
  en: 'If this does not help, use "Talk to a human agent".',
  fr: "Si cela ne vous aide pas, utilisez « Parler à un agent ».",
};
const TRANSFER_COMPLAINT = /\b(?:sent|transferred|transfer(?:red)?|paid)\b.{0,100}\b(?:hasn['’]?t|has not|didn['’]?t|did not|never|not)\b.{0,40}\b(?:received|arrived|credited|got)\b|\b(?:ne\s+(?:l['’])?a\s+pas|n['’]?a\s+pas|pas encore)\b.{0,35}\b(?:recu|arrive|credit)\b|\b(?:envoye|transfere|paye)\b.{0,100}\b(?:pas recu|pas arrive|pas credite)\b/i;
const TRANSFER_REFERENCE = /\b(?:reference|ref|r[eé]f[eé]rence|id)\b(?=[\s:#])(?:\s+(?:is|est)\s+|\s*[:#]\s*|\s+)([A-Za-z0-9._-]{4,64})/i;
const HISTORY_HELP = {
  en: 'I’m sorry the recipient has not received it. When did you send the transfer?',
  fr: "Je suis désolé que le destinataire ne l'ait pas reçu. Quand avez-vous envoyé le transfert ?",
};
const HISTORY_REFERENCE_HELP = {
  en: 'Open History and find the row for this transfer. Copy the transaction reference shown there (for example, ntrans or nhis) and paste it here. I will check only that reference against your wallet.',
  fr: "Ouvrez Historique et repérez la ligne de ce transfert. Copiez la référence de transaction affichée (par exemple ntrans ou nhis), puis collez-la ici. Je vérifierai uniquement cette référence dans votre portefeuille.",
};
const TRANSFER_QUICK_REPLIES = {
  en: ['Where do I find the reference?', 'Check another transfer', 'Talk to an agent'],
  fr: ['Où trouver la référence ?', 'Vérifier un autre transfert', 'Parler à un agent'],
};
const findSuppliedReference = (message) => {
  const explicit = TRANSFER_REFERENCE.exec(message)?.[1];
  if (explicit) return explicit;
  const bare = /^\s*([A-Za-z0-9._-]{4,64})[.!?,;:]?\s*$/.exec(message);
  if (bare && !/[0-9_-]/.test(bare[1])) return null;
  return bare?.[1] ?? null;
};
const isTransferComplaint = (message) => TRANSFER_COMPLAINT.test(message.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, ''));

async function collect(stream) {
  let text = '';
  for await (const part of stream) text += part;
  return text;
}

// Router mode: the model sees a short index of the guides this customer may
// use and returns the ids it needs. Anything not in the index is dropped.
async function routeGuides({ model, language, available, guides, history, tools, retry = false, page = null }) {
  const index = available.map((g) => ({ id: g.id, title: g[language].title }));
  // The title names each unavailable feature (the bold lead of every bullet in UNSUPPORTED.md), so the model can
  // match "add a beneficiary" or "block my card" to it instead of to the nearest real guide.
  if (guides.unsupported) {
    const topics = [...guides.unsupported.matchAll(/^- \*\*(.+?)\.\*\*/gm)].map((m) => m[1]);
    index.push({ id: UNSUPPORTED_ID, title: `Things the portal does not offer: ${topics.join('; ')}` });
  }
  const raw = await collect(model.chat({ purpose: 'route', messages: routerMessages(index, history, { tools, retry, page }), language }));
  const routed = parseRefusal(raw);
  let decoded;
  try { decoded = JSON.parse(raw); } catch { /* keep the legacy array parser below */ }
  if (decoded && !Array.isArray(decoded) && Array.isArray(decoded.clarify)) {
    const eligible = new Set(available.map((guide) => guide.id));
    const clarify = [...new Set(decoded.clarify.filter((id) => typeof id === 'string' && eligible.has(id)))].slice(0, 3);
    return { picks: [], refusal: null, clarification: clarify, ambiguous: true };
  }
  // The model's own tool tag (with its arguments) wins. A plain own-data question (balance, recent transactions,
  // fees and limits) is otherwise decided by rules, even over a model refusal: the model has seen earlier replies
  // that mention a PIN and can wrongly refuse it as a PIN request. The rules are narrow (short, own data, no
  // failure story) and the tools only read the customer's own data.
  const modelTool = !routed.category && tools ? parseToolCall(raw) : null;
  const tool = modelTool ?? intentTool(history.at(-1)?.content);
  if (tool) return { picks: [], refusal: null, tool, toolSource: modelTool ? 'model' : 'rules' };
  if (routed.category) return { picks: [], refusal: routed.category };
  if (page && asksAboutCurrentPage(history.at(-1)?.content)) {
    const candidates = page.guides.map((guide) => guide.id);
    if (candidates.length === 1) return { picks: candidates, refusal: null };
  }
  // Features the portal does not offer are decided by rules too: the model kept picking the nearest real guide.
  if (guides.unsupported && asksForUnavailable(history.at(-1)?.content)) return { picks: [UNSUPPORTED_ID], refusal: null };
  let picks = [];
  try { picks = Array.isArray(decoded) ? decoded : JSON.parse(/\[[\s\S]*?\]/.exec(raw)?.[0] ?? '[]'); } catch { /* unparseable means no guide */ }
  const allowed = new Set(index.map((i) => i.id));
  return { picks: [...new Set(picks)].filter((id) => allowed.has(id)).slice(0, MAX_GUIDES), refusal: null };
}

// The customer is asking about the overview / dashboard (EN or FR): then, and only then, an Overview link fits.
const OVERVIEW_WORDS = /\b(overview|dashboard|home ?page|accueil|vue d.ensemble|tableau de bord)\b/i;

// References the service itself read for the customer (their own rows). Their digits can look like a phone number to
// the output filter, so the filter ignores exactly these strings.
const referencesOf = (result) => [result?.transaction?.reference, ...(result?.transactions ?? []).map((t) => t.reference)]
  .filter((r) => typeof r === 'string' && r.length >= 4);

const normalizeChoiceText = (text, language) => text.toLocaleLowerCase(language)
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export function createService({ allowedOrigins = [], devPage, model, gateway, clock, audit: auditSink, guides, navigation, scamCues, entitlements, failedQuestions, outputAllowlist, limits, mailer, agents, support, consoleUrl, retention, sessionSecret, sessionTtlMs, database }) {
  // Every audit record goes through the trail: complete fields, nothing secret-shaped stored.
  const audit = createAuditTrail({ sink: auditSink, clock });
  // Failed questions are stored masked and cut short, through one write point (the sink itself stays for the dashboard and the retention job).
  const failedTrail = failedQuestions ? createFailedQuestionTrail({ sink: failedQuestions }) : null;
  const t1 = gateway ? createT1({ gateway, clock }) : null;
  const limiter = createLimiter({ clock, limits });
  const checkOutput = createOutputFilter({ allowlist: outputAllowlist, protectedTexts: PROTECTED_TEXTS });
  // Conversations and cases are kept in memory, and also in SQLite when a database is given (ticket 62).
  const conversations = createConversationStore({ database });
  // Who is asking (ticket 38): the owner of everything a customer touches comes from the signed session id, never from the
  // raw token subject. Pseudonymous user id for the audit log and rate limits: the verified owner, else the guest's.
  const identity = createIdentity({ secret: sessionSecret, clock, ttlMs: sessionTtlMs });
  const pseudonym = (req) => { const who = identity.resolve(req); return who.owner ?? guestOwnerOf(tokenOf(req)); };
  const handoff = createHandoff({
    identity, database, clock, audit, failedQuestions, mailer, agents, support, consoleUrl, conversations, retentionMs: retention?.ms,
    model: model && limiter.track(model), // agent summaries spend the same global token budget
    // Suggested replies take the metered path: counted as requests and tokens, and not run once a global budget is used up.
    suggestions: { model, meter: (m) => limiter.meter(m), budgetHit: () => limiter.budgetHit(), checkOutput },
    recordsFor: async ({ conversation, req, tenant }) => (t1 && req ? t1.recentMasked(conversation, tokenOf(req), await entitlementsFor(req, tenant, conversation)) : null),
  });

  // Fail closed: if entitlements cannot be read, offer only guides that need
  // no package, no primary connect and fit the individual role.
  async function entitlementsFor(req, tenant, conversation) {
    if (!entitlements) return conversation?.session?.entitlements ?? null;
    const token = tokenOf(req);
    try { return await entitlements({ token, tenant }); } catch { return { packages: [], primaryConnect: false, audience: 'individual' }; }
  }

  // A turn stopped by a limit: the fixed busy message and the human chip, then done.
  // The model saw nothing (or its reply is dropped), so no customer text is audited.
  async function endBusy(req, res, { limit, conversationId, language, tenant }) {
    const text = BUSY[language];
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    send(res, 'busy', { limit, text, card: refusalCard('off_topic', language) });
    send(res, 'chip', chipState(['busy']));
    send(res, 'done', { conversationId, language, model: null, offline: false });
    await audit.append({
      time: new Date(clock.now()).toISOString(),
      user: pseudonym(req),
      tenant: tenant ?? null,
      conversationId,
      userText: '',
      replyText: text,
      language,
      guideIds: [],
      model: null,
      latencyMs: 0,
      outcome: 'limited',
      limit,
    });
    res.end();
  }

  // Session start. The widget sends the customer's cli once; the service
  // verifies it with the backend under the customer's own token and fixes the
  // ids for the conversation. Chat requests then carry only the token and the id.
  async function handleSession(req, res) {
    const reply = (status, payload) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
    let body;
    try { body = await readJson(req); } catch { reply(400, { error: 'bad_request' }); return; }
    if (!t1) { reply(404, { error: 'not_available' }); return; }
    // The owner of a verified session is derived from the token the gateway is about to accept; a conversation the same
    // token began as a guest may be taken over by it, nobody else's.
    const owner = ownerOf(tokenOf(req));
    const known = typeof body?.conversationId === 'string' ? conversations.get(body.conversationId) : undefined;
    const record = (outcome, extra = {}) => audit.append({
      time: new Date(clock.now()).toISOString(), user: owner, tenant: typeof body?.tenant === 'string' ? body.tenant.slice(0, 40) : null,
      conversationId: known ? body.conversationId : null, userText: '', replyText: '', outcome, ...extra,
    });
    if (known && known.owner !== owner && known.owner !== guestOwnerOf(tokenOf(req))) { await record('conversation_denied'); reply(404, { error: 'not_found' }); return; }
    const started = await t1.start({ tenant: body?.tenant, token: tokenOf(req), cli: body?.cli });
    if (!started.session) {
      await record(started.code, started.reason ? { reason: started.reason } : {});
      reply({ session_expired: 401, session_refused: 403, unavailable: 502 }[started.code], { error: started.code });
      return;
    }
    // Package data is supplied by the widget (no backend endpoint returns it to a customer): demo only.
    // primaryConnect is not: it comes from the backend's own row for this wallet.
    const g = body?.gating ?? {};
    // The login response keeps the package under `pack` (`package` is accepted as a fallback).
    const codes = g.pack?.natureCodes ?? g.package?.natureCodes ?? g.natureCodes;
    const entitlementsFromWidget = {
      // packages gate only when usePackages is true; then a missing list locks everything
      packages: g.usePackages === true ? (Array.isArray(codes) ? codes.filter((c) => typeof c === 'string') : []) : null,
      primaryConnect: started.session.primaryConnect,
      audience: g.audience === 'merchant' ? 'merchant' : 'individual',
    };
    const session = Object.freeze({ ...started.session, entitlements: Object.freeze(entitlementsFromWidget) });
    const conversationId = known ? body.conversationId : randomUUID();
    const conversation = known ?? { owner, history: [], language: 'en', asked: new Set(), feedback: [], session: null };
    if (conversation.owner !== owner) { conversation.owner = owner; handoff.adopt(conversationId, owner); } // began as a guest
    conversation.lastActiveAt = clock.now();
    conversation.session = session;
    conversation.unlock = null; // a new session starts with the balance locked
    conversations.set(conversationId, conversation);
    await audit.append({
      time: new Date(clock.now()).toISOString(), user: owner, tenant: session.tenant, conversationId,
      userText: '', replyText: '', outcome: 'session_started',
    });
    reply(200, { conversationId, sessionId: identity.issue(tokenOf(req)).sessionId });
  }

  // Balance unlock (ticket 24). Either the portal's PIN-verified flag (a client claim) or the widget's own
  // PIN box (a SHA-512 hash, forwarded to the PIN check and never kept). Unlocks last 5 minutes.
  async function handleUnlock(req, res) {
    const reply = (status, payload) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
    let body;
    try { body = await readJson(req); } catch { reply(400, { error: 'bad_request' }); return; }
    if (!t1) { reply(404, { error: 'not_available' }); return; }
    const who = identity.resolve(req);
    if (who.error) { reply(401, { error: who.error }); return; }
    const owner = who.owner;
    const conversation = typeof body?.conversationId === 'string' ? conversations.get(body.conversationId) : undefined;
    const record = (outcome, extra = {}) => audit.append({
      time: new Date(clock.now()).toISOString(), user: owner, tenant: conversation?.session?.tenant ?? null,
      conversationId: conversation && conversation.owner === owner ? body.conversationId : null, userText: '', replyText: '', outcome, ...extra,
    });
    if (!conversation || conversation.owner !== owner) {
      if (conversation) await record('conversation_denied');
      reply(404, { error: 'not_found' });
      return;
    }
    if (!conversation.session) { reply(401, { error: 'session_expired' }); return; }
    const granted = { unlocked: true, expiresInSeconds: UNLOCK_MS / 1000 };
    if ('pinHash' in body) {
      const result = await t1.unlockWithPin(conversation, tokenOf(req), body.pinHash);
      if (result.ok) { await record('balance_unlocked_pin'); reply(200, granted); return; }
      await record(`unlock_${result.error}`);
      const status = { bad_request: 400, pin_wrong: 403, pin_blocked: 423, session_expired: 401, unavailable: 502 }[result.error];
      reply(status, { error: result.error, ...(result.attemptsLeft !== undefined ? { attemptsLeft: result.attemptsLeft } : {}) });
      return;
    }
    if (t1.unlockWithPortalFlag(conversation, body.portalFlag)) { await record('balance_unlocked_flag'); reply(200, granted); return; }
    await record('unlock_flag_not_valid', { toolReason: t1.portalFlagProblem(conversation, body.portalFlag) });
    reply(403, { error: 'flag_not_valid' });
  }

  // Answer feedback is a small enum tied to an assistant answer in the owner's own conversation. Never accept
  // free text here: it could contain a PIN, OTP, account number or other material outside the feedback signal.
  async function handleAnswerFeedback(req, res) {
    const reply = (status, payload) => res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(payload));
    let body;
    try { body = await readJson(req); } catch { reply(400, { error: 'bad_request' }); return; }
    const who = identity.resolve(req);
    if (who.error) { reply(401, { error: who.error }); return; }
    const conversation = typeof body?.conversationId === 'string' ? conversations.get(body.conversationId) : undefined;
    if (!conversation || conversation.owner !== who.owner) { reply(404, { error: 'not_found' }); return; }
    const answerId = typeof body.answerId === 'string' && body.answerId.length <= 64 ? body.answerId : '';
    const rating = body.rating;
    if (!answerId || !['up', 'down'].includes(rating)
      || !conversation.history.some((message) => message.role === 'assistant' && message.id === answerId)) {
      reply(404, { error: 'not_found' }); return;
    }
    const at = new Date(clock.now()).toISOString();
    conversation.feedback ??= [];
    const feedback = { answerId, rating, at };
    const existing = conversation.feedback.findIndex((item) => item.answerId === answerId);
    if (existing < 0) conversation.feedback.push(feedback);
    else conversation.feedback[existing] = feedback;
    conversations.save(body.conversationId);
    await audit.append({ time: at, user: who.owner, tenant: conversation.session?.tenant ?? null,
      conversationId: body.conversationId, userText: '', replyText: '', outcome: 'answer_feedback', answerId, rating });
    reply(200, { ok: true });
  }

  // Read-only help discovery. Keep guide contents on the server and derive the
  // list from the same session entitlements used by chat before exposing titles.
  async function handleHelpTopics(req, res) {
    const reply = (status, payload) => res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(payload));
    const who = identity.resolve(req);
    if (who.error || !who.verified) { reply(401, { error: who.error ?? 'session_required' }); return; }
    if (!guides) { reply(200, { topics: [], context: null }); return; }
    const url = new URL(req.url, 'http://localhost');
    const lang = url.searchParams.get('language') === 'fr' ? 'fr' : 'en';
    const conversationId = url.searchParams.get('conversationId');
    const conversation = typeof conversationId === 'string' ? conversations.get(conversationId) : null;
    if (!conversation || conversation.owner !== who.owner || !conversation.session) { reply(404, { error: 'not_found' }); return; }
    const ent = await entitlementsFor(req, conversation.session.tenant, conversation);
    const available = guides.availableFor(ent).filter((guide) => guide.customerCatalogue);
    const topics = available.map((guide) => ({ key: guide.id, title: guide[lang].title }));
    const path = url.searchParams.get('path');
    const route = navigation && [...navigation.routes].find(([, item]) => item.path === path);
    const contextGuides = route ? available.filter((guide) => guide.route === path || guide.route?.startsWith(`${path.replace(/\/$/, '')}/`)) : [];
    const contextDescriptions = {
      overview: { en: 'See balance and recent activity guidance', fr: 'Consulter les conseils sur le solde et l’activité récente' },
      history: { en: 'Find and review your transactions', fr: 'Retrouver et consulter vos transactions' },
      account_history: { en: 'Review activity on your account', fr: 'Consulter l’activité de votre compte' },
      transfer: { en: 'Get help with making a transfer', fr: 'Obtenir de l’aide pour effectuer un transfert' },
      payments: { en: 'Get help with your payments', fr: 'Obtenir de l’aide sur vos paiements' },
      bill_payment: { en: 'Get help paying a bill', fr: 'Obtenir de l’aide pour payer une facture' },
      vouchers: { en: 'Get help finding and using vouchers', fr: 'Obtenir de l’aide pour trouver et utiliser vos bons' },
      airtime: { en: 'Get help buying airtime', fr: 'Obtenir de l’aide pour acheter du crédit téléphonique' },
      request_to_pay: { en: 'Get help with payment requests', fr: 'Obtenir de l’aide sur les demandes de paiement' },
    };
    const context = route ? {
      label: route[1].labels[lang] ?? route[1].labels.en,
      description: contextGuides.length
        ? contextDescriptions[route[0]]?.[lang] ?? (lang === 'fr' ? 'Consulter les conseils pour cette page' : 'See guidance for this page')
        : (lang === 'fr' ? 'Posez une question sur cette page' : 'Ask a question about this page'),
      topics: contextGuides.map((guide) => ({ key: guide.id, title: guide[lang].title })),
    } : null;
    reply(200, { topics, context });
  }

  // A customer may reopen only their own saved conversation. Return the masked
  // transcript and a short display preview; never expose internal state/session data.
  async function handleConversationHistory(req, res, conversationId = null) {
    const reply = (status, payload) => res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(payload));
    const who = identity.resolve(req);
    if (who.error || !who.verified) { reply(401, { error: who.error ?? 'session_required' }); return; }
    if (conversationId === null) {
      const rows = conversations.listForOwner(who.owner).map((conversation) => ({
        ...conversation,
        ...(handoff.unreadReplyFor(conversation.id, who.owner) ?? {}),
      }));
      reply(200, { conversations: rows }); return;
    }
    const conversation = conversations.get(conversationId);
    if (!conversation || conversation.owner !== who.owner || !conversation.history.some((message) => message.role === 'user')) {
      reply(404, { error: 'not_found' }); return;
    }
    reply(200, {
      id: conversationId,
      lastActiveAt: new Date(conversation.lastActiveAt ?? 0).toISOString(),
      messages: conversation.history.slice(-100).map(({ role, content }) => ({ role, text: maskText(content) })),
      truncated: conversation.history.length > 100,
    });
  }

  // Turns by owner and message id, so a retry after a dropped connection gets the same reply instead of a second run
  // (one history entry, one audit record, one rate-limit charge). Kept in memory for a short while: the bytes sent are
  // the same ones the customer already received.
  const turns = new Map();
  function recordTurn(key, res) {
    const turn = { at: clock.now(), chunks: [], waiting: new Set(), ended: false };
    turns.set(key, turn);
    if (turns.size > MAX_TURNS) turns.delete(turns.keys().next().value);
    const write = res.write.bind(res);
    const end = res.end.bind(res);
    res.write = (chunk, ...rest) => { turn.chunks.push(chunk); for (const r of turn.waiting) r.write(chunk); return write(chunk, ...rest); };
    res.end = (...args) => {
      turn.ended = true;
      // Only a turn that reached its end is worth replaying; an error or a crash is asked again.
      if (!turn.chunks.some((c) => typeof c === 'string' && c.startsWith('event: done\n'))) turns.delete(key);
      for (const r of turn.waiting) r.end();
      turn.waiting.clear();
      return end(...args);
    };
  }
  function replayTurn(key, res) {
    const turn = turns.get(key);
    if (!turn) return false;
    if (clock.now() - turn.at > TURN_TTL_MS) { turns.delete(key); return false; }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    for (const chunk of turn.chunks) res.write(chunk);
    if (turn.ended) res.end(); else {
      const removeClosed = () => turn.waiting.delete(res);
      res.once('close', removeClosed);
      turn.waiting.add(res); // still running: follow it live
    }
    return true;
  }

  async function handleChat(req, res) {
    let body;
    try { body = await readJson(req); } catch { res.writeHead(400).end(); return; }
    if (typeof body?.message !== 'string' || !body.message.trim()) { res.writeHead(400).end(); return; }

    // Everything past this point sees only the redacted text; the raw message is never stored.
    const shielded = shield(body.message);
    const message = shielded.text;
    // A conversation belongs to the customer who started it. An id the service
    // did not issue is ignored; someone else's id is refused without saying it exists.
    const who = identity.resolve(req);
    if (who.error) { sessionExpired(res); return; }
    const owner = who.owner;
    const known = typeof body.conversationId === 'string' ? conversations.get(body.conversationId) : undefined;
    if (known && known.owner !== owner) {
      await audit.append({
        time: new Date(clock.now()).toISOString(), user: owner, tenant: body.tenant ?? null, conversationId: body.conversationId,
        userText: '', replyText: '', outcome: 'conversation_denied',
      });
      res.writeHead(404).end();
      return;
    }
    // A retry carries the id of the message it repeats (ticket 50). A turn already seen is replayed, never run again.
    const turnKey = MESSAGE_ID.test(body.messageId ?? '') ? `${owner}\n${body.messageId}` : null;
    if (turnKey && replayTurn(turnKey, res)) return;
    const conversationId = known ? body.conversationId : randomUUID();
    const conversation = known ?? { owner, history: [], language: 'en', asked: new Set(), session: null };
    if (turnKey) recordTurn(turnKey, res);
    conversation.lastActiveAt = clock.now();
    const language = detectLanguage(body.message, conversation.language);
    const withAgent = known ? handoff.agentCaseFor(body.conversationId) : null;
    const social = !shielded.flagged ? socialKind(message) : null;
    if (social) {
      if (!withAgent) {
        const limit = limiter.admit(pseudonym(req), body.message.length);
        if (limit) {
          await endBusy(req, res, { limit, conversationId, language, tenant: body.tenant });
          return;
        }
      }
      const text = socialReply(social, language);
      conversation.language = language;
      conversation.history.push({ role: 'user', content: message }, { role: 'assistant', content: text });
      conversations.set(conversationId, conversation);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      send(res, 'thinking', { conversationId });
      send(res, 'delta', { text });
      send(res, 'done', { conversationId, language, model: null, offline: false });
      await audit.append({
        time: new Date(clock.now()).toISOString(),
        user: pseudonym(req),
        tenant: body.tenant ?? null,
        conversationId,
        userText: message,
        replyText: text,
        language,
        guideIds: [],
        model: null,
        latencyMs: 0,
        outcome: 'social',
      });
      res.end();
      return;
    }
    // With a human agent, non-social messages go to the agent and nothing is sent to the model.
    if (withAgent) {
      if (message.length > 1000) { res.writeHead(400).end(); return; }
      await handoff.relayToAgent(withAgent, message);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      if (shielded.flagged) send(res, 'warning', { code: 'secret_input', text: WARNING[language] });
      send(res, 'case', { state: 'with_agent', ref: withAgent.ref });
      send(res, 'done', { conversationId, language, model: null, offline: false });
      await audit.append({
        time: new Date(clock.now()).toISOString(), user: pseudonym(req), tenant: body.tenant ?? null, conversationId,
        userText: message, replyText: '', language, guideIds: [], model: null, latencyMs: 0, outcome: 'relayed_to_agent', caseRef: withAgent.ref,
      });
      res.end();
      return;
    }
    const limit = limiter.admit(pseudonym(req), body.message.length);
    if (limit) {
      await endBusy(req, res, { limit, conversationId, language, tenant: body.tenant });
      return;
    }
    const { history } = conversation;
    const chipReasons = cuesIn(message);
    const scam = scamCues?.match(message) ?? [];
    if (scam.length) chipReasons.push('scam_cue');
    const key = questionKey(message);
    if (key && conversation.asked.has(key)) chipReasons.push('repeated_question');
    if (key) conversation.asked.add(key);
    conversation.language = language;
    const pendingClarification = conversation.pendingClarification ?? null;
    history.push({ role: 'user', content: message });
    conversations.set(conversationId, conversation);

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    send(res, 'thinking', { conversationId });
    // While a case waits for an agent the bot still answers, and says so.
    const waitingCase = handoff.waitingCaseFor(conversationId);
    if (waitingCase) send(res, 'case', { state: 'waiting', ref: waitingCase.ref, automated: true });
    if (shielded.flagged) send(res, 'warning', { code: 'secret_input', text: WARNING[language] });
    for (const category of scam) send(res, 'warning', { code: 'scam_cue', category, text: scamCues.warning(category, language) });
    const startedAt = clock.now();
    let reply = '';
    let outcome = 'ok';
    let served = { model: model.name };
    const turnModel = limiter.meter(model);
    let guideIds = [];
    let refusal = null;
    let filtered = null;
    let limited = null;
    let toolAudit = null;
    let nextTag = null;
    let navigateAudit = null;
    // The model's text is held back until it has been read in full: the refusal
    // tag comes off the front before anything reaches the customer.
    const answer = async (messages, { known, navigate } = {}) => {
      let raw = '';
      for await (const text of turnModel.chat({ purpose: 'answer', messages, language, onServed: (info) => { served = info; } })) raw += text;
      const refused = parseRefusal(raw);
      const escalated = parseEscalate(refused.text);
      const nexted = parseNext(escalated.text);
      nextTag = nexted.next;
      const fillTag = /\[\[prefill:[\s\S]*?\]\]/i.test(nexted.text);
      const withoutFill = nexted.text.replace(/\[\[prefill:[\s\S]*?\]\]/gi, '');
      const navigated = parseNavigate(withoutFill);
      const parsed = { category: refused.category, text: fillTag && navigate?.guided ? (navigate.fallback || NO_VERIFIED_STEPS[language]) : navigated.text };
      let overrode = null;
      // A guide was picked for a task and the answer still refused it as "execute": over-refusal. The assistant never
      // executes anything either way, so the customer gets the guide's steps (and the page link) unless they asked the
      // assistant itself to complete or approve it.
      if (parsed.category === 'execute' && navigate?.guided && navigated.proposal === null && !asksToComplete(message)) {
        overrode = 'execute';
        parsed.category = null;
        parsed.text = navigate.fallback || NO_VERIFIED_STEPS[language];
      }
      // A navigation proposal is checked before it is shown. If it is dropped, the reply uses verified guide steps.
      let card = null;
      let checkedProposal = null;
      if (navigate && navigated.proposal !== null && !parsed.category) {
        const checked = validateProposal(navigation, navigated.proposal, language, navigate.entitlements);
        const plain = /^[a-z_]{1,32}$/.test(navigated.proposal) ? navigated.proposal : null;
        if (checked.ok) {
          // A valid tag. The model sometimes writes Overview for everything, so unless the customer asked to be taken
          // somewhere, the page the guide itself is about wins over a different page, and Overview is only linked when
          // it was asked for.
          const guidePage = navigate.guideRoutes?.map((r) => routeIdForPath(navigation, r)).find(Boolean) ?? null;
          let swap = null;
          if (!isNavigationAsk(message)) {
            if (guidePage && navigated.proposal !== guidePage) swap = guidePage;
            else if (!guidePage && navigated.proposal === 'overview' && !OVERVIEW_WORDS.test(message)) swap = 'none';
          }
          const swapped = swap && swap !== 'none' ? validateProposal(navigation, swap, language, navigate.entitlements) : null;
          if (swap === null) {
            card = checked.card;
            checkedProposal = { outcome: 'offered', proposal: plain };
          } else if (swapped?.ok) {
            card = swapped.card;
            checkedProposal = { outcome: 'offered', proposal: swap, source: 'guide', replaced: plain };
          } else {
            checkedProposal = { outcome: 'ignored', proposal: plain };
          }
        } else {
          checkedProposal = { outcome: 'dropped', reason: checked.reason, proposal: plain };
          parsed.text = navigate.fallback || NO_VERIFIED_STEPS[language];
        }
      }
      // The model did not add a link, or its link was dropped: the page the guide itself is about gets one, so the
      // link never depends on the model remembering a tag.
      if (navigate && !card && !parsed.category && !refusal && navigate.guideRoutes?.length && !checkedProposal) {
        const id = navigate.guideRoutes.map((r) => routeIdForPath(navigation, r)).find(Boolean);
        const checked = id ? validateProposal(navigation, id, language, navigate.entitlements) : null;
        if (checked?.ok) {
          card = checked.card;
          checkedProposal = { outcome: 'offered', proposal: id, source: 'guide' };
        } else if (id) {
          // The guide's page cannot be linked for this customer (package, audience or primary connect): say why in the audit.
          checkedProposal = { outcome: 'none', proposal: id, source: 'guide', reason: checked?.reason ?? 'not_available' };
        }
      }
      if (escalated.reason) chipReasons.push(escalated.reason);
      const leak = checkOutput(parsed.text, { known, typed: message });
      if (leak) {
        filtered = leak;
        chipReasons.push('blocked');
        reply += BLOCKED[language];
        send(res, 'delta', { text: BLOCKED[language] });
        send(res, 'blocked', { reason: leak, card: refusalCard('off_topic', language) });
        return;
      }
      refusal = parsed.category ?? refusal;
      if (overrode) checkedProposal = { ...(checkedProposal ?? { outcome: 'none' }), overrodeRefusal: overrode };
      navigateAudit = checkedProposal;
      // The link comes first ("click here"), the steps below it.
      if (card && !refusal) send(res, 'action_card', card);
      reply += parsed.text;
      send(res, 'delta', { text: parsed.text });
    };
    // Explain my failure: the transfer's status data and the failed-transfer guide only. Only a plain "failed"
    // record is worded by the model; every other outcome is fixed text. Whatever happens, the explanation ends
    // with exactly one next step, and a human next step makes the chip prominent.
    const explain = async ({ result }, material, ent) => {
      const { outcome } = result;
      const { reference } = result; // as the customer typed it: the id they can see, not clientReferenceId
      const t = result.transaction;
      const d = result.detail;
      let next = OUTCOMES[outcome]?.next ?? null;
      const guidedTransfer = conversation.transferSupport?.stage === 'checking';
      if (guidedTransfer && outcome === 'succeeded') next = 'human';
      if (guidedTransfer && outcome === 'not_found') {
        conversation.transferSupport.attempts += 1;
        conversation.transferSupport.stage = conversation.transferSupport.attempts > 1 ? 'result' : 'reference';
        next = conversation.transferSupport.attempts > 1 ? 'human' : 'history';
      }
      // The history step is the navigate card for History, so it follows the same package and connect rules. Where the
      // page is not offered the step (and any wording that points to it) becomes the human one.
      const historyPage = next === 'history' && navigation ? validateProposal(navigation, 'history', language, ent) : null;
      const historyOpen = historyPage?.ok === true;
      if (next === 'history' && !historyOpen) next = 'human';
      if (outcome !== 'not_found') {
        guideIds = [GUIDE_ID];
        send(res, 'guides', { guides: [{ id: GUIDE_ID, title: material.title }] });
      }
      if (outcome === 'failed') {
        await answer(explainMessages(material.text, JSON.stringify({ transaction: t, detail: d }), history), { known: [reference] });
        next = nextTag === 'retry' ? 'retry' : 'human';
        if (next === 'human') chipReasons.push('contact_bank');
      } else {
        let text = outcome === 'not_found' ? EXPLAIN_TEXT.not_found[language](reference, historyOpen) : EXPLAIN_TEXT[outcome][language](t, d, historyOpen);
        if (guidedTransfer && outcome === 'succeeded') text = language === 'fr'
          ? `Le relevé de la banque indique que le transfert ${t.reference} est terminé. Ce statut seul ne confirme pas que le compte du destinataire a été crédité. Demandez au destinataire de vérifier son compte ; si le transfert manque toujours, un agent peut vous aider.`
          : `The bank's record reports transfer ${t.reference} as completed. That status alone does not confirm that the recipient's account was credited. Ask the recipient to check their account; if it is still missing, a human agent can help.`;
        reply += text;
        send(res, 'delta', { text });
        if (OUTCOMES[outcome].chip) chipReasons.push(OUTCOMES[outcome].chip);
      }
      if (guidedTransfer && outcome !== 'not_found') conversation.transferSupport.stage = 'result';
      // a refusal or a blocked reply already carries its own fixed next-step card
      if (refusal || filtered) return;
      if (guidedTransfer && next === 'human' && !chipReasons.includes('contact_bank')) chipReasons.push('contact_bank');
      const text = `\n\n${NEXT_STEP[next][language](reference)}`;
      reply += text;
      send(res, 'delta', { text });
      send(res, 'next_step', { kind: next, ...(historyOpen ? { target: 'history', card: historyPage.card } : {}), text: text.trim() });
      if (guidedTransfer) send(res, 'quick_replies', { options: TRANSFER_QUICK_REPLIES[language] });
    };
    try {
      if (guides) {
        const ent = await entitlementsFor(req, body.tenant, conversation);
        const available = guides.availableFor(ent);
        const page = verifiedPageContext(body.pageContext, { navigation, availableGuides: available, language, now: clock.now() });
        const pendingTransfer = conversation.transferSupport ?? null;
        const complaint = isTransferComplaint(message);
        let transferReply = null;
        let transferTool = null;
        if (complaint && !pendingTransfer) conversation.transferSupport = { stage: 'timing', attempts: 0 };
        let transfer = conversation.transferSupport;
        const selectionText = message.normalize('NFD').replace(/\p{Diacritic}/gu, '');
        const findReferenceRequest = /where do i find (?:the )?reference|where is (?:the )?reference|ou trouver la reference|ou se trouve la reference/i.test(selectionText);
        const anotherTransfer = /check another transfer|another transfer|verifier un autre transfert|autre transfert/i.test(selectionText);
        if (transfer?.stage === 'result') {
          if (complaint) conversation.transferSupport = transfer = { stage: 'timing', attempts: 0 };
          else if (findReferenceRequest || anotherTransfer) transfer.stage = 'reference';
          else { delete conversation.transferSupport; transfer = null; }
        }
        if (transfer) {
          const suppliedReference = findSuppliedReference(message);
          if (suppliedReference) {
            transferTool = { name: 'explain_failure', rawArgs: JSON.stringify({ reference: suppliedReference }) };
            transfer.stage = 'checking';
          } else if (transfer.stage === 'timing') {
            transfer.stage = 'reference';
            transferReply = HISTORY_REFERENCE_HELP[language];
          } else if (anotherTransfer || findReferenceRequest) {
            transfer.stage = 'reference';
            transferReply = HISTORY_REFERENCE_HELP[language];
          } else {
            transferReply = HISTORY_REFERENCE_HELP[language];
          }
          if (complaint && !pendingTransfer) transferReply = HISTORY_HELP[language];
        }
        const requestedGuide = typeof body.guideKey === 'string' ? available.find((guide) => guide.id === body.guideKey && guide.customerCatalogue) : null;
        const selected = requestedGuide ?? pendingClarification?.guideIds
          .map((id) => available.find((guide) => guide.id === id))
          .find((guide) => guide && normalizeChoiceText(guide[language].title, language) === normalizeChoiceText(message, language));
        let routed = transferTool
          ? { picks: [], refusal: null, tool: transferTool, toolSource: 'customer_reference' }
          : transferReply
            ? { picks: [], refusal: null }
            : selected
              ? { picks: [selected.id], refusal: null }
              : await routeGuides({ model: turnModel, language, available, guides, history, tools: t1 ? TOOL_RULES : '', page });
        // Common account-transfer and vague help phrasing was model-routed inconsistently.
        // Resolve it after the model has had a chance to refuse unsafe asks.
        if (!transferTool && !transferReply && !selected && routed.refusal === 'execute' && !asksToComplete(message)) {
          routed = await routeGuides({ model: turnModel, language, available, guides, history, tools: t1 ? TOOL_RULES : '', retry: true, page });
        }
        if (!transferTool && !transferReply && !selected && !routed.tool && (!routed.refusal || routed.refusal === 'execute' && !asksToComplete(message))) {
          routed = transferGuideIntent(message, available) ?? routed;
        }
        let askClarification = false;
        if (routed.ambiguous) {
          if (pendingClarification) {
            // One follow-up is the limit; a second unresolved response can use only an exact shared guide step.
            conversation.pendingClarification = null;
            const candidates = pendingClarification.guideIds.map((id) => available.find((guide) => guide.id === id)).filter(Boolean);
            const common = candidates.length === pendingClarification.guideIds.length ? commonVerifiedStep(candidates, language) : null;
            routed = { picks: [], refusal: null, ...(common ? { commonGuidance: common, commonGuideIds: candidates.map((guide) => guide.id) } : {}) };
          } else if (routed.clarification.length >= 2) {
            askClarification = true;
            conversation.pendingClarification = { guideIds: routed.clarification };
          }
        } else if (pendingClarification) conversation.pendingClarification = null;
        const { picks } = routed;
        refusal = routed.refusal;
        if (askClarification) {
          const question = language === 'fr' ? 'Vous cherchez des informations sur quel sujet ?' : 'What would you like help with?';
          const options = conversation.pendingClarification.guideIds
            .map((id) => available.find((guide) => guide.id === id))
            .filter(Boolean)
            .map((guide) => guide[language].title);
          reply = question;
          send(res, 'guides', { guides: [] });
          send(res, 'clarification', { question, options });
        } else if (transferReply) {
          let text = transferReply;
          const canNavigate = navigation ? validateProposal(navigation, 'history', language, ent) : null;
          if (transfer.stage === 'reference' && !canNavigate?.ok) {
            text = language === 'fr'
              ? 'Je ne peux pas ouvrir Historique pour votre profil. Utilisez « Parler à un agent » pour obtenir de l’aide.'
              : 'History is not available for your profile. Use “Talk to a human agent” for help.';
            chipReasons.push('contact_bank');
          }
          reply += text;
          send(res, 'delta', { text });
          if (transfer.stage === 'reference' && canNavigate?.ok) send(res, 'action_card', canNavigate.card);
          if (transfer.stage === 'reference') send(res, 'quick_replies', { options: canNavigate?.ok
            ? TRANSFER_QUICK_REPLIES[language]
            : [TRANSFER_QUICK_REPLIES[language][2]] });
          send(res, 'guides', { guides: [] });
        } else if (routed.tool) {
          // Without a gateway there is no session to read from: the customer is told to sign in, never that no guide matched.
          const guidedTransferLocked = conversation.transferSupport?.stage === 'checking' && ent?.packages && !ent.packages.includes('HIST');
          const done = guidedTransferLocked
            ? { kind: 'fixed', code: 'not_in_package', name: routed.tool.name }
            : t1 ? await t1.run({ call: routed.tool, conversation, token: tokenOf(req), entitlements: ent }) : { kind: 'fixed', code: 'session_expired', name: routed.tool.name };
          if (done.kind === 'data') {
            const masked = JSON.stringify(done.result);
            toolAudit = { name: done.name, args: done.args, outcome: 'ok', data: masked, source: routed.toolSource };
            send(res, 'tool', { name: done.name, result: done.result, ...(done.display ? { display: done.display, language } : {}) });
            // A drafted case message about "that transfer" needs to know which one the customer was asking about.
            if (['transfer_status', 'explain_failure'].includes(done.name) && done.result.found) conversation.lastReference = done.result.transaction.reference;
            if (done.name === 'explain_failure') await explain(done, guides.get(GUIDE_ID)[language], ent);
            else await answer(dataMessages(masked, history, { tabled: Boolean(done.display) }), { known: referencesOf(done.result) });
            if (done.notice && !filtered) {
              const text = `\n\n${T1_MESSAGES[done.notice][language]}`;
              reply += text;
              send(res, 'delta', { text });
            }
          } else {
            const text = guidedTransferLocked
              ? language === 'fr' ? 'La consultation du statut nécessite l’accès à Historique. Utilisez « Parler à un agent » pour obtenir de l’aide.' : 'Checking a transfer needs History access. Use “Talk to a human agent” for help.'
              : T1_MESSAGES[done.code][language];
            toolAudit = { name: done.name, outcome: done.code, source: routed.toolSource, ...(done.reason ? { reason: done.reason } : {}) };
            outcome = done.code === 'rejected' ? 'tool_rejected' : done.code;
            reply += text;
            send(res, 'tool_blocked', { code: done.code, text });
            send(res, 'delta', { text });
            if (!['session_expired', 'pin_required'].includes(done.code)) chipReasons.push(`tool_${done.code}`);
            if (guidedTransferLocked) chipReasons.push('contact_bank');
            if (conversation.transferSupport?.stage === 'checking') {
              conversation.transferSupport.stage = 'result';
              const next = 'human';
              const nextText = language === 'fr'
                ? 'Prochaine étape : réessayez la vérification plus tard ou utilisez « Parler à un agent » pour obtenir de l’aide.'
                : 'Next step: try the check again later or use “Talk to an agent” for help.';
              reply += `\n\n${nextText}`;
              send(res, 'next_step', { kind: next, text: nextText });
              send(res, 'quick_replies', { options: TRANSFER_QUICK_REPLIES[language] });
            }
          }
        } else {
          const used = picks.filter((id) => id !== UNSUPPORTED_ID).map((id) => guides.get(id));
          guideIds = used.map((g) => g.id);
          send(res, 'guides', { guides: used.map((g) => ({ id: g.id, title: g[language].title })) });
          if (picks.length === 0 && routed.commonGuidance && !refusal) {
            guideIds = routed.commonGuideIds;
            send(res, 'guides', { guides: routed.commonGuideIds.map((id) => guides.get(id)).filter(Boolean).map((guide) => ({ id: guide.id, title: guide[language].title })) });
            const text = language === 'fr'
              ? `Un point commun à ces options :\n\n- ${routed.commonGuidance}`
              : `One step shared by these options:\n\n- ${routed.commonGuidance}`;
            reply += text;
            send(res, 'delta', { text });
          } else if (picks.length === 0 && !refusal) {
            chipReasons.push('no_guide_hit');
            reply += NO_VERIFIED_STEPS[language];
            send(res, 'delta', { text: NO_VERIFIED_STEPS[language] });
            await failedTrail?.append({ time: new Date(clock.now()).toISOString(), conversationId, tenant: body.tenant ?? null, language, question: message });
          } else {
            const material = picks.map((id) => guides.get(id)?.[language] ?? null).filter(Boolean);
            // An answer from the unsupported list has no task page: the model is offered no links and none can be drawn.
            const linkable = navigation && used.length > 0 && page?.surface !== 'my-cases';
            await answer(answerMessages(material, picks.includes(UNSUPPORTED_ID) ? guides.unsupported : '', history, linkable ? offeredPages(navigation, language, ent) : [], page), {
              navigate: linkable ? { fallback: stepsOf(material[0]?.text ?? ''), entitlements: ent, guided: used.length > 0, guideRoutes: used.map((g) => g.route).filter(Boolean) } : null,
            });
            const closing = used.find((g) => g[language].closing)?.[language].closing;
            if (!refusal && !filtered) {
              const text = closing ? `\n\n${closing.heading}${language === 'fr' ? ' :' : ':'} ${closing.body}` : `\n\n${GENERIC_CLOSING[language]}`;
              reply += text;
              send(res, 'delta', { text });
            }
          }
        }
      } else {
        await answer(modelHistory(history));
      }
      if (refusal) send(res, 'refusal', { category: refusal, card: refusalCard(refusal, language) });
      if (refusal) chipReasons.push('refusal');
      send(res, 'chip', chipState(chipReasons));
      const answerId = randomUUID();
      history.push({ role: 'assistant', content: reply, id: answerId });
      conversations.save(conversationId);
      send(res, 'done', { conversationId, answerId, language: served.offline ? 'en' : language, model: served.model, offline: Boolean(served.offline) });
    } catch (err) {
      if (err instanceof LimitError) {
        limited = err.limit;
        reply = BUSY[language];
        send(res, 'busy', { limit: limited, text: reply, card: refusalCard('off_topic', language) });
        send(res, 'chip', chipState([...chipReasons, 'busy']));
        send(res, 'done', { conversationId, language, model: served.model, offline: false });
      } else {
        outcome = 'error';
        send(res, 'error', { code: 'model_unavailable' });
      }
    }
    if (waitingCase) handoff.mirrorTurn(waitingCase, message, reply);
    await audit.append({
      time: new Date(clock.now()).toISOString(),
      user: pseudonym(req),
      tenant: body.tenant ?? null,
      conversationId,
      userText: message,
      replyText: reply,
      language,
      guideIds,
      model: served.model,
      latencyMs: clock.now() - startedAt,
      outcome: limited ? 'limited' : filtered ? 'filtered' : outcome,
      ...(limited ? { limit: limited } : {}),
      // A turn is admitted under the daily budget and runs to its end; when its own calls took the total over, say by how much.
      ...(limiter.dailyTokens() > limiter.cfg.tokensPerDay ? { tokenOvershoot: limiter.dailyTokens() - limiter.cfg.tokensPerDay } : {}),
      ...(filtered ? { filter: filtered } : {}),
      ...(refusal ? { refusalCategory: refusal } : {}),
      ...(scam.length ? { scamCues: scam } : {}),
      ...(navigateAudit ? { navigate: navigateAudit } : {}),
      ...(toolAudit ? { tool: toolAudit.name, ...(toolAudit.args ? { toolArgs: toolAudit.args } : {}), toolOutcome: toolAudit.outcome, toolSource: toolAudit.source, ...(toolAudit.reason ? { toolReason: toolAudit.reason } : {}), ...(toolAudit.data ? { toolData: toolAudit.data } : {}) } : {}),
    });
    res.end();
  }

  handoff.resume(); // timers of the cases loaded from the database

  const drafts = createDrafts({ identity, t1, entitlementsFor, conversations, handoff, supportAddress: support?.mail?.supportAddress, mailer, clock, audit });

  const server = http.createServer((req, res) => {
    const fail = () => { if (!res.headersSent) res.writeHead(500); res.end(); };
    // Cross-origin calls (the widget in the portal, on another port or host) are allowed only from the exact origins
    // listed in ALLOWED_ORIGINS. No wildcard, no credentials: the token travels in the Authorization header.
    const origin = req.headers.origin;
    const originAllowed = typeof origin === 'string' && allowedOrigins.includes(origin);
    if (originAllowed) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('access-control-allow-headers', 'authorization, content-type, x-assistant-session');
      res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
      res.setHeader('access-control-max-age', '600');
    }
    res.setHeader('vary', 'Origin');
    if (req.method === 'OPTIONS') { res.writeHead(originAllowed ? 204 : 403).end(); return; }
    if (/^\/draft(\/|\?|$)/.test(req.url)) {
      drafts(req, res).then((served) => { if (!served) res.writeHead(404).end(); }, fail);
      return;
    }
    if (/^\/(handoff|case|agent)(\/|\?|$)/.test(req.url)) {
      handoff(req, res).then((served) => { if (!served) res.writeHead(404).end(); }, fail);
      return;
    }
    if (req.method === 'POST' && req.url === '/chat') {
      handleChat(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
      return;
    }
    if (req.method === 'POST' && req.url === '/unlock') {
      handleUnlock(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
      return;
    }
    if (req.method === 'POST' && req.url === '/session') {
      handleSession(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
      return;
    }
    if (req.method === 'POST' && req.url === '/feedback') {
      handleAnswerFeedback(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/help/topics?')) {
      handleHelpTopics(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
      return;
    }
    if (req.method === 'GET' && req.url === '/conversations') {
      handleConversationHistory(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
      return;
    }
    const conversationMatch = req.method === 'GET' && /^\/conversations\/([^/?]+)$/.exec(req.url);
    if (conversationMatch) {
      let conversationId;
      try { conversationId = decodeURIComponent(conversationMatch[1]); } catch { res.writeHead(404).end(); return; }
      handleConversationHistory(req, res, conversationId).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
      return;
    }
    const file = req.method === 'GET' ? STATIC[req.url.split('?')[0]] : undefined;
    if (file) {
      readFile(new URL(file[0], PUBLIC)).then(
        (data) => res.writeHead(200, { 'content-type': file[1] }).end(file[0] === 'index.html' && devPage ? devPageHtml(data.toString(), devPage) : data),
        () => res.writeHead(500).end(),
      );
      return;
    }
    res.writeHead(404).end();
  });
  // Everything not yet written goes to the database when the server stops (and on request, for tests).
  server.flushStorage = () => { handoff.flush(); conversations.flush(); };
  server.on('close', server.flushStorage);
  // Retention (ticket 33): with a retention value the purge job exists, runs on the clock, and stops with the server.
  if (retention) {
    server.retention = createRetention({ clock, ms: retention.ms, audit, failedQuestions, conversations, handoff, drafts });
    server.retention.start();
    server.on('close', () => server.retention.stop());
  }
  return server;
}
