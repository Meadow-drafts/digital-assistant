import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createCaseStore } from './cases.js';
import { createHours } from './hours.js';
import { json, readJson } from './http.js';
import { maskText } from './mask.js';
import { ownerOf, tokenOf } from './identity.js';

// Fixed customer-facing text. The customer is told when to expect an update, never that it will be resolved.
export const NOTICE = {
  en: 'We will update you within 24 hours.',
  fr: 'Nous vous tiendrons informé dans les 24 heures.',
};
// Shown once a case is queued: after 15 minutes unclaimed, or at once outside opening hours.
export const QUEUED = {
  en: 'Your case is queued. You can leave this chat: we will email you.',
  fr: "Votre dossier est mis en file d'attente. Vous pouvez quitter ce chat : nous vous écrirons par e-mail.",
};
export const QUEUED_AFTER_HOURS = {
  en: 'Our support team is closed right now. Your case is queued and an agent will pick it up at the start of the next shift. We will email you.',
  fr: "Notre équipe est fermée pour le moment. Votre dossier est mis en file d'attente et un agent le prendra au début de la prochaine période d'ouverture. Nous vous écrirons par e-mail.",
};
// Emails to the customer carry the case reference and a fixed sentence, never anything from the conversation.
const CUSTOMER_MAIL = {
  received: {
    en: (ref) => ({ subject: `[${ref}] We received your request`, body: `We received your request (case ${ref}) outside our opening hours.\nAn agent will pick it up at the start of the next shift. We will update you within 24 hours.` }),
    fr: (ref) => ({ subject: `[${ref}] Nous avons bien reçu votre demande`, body: `Nous avons reçu votre demande (dossier ${ref}) en dehors de nos horaires d'ouverture.\nUn agent la prendra au début de la prochaine période d'ouverture. Nous vous tiendrons informé dans les 24 heures.` }),
  },
  reply: {
    en: (ref) => ({ subject: `[${ref}] You have a new message`, body: `An agent answered your case ${ref}. Open the chat on the portal to read it.` }),
    fr: (ref) => ({ subject: `[${ref}] Vous avez un nouveau message`, body: `Un agent a répondu à votre dossier ${ref}. Ouvrez le chat sur le portail pour le lire.` }),
  },
};

