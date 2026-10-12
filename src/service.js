import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { detectLanguage } from './language.js';
import { WARNING, shield } from './shield.js';
import { BUSY, LimitError, createLimiter } from './limits.js';
import { parseRefusal, refusalCard } from './refusals.js';
import { BLOCKED, createOutputFilter } from './filter.js';
import { PROTECTED_TEXTS, modelHistory, UNSUPPORTED_ID, answerMessages, routerMessages } from './prompts.js';

const PUBLIC = new URL('../public/', import.meta.url);
// Only these files are served; no user-controlled path ever reaches the disk.
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/widget.js': ['widget.js', 'text/javascript; charset=utf-8'],
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

// Pseudonymous user id for the audit log. Until the gateway client id is fixed
// per conversation (T1 tickets), it is a one-way digest of the bearer token;
// the token itself is never stored or logged.
function pseudonym(req) {
  const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? 'anonymous';
  return createHash('sha256').update(token).digest('hex').slice(0, 12);
}

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
async function routeGuides({ model, language, available, guides, history }) {
  const index = available.map((g) => ({ id: g.id, title: g[language].title }));
  if (guides.unsupported) index.push({ id: UNSUPPORTED_ID, title: 'Things the portal does not offer' });
  const raw = await collect(model.chat({ purpose: 'route', messages: routerMessages(index, history), language }));
  const routed = parseRefusal(raw);
  if (routed.category) return { picks: [], refusal: routed.category };
  let picks = [];
  try { picks = JSON.parse(/\[[\s\S]*?\]/.exec(raw)?.[0] ?? '[]'); } catch { /* unparseable means no guide */ }
  const allowed = new Set(index.map((i) => i.id));
  return { picks: [...new Set(picks)].filter((id) => allowed.has(id)).slice(0, MAX_GUIDES), refusal: null };
}

export function createService({ model, clock, audit, guides, entitlements, failedQuestions, outputAllowlist, limits }) {
  const limiter = createLimiter({ clock, limits });
  const checkOutput = createOutputFilter({ allowlist: outputAllowlist, protectedTexts: PROTECTED_TEXTS });
  const conversations = new Map();

  // Fail closed: if entitlements cannot be read, offer only guides that need
  // no package, no primary connect and fit the individual role.
  async function entitlementsFor(req, tenant) {
    if (!entitlements) return null;
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    try { return await entitlements({ token, tenant }); } catch { return { packages: [], primaryConnect: false, audience: 'individual' }; }
  }

  // A turn stopped by a limit: the fixed busy message and the human chip, then done.
  // The model saw nothing (or its reply is dropped), so no customer text is audited.
  async function endBusy(req, res, { limit, conversationId, language, tenant }) {
    const text = BUSY[language];
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    send(res, 'busy', { limit, text, card: refusalCard('off_topic', language) });
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

  async function handleChat(req, res) {
    let body;
    try { body = await readJson(req); } catch { res.writeHead(400).end(); return; }
    if (typeof body?.message !== 'string' || !body.message.trim()) { res.writeHead(400).end(); return; }

    // Everything past this point sees only the redacted text; the raw message is never stored.
    const shielded = shield(body.message);
    const message = shielded.text;
    const conversationId = body.conversationId ?? randomUUID();
    const conversation = conversations.get(conversationId) ?? { history: [], language: 'en' };
    const language = detectLanguage(body.message, conversation.language);
    const limit = limiter.admit(pseudonym(req), body.message.length);
    if (limit) {
      await endBusy(req, res, { limit, conversationId, language, tenant: body.tenant });
      return;
    }
    const { history } = conversation;
    conversation.language = language;
    history.push({ role: 'user', content: message });
    conversations.set(conversationId, conversation);

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    send(res, 'thinking', {});
    if (shielded.flagged) send(res, 'warning', { code: 'secret_input', text: WARNING[language] });
    const startedAt = clock.now();
    let reply = '';
    let outcome = 'ok';
    let served = { model: model.name };
    const turnModel = limiter.meter(model);
    let guideIds = [];
    let refusal = null;
    let filtered = null;
    let limited = null;
    // The model's text is held back until it has been read in full: the refusal
    // tag comes off the front before anything reaches the customer.
    const answer = async (messages) => {
      let raw = '';
      for await (const text of turnModel.chat({ purpose: 'answer', messages, language, onServed: (info) => { served = info; } })) raw += text;
      const parsed = parseRefusal(raw);
      const leak = checkOutput(parsed.text);
      if (leak) {
        filtered = leak;
        reply += BLOCKED[language];
        send(res, 'delta', { text: BLOCKED[language] });
        send(res, 'blocked', { reason: leak, card: refusalCard('off_topic', language) });
        return;
      }
      refusal = parsed.category ?? refusal;
      reply += parsed.text;
      send(res, 'delta', { text: parsed.text });
    };
    try {
      if (guides) {
        const available = guides.availableFor(await entitlementsFor(req, body.tenant));
        const routed = await routeGuides({ model: turnModel, language, available, guides, history });
        const { picks } = routed;
        refusal = routed.refusal;
        const used = picks.filter((id) => id !== UNSUPPORTED_ID).map((id) => guides.get(id));
        guideIds = used.map((g) => g.id);
        send(res, 'guides', { guides: used.map((g) => ({ id: g.id, title: g[language].title })) });
        if (picks.length === 0 && !refusal) {
          reply += NO_VERIFIED_STEPS[language];
          send(res, 'delta', { text: NO_VERIFIED_STEPS[language] });
          await failedQuestions?.append({ time: new Date(clock.now()).toISOString(), conversationId, tenant: body.tenant ?? null, language, question: message });
        } else {
          const material = picks.map((id) => guides.get(id)?.[language] ?? null).filter(Boolean);
          await answer(answerMessages(material, picks.includes(UNSUPPORTED_ID) ? guides.unsupported : '', history));
          const closing = used.find((g) => g[language].closing)?.[language].closing;
          if (!refusal && !filtered) {
            const text = closing ? `\n\n${closing.heading}${language === 'fr' ? ' :' : ':'} ${closing.body}` : `\n\n${GENERIC_CLOSING[language]}`;
            reply += text;
            send(res, 'delta', { text });
          }
        }
      } else {
        await answer(modelHistory(history));
      }
      if (refusal) send(res, 'refusal', { category: refusal, card: refusalCard(refusal, language) });
      history.push({ role: 'assistant', content: reply });
      send(res, 'done', { conversationId, language: served.offline ? 'en' : language, model: served.model, offline: Boolean(served.offline) });
    } catch (err) {
      if (err instanceof LimitError) {
        limited = err.limit;
        reply = BUSY[language];
        send(res, 'busy', { limit: limited, text: reply, card: refusalCard('off_topic', language) });
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
    });
    res.end();
  }

  return http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/chat') {
      handleChat(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
      return;
    }
    const file = req.method === 'GET' ? STATIC[req.url] : undefined;
    if (file) {
      readFile(new URL(file[0], PUBLIC)).then(
        (data) => res.writeHead(200, { 'content-type': file[1] }).end(data),
        () => res.writeHead(500).end(),
      );
      return;
    }
    res.writeHead(404).end();
  });
}
