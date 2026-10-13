import { createHash, randomUUID } from 'node:crypto';
import { json, readJson } from './http.js';
import { ownerOf, tokenOf } from './identity.js';
import { maskText } from './mask.js';
import { WARNING, shield } from './shield.js';
import { NOTICE } from './handoff.js';

const MAX_WORDS = 3; // how many of the customer's latest messages go into the draft
const MAX_WORD_LENGTH = 400;

const LABELS = {
  reference: { en: 'Transaction id', fr: 'Identifiant de la transaction' },
  amount: { en: 'Amount', fr: 'Montant' },
  date: { en: 'Date', fr: 'Date' },
  account: { en: 'Account', fr: 'Compte' },
  counterparty: { en: 'Counterparty', fr: 'Contrepartie' },
  status: { en: 'Status', fr: 'Statut' },
};
// Fixed wording around the customer's own words. It asks for a review and promises nothing.
const FRAME = {
  en: { intro: 'Hello, I need help with a transaction.', words: 'What happened, in my words:', ask: 'Please look into it and tell me what can be done.' },
  fr: { intro: "Bonjour, j'ai besoin d'aide pour une opération.", words: "Ce qui s'est passé, avec mes mots :", ask: 'Merci de regarder ce dossier et de me dire ce qui peut être fait.' },
};

const DESTINATIONS = ['chat', 'email', 'both'];
const MAX_TEXT = 2000;
const DETAILS_HEADING = { en: 'Transaction details (masked):', fr: 'Détails de la transaction (masqués) :' };
const SUBJECT = { en: 'Customer case message', fr: 'Message du client pour un dossier' };
const CASE_LINE = { en: 'Case', fr: 'Dossier' };
// Said once after sending. It gives the reference and when to expect an update, and promises no outcome.
const SENT_TO = {
  chat: { en: 'the live chat', fr: 'le chat' },
  email: { en: 'our support team by email', fr: "notre équipe d'assistance par e-mail" },
  both: { en: 'the live chat and our support team by email', fr: "le chat et notre équipe d'assistance par e-mail" },
};
const CONFIRMATION = {
  en: (ref, to) => `Your message was sent to ${to}. Your case reference is ${ref}. ${NOTICE.en}`,
  fr: (ref, to) => `Votre message a été envoyé à ${to}. Votre référence de dossier est ${ref}. ${NOTICE.fr}`,
};

// The read-only lines of a draft, from the masked transaction record. A part the record lacks is left out.
function detailLines(tx, language) {
  const values = {
    reference: tx.reference,
    amount: tx.amount != null ? `${tx.amount}${tx.currency ? ` ${tx.currency}` : ''}` : null,
    date: tx.date,
    account: tx.account,
    counterparty: tx.counterparty,
    status: tx.status,
  };
  return Object.entries(values).filter(([, value]) => value != null).map(([key, value]) => ({ key, label: LABELS[key][language], value: String(value) }));
}

