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
import { intentTool } from './intents.js';
import { offeredPages, parseNavigate, stepsOf, validateProposal } from './navigate.js';
import { offeredForms, parsePrefill, validatePrefill } from './prefill.js';
import { GUIDE_ID, NEXT_STEP, OUTCOMES, TEXT as EXPLAIN_TEXT, parseNext } from './explain.js';
import { MESSAGES as T1_MESSAGES, TOOL_RULES, UNLOCK_MS, createT1, parseToolCall } from './t1.js';
import { ownerOf, subjectOf, tokenOf } from './identity.js';

const PUBLIC = new URL('../public/', import.meta.url);
// Only these files are served; no user-controlled path ever reaches the disk.
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/widget.js': ['widget.js', 'text/javascript; charset=utf-8'],
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
const MAX_BODY = 16 * 1024;

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// Pseudonymous user id for the audit log and rate limits: a one-way digest of
// the token's subject (or of the token itself when it has none). The token
// itself is never stored or logged.
const pseudonym = (req) => ownerOf(tokenOf(req));

const MAX_GUIDES = 3;
const NO_VERIFIED_STEPS = {
  en: 'I have no verified steps for that in the portal guides, so I will not guess. Please use "Talk to a human agent" and they can help.',
  fr: "Je n'ai pas d'étapes vérifiées pour cela dans les guides du portail, donc je ne vais pas deviner. Utilisez « Parler à un agent » et il pourra vous aider.",
};
const GENERIC_CLOSING = {
  en: 'If this does not help, use "Talk to a human agent".',
  fr: "Si cela ne vous aide pas, utilisez « Parler à un agent ».",
};

async function collect(stream) {
  let text = '';
  for await (const part of stream) text += part;
  return text;
}

// Router mode: the model sees a short index of the guides this customer may
// use and returns the ids it needs. Anything not in the index is dropped.
async function routeGuides({ model, language, available, guides, history, tools }) {
  const index = available.map((g) => ({ id: g.id, title: g[language].title }));
  if (guides.unsupported) index.push({ id: UNSUPPORTED_ID, title: 'Things the portal does not offer' });
  const raw = await collect(model.chat({ purpose: 'route', messages: routerMessages(index, history, { tools }), language }));
  const routed = parseRefusal(raw);
  // The model's own tool tag (with its arguments) wins. A plain own-data question (balance, recent transactions,
  // fees and limits) is otherwise decided by rules, even over a model refusal: the model has seen earlier replies
  // that mention a PIN and can wrongly refuse it as a PIN request. The rules are narrow (short, own data, no
  // failure story) and the tools only read the customer's own data.
  const modelTool = !routed.category && tools ? parseToolCall(raw) : null;
  const tool = modelTool ?? intentTool(history.at(-1)?.content);
  if (tool) return { picks: [], refusal: null, tool, toolSource: modelTool ? 'model' : 'rules' };
  if (routed.category) return { picks: [], refusal: routed.category };
  let picks = [];
  try { picks = JSON.parse(/\[[\s\S]*?\]/.exec(raw)?.[0] ?? '[]'); } catch { /* unparseable means no guide */ }
  const allowed = new Set(index.map((i) => i.id));
  return { picks: [...new Set(picks)].filter((id) => allowed.has(id)).slice(0, MAX_GUIDES), refusal: null };
}

