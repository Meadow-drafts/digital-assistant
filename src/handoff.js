import { randomUUID } from 'node:crypto';
import { verifyPassword } from './password.js';
import { createCaseStore, lastActivity } from './cases.js';
import { createHours } from './hours.js';
import { json, readJson } from './http.js';
import { maskText } from './mask.js';
import { tokenOf } from './identity.js';
import { cuesIn } from './chip.js';
import { computeDashboard } from './dashboard.js';
import { SUMMARY_LABEL, createSummarizer } from './summary.js';
import { MAX_SUGGESTIONS, NO_SUGGESTIONS, createSuggester } from './suggestions.js';
import { scrub } from './audit.js';
import { shield } from './shield.js';

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
  // The confirmation when a case opens during opening hours (after hours, `received` above is the confirmation).
  opened: {
    en: (ref) => ({ subject: `[${ref}] Your request is open`, body: `Your request is open (case ${ref}). You can follow it under "My cases" in the chat on the portal.\nWe will update you within 24 hours.` }),
    fr: (ref) => ({ subject: `[${ref}] Votre demande est ouverte`, body: `Votre demande est ouverte (dossier ${ref}). Vous pouvez la suivre sous « Mes dossiers » dans le chat du portail.\nNous vous tiendrons informé dans les 24 heures.` }),
  },
  reply: {
    en: (ref) => ({ subject: `[${ref}] You have a new message`, body: `An agent answered your case ${ref}. Open the chat on the portal to read it.` }),
    fr: (ref) => ({ subject: `[${ref}] Vous avez un nouveau message`, body: `Un agent a répondu à votre dossier ${ref}. Ouvrez le chat sur le portail pour le lire.` }),
  },
};