// The customer's drafted case message (ticket 31). Nothing here sends anything: a draft only becomes a case or an
// email when the customer confirms the exact content they were shown.
export function createDrafts({ t1, entitlementsFor, conversations, handoff, supportAddress, mailer, clock, audit }) {
  const drafts = new Map(); // conversationId -> the customer's current draft

  async function create(req, res) {
    let body;
    try { body = await readJson(req); } catch { json(res, 400, { error: 'bad_request' }); return; }
    const conversation = typeof body?.conversationId === 'string' ? conversations.get(body.conversationId) : undefined;
    if (!conversation || conversation.owner !== ownerOf(tokenOf(req))) { json(res, 404, { error: 'not_found' }); return; }
    const language = conversation.language;
    const entitlements = await entitlementsFor(req, body.tenant, conversation);
    const found = t1 ? await t1.caseTransaction(conversation, tokenOf(req), entitlements, body.reference ?? conversation.lastReference) : null;
    const details = found ? detailLines(found.transaction, language) : [];
    const words = conversation.history.filter((m) => m.role === 'user').slice(-MAX_WORDS).map((m) => m.content.slice(0, MAX_WORD_LENGTH));
    const frame = FRAME[language];
    const text = [frame.intro, '', frame.words, ...words.map((w) => `> ${w}`), '', frame.ask].join('\n');
    const draft = { id: randomUUID(), conversationId: body.conversationId, owner: conversation.owner, tenant: typeof body.tenant === 'string' ? body.tenant.slice(0, 40) : null, details, scrub: found?.scrub ?? ((t) => t), ref: null, preview: null };
    drafts.set(body.conversationId, draft);
    json(res, 200, { draftId: draft.id, language, text, details, detailsFound: Boolean(found) });
  }

  // The customer's current draft, or null after a 404 for an id that is not theirs.
  function ownDraft(res, req, body) {
    const draft = typeof body?.conversationId === 'string' ? drafts.get(body.conversationId) : undefined;
    if (!draft || draft.owner !== ownerOf(tokenOf(req)) || draft.id !== body.draftId) { json(res, 404, { error: 'not_found' }); return null; }
    return draft;
  }

  // The exact content, built once: what the preview returns is what a confirm will send.
  async function preview(req, res) {
    let body;
    try { body = await readJson(req); } catch { json(res, 400, { error: 'bad_request' }); return; }
    const draft = ownDraft(res, req, body);
    if (!draft) return;
    if (!DESTINATIONS.includes(body.destination)) { json(res, 400, { error: 'bad_destination' }); return; }
    if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > MAX_TEXT) { json(res, 400, { error: 'bad_text' }); return; }
    const language = conversations.get(draft.conversationId).language;
    // What the customer typed is untrusted like any message: secrets come out, long numbers and the counterparty's name are masked.
    const shielded = shield(body.text.trim());
    const words = draft.scrub(maskText(shielded.text));
    const lines = draft.details.map((d) => `${d.label}: ${d.value}`);
    const content = lines.length ? `${words}\n\n${DETAILS_HEADING[language]}\n${lines.join('\n')}` : words;
    draft.ref = handoff.caseRefFor(draft.conversationId, { reopen: body.destination !== 'email' }) ?? draft.ref ?? handoff.reserveRef();
    const shown = {
      destination: body.destination,
      ...(body.destination !== 'email' ? { chat: { text: content } } : {}),
      ...(body.destination !== 'chat' ? { email: { to: supportAddress, subject: `[${draft.ref}] ${SUBJECT[language]}`, body: `${CASE_LINE[language]}: ${draft.ref}\n\n${content}` } } : {}),
    };
    const previewToken = createHash('sha256').update(JSON.stringify(shown)).digest('hex');
    draft.preview = { token: previewToken, content, ...shown };
    json(res, 200, { previewToken, ref: draft.ref, ...shown, ...(shielded.flagged ? { warning: { code: 'secret_input', text: WARNING[language] } } : {}) });
  }

  // Sends exactly what the last preview showed, and only when the confirm carries that preview's token.
  async function confirm(req, res) {
    let body;
    try { body = await readJson(req); } catch { json(res, 400, { error: 'bad_request' }); return; }
    const draft = ownDraft(res, req, body);
    if (!draft) return;
    if (!draft.preview || body.previewToken !== draft.preview.token) { json(res, 409, { error: 'not_previewed' }); return; }
    if (draft.sent) { json(res, 409, { error: 'already_sent' }); return; }
    // A case opened since the preview has its own reference: what was shown (the subject) would no longer be true.
    const current = handoff.caseRefFor(draft.conversationId, { reopen: draft.preview.destination !== 'email' });
    if (current ? current !== draft.ref : handoff.refInUse(draft.ref)) { json(res, 409, { error: 'case_changed' }); return; }
    draft.sent = true; // before any await: a second confirm cannot send it twice
    const conversation = conversations.get(draft.conversationId);
    const { language } = conversation;
    const { destination, content, email } = draft.preview;
    const filing = { conversationId: draft.conversationId, conversation, tenant: draft.tenant, ref: draft.ref, text: content, req };
    const record = (outcome) => audit.append({
      time: new Date(clock.now()).toISOString(), user: draft.owner, tenant: draft.tenant, conversationId: draft.conversationId,
      userText: '', replyText: '', outcome, caseRef: draft.ref, destination,
    });
    // The email goes first: if it cannot be sent, no case is opened and the customer can send the same draft again.
    if (email) {
      try { await mailer.send(email); } catch {
        draft.sent = false;
        await record('draft_email_failed');
        json(res, 502, { error: 'email_failed' });
        return;
      }
    }
    const view = destination === 'email' ? await handoff.fileEmailedDraft(filing) : await handoff.sendChatDraft(filing);
    await record('draft_sent');
    json(res, 200, { ...view, destination, confirmation: CONFIRMATION[language](draft.ref, SENT_TO[destination][language]) });
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://local');
    if (req.method === 'POST' && url.pathname === '/draft') { await create(req, res); return true; }
    if (req.method === 'POST' && url.pathname === '/draft/preview') { await preview(req, res); return true; }
    if (req.method === 'POST' && url.pathname === '/draft/confirm') { await confirm(req, res); return true; }
    return false;
  }
  // Retention: a forgotten conversation takes its draft with it.
  handle.forget = (conversationId) => drafts.delete(conversationId);
  return handle;
}