export function createService({ devPage, model, gateway, clock, audit, guides, navigation, prefill, scamCues, entitlements, failedQuestions, outputAllowlist, limits }) {
  const t1 = gateway ? createT1({ gateway, clock }) : null;
  const limiter = createLimiter({ clock, limits });
  const checkOutput = createOutputFilter({ allowlist: outputAllowlist, protectedTexts: PROTECTED_TEXTS });
  const conversations = new Map();

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
    const owner = pseudonym(req);
    const known = typeof body?.conversationId === 'string' ? conversations.get(body.conversationId) : undefined;
    const record = (outcome, extra = {}) => audit.append({
      time: new Date(clock.now()).toISOString(), user: owner, tenant: typeof body?.tenant === 'string' ? body.tenant.slice(0, 40) : null,
      conversationId: known ? body.conversationId : null, userText: '', replyText: '', outcome, ...extra,
    });
    if (known && known.owner !== owner) { await record('conversation_denied'); reply(404, { error: 'not_found' }); return; }
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
    const conversation = known ?? { owner, history: [], language: 'en', asked: new Set(), session: null };
    conversation.session = session;
    conversation.unlock = null; // a new session starts with the balance locked
    conversations.set(conversationId, conversation);
    await audit.append({
      time: new Date(clock.now()).toISOString(), user: owner, tenant: session.tenant, conversationId,
      userText: '', replyText: '', outcome: 'session_started',
    });
    reply(200, { conversationId });
  }

  // Balance unlock (ticket 24). Either the portal's PIN-verified flag (a client claim) or the widget's own
  // PIN box (a SHA-512 hash, forwarded to the PIN check and never kept). Unlocks last 5 minutes.
  async function handleUnlock(req, res) {
    const reply = (status, payload) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
    let body;
    try { body = await readJson(req); } catch { reply(400, { error: 'bad_request' }); return; }
    if (!t1) { reply(404, { error: 'not_available' }); return; }
    const owner = pseudonym(req);
    const conversation = typeof body?.conversationId === 'string' ? conversations.get(body.conversationId) : undefined;
    const record = (outcome) => audit.append({
      time: new Date(clock.now()).toISOString(), user: owner, tenant: conversation?.session?.tenant ?? null,
      conversationId: conversation && conversation.owner === owner ? body.conversationId : null, userText: '', replyText: '', outcome,
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
    await record('unlock_flag_not_valid');
    reply(403, { error: 'flag_not_valid' });
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
    const owner = pseudonym(req);
    const known = typeof body.conversationId === 'string' ? conversations.get(body.conversationId) : undefined;
    if (known && known.owner !== owner) {
      await audit.append({
        time: new Date(clock.now()).toISOString(), user: owner, tenant: body.tenant ?? null, conversationId: body.conversationId,
        userText: '', replyText: '', outcome: 'conversation_denied',
      });
      res.writeHead(404).end();
      return;
    }
    const conversationId = known ? body.conversationId : randomUUID();
    const conversation = known ?? { owner, history: [], language: 'en', asked: new Set(), session: null };
    const language = detectLanguage(body.message, conversation.language);
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
    history.push({ role: 'user', content: message });
    conversations.set(conversationId, conversation);

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    send(res, 'thinking', {});
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
    let prefillAudit = null;
    // The model's text is held back until it has been read in full: the refusal
    // tag comes off the front before anything reaches the customer.
    const answer = async (messages, { known, navigate } = {}) => {
      let raw = '';
      for await (const text of turnModel.chat({ purpose: 'answer', messages, language, onServed: (info) => { served = info; } })) raw += text;
      const refused = parseRefusal(raw);
      const escalated = parseEscalate(refused.text);
      const nexted = parseNext(escalated.text);
      nextTag = nexted.next;
      const prefilled = parsePrefill(nexted.text);
      const navigated = parseNavigate(prefilled.text);
      const parsed = { category: refused.category, text: navigated.text };
      // A proposal is checked before anything is shown. If it is dropped, the model's words (which may point at the
      // card or a page) are replaced by the steps of the guide it answered from.
      let card = null;
      let checkedProposal = null;
      let checkedPrefill = null;
      if (navigate && prefilled.proposal !== null && !refused.category) {
        // The tag is always taken off the text; a form is only offered when the registry accepts every value.
        const checked = prefill
          ? await validatePrefill({
            registry: prefill, navigation, proposal: prefilled.proposal, language, entitlements: navigate.entitlements,
            session: navigate.prefill?.conversation.session, message, history: navigate.prefill?.history ?? (async () => null),
          })
          : { ok: false, reason: 'not_available', form: null };
        if (checked.ok) {
          card = checked.card;
          checkedPrefill = checked.audit;
        } else {
          checkedPrefill = { outcome: 'dropped', reason: checked.reason, form: checked.form };
          parsed.text = navigate.fallback || NO_VERIFIED_STEPS[language];
        }
      } else if (navigate && navigated.proposal !== null && !refused.category) {
        const checked = validateProposal(navigation, navigated.proposal, language, navigate.entitlements);
        const plain = /^[a-z_]{1,32}$/.test(navigated.proposal) ? navigated.proposal : null;
        if (checked.ok) {
          card = checked.card;
          checkedProposal = { outcome: 'offered', proposal: plain };
        } else {
          checkedProposal = { outcome: 'dropped', reason: checked.reason, proposal: plain };
          parsed.text = navigate.fallback || NO_VERIFIED_STEPS[language];
        }
      }
      if (escalated.reason) chipReasons.push(escalated.reason);
      const leak = checkOutput(parsed.text, { known });
      if (leak) {
        filtered = leak;
        chipReasons.push('blocked');
        reply += BLOCKED[language];
        send(res, 'delta', { text: BLOCKED[language] });
        send(res, 'blocked', { reason: leak, card: refusalCard('off_topic', language) });
        return;
      }
      refusal = parsed.category ?? refusal;
      navigateAudit = checkedProposal;
      prefillAudit = checkedPrefill;
      reply += parsed.text;
      send(res, 'delta', { text: parsed.text });
      if (card && !refusal) send(res, 'action_card', card);
    };
    // Explain my failure: the transfer's status data and the failed-transfer guide only. Only a plain "failed"
    // record is worded by the model; every other outcome is fixed text. Whatever happens, the explanation ends
    // with exactly one next step, and a human next step makes the chip prominent.
    const explain = async ({ result }, material) => {
      const { outcome } = result;
      const { reference } = result; // as the customer typed it: the id they can see, not clientReferenceId
      const t = result.transaction;
      const d = result.detail;
      let next = OUTCOMES[outcome]?.next ?? null;
      if (outcome !== 'not_found') {
        guideIds = [GUIDE_ID];
        send(res, 'guides', { guides: [{ id: GUIDE_ID, title: material.title }] });
      }
      if (outcome === 'failed') {
        await answer(explainMessages(material.text, JSON.stringify({ transaction: t, detail: d }), history), { known: [reference] });
        next = nextTag === 'retry' ? 'retry' : 'human';
        if (next === 'human') chipReasons.push('contact_bank');
      } else {
        const text = outcome === 'not_found' ? EXPLAIN_TEXT.not_found[language](reference) : EXPLAIN_TEXT[outcome][language](t, d);
        reply += text;
        send(res, 'delta', { text });
        if (OUTCOMES[outcome].chip) chipReasons.push(OUTCOMES[outcome].chip);
      }
      // a refusal or a blocked reply already carries its own fixed next-step card
      if (refusal || filtered) return;
      const text = `\n\n${NEXT_STEP[next][language](reference)}`;
      reply += text;
      send(res, 'delta', { text });
      send(res, 'next_step', { kind: next, ...(next === 'history' ? { target: 'history' } : {}), text: text.trim() });
    };
    try {
      if (guides) {
        const ent = await entitlementsFor(req, body.tenant, conversation);
        const available = guides.availableFor(ent);
        const routed = await routeGuides({ model: turnModel, language, available, guides, history, tools: t1 ? TOOL_RULES : '' });
        const { picks } = routed;
        refusal = routed.refusal;
        if (routed.tool) {
          // Without a gateway there is no session to read from: the customer is told to sign in, never that no guide matched.
          const done = t1 ? await t1.run({ call: routed.tool, conversation, token: tokenOf(req), entitlements: ent }) : { kind: 'fixed', code: 'session_expired', name: routed.tool.name };
          if (done.kind === 'data') {
            const masked = JSON.stringify(done.result);
            toolAudit = { name: done.name, outcome: 'ok', data: masked, source: routed.toolSource };
            send(res, 'tool', { name: done.name, result: done.result });
            if (done.name === 'explain_failure') await explain(done, guides.get(GUIDE_ID)[language]);
            else await answer(dataMessages(masked, history));
            if (done.notice && !filtered) {
              const text = `\n\n${T1_MESSAGES[done.notice][language]}`;
              reply += text;
              send(res, 'delta', { text });
            }
          } else {
            const text = T1_MESSAGES[done.code][language];
            toolAudit = { name: done.name, outcome: done.code, source: routed.toolSource, ...(done.reason ? { reason: done.reason } : {}) };
            outcome = done.code === 'rejected' ? 'tool_rejected' : done.code;
            reply += text;
            send(res, 'tool_blocked', { code: done.code, text });
            send(res, 'delta', { text });
            if (!['session_expired', 'pin_required'].includes(done.code)) chipReasons.push(`tool_${done.code}`);
          }
        } else {
          const used = picks.filter((id) => id !== UNSUPPORTED_ID).map((id) => guides.get(id));
          guideIds = used.map((g) => g.id);
          send(res, 'guides', { guides: used.map((g) => ({ id: g.id, title: g[language].title })) });
          if (picks.length === 0 && !refusal) {
            chipReasons.push('no_guide_hit');
            reply += NO_VERIFIED_STEPS[language];
            send(res, 'delta', { text: NO_VERIFIED_STEPS[language] });
            await failedQuestions?.append({ time: new Date(clock.now()).toISOString(), conversationId, tenant: body.tenant ?? null, language, question: message });
          } else {
            const material = picks.map((id) => guides.get(id)?.[language] ?? null).filter(Boolean);
            // The customer's own history is read at most once per turn, and only if a pre-fill check needs it.
            let ownRows;
            const prefillHistory = () => (ownRows ??= t1 ? t1.ownHistory(conversation, tokenOf(req), ent) : Promise.resolve(null));
            const forms = navigation && prefill ? offeredForms(prefill, navigation, language, ent) : [];
            await answer(answerMessages(material, picks.includes(UNSUPPORTED_ID) ? guides.unsupported : '', history, navigation ? offeredPages(navigation, language, ent) : [], forms), {
              navigate: navigation ? { fallback: stepsOf(material[0]?.text ?? ''), entitlements: ent, prefill: { conversation, history: prefillHistory } } : null,
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
      history.push({ role: 'assistant', content: reply });
      send(res, 'done', { conversationId, language: served.offline ? 'en' : language, model: served.model, offline: Boolean(served.offline) });
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
      ...(filtered ? { filter: filtered } : {}),
      ...(refusal ? { refusalCategory: refusal } : {}),
      ...(scam.length ? { scamCues: scam } : {}),
      ...(navigateAudit ? { navigate: navigateAudit } : {}),
      ...(prefillAudit ? { prefill: prefillAudit } : {}),
      ...(toolAudit ? { tool: toolAudit.name, toolOutcome: toolAudit.outcome, toolSource: toolAudit.source, ...(toolAudit.reason ? { toolReason: toolAudit.reason } : {}), ...(toolAudit.data ? { toolData: toolAudit.data } : {}) } : {}),
    });
    res.end();
  }

  return http.createServer((req, res) => {
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
    const file = req.method === 'GET' ? STATIC[req.url] : undefined;
    if (file) {
      readFile(new URL(file[0], PUBLIC)).then(
        (data) => res.writeHead(200, { 'content-type': file[1] }).end(file[0] === 'index.html' && devPage ? devPageHtml(data.toString(), devPage) : data),
        () => res.writeHead(500).end(),
      );
      return;
    }
    res.writeHead(404).end();
  });
}