// Customer and agent routes for handoff cases. Returns true when it served the request.
export function createHandoff({ identity, database, clock, audit, failedQuestions, mailer, agents, support, consoleUrl, conversations, model, suggestions, recordsFor, retentionMs }) {
  const summarize = createSummarizer({ model });
  const suggest = createSuggester(suggestions ?? {});
  const store = createCaseStore({ clock, database, agentById: (id) => agents?.list?.find((a) => a.id === id) });
  const { timers } = support;
  const hours = createHours(support.hours);
  const onCall = (agents?.onCall ?? []).map((id) => agents.list.find((a) => a.id === id)).filter(Boolean);

  // Demo agent login: the agents come from config, sessions live in memory for sessionMs.
  const sessions = new Map();
  const sessionMs = agents?.sessionMs ?? 8 * 60 * 60_000;

  // The one place text enters a case transcript. Everything except an agent's own words is masked first.
  const add = (c, from, text, extra) => store.append(c, from, from === 'agent' || from === 'system' ? text : maskText(text), extra);

  // Who is calling, from the signed session id (see identity.js); a bad or expired id is a 401. `verified` routes also
  // refuse a guest, who has no gateway-checked identity.
  function caller(req, res, { verified = false } = {}) {
    const who = identity.resolve(req);
    if (who.error) { json(res, 401, { error: who.error }); return null; }
    if (verified && !who.verified) { json(res, 401, { error: 'session_required' }); return null; }
    return who.owner;
  }

  const view = (c) => ({
    state: c.state, ref: c.ref, notice: NOTICE[c.language],
    // The customer learns the agent's first name and that this is a person, nothing else about them.
    ...(c.state === 'with_agent' ? { agent: { firstName: c.agent.name.split(/\s+/)[0], human: true } } : {}),
    // After resolution the customer is asked once whether it was solved.
    // Only a resolution by a person is followed by the question; an automatic one has nothing to ask about.
    ...(c.state === 'resolved' ? { askSolved: c.solved === null && c.closeReason === 'resolved_by_agent' } : {}),
    ...(c.state === 'with_agent' && c.followUpOffered ? { emailFollowUp: true } : {}),
    ...(c.state === 'waiting' ? { elapsedSeconds: Math.floor((clock.now() - c.openedAt) / 1000) } : {}),
    ...(c.state === 'waiting' && c.queued ? { queued: true, queuedNotice: (c.afterHours ? QUEUED_AFTER_HOURS : QUEUED)[c.language] } : {}),
  });

  const record = (c, outcome, extra = {}) => audit.append({
    time: new Date(clock.now()).toISOString(), user: c.owner, tenant: c.tenant, conversationId: c.conversationId,
    userText: '', replyText: '', outcome, caseRef: c.ref, caseState: c.state, ...(c.closeReason ? { closeReason: c.closeReason } : {}), ...extra,
  });

  // Mail never throws into a request or a timer: a failed send is audited and the case carries on.
  const send = async (c, message, outcome) => {
    try { await mailer.send(message); } catch { await record(c, `${outcome}_failed`); return; }
    await record(c, outcome);
  };

  // The page: a link and the conversation id only. Never any message content.
  const pageText = (c, agent) => ({
    to: agent.email,
    subject: `[${c.ref}] ${c.priority ? 'PRIORITY ' : ''}New chat case`,
    body: `A customer is waiting for an agent.\nCase: ${c.ref}\nConversation: ${c.conversationId}\nOpen: ${consoleUrl}?case=${c.ref}`,
  });
  const page = (c, who, outcome, text = pageText) => Promise.all(who.map((agent) => send(c, text(c, agent), outcome)));
  // Also a link and the conversation id only: a case that has an agent but whose customer is still waiting.
  const overdueText = (c, agent) => ({
    to: agent.email,
    subject: `[${c.ref}] ${c.priority ? 'PRIORITY ' : ''}Customer waiting for a reply`,
    body: `A customer is waiting for a reply on a case that has an agent. Any agent can open it and take it over.\nCase: ${c.ref}\nConversation: ${c.conversationId}\nOpen: ${consoleUrl}?case=${c.ref}`,
  });
  // Mail to the agent who holds the case: a sentence of ours, the link and the conversation id.
  const holderText = (c, subject, line) => ({
    to: c.agent.email, subject: `[${c.ref}] ${subject}`,
    body: `${line}\nCase: ${c.ref}\nConversation: ${c.conversationId}\nOpen: ${consoleUrl}?case=${c.ref}`,
  });

  // Case lifecycle after the claim. Two clocks, each restarted by an event and made harmless by a generation number
  // (the controllable clock cannot cancel a timer that was set before a restart, so the old one just finds it is stale).
  //   silence: the customer is waiting for the agent. Audit at agentSilenceMs, re-broadcast at agentFollowUpMs.
  //   activity: any message on the case. No message for autoResolveMs resolves it.
  // Every deadline is worked out from a time stored on the case (silenceStartedAt, activityAt), so after a restart the
  // same timers are armed again for the same moments (ticket 62): one already due fires at once, the rest keep their time.
  const remaining = (from, ms) => Math.max(0, from + ms - clock.now());
  function armSilence(c) {
    // Older stored cases used `softSent` for this same deadline; carry it forward without replaying the audit event.
    if (c.silenceAudited === undefined && c.softSent !== undefined) {
      c.silenceAudited = c.softSent;
      delete c.softSent;
    }
    const gen = c.silenceGen;
    const live = () => c.state === 'with_agent' && c.silenceGen === gen;
    if (!c.silenceAudited) {
      clock.setTimeout(async () => {
        if (!live()) return;
        c.silenceAudited = true;
        await record(c, 'case_still_working');
      }, remaining(c.silenceStartedAt, timers.agentSilenceMs));
    }
    if (!c.followUpOffered) {
      clock.setTimeout(async () => {
        if (!live()) return;
        c.followUpOffered = true;
        c.openToPool = true; // from this moment any agent can open and claim it; set before the first await
        await page(c, agents.list, 'case_rebroadcast', overdueText);
      }, remaining(c.silenceStartedAt, timers.agentFollowUpMs));
    }
  }
  function awaitAgent(c) {
    c.silenceGen = (c.silenceGen ?? 0) + 1;
    c.awaitingAgent = true;
    c.followUpOffered = false;
    c.silenceAudited = false;
    c.openToPool = false; // a new clock means somebody is on it again: the case is closed to the pool
    c.silenceStartedAt = clock.now();
    armSilence(c);
  }
  function agentAnswered(c) {
    c.silenceGen = (c.silenceGen ?? 0) + 1;
    c.awaitingAgent = false;
    c.followUpOffered = false;
    c.openToPool = false; // the holder replied: it is theirs alone again
  }
  function armActivity(c) {
    const gen = c.activityGen;
    clock.setTimeout(async () => {
      if (c.state !== 'with_agent' || c.activityGen !== gen) return;
      store.resolve(c, 'auto_resolved');
      add(c, 'system', 'Case closed automatically: no messages from either side.');
      await record(c, 'case_auto_resolved');
    }, remaining(c.activityAt, timers.autoResolveMs));
  }
  function touch(c) {
    c.activityGen = (c.activityGen ?? 0) + 1;
    c.activityAt = clock.now();
    armActivity(c);
  }

  // A resolved case comes back when the customer asks for a person again within the window; cancelled ones never do.
  const reopenable = (c) => c?.state === 'resolved' && c.closeReason !== 'cancelled_by_user' && clock.now() - c.resolvedAt <= timers.reopenWindowMs;
  async function reopen(c) {
    store.reopen(c);
    add(c, 'system', 'Case reopened by the customer.');
    awaitAgent(c);
    touch(c);
    customerSeen(c);
    await record(c, 'case_reopened');
    c.agentEmailed = true; // the page below is the one email for this absence
    await send(c, holderText(c, 'The customer wrote again', 'A customer has reopened a case you handled.'), 'case_reopened_paged');
  }

  // The summary is made from the transcript as it is now; `upTo` remembers how far the transcript had got.
  // Generation runs behind the customer's request: whoever reads the case waits for it, nobody else does.
  function generateSummary(c) {
    const upTo = c.transcript.length;
    c.summaryUpTo = upTo; // set now, not when the model answers: "did the bot chat since?" must not depend on timing
    c.summaryPending = Promise.resolve(c.summaryPending).then(() => summarize(c.transcript.slice(0, upTo), c.language)).then(async ({ text, exhausted }) => {
      c.summaryFailed = !text; // remembered so a claim can tell "never written" from "written, bot said nothing more"
      if (text) { c.summary = { text, upTo, at: clock.now(), regenerated: Boolean(c.summary) }; await record(c, c.summary.regenerated ? 'summary_regenerated' : 'summary_created'); }
      else await record(c, exhausted ? 'summary_unavailable' : 'summary_failed');
    });
    return c.summaryPending;
  }

  const stillWaiting = (c) => c.state === 'waiting';
  // A timer that does nothing once the case has been claimed or cancelled.
  const later = (c, ms, fn) => clock.setTimeout(async () => { if (stillWaiting(c)) await fn(); }, ms);

  // On-call first; the whole pool after broadcastMs unclaimed; the customer told "queued" after queuedNoticeMs.
  // The moment paging began is stored, so a restart arms the same two timers for the same moments.
  async function startPaging(c) {
    c.pagingStartedAt = clock.now();
    await page(c, onCall, 'case_paged');
    armPaging(c);
  }
  function armPaging(c) {
    if (!c.broadcastDone) later(c, remaining(c.pagingStartedAt, timers.broadcastMs), async () => { c.broadcastDone = true; await page(c, agents.list, 'case_broadcast'); });
    if (!c.queued) later(c, remaining(c.pagingStartedAt, timers.queuedNoticeMs), async () => { c.queued = true; await record(c, 'case_queued'); });
  }

  // Outside opening hours: queued at once, the customer is emailed, the page waits for the next shift start.
  const afterHoursQueue = new Set();
  async function queueUntilOpen(c, conversation) {
    c.queued = true;
    c.afterHours = true;
    await record(c, 'case_queued_after_hours');
    const email = conversation.session?.email;
    if (email) await send(c, { to: email, ...CUSTOMER_MAIL.received[c.language](c.ref) }, 'customer_confirmation_emailed');
    else await record(c, 'customer_email_missing');
    afterHoursQueue.add(c);
    armAfterHours(c);
  }
  // At shift start everything that queued is paged in one pass, priority cases first, then in the order they came in.
  function armAfterHours(c) {
    later(c, Math.max(0, hours.nextOpen(c.openedAt) - clock.now()), async () => {
      const batch = [...afterHoursQueue].filter(stillWaiting).sort((x, y) => Number(Boolean(y.priority)) - Number(Boolean(x.priority)) || x.openedAt - y.openedAt);
      afterHoursQueue.clear();
      for (const queued of batch) { queued.afterHours = false; queued.queued = false; await startPaging(queued); }
    });
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
    await send(c, holderText(c, 'The customer wrote', 'A customer has a new message waiting.'), 'agent_emailed');
  }

  // Opens a waiting case. `opening` is a confirmed draft: the first message of the case, ahead of the replayed chat.
  async function startCase({ conversationId, conversation, owner, tenant, ref, opening, req }) {
    // A customer who comes back after the window gets a new case that points at the last resolved one.
    const previous = store.latestFor(conversationId);
    const c = store.open({ conversationId, owner, tenant, language: conversation.language, ref });
    if (previous?.state === 'resolved' && previous.closeReason !== 'cancelled_by_user') c.linkedTo = previous.ref;
    if (opening) { add(c, 'customer', opening); c.draft = opening; }
    // The agent starts with the conversation so far, not a blank page.
    for (const m of conversation.history) add(c, m.role === 'user' ? 'customer' : 'bot', m.content);
    add(c, 'system', 'Case opened by the customer.');
    // Wrong-transfer cases carry a priority flag, decided from what the customer said (already through the shield).
    c.priority = [opening, ...conversation.history.filter((m) => m.role === 'user').map((m) => m.content)].some((t) => t && cuesIn(t).includes('wrong_transfer'));
    // Masked recent transactions are read now, while the customer's own request (and token) is in hand.
    try { c.records = (await recordsFor?.({ conversation, req, tenant })) ?? null; } catch { c.records = null; }
    generateSummary(c);
    c.customerEmail = conversation.session?.email ?? null;
    customerSeen(c);
    await record(c, 'handoff_opened');
    if (hours.isOpen(clock.now())) {
      // Ticket 38: the customer is emailed the reference. Fixed sentence and the reference only, never message content.
      if (c.customerEmail) await send(c, { to: c.customerEmail, ...CUSTOMER_MAIL.opened[c.language](c.ref) }, 'case_confirmation_emailed');
      else await record(c, 'customer_email_missing');
      await startPaging(c);
    } else await queueUntilOpen(c, conversation);
    return c;
  }

  async function openHandoff(req, res) {
    let body;
    try { body = await readJson(req); } catch { json(res, 400, { error: 'bad_request' }); return; }
    const owner = caller(req, res);
    if (!owner) return;
    const known = typeof body?.conversationId === 'string' ? conversations.get(body.conversationId) : undefined;
    if (known && known.owner !== owner) { json(res, 404, { error: 'not_found' }); return; }
    // A customer can ask for a person before saying anything: that starts a conversation.
    const conversationId = known ? body.conversationId : randomUUID();
    const conversation = known ?? { owner, history: [], language: 'en', asked: new Set(), session: null };
    conversation.lastActiveAt = clock.now();
    conversations.set(conversationId, conversation);
    const open = store.latestFor(conversationId);
    if (open && (open.state === 'waiting' || open.state === 'with_agent')) { json(res, 200, { conversationId, ...view(open) }); return; }
    if (reopenable(open)) { await reopen(open); json(res, 200, { conversationId, ...view(open) }); return; }
    const tenant = typeof body?.tenant === 'string' ? body.tenant.slice(0, 40) : conversation.session?.tenant ?? null;
    const c = await startCase({ conversationId, conversation, owner, tenant, req });
    json(res, 200, { conversationId, ...view(c) });
  }

  // The customer's own conversation, or a 404 that does not say whether the id exists.
  function ownConversation(req, res, id) {
    const owner = caller(req, res);
    if (!owner) return null;
    const conversation = typeof id === 'string' ? conversations.get(id) : undefined;
    if (conversation && conversation.owner === owner) return conversation;
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
    const messages = c.transcript.filter((m) => (m.from === 'agent' || m.public) && m.seq > after).map(({ seq, from, text }) => ({ seq, from, text }));
    if (url.searchParams.get('read') === '1') {
      const lastRead = Math.min(c.transcript.length, Math.max(after, ...messages.map((message) => message.seq), 0));
      if (lastRead > (c.customerReadSeq ?? 0)) c.customerReadSeq = lastRead;
    }
    json(res, 200, { ...view(c), messages, next: c.transcript.length });
  }

  // 'My cases' (ticket 38). The customer's own cases, found by the owner on the case, which is the owner derived from the
  // token when the case opened. No id or owner ever comes from the request.
  const customerState = (c) => (c.state === 'resolved' && c.closeReason === 'cancelled_by_user' ? 'cancelled' : c.state);
  // The last time something the customer could notice happened: a state change, or a message of theirs, an agent's or a
  // public notice. Internal system notes ("transferred from X to Y") do not count, their public twin does.
  const updatedAtOf = (c) => Math.max(c.openedAt, c.claimedAt ?? 0, c.resolvedAt ?? 0, c.reopenedAt ?? 0,
    ...(c.transfers ?? []).map((transfer) => transfer.at), ...c.transcript.filter((m) => m.from !== 'system' || m.public).map((m) => m.at));
  const iso = (ms) => new Date(ms).toISOString();
  const myCaseView = (c) => ({
    ref: c.ref, state: customerState(c), openedAt: iso(c.openedAt), updatedAt: iso(updatedAtOf(c)),
    ...(handle.unreadReplyFor(c.conversationId, c.owner) ?? {}),
  });
  // A closed case is listed for the retention period (measured like the purge job, so the two never disagree between runs);
  // a case still open is live work and is always listed. An email-only case is listed as 'emailed': it has a reference and
  // a date, but no chat and no progress to follow, and it expires like a closed case.
  const listable = (c, owner) => c.owner === owner
    && (c.state === 'waiting' || c.state === 'with_agent' || !retentionMs || clock.now() - lastActivity(c) <= retentionMs);
  function myCases(req, res) {
    const owner = caller(req, res, { verified: true });
    if (!owner) return;
    json(res, 200, { cases: store.all().filter((c) => listable(c, owner)).reverse().map(myCaseView) });
  }
  // One of the customer's own cases. An open one also names its conversation, so the widget can go back to that chat;
  // someone else's case (or none) is the same 404.
  function myCase(req, res, ref) {
    const owner = caller(req, res, { verified: true });
    if (!owner) return;
    const c = store.get(ref);
    if (!c || !listable(c, owner)) { json(res, 404, { error: 'not_found' }); return; }
    json(res, 200, { ...myCaseView(c), ...(c.state === 'waiting' || c.state === 'with_agent' ? { conversationId: c.conversationId } : {}) });
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
    const ok = verifyPassword(body?.password ?? '', agent?.password ?? randomUUID());
    if (!agent || !ok) { json(res, 401, { error: 'login_failed' }); return; }
    const token = randomUUID();
    sessions.set(token, { agent, expiresAt: clock.now() + sessionMs });
    json(res, 200, { token, name: agent.name, canReadAudit: canReadAudit(agent) });
  }

  // Only staff named in agents.auditReaders may read the audit log; being an agent is not enough.
  const canReadAudit = (agent) => (agents?.auditReaders ?? []).includes(agent.id);
  const MAX_AUDIT_ROWS = 500;
  // The filters the reader and the export share: one parser and one read, so the export can never hold more than the reader can show.
  // `from` and `to` are an ISO date or date-time; a bare `to` date includes that whole day.
  const auditFilter = (url) => {
    const param = (name) => url.searchParams.get(name) || undefined;
    const bound = (name, endOfDay) => {
      const raw = param(name);
      if (raw === undefined) return {};
      const ms = Date.parse(raw);
      if (Number.isNaN(ms)) return { bad: name };
      return { ms: endOfDay && /^\d{4}-\d\d-\d\d$/.test(raw) ? ms + 24 * 60 * 60_000 - 1 : ms };
    };
    const from = bound('from', false);
    const to = bound('to', true);
    if (from.bad || to.bad) return { error: 'bad_date' };
    return {
      filter: { from: param('from') ?? null, to: param('to') ?? null, conversationId: param('conversationId') ?? null, outcome: param('outcome') ?? null },
      query: { conversationId: param('conversationId'), outcome: param('outcome'), ...(from.ms === undefined ? {} : { fromMs: from.ms }), ...(to.ms === undefined ? {} : { toMs: to.ms }) },
    };
  };
  async function auditView(req, res, url) {
    const agent = agentOf(req, res);
    if (!agent) return;
    if (req.method !== 'GET') { json(res, 405, { error: 'read_only' }); return; }
    if (!canReadAudit(agent)) { json(res, 403, { error: 'not_authorised' }); return; }
    const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_AUDIT_ROWS) { json(res, 400, { error: 'bad_limit' }); return; }
    const parsed = auditFilter(url);
    if (parsed.error) { json(res, 400, { error: parsed.error }); return; }
    json(res, 200, { records: await audit.read({ ...parsed.query, limit }) });
  }

  // CSV columns: the common fields first, then every other field in the order it first appears. Cells that a spreadsheet
  // would run as a formula (customer text can start with = + - @) get a leading quote.
  const LEAD_COLUMNS = ['time', 'user', 'tenant', 'conversationId', 'outcome'];
  const csvCell = (value) => {
    if (value === undefined || value === null) return '';
    let text = typeof value === 'string' ? value : JSON.stringify(value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const toCsv = (records) => {
    const columns = [...LEAD_COLUMNS];
    for (const r of records) for (const k of Object.keys(r)) if (!columns.includes(k)) columns.push(k);
    return [columns.join(','), ...records.map((r) => columns.map((c) => csvCell(r[c])).join(','))].map((l) => `${l}\r\n`).join('');
  };
  // Download of the audit log for review. Same authorisation, same records and same masking as the reader; the export
  // itself is written to the audit log (who, when, which filter, how many records) before the file is sent.
  async function auditExport(req, res, url) {
    const agent = agentOf(req, res);
    if (!agent) return;
    if (req.method !== 'GET') { json(res, 405, { error: 'read_only' }); return; }
    if (!canReadAudit(agent)) { json(res, 403, { error: 'not_authorised' }); return; }
    const format = url.searchParams.get('format') ?? 'json';
    if (format !== 'json' && format !== 'csv') { json(res, 400, { error: 'bad_format' }); return; }
    const parsed = auditFilter(url);
    if (parsed.error) { json(res, 400, { error: parsed.error }); return; }
    const records = await audit.read({ ...parsed.query, limit: Infinity });
    await audit.append({ user: `agent:${agent.id}`, tenant: null, conversationId: null, outcome: 'audit_exported', agent: agent.id, format, filter: parsed.filter, records: records.length });
    const body = format === 'csv' ? toCsv(records) : JSON.stringify(records, null, 2);
    const stamp = new Date(clock.now()).toISOString().slice(0, 10);
    res.writeHead(200, {
      'content-type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="audit-${stamp}.${format}"`,
      'cache-control': 'no-store',
    }).end(body);
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

  // A held case is closed to every agent but the holder, until the 30-minute re-broadcast opens it to the pool.
  const isOpenToPool = (c) => c.state === 'with_agent' && c.openToPool === true;
  const mayOpen = (c, agent) => !c.agent || c.agent.id === agent.id || isOpenToPool(c);

  // How long the customer has been waiting on this case, and for what: an unclaimed case waits for an agent from the moment it
  // opened; a held case waits for a reply from the moment its silence clock started (the claim, the customer's message that
  // the agent had not answered, a reopen or a transfer). Once the agent answers, or the case is closed, nobody is waiting.
  const waitOf = (c) => {
    if (c.state === 'waiting') return { since: c.openedAt, for: 'claim' };
    if (c.state === 'with_agent' && c.awaitingAgent) return { since: c.silenceStartedAt, for: 'reply' };
    return null;
  };
  // The levels come from the same timers the lifecycle runs on: the whole pool is paged at broadcastMs and the customer is told
  // "queued" at queuedNoticeMs; agent silence is audited at agentSilenceMs and re-broadcast at agentFollowUpMs.
  const thresholds = {
    waiting: { warnSeconds: timers.broadcastMs / 1000, urgentSeconds: timers.queuedNoticeMs / 1000 },
    withAgent: { warnSeconds: timers.agentSilenceMs / 1000, urgentSeconds: timers.agentFollowUpMs / 1000 },
  };
  const levelOf = (waiting, ms) => {
    const t = waiting.for === 'claim' ? thresholds.waiting : thresholds.withAgent;
    return ms >= t.urgentSeconds * 1000 ? 'urgent' : ms >= t.warnSeconds * 1000 ? 'warning' : 'normal';
  };

  const row = (c, agent) => {
    const waiting = waitOf(c);
    const ms = waiting ? Math.max(0, clock.now() - waiting.since) : null;
    return {
      ref: c.ref, state: c.state, language: c.language, priority: Boolean(c.priority), claimedBy: c.agent?.name ?? null, closeReason: c.closeReason,
      ageSeconds: Math.max(0, Math.floor((clock.now() - c.openedAt) / 1000)),
      ...(mayOpen(c, agent) && (c.summary?.text || c.draft) ? { queueSummary: c.summary?.text ?? c.draft, queueSummarySource: c.summary?.text ? 'assistant' : 'customer' } : {}),
      waitingSeconds: ms === null ? null : Math.floor(ms / 1000),
      waitingFor: waiting?.for ?? null,
      waitLevel: waiting ? levelOf(waiting, ms) : null,
      // Can this agent claim it now: unclaimed, or re-broadcast after 30 minutes of the holder's silence (not the holder).
      claimable: c.state === 'waiting' || (isOpenToPool(c) && c.agent.id !== agent?.id),
    };
  };

  function agentCases(req, res) {
    const agent = agentOf(req, res);
    if (!agent) return;
    // Open priority cases first, then the longest waiting; what nobody is waiting on (answered, resolved) follows, newest first.
    const open = (r) => r.state === 'waiting' || r.state === 'with_agent';
    const rows = store.all().reverse().map((c) => row(c, agent));
    rows.sort((x, y) => Number(y.priority && open(y)) - Number(x.priority && open(x)) || (y.waitingSeconds ?? -1) - (x.waitingSeconds ?? -1));
    json(res, 200, { cases: rows, thresholds });
  }

  const MAX_TEXT = 1000;

  async function caseDetail(res, ref, agent) {
    const c = store.get(ref);
    if (!c) { json(res, 404, { error: 'not_found' }); return; }
    // A case somebody has claimed (or handled) is theirs alone; a colleague learns only who has it. Unclaimed cases
    // are open to the pool, which is who gets paged. A transfer (ticket 30) hands the case over by changing c.agent.
    if (!mayOpen(c, agent)) { json(res, 403, { error: 'not_your_case', claimedBy: c.agent.name }); return; }
    if (c.agent?.id === agent.id) agentSeen(c);
    await c.summaryPending;
    json(res, 200, {
      ...row(c, agent), conversationId: c.conversationId, linkedTo: c.linkedTo,
      colleagues: agents.list.filter((a) => a.id !== agent.id).map(({ id, name }) => ({ id, name })), draft: c.draft ?? null,
      summary: c.summary ? { text: c.summary.text, label: SUMMARY_LABEL[c.language], regenerated: c.summary.regenerated } : null,
      summaryUnavailable: !c.summary,
      records: c.records ?? null,
      notes: (c.notes ?? []).map(({ id, agent: by, agentId, text, at }) => ({ id, agent: by, agentId, text, at })),
      transcript: c.transcript.map(({ seq, from, text, at }) => ({ seq, from, text, at })) });
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
    agentAnswered(c);
    touch(c);
    await mailCustomerIfGone(c);
    json(res, 200, { ok: true });
  }

  // Suggested replies (ticket 42): 1 to 3 drafts for the holder to edit. Nothing is added to the case or sent; the model call goes
  // through the metered path (it counts against the request and token budgets) and any failure is a quiet empty answer.
  async function suggestReplies(req, res, agent, ref) {
    let body;
    try { body = await readJson(req); } catch { json(res, 400, { error: 'bad_request' }); return; }
    const c = ownCase(res, agent, ref);
    if (!c) return;
    const count = body?.count === undefined ? MAX_SUGGESTIONS : body.count;
    if (!Number.isInteger(count) || count < 1 || count > MAX_SUGGESTIONS) { json(res, 400, { error: 'bad_count' }); return; }
    const { suggestions: drafts, reason } = await suggest(c.transcript, c.language, count);
    await record(c, 'suggestions_requested', { agent: agent.id, requested: count, shown: drafts.length, ...(reason ? { reason } : {}) });
    json(res, 200, drafts.length ? { suggestions: drafts } : { suggestions: [], message: NO_SUGGESTIONS });
  }

  // Internal notes (ticket 42). Any agent who may open the case can read and add them; they are not part of the transcript, so the
  // customer's view, the emails and the summary never see them. Stored masked and written to the audit log.
  async function addNote(req, res, agent, ref) {
    let body;
    try { body = await readJson(req); } catch { json(res, 400, { error: 'bad_request' }); return; }
    const c = store.get(ref);
    if (!c) { json(res, 404, { error: 'not_found' }); return; }
    if (!mayOpen(c, agent)) { json(res, 403, { error: 'not_your_case', claimedBy: c.agent.name }); return; }
    const raw = typeof body?.text === 'string' ? body.text.trim() : '';
    if (!raw || raw.length > MAX_TEXT) { json(res, 400, { error: 'bad_text' }); return; }
    const text = scrub(maskText(shield(raw).text));
    const note = store.addNote(c, agent, text);
    await record(c, 'case_note_added', { agent: agent.id, noteId: note.id, noteText: note.text });
    json(res, 200, { note });
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
    const conversation = ownConversation(req, res, body?.conversationId);
    if (!conversation) return;
    const c = store.latestFor(body.conversationId);
    if (c?.state !== 'resolved' || c.solved !== null || c.closeReason !== 'resolved_by_agent') { json(res, 409, { error: 'not_asked' }); return; }
    if (typeof body.solved !== 'boolean') { json(res, 400, { error: 'bad_request' }); return; }
    c.solved = body.solved;
    await audit.append({
      time: new Date(clock.now()).toISOString(), user: c.owner, tenant: c.tenant, conversationId: c.conversationId,
      userText: '', replyText: '', outcome: 'case_feedback', caseRef: c.ref, solved: c.solved,
    });
    if (c.solved) { json(res, 200, { ok: true }); return; }
    // "No" asks for a person again, exactly like the chip: inside the window the same case comes back, later a new linked one.
    // (A resolved_by_agent case is never a cancelled one, so the reopenable rule's cancelled exception cannot apply here.)
    let current = c;
    if (reopenable(c)) await reopen(c);
    else current = await startCase({ conversationId: c.conversationId, conversation, owner: c.owner, tenant: c.tenant, req });
    json(res, 200, { ok: true, conversationId: c.conversationId, ...view(current) });
  }

  // The holder hands the case to a colleague. It is the same case: transcript, draft, summary, records and priority
  // stay on it, only the agent changes. The customer is told in neutral words; the colleague is paged with a link.
  async function transferCase(req, res, agent, ref) {
    let body;
    try { body = await readJson(req); } catch { json(res, 400, { error: 'bad_request' }); return; }
    const c = ownCase(res, agent, ref);
    if (!c) return;
    const target = typeof body?.to === 'string' ? agents.list.find((a) => a.id === body.to) : undefined;
    if (!target || target.id === agent.id) { json(res, 400, { error: 'bad_agent' }); return; }
    store.transfer(c, target);
    add(c, 'system', `Case transferred from ${agent.name} to ${target.name}.`);
    agentSeen(c);
    awaitAgent(c); // the colleague starts with a fresh clock: the customer has not been waiting on them
    touch(c);
    await record(c, 'case_transferred', { fromAgent: agent.id, toAgent: target.id });
    await send(c, holderText(c, 'A case was transferred to you', 'A colleague has transferred a customer case to you.'), 'case_transfer_paged');
    json(res, 200, { ref, state: 'with_agent', claimedBy: target.name });
  }

  // A re-broadcast case: the first colleague to claim takes it over. The customer is told in the same neutral words as
  // for a transfer, the previous holder is out, and the new holder starts with a fresh clock.
  async function takeOverCase(res, agent, ref) {
    const taken = store.takeOver(ref, agent);
    if (!taken.ok) { json(res, taken.reason === 'not_found' ? 404 : 409, { error: taken.reason }); return; }
    const c = taken.case;
    add(c, 'system', `Case taken over by ${agent.name} from ${taken.from.name} after the re-broadcast.`);
    agentSeen(c);
    awaitAgent(c);
    touch(c);
    await record(c, 'case_claimed_after_rebroadcast', { fromAgent: taken.from.id, toAgent: agent.id });
    json(res, 200, { ref, state: 'with_agent', claimedBy: agent.name });
  }

  async function claimCase(res, agent, ref) {
    const held = store.get(ref);
    if (held && isOpenToPool(held) && held.agent.id !== agent.id) { await takeOverCase(res, agent, ref); return; }
    const claimed = store.claim(ref, agent);
    if (!claimed.ok) { json(res, claimed.reason === 'not_found' ? 404 : 409, { error: claimed.reason }); return; }
    // The summary dates from the handoff. It is made again if the bot answered the customer after that, or once if the
    // last attempt failed (a good summary is never regenerated just because the agent claimed).
    const botChatted = claimed.case.transcript.some((m) => m.from === 'bot' && m.seq > claimed.case.summaryUpTo);
    const retry = claimed.case.summaryFailed && !claimed.case.summaryRetried;
    if (botChatted || retry) { claimed.case.summaryRetried = true; generateSummary(claimed.case); }
    awaitAgent(claimed.case);
    touch(claimed.case);
    customerSeen(claimed.case); // the customer was in the queue a moment ago; the clock for "gone" starts from the claim
    agentSeen(claimed.case);
    await record(claimed.case, 'case_claimed');
    json(res, 200, { ref, state: 'with_agent', claimedBy: agent.name });
  }

  // Staff dashboard (ticket 46): figures for a date range and language, computed from the audit log and the
  // failed-question log only. Same authorisation as the audit reader. Read only; nothing is written to the audit log.
  async function dashboard(req, res, url) {
    const agent = agentOf(req, res);
    if (!agent) return;
    if (req.method !== 'GET') { json(res, 405, { error: 'read_only' }); return; }
    if (!canReadAudit(agent)) { json(res, 403, { error: 'not_authorised' }); return; }
    const language = url.searchParams.get('language') || 'all';
    if (!['all', 'en', 'fr'].includes(language)) { json(res, 400, { error: 'bad_language' }); return; }
    const parsed = auditFilter(url);
    if (parsed.error) { json(res, 400, { error: parsed.error }); return; }
    const { fromMs = -Infinity, toMs = Infinity } = parsed.query;
    const records = await audit.read({ fromMs, toMs, limit: Infinity });
    const failed = ((await failedQuestions?.all?.()) ?? []).filter((f) => { const at = Date.parse(f.time); return at >= fromMs && at <= toMs; });
    json(res, 200, { range: { from: parsed.filter.from, to: parsed.filter.to }, ...computeDashboard({ records, failedQuestions: failed, language }) });
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://local');
    if (req.method === 'POST' && url.pathname === '/handoff') { await openHandoff(req, res); return true; }
    if (req.method === 'GET' && url.pathname === '/case') { customerStatus(req, res, url); return true; }
    if (req.method === 'GET' && url.pathname === '/case/mine') { myCases(req, res); return true; }
    const mine = req.method === 'GET' ? /^\/case\/mine\/([A-Za-z0-9-]{1,20})$/.exec(url.pathname) : null;
    if (mine) { myCase(req, res, mine[1]); return true; }
    if (req.method === 'POST' && url.pathname === '/case/cancel') { await cancelCase(req, res); return true; }
    if (req.method === 'POST' && url.pathname === '/case/feedback') { await solvedFeedback(req, res); return true; }
    if (req.method === 'POST' && url.pathname === '/agent/login') { await agentLogin(req, res); return true; }
    if (url.pathname === '/agent/dashboard') { await dashboard(req, res, url); return true; }
    if (url.pathname === '/agent/audit/export') { await auditExport(req, res, url); return true; }
    if (url.pathname === '/agent/audit') { await auditView(req, res, url); return true; }
    if (req.method === 'GET' && url.pathname === '/agent/cases') { agentCases(req, res); return true; }
    const target = /^\/agent\/cases\/([A-Za-z0-9-]{1,20})(?:\/(claim|messages|resolve|transfer|suggestions|notes))?$/.exec(url.pathname);
    if (target) {
      const agent = agentOf(req, res);
      if (!agent) return true;
      if (req.method === 'POST' && target[2] === 'claim') await claimCase(res, agent, target[1]);
      else if (req.method === 'POST' && target[2] === 'messages') await agentMessage(req, res, agent, target[1]);
      else if (req.method === 'POST' && target[2] === 'resolve') await resolveCase(res, agent, target[1]);
      else if (req.method === 'POST' && target[2] === 'transfer') await transferCase(req, res, agent, target[1]);
      else if (req.method === 'POST' && target[2] === 'suggestions') await suggestReplies(req, res, agent, target[1]);
      else if (req.method === 'POST' && target[2] === 'notes') await addNote(req, res, agent, target[1]);
      else if (req.method === 'GET' && !target[2]) await caseDetail(res, target[1], agent);
      else json(res, 404, { error: 'not_found' });
      return true;
    }
    return false;
  }

  // After a restart (ticket 62): the cases loaded from the database that are still live get their timers back, from the
  // times stored on them. Nobody is paged again for a page already sent; a deadline already past fires at once.
  handle.resume = () => {
    for (const c of store.all()) {
      if (c.state === 'waiting') {
        if (c.afterHours) { afterHoursQueue.add(c); armAfterHours(c); }
        else if (c.pagingStartedAt != null) armPaging(c);
        else if (hours.isOpen(clock.now())) startPaging(c).catch(() => {}); // it was opened but never paged before the stop
        else { c.queued = true; c.afterHours = true; afterHoursQueue.add(c); armAfterHours(c); }
      } else if (c.state === 'with_agent') {
        if (c.awaitingAgent) armSilence(c);
        c.activityAt ??= c.claimedAt ?? c.openedAt;
        armActivity(c);
      }
    }
  };
  handle.flush = () => store.flush();
  // A conversation that began as a guest became the customer's own when their session started: so do its cases.
  handle.adopt = (conversationId, owner) => { for (const c of store.all()) if (c.conversationId === conversationId) c.owner = owner; };
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
  handle.sendChatDraft = async ({ conversationId, conversation, tenant, ref, text, req }) => {
    let open = handle.openCaseFor(conversationId);
    // A draft inside the window is a new message on the resolved case: it comes back instead of a second one opening.
    const resolved = store.latestFor(conversationId);
    if (!open && reopenable(resolved)) { await reopen(resolved); open = resolved; }
    if (!open) return view(await startCase({ conversationId, conversation, owner: conversation.owner, tenant, ref, opening: text, req }));
    add(open, 'customer', text);
    if (open.state === 'with_agent') {
      await mailAgentIfGone(open);
      if (!open.awaitingAgent) awaitAgent(open);
      touch(open);
    }
    customerSeen(open);
    await record(open, 'draft_added_to_case');
    return view(open);
  };
  // The reference a draft belongs to: the open case, or (for chat) the resolved one a confirmed draft would reopen.
  handle.caseRefFor = (conversationId, { reopen: counts = true } = {}) => {
    const c = store.latestFor(conversationId);
    if (c && (c.state === 'waiting' || c.state === 'with_agent')) return c.ref;
    return counts && reopenable(c) ? c.ref : null;
  };
  handle.refInUse = (ref) => Boolean(store.get(ref));
  handle.purge = (cutoff) => store.purge(cutoff);
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
    if (!c.awaitingAgent) awaitAgent(c); // the customer now waits for an answer
    touch(c);
    customerSeen(c);
  };
  // A waiting case: the bot keeps answering, and both sides of the turn are kept on the case.
  handle.waitingCaseFor = (conversationId) => {
    const c = store.latestFor(conversationId);
    return c?.state === 'waiting' ? c : null;
  };
  // Only the customer-facing list handlers call this after filtering conversations/cases by the signed owner.
  // The read cursor is stored with the case so the unread state survives a widget close and a service restart.
  handle.unreadReplyFor = (conversationId, owner) => {
    const c = store.latestFor(conversationId);
    if (!c || c.owner !== owner) return null;
    const latest = [...c.transcript].reverse().find((message) => message.from === 'agent');
    if (!latest || latest.seq <= (c.customerReadSeq ?? 0)) return null;
    return { unreadReply: true, latestAgentReplyAt: new Date(latest.at).toISOString() };
  };
  handle.mirrorTurn = (c, question, answer) => {
    add(c, 'customer', question);
    if (answer) add(c, 'bot', answer);
  };
  return handle;
}