// Customer and agent routes for handoff cases. Returns true when it served the request.
export function createHandoff({ clock, audit, mailer, agents, support, consoleUrl, conversations }) {
  const store = createCaseStore({ clock });
  const { timers } = support;
  const hours = createHours(support.hours);
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
    ...(c.state === 'waiting' && c.queued ? { queued: true, queuedNotice: (c.afterHours ? QUEUED_AFTER_HOURS : QUEUED)[c.language] } : {}),
  });

  const record = (c, outcome) => audit.append({
    time: new Date(clock.now()).toISOString(), user: c.owner, tenant: c.tenant, conversationId: c.conversationId,
    userText: '', replyText: '', outcome, caseRef: c.ref,
  });

  // Mail never throws into a request or a timer: a failed send is audited and the case carries on.
  const send = async (c, message, outcome) => {
    try { await mailer.send(message); } catch { await record(c, `${outcome}_failed`); return; }
    await record(c, outcome);
  };

  // The page: a link and the conversation id only. Never any message content.
  const pageText = (c, agent) => ({
    to: agent.email,
    subject: `[${c.ref}] New chat case`,
    body: `A customer is waiting for an agent.\nCase: ${c.ref}\nConversation: ${c.conversationId}\nOpen: ${consoleUrl}?case=${c.ref}`,
  });
  const page = (c, who, outcome) => Promise.all(who.map((agent) => send(c, pageText(c, agent), outcome)));

  const stillWaiting = (c) => c.state === 'waiting';
  // A timer that does nothing once the case has been claimed or cancelled.
  const later = (c, ms, fn) => clock.setTimeout(async () => { if (stillWaiting(c)) await fn(); }, ms);

  // On-call first; the whole pool after broadcastMs unclaimed; the customer told "queued" after queuedNoticeMs.
  async function startPaging(c) {
    await page(c, onCall, 'case_paged');
    later(c, timers.broadcastMs, () => page(c, agents.list, 'case_broadcast'));
    later(c, timers.queuedNoticeMs, async () => { c.queued = true; await record(c, 'case_queued'); });
  }

  // Outside opening hours: queued at once, the customer is emailed, the page waits for the next shift start.
  async function queueUntilOpen(c, conversation) {
    c.queued = true;
    c.afterHours = true;
    await record(c, 'case_queued_after_hours');
    const email = conversation.session?.email;
    if (email) await send(c, { to: email, ...CUSTOMER_MAIL.received[c.language](c.ref) }, 'customer_confirmation_emailed');
    else await record(c, 'customer_email_missing');
    const opensAt = hours.nextOpen(clock.now());
    later(c, opensAt - clock.now(), async () => { c.afterHours = false; c.queued = false; await startPaging(c); });
  }

  // Presence: each side counts as "gone" after absentMs without touching the case. One email per absence.
  const gone = (seenAt) => clock.now() - seenAt > timers.absentMs;
  const customerSeen = (c) => { c.customerSeenAt = clock.now(); c.customerEmailed = false; };
  const agentSeen = (c) => { c.agentSeenAt = clock.now(); c.agentEmailed = false; };

  // An agent wrote and the customer has left: the words wait on the case, the customer gets a fixed-sentence email.
  async function mailCustomerIfGone(c) {
    if (c.customerEmailed || !gone(c.customerSeenAt)) return;
    c.customerEmailed = true;
    if (!c.customerEmail) { await record(c, 'customer_email_missing'); return; }
    await send(c, { to: c.customerEmail, ...CUSTOMER_MAIL.reply[c.language](c.ref) }, 'customer_emailed');
  }
  // The customer wrote and the agent who has the case has left: link and conversation id only.
  async function mailAgentIfGone(c) {
    if (c.agentEmailed || !gone(c.agentSeenAt)) return;
    c.agentEmailed = true;
    await send(c, {
      to: c.agent.email,
      subject: `[${c.ref}] The customer wrote`,
      body: `A customer has a new message waiting.\nCase: ${c.ref}\nConversation: ${c.conversationId}\nOpen: ${consoleUrl}?case=${c.ref}`,
    }, 'agent_emailed');
  }

  // Opens a waiting case. `opening` is a confirmed draft: the first message of the case, ahead of the replayed chat.
  async function startCase({ conversationId, conversation, owner, tenant, ref, opening }) {
    const c = store.open({ conversationId, owner, tenant, language: conversation.language, ref });
    if (opening) add(c, 'customer', opening);
    // The agent starts with the conversation so far, not a blank page.
    for (const m of conversation.history) add(c, m.role === 'user' ? 'customer' : 'bot', m.content);
    add(c, 'system', 'Case opened by the customer.');
    c.customerEmail = conversation.session?.email ?? null;
    customerSeen(c);
    await record(c, 'handoff_opened');
    if (hours.isOpen(clock.now())) await startPaging(c);
    else await queueUntilOpen(c, conversation);
    return c;
  }

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
    const c = await startCase({ conversationId, conversation, owner, tenant: typeof body?.tenant === 'string' ? body.tenant.slice(0, 40) : null });
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
    if (!c || c.closeReason === 'cancelled_by_user' || c.state === 'emailed') { json(res, 200, { state: 'bot', ref: null }); return; }
    customerSeen(c);
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

  function caseDetail(res, ref, agent) {
    const c = store.get(ref);
    if (!c) { json(res, 404, { error: 'not_found' }); return; }
    if (c.agent?.id === agent.id) agentSeen(c);
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
    agentSeen(c);
    add(c, 'agent', text);
    await mailCustomerIfGone(c);
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
    customerSeen(claimed.case); // the customer was in the queue a moment ago; the clock for "gone" starts from the claim
    agentSeen(claimed.case);
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
      else if (req.method === 'GET' && !target[2]) caseDetail(res, target[1], agent);
      else json(res, 404, { error: 'not_found' });
      return true;
    }
    return false;
  }

  // For drafted case messages: a reference for the email subject, and the case the customer already has open.
  handle.reserveRef = () => store.reserveRef();
  // The customer emailed support without opening a chat. The reference leads to a recorded case that nobody is paged
  // for (state 'emailed'); with a case already open, the email belongs to that case and nothing new is recorded.
  handle.fileEmailedDraft = async ({ conversationId, conversation, tenant, ref, text }) => {
    const open = handle.openCaseFor(conversationId);
    if (open) return view(open);
    const c = store.open({ conversationId, owner: conversation.owner, tenant, language: conversation.language, ref, state: 'emailed' });
    add(c, 'customer', text);
    await record(c, 'draft_emailed');
    return { state: 'bot', ref };
  };
  // The customer confirmed a chat draft. With a case already open it joins that case; otherwise it opens one.
  handle.sendChatDraft = async ({ conversationId, conversation, tenant, ref, text }) => {
    const open = handle.openCaseFor(conversationId);
    if (!open) return view(await startCase({ conversationId, conversation, owner: conversation.owner, tenant, ref, opening: text }));
    add(open, 'customer', text);
    if (open.state === 'with_agent') await mailAgentIfGone(open);
    customerSeen(open);
    await record(open, 'draft_added_to_case');
    return view(open);
  };
  handle.openCaseFor = (conversationId) => {
    const c = store.latestFor(conversationId);
    return c && (c.state === 'waiting' || c.state === 'with_agent') ? c : null;
  };
  // For the chat route: the case that currently has the customer's messages, if an agent has it.
  handle.agentCaseFor = (conversationId) => {
    const c = store.latestFor(conversationId);
    return c?.state === 'with_agent' ? c : null;
  };
  // A customer message for the agent. The text has already been through the secret shield.
  handle.relayToAgent = async (c, text) => {
    add(c, 'customer', text);
    await mailAgentIfGone(c);
    customerSeen(c);
  };
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
