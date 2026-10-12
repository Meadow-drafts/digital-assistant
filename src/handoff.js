import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createCaseStore } from './cases.js';
import { json, readJson } from './http.js';
import { maskText } from './mask.js';
import { ownerOf, tokenOf } from './identity.js';

// Fixed customer-facing text. The customer is told when to expect an update, never that it will be resolved.
export const NOTICE = {
  en: 'We will update you within 24 hours.',
  fr: 'Nous vous tiendrons informé dans les 24 heures.',
};

// Customer and agent routes for handoff cases. Returns true when it served the request.
export function createHandoff({ clock, audit, mailer, agents, consoleUrl, conversations }) {
  const store = createCaseStore({ clock });
  const onCall = (agents?.onCall ?? []).map((id) => agents.list.find((a) => a.id === id)).filter(Boolean);

  // Demo agent login: the agents come from config, sessions live in memory for sessionMs.
  const sessions = new Map();
  const sessionMs = agents?.sessionMs ?? 8 * 60 * 60_000;
  const digest = (v) => createHash('sha256').update(String(v)).digest();
  const samePassword = (given, expected) => timingSafeEqual(digest(given), digest(expected));

  // The one place text enters a case transcript. Everything except an agent's own words is masked first.
  const add = (c, from, text) => store.append(c, from, from === 'agent' || from === 'system' ? text : maskText(text));

  const view = (c) => ({
    state: c.state, ref: c.ref, notice: NOTICE[c.language],
    // The customer learns the agent's first name and that this is a person, nothing else about them.
    ...(c.state === 'with_agent' ? { agent: { firstName: c.agent.name.split(/\s+/)[0], human: true } } : {}),
    // After resolution the customer is asked once whether it was solved.
    ...(c.state === 'resolved' ? { askSolved: c.solved === null } : {}),
    ...(c.state === 'waiting' ? { elapsedSeconds: Math.floor((clock.now() - c.openedAt) / 1000) } : {}),
  });

  const record = (c, outcome) => audit.append({
    time: new Date(clock.now()).toISOString(), user: c.owner, tenant: c.tenant, conversationId: c.conversationId,
    userText: '', replyText: '', outcome, caseRef: c.ref,
  });

  // The page: a link and the conversation id only. Never any message content.
  const page = (c) => Promise.all(onCall.map((agent) => mailer.send({
    to: agent.email,
    subject: `[${c.ref}] New chat case`,
    body: `A customer is waiting for an agent.\nCase: ${c.ref}\nConversation: ${c.conversationId}\nOpen: ${consoleUrl}?case=${c.ref}`,
  })));

  async function openHandoff(req, res) {
    let body;
    try { body = await readJson(req); } catch { json(res, 400, { error: 'bad_request' }); return; }
    const owner = ownerOf(tokenOf(req));
    const known = typeof body?.conversationId === 'string' ? conversations.get(body.conversationId) : undefined;
    if (known && known.owner !== owner) { json(res, 404, { error: 'not_found' }); return; }
    // A customer can ask for a person before saying anything: that starts a conversation.
    const conversationId = known ? body.conversationId : randomUUID();
    const conversation = known ?? { owner, history: [], language: 'en', asked: new Set(), session: null };
    conversations.set(conversationId, conversation);
    const open = store.latestFor(conversationId);
    if (open && (open.state === 'waiting' || open.state === 'with_agent')) { json(res, 200, { conversationId, ...view(open) }); return; }
    const c = store.open({ conversationId, owner, tenant: typeof body?.tenant === 'string' ? body.tenant.slice(0, 40) : null, language: conversation.language });
    // The agent starts with the conversation so far, not a blank page.
    for (const m of conversation.history) add(c, m.role === 'user' ? 'customer' : 'bot', m.content);
    add(c, 'system', 'Case opened by the customer.');
    await record(c, 'handoff_opened');
    await page(c);
    json(res, 200, { conversationId, ...view(c) });
  }

  // The customer's own conversation, or a 404 that does not say whether the id exists.
  function ownConversation(req, res, id) {
    const conversation = typeof id === 'string' ? conversations.get(id) : undefined;
    if (conversation && conversation.owner === ownerOf(tokenOf(req))) return conversation;
    json(res, 404, { error: 'not_found' });
    return null;
  }

  function customerStatus(req, res, url) {
    const id = url.searchParams.get('conversationId');
    if (!ownConversation(req, res, id)) return;
    const c = store.latestFor(id);
    // A cancelled case is closed: the conversation is back with the bot.
    if (!c || c.closeReason === 'cancelled_by_user') { json(res, 200, { state: 'bot', ref: null }); return; }
    const after = Number.parseInt(url.searchParams.get('after') ?? '0', 10) || 0;
    // The customer receives the agent's words; their own side is already on their screen.
    const messages = c.transcript.filter((m) => m.from === 'agent' && m.seq > after).map(({ seq, from, text }) => ({ seq, from, text }));
    json(res, 200, { ...view(c), messages, next: c.transcript.length });
  }

  async function cancelCase(req, res) {
    let body;
    try { body = await readJson(req); } catch { json(res, 400, { error: 'bad_request' }); return; }
    if (!ownConversation(req, res, body?.conversationId)) return;
    const c = store.latestFor(body.conversationId);
    // Only a case nobody has taken yet can be cancelled; once an agent has it, the agent resolves it.
    if (c?.state !== 'waiting') { json(res, 409, { error: 'not_waiting' }); return; }
    store.resolve(c, 'cancelled_by_user');
    await record(c, 'case_cancelled');
    json(res, 200, { state: 'bot', ref: null });
  }

  async function agentLogin(req, res) {
    let body;
    try { body = await readJson(req); } catch { json(res, 400, { error: 'bad_request' }); return; }
    const agent = agents?.list?.find((a) => a.id === body?.id);
    // The password is compared even for an unknown id, so the answer does not reveal which ids exist.
    const ok = samePassword(body?.password ?? '', agent?.password ?? randomUUID());
    if (!agent || !ok) { json(res, 401, { error: 'login_failed' }); return; }
    const token = randomUUID();
    sessions.set(token, { agent, expiresAt: clock.now() + sessionMs });
    json(res, 200, { token, name: agent.name });
  }

  // The logged-in agent, or a 401 that says nothing else.
  function agentOf(req, res) {
    const token = tokenOf(req);
    const session = token ? sessions.get(token) : undefined;
    if (session && session.expiresAt > clock.now()) return session.agent;
    if (session) sessions.delete(token);
    json(res, 401, { error: 'login_required' });
    return null;
  }

  const row = (c) => ({
    ref: c.ref, state: c.state, claimedBy: c.agent?.name ?? null, closeReason: c.closeReason,
    waitingSeconds: c.state === 'waiting' ? Math.floor((clock.now() - c.openedAt) / 1000) : null,
  });

  function agentCases(req, res) {
    if (!agentOf(req, res)) return;
    json(res, 200, { cases: store.all().reverse().map(row) });
  }

  const MAX_TEXT = 1000;

  function caseDetail(res, ref) {
    const c = store.get(ref);
    if (!c) { json(res, 404, { error: 'not_found' }); return; }
    json(res, 200, { ...row(c), conversationId: c.conversationId, transcript: c.transcript.map(({ seq, from, text, at }) => ({ seq, from, text, at })) });
  }

  // The agent must be the one who claimed the case, and the case must still be with them.
  function ownCase(res, agent, ref) {
    const c = store.get(ref);
    if (!c) { json(res, 404, { error: 'not_found' }); return null; }
    if (c.agent && c.agent.id !== agent.id) { json(res, 403, { error: 'not_your_case' }); return null; }
    if (c.state !== 'with_agent') { json(res, 409, { error: 'not_with_agent' }); return null; }
    return c;
  }

  async function agentMessage(req, res, agent, ref) {
    let body;
    try { body = await readJson(req); } catch { json(res, 400, { error: 'bad_request' }); return; }
    const c = ownCase(res, agent, ref);
    if (!c) return;
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    if (!text || text.length > MAX_TEXT) { json(res, 400, { error: 'bad_text' }); return; }
    add(c, 'agent', text);
    json(res, 200, { ok: true });
  }

  async function resolveCase(res, agent, ref) {
    const c = ownCase(res, agent, ref);
    if (!c) return;
    store.resolve(c);
    await record(c, 'case_resolved');
    json(res, 200, { ref, state: 'resolved' });
  }

  async function solvedFeedback(req, res) {
    let body;
    try { body = await readJson(req); } catch { json(res, 400, { error: 'bad_request' }); return; }
    if (!ownConversation(req, res, body?.conversationId)) return;
    const c = store.latestFor(body.conversationId);
    if (c?.state !== 'resolved' || c.solved !== null || c.closeReason !== 'resolved_by_agent') { json(res, 409, { error: 'not_asked' }); return; }
    if (typeof body.solved !== 'boolean') { json(res, 400, { error: 'bad_request' }); return; }
    c.solved = body.solved;
    await audit.append({
      time: new Date(clock.now()).toISOString(), user: c.owner, tenant: c.tenant, conversationId: c.conversationId,
      userText: '', replyText: '', outcome: 'case_feedback', caseRef: c.ref, solved: c.solved,
    });
    json(res, 200, { ok: true });
  }

  async function claimCase(res, agent, ref) {
    const claimed = store.claim(ref, agent);
    if (!claimed.ok) { json(res, claimed.reason === 'not_found' ? 404 : 409, { error: claimed.reason }); return; }
    await record(claimed.case, 'case_claimed');
    json(res, 200, { ref, state: 'with_agent', claimedBy: agent.name });
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://local');
    if (req.method === 'POST' && url.pathname === '/handoff') { await openHandoff(req, res); return true; }
    if (req.method === 'GET' && url.pathname === '/case') { customerStatus(req, res, url); return true; }
    if (req.method === 'POST' && url.pathname === '/case/cancel') { await cancelCase(req, res); return true; }
    if (req.method === 'POST' && url.pathname === '/case/feedback') { await solvedFeedback(req, res); return true; }
    if (req.method === 'POST' && url.pathname === '/agent/login') { await agentLogin(req, res); return true; }
    if (req.method === 'GET' && url.pathname === '/agent/cases') { agentCases(req, res); return true; }
    const target = /^\/agent\/cases\/([A-Za-z0-9-]{1,20})(?:\/(claim|messages|resolve))?$/.exec(url.pathname);
    if (target) {
      const agent = agentOf(req, res);
      if (!agent) return true;
      if (req.method === 'POST' && target[2] === 'claim') await claimCase(res, agent, target[1]);
      else if (req.method === 'POST' && target[2] === 'messages') await agentMessage(req, res, agent, target[1]);
      else if (req.method === 'POST' && target[2] === 'resolve') await resolveCase(res, agent, target[1]);
      else if (req.method === 'GET' && !target[2]) caseDetail(res, target[1]);
      else json(res, 404, { error: 'not_found' });
      return true;
    }
    return false;
  }

  // For the chat route: the case that currently has the customer's messages, if an agent has it.
  handle.agentCaseFor = (conversationId) => {
    const c = store.latestFor(conversationId);
    return c?.state === 'with_agent' ? c : null;
  };
  // A customer message for the agent. The text has already been through the secret shield.
  handle.relayToAgent = (c, text) => add(c, 'customer', text);
  // A waiting case: the bot keeps answering, and both sides of the turn are kept on the case.
  handle.waitingCaseFor = (conversationId) => {
    const c = store.latestFor(conversationId);
    return c?.state === 'waiting' ? c : null;
  };
  handle.mirrorTurn = (c, question, answer) => {
    add(c, 'customer', question);
    if (answer) add(c, 'bot', answer);
  };
  return handle;
}
