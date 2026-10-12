// <bank-assistant> chat widget. Mounted by one script tag; talks only to the
// assistant service (never to a model). Attributes: api (service base URL,
// default same origin), tenant, token (demo only; the portal sets
// el.getToken = () => userToken instead). For account reads the host also
// provides the customer's cli once (cli attribute or el.getCli) and, until the
// backend can supply them, gating data (gating attribute or el.getGating).
// Host events (all cancelable): bank-assistant:navigate {path, target} when a card asks for a page, and
// bank-assistant:prefill {form, fields} when a pre-fill card has a page to fill. A host that cancels the second one
// owns the fill (the production hook); otherwise the widget fills matching inputs of the page itself.
// fill-timeout (attribute, ms, default 3000): how long to wait for the form to appear after navigating.
// Handoff: only a click on the human chip asks the service for a case (the host also hears
// bank-assistant:handoff-request). The widget then shows the case banner and polls the service every poll-ms
// (attribute, default 2000) for the case state and the agent's messages.
// Disputed transactions (a dispute, a wrong transfer, a reversal, a debit without credit): the chip click opens a
// draft message for the customer to edit and review instead. Nothing is sent, and no case is opened, until the
// customer confirms the exact content on the confirm screen.
const TEXT = {
  en: {
    title: 'Assistant',
    placeholder: 'Ask how to do something…',
    send: 'Send',
    human: 'Talk to a human agent',
    thinking: 'Thinking…',
    used: 'What I used',
    error: 'The assistant is unavailable right now. Please try again.',
    pinTitle: 'Enter your PIN to see your balance. It is not sent to the assistant or kept in the chat.',
    pinPlaceholder: 'PIN',
    pinSubmit: 'Unlock balance',
    pinWrong: (n) => (n === null || n === undefined ? 'Wrong PIN.' : `Wrong PIN. ${n} attempt${n === 1 ? '' : 's'} left.`),
    pinBlocked: 'Your PIN is blocked. Please contact the bank.',
    pinExpired: 'Your session has expired. Please sign in again.',
    pinUnavailable: 'The PIN check is unavailable right now. Please try again.',
    disclaimer: 'Automated assistant, it may make mistakes. It will never ask for your PIN or OTP.',
    beneficiary: 'Beneficiary',
    amount: 'Amount',
    filled: 'Filled by the assistant. Check it before you continue.',
    copyTitle: 'These fields could not be filled. Copy the values:',
    copy: 'Copy',
    caseWaiting: 'Waiting for an agent',
    caseWithAgent: 'With an agent',
    caseRef: (ref) => `Case ${ref}`,
    cancel: 'Cancel',
    humanBadge: 'human agent',
    automated: 'Automated reply',
    agentJoined: (name) => `${name} (human agent) joined. The assistant is now muted.`,
    cancelled: (ref) => `Case ${ref} closed: cancelled by you. Back to the assistant.`,
    resolved: (ref) => `Case ${ref} resolved.`,
    solvedQ: 'Was this solved?',
    yes: 'Yes',
    no: 'No',
    thanks: 'Thank you for your feedback.',
    handoffError: 'We could not reach support right now. Please try again.',
    draftTitle: 'Review your message before it goes anywhere',
    draftHint: 'I wrote this from what you told me and your transaction record. Change anything you like. The transaction details below are masked and cannot be edited.',
    destChat: 'Live chat with an agent',
    destEmail: 'Email to the support team',
    destBoth: 'Both',
    review: 'Review what will be sent',
    skip: 'Open the chat without a message',
    discard: 'Discard',
    confirmNote: 'This is exactly what will be sent. Nothing has been sent yet.',
    previewChat: 'Message for the live chat',
    previewEmail: 'Email to the support team',
    to: 'To',
    subject: 'Subject',
    confirmSend: 'Confirm and send',
    back: 'Back and edit',
    draftError: 'We could not prepare your message. Please try again.',
    sendError: 'Nothing was sent. Please try again.',
    caseChanged: 'Your case changed in the meantime. Nothing was sent: please review your message again.',
  },
  fr: {
    title: 'Assistant',
    placeholder: 'Demandez comment faire…',
    send: 'Envoyer',
    human: 'Parler à un agent',
    thinking: 'Réflexion en cours…',
    used: "Ce que j'ai utilisé",
    error: "L'assistant est indisponible pour le moment. Veuillez réessayer.",
    pinTitle: "Saisissez votre PIN pour voir votre solde. Il n'est pas envoyé à l'assistant ni conservé dans le chat.",
    pinPlaceholder: 'PIN',
    pinSubmit: 'Déverrouiller le solde',
    pinWrong: (n) => (n === null || n === undefined ? 'PIN incorrect.' : `PIN incorrect. Il reste ${n} tentative${n === 1 ? '' : 's'}.`),
    pinBlocked: 'Votre PIN est bloqué. Veuillez contacter la banque.',
    pinExpired: 'Votre session a expiré. Veuillez vous reconnecter.',
    pinUnavailable: 'La vérification du PIN est indisponible. Veuillez réessayer.',
    disclaimer: 'Assistant automatique, il peut se tromper. Il ne vous demandera jamais votre PIN ni votre OTP.',
    beneficiary: 'Bénéficiaire',
    amount: 'Montant',
    filled: 'Rempli par l’assistant. Vérifiez avant de continuer.',
    copyTitle: 'Ces champs n’ont pas pu être remplis. Copiez les valeurs :',
    copy: 'Copier',
    caseWaiting: "En attente d'un agent",
    caseWithAgent: 'Avec un agent',
    caseRef: (ref) => `Dossier ${ref}`,
    cancel: 'Annuler',
    humanBadge: 'agent humain',
    automated: 'Réponse automatique',
    agentJoined: (name) => `${name} (agent humain) a rejoint la conversation. L'assistant est maintenant en sourdine.`,
    cancelled: (ref) => `Dossier ${ref} fermé : annulé par vous. Retour à l'assistant.`,
    resolved: (ref) => `Dossier ${ref} résolu.`,
    solvedQ: 'Cela a-t-il résolu votre problème ?',
    yes: 'Oui',
    no: 'Non',
    thanks: 'Merci pour votre retour.',
    handoffError: "Nous n'avons pas pu joindre le support pour le moment. Veuillez réessayer.",
    draftTitle: 'Relisez votre message avant tout envoi',
    draftHint: "Je l'ai rédigé à partir de ce que vous m'avez dit et de votre opération. Modifiez ce que vous voulez. Les détails de l'opération ci-dessous sont masqués et non modifiables.",
    destChat: 'Chat en direct avec un agent',
    destEmail: "E-mail à l'équipe d'assistance",
    destBoth: 'Les deux',
    review: 'Vérifier ce qui sera envoyé',
    skip: 'Ouvrir le chat sans message',
    discard: 'Abandonner',
    confirmNote: "Voici exactement ce qui sera envoyé. Rien n'a encore été envoyé.",
    previewChat: 'Message pour le chat en direct',
    previewEmail: "E-mail à l'équipe d'assistance",
    to: 'À',
    subject: 'Objet',
    confirmSend: 'Confirmer et envoyer',
    back: 'Retour pour modifier',
    draftError: "Nous n'avons pas pu préparer votre message. Veuillez réessayer.",
    sendError: "Rien n'a été envoyé. Veuillez réessayer.",
    caseChanged: "Votre dossier a changé entre-temps. Rien n'a été envoyé : relisez votre message.",
  },
};

const PLAIN_PATH = /^\/(?!\/)[A-Za-z0-9\-/]*$/;
const PLAIN_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
// Never filled, whatever a card says: PIN, OTP, password, voucher and code inputs (by name, id or type).
const SECRET = /pin|otp|pass|voucher|code|cvv|token|secret|mdp/i;
// Chip reasons for a disputed transaction (a dispute, a wrong transfer, a reversal, a debit with no credit): the chip
// click starts a drafted message. Fraud cues and plain "contact the bank" endings keep opening the handoff directly.
const DISPUTE_REASONS = ['dispute', 'wrong_transfer', 'reversal', 'debit_without_credit', 'reversal_in_progress'];
const RESUME_KEY = 'bank-assistant:prefill';
const RESUME_MS = 60_000;
const text = (v, max) => (typeof v === 'string' && v.length <= max ? v : null);

class BankAssistant extends HTMLElement {
  connectedCallback() {
    this.lang = this.getAttribute('lang') === 'fr' ? 'fr' : 'en';
    this.conversationId = null;
    this.caseView = null;
    this.cursor = 0;
    this.cards = new WeakMap();
    this.innerHTML = `
      <section class="ba-root" aria-label="Assistant">
        <header data-role="title"></header>
        <div data-role="case-banner" hidden>
          <strong data-role="case-state"></strong>
          <span data-role="case-ref"></span>
          <span data-role="case-elapsed"></span>
          <span data-role="case-agent" hidden><span data-role="case-agent-name"></span> <span data-role="human-badge"></span></span>
          <p data-role="case-notice"></p>
          <span data-role="case-actions"></span>
        </div>
        <div data-role="messages" aria-live="polite"></div>
        <div data-role="thinking" hidden></div>
        <div data-role="solved-prompt" hidden>
          <span data-role="solved-text"></span>
          <button data-role="solved-yes" type="button"></button>
          <button data-role="solved-no" type="button"></button>
        </div>
        <form data-role="pin-box" hidden>
          <p data-role="pin-title"></p>
          <input data-role="pin-input" type="password" inputmode="numeric" autocomplete="off" maxlength="12" />
          <button data-role="pin-submit" type="submit"></button>
          <p data-role="pin-note" aria-live="polite"></p>
        </form>
        <section data-role="draft-panel" hidden>
          <h3 data-role="draft-title"></h3>
          <div data-role="draft-edit">
            <p data-role="draft-hint"></p>
            <textarea data-role="draft-text" rows="8" maxlength="2000"></textarea>
            <ul data-role="draft-details"></ul>
            <fieldset data-role="draft-destinations">
              <label><input type="radio" name="ba-destination" value="chat" data-role="dest-chat" checked /> <span data-role="dest-chat-label"></span></label>
              <label><input type="radio" name="ba-destination" value="email" data-role="dest-email" /> <span data-role="dest-email-label"></span></label>
              <label><input type="radio" name="ba-destination" value="both" data-role="dest-both" /> <span data-role="dest-both-label"></span></label>
            </fieldset>
            <button data-role="draft-review" type="button"></button>
            <button data-role="draft-skip" type="button"></button>
            <button data-role="draft-discard" type="button"></button>
          </div>
          <div data-role="draft-confirm-screen" hidden>
            <p data-role="draft-confirm-note"></p>
            <div data-role="preview-chat-box">
              <strong data-role="preview-chat-title"></strong>
              <pre data-role="preview-chat"></pre>
            </div>
            <div data-role="preview-email-box">
              <strong data-role="preview-email-title"></strong>
              <p><span data-role="preview-to-label"></span>: <span data-role="preview-email-to"></span></p>
              <p><span data-role="preview-subject-label"></span>: <span data-role="preview-email-subject"></span></p>
              <pre data-role="preview-email-body"></pre>
            </div>
            <p data-role="draft-warning" hidden></p>
            <button data-role="draft-send" type="button"></button>
            <button data-role="draft-back" type="button"></button>
          </div>
          <p data-role="draft-error" aria-live="polite"></p>
        </section>
        <button data-role="human-chip" type="button" data-prominent="false"></button>
        <form data-role="form">
          <input data-role="input" type="text" maxlength="1000" autocomplete="off" />
          <button data-role="send" type="submit"></button>
        </form>
        <p data-role="disclaimer"></p>
      </section>`;
    this.q = (r) => this.querySelector(`[data-role="${r}"]`);
    this.q('form').addEventListener('submit', (e) => { e.preventDefault(); this.submit(); });
    this.q('pin-box').addEventListener('submit', (e) => { e.preventDefault(); this.submitPin(); });
    // Only this click opens a handoff: the host hears about it, then the service is asked for a case.
    this.q('human-chip').addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent('bank-assistant:handoff-request', { bubbles: true, detail: { conversationId: this.conversationId } }));
      // A dispute-like situation starts with a drafted message to review; anything else opens the handoff as before.
      if (this.disputeLike && this.conversationId) this.openDraft();
      else this.startHandoff();
    });
    this.q('draft-review').addEventListener('click', () => this.reviewDraft());
    this.q('draft-send').addEventListener('click', () => this.sendDraft());
    this.q('draft-back').addEventListener('click', () => this.showDraftStep('edit'));
    this.q('draft-discard').addEventListener('click', () => this.closeDraft());
    this.q('draft-skip').addEventListener('click', () => { this.closeDraft(); this.startHandoff(); });
    this.q('solved-yes').addEventListener('click', () => this.answerSolved(true));
    this.q('solved-no').addEventListener('click', () => this.answerSolved(false));
    this.render();
    this.resumeFill();
  }

  render() {
    const t = TEXT[this.lang];
    this.q('title').textContent = t.title;
    this.q('input').placeholder = t.placeholder;
    this.q('send').textContent = t.send;
    this.q('pin-title').textContent = t.pinTitle;
    this.q('pin-input').placeholder = t.pinPlaceholder;
    this.q('pin-submit').textContent = t.pinSubmit;
    this.q('human-chip').textContent = t.human;
    this.q('thinking').textContent = t.thinking;
    this.q('disclaimer').textContent = t.disclaimer;
    this.q('disclaimer').hidden = false;
    this.q('solved-text').textContent = t.solvedQ;
    this.q('solved-yes').textContent = t.yes;
    this.q('solved-no').textContent = t.no;
    this.renderDraftText();
    this.renderCase();
  }

  // ---- handoff: the four states the customer sees (bot, waiting for agent, with agent, resolved) ----

  // The banner for an open case. Everything comes from the service's case view, set as text.
  renderCase() {
    const t = TEXT[this.lang];
    const view = this.caseView;
    const open = view && (view.state === 'waiting' || view.state === 'with_agent');
    this.q('case-banner').hidden = !open;
    this.q('human-chip').disabled = Boolean(open);
    if (!open) return;
    const withAgent = view.state === 'with_agent';
    this.q('case-state').textContent = withAgent ? t.caseWithAgent : t.caseWaiting;
    this.q('case-ref').textContent = t.caseRef(view.ref);
    const seconds = Number.isFinite(view.elapsedSeconds) ? view.elapsedSeconds : 0;
    this.q('case-elapsed').hidden = withAgent;
    this.q('case-elapsed').textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    this.q('case-agent').hidden = !withAgent;
    this.q('case-agent-name').textContent = withAgent ? String(view.agent?.firstName ?? '') : '';
    this.q('human-badge').textContent = t.humanBadge;
    // The queued sentence (after 15 minutes, or outside opening hours) comes before the 24-hour expectation.
    this.q('case-notice').textContent = [view.queuedNotice, view.notice].filter((x) => typeof x === 'string').join(' ');
    // Cancel exists only while nobody has taken the case.
    const actions = this.q('case-actions');
    if (withAgent) actions.replaceChildren();
    else if (!actions.firstChild) {
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.dataset.role = 'case-cancel';
      cancel.textContent = t.cancel;
      cancel.addEventListener('click', () => this.cancelHandoff());
      actions.append(cancel);
    }
    const cancel = actions.firstChild;
    if (cancel) cancel.textContent = t.cancel;
  }

  addNote(text) {
    const el = document.createElement('div');
    el.dataset.role = 'case-note';
    el.textContent = text;
    this.q('messages').appendChild(el);
  }

  token() { return this.getToken?.() ?? this.getAttribute('token') ?? ''; }

  async caseCall(method, path, body) {
    const res = await fetch(`${this.getAttribute('api') ?? ''}${path}`, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${this.token()}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) };
  }

  async startHandoff() {
    if (this.handoffBusy || this.caseView?.state === 'waiting' || this.caseView?.state === 'with_agent') return;
    this.handoffBusy = true;
    try {
      const res = await this.caseCall('POST', '/handoff', { conversationId: this.conversationId, tenant: this.getAttribute('tenant') });
      if (!res.ok) { this.addNote(TEXT[this.lang].handoffError); return; }
      this.conversationId = res.body.conversationId;
      this.cursor = 0;
      this.applyCase(res.body);
    } catch { this.addNote(TEXT[this.lang].handoffError); } finally { this.handoffBusy = false; }
  }

  // ---- drafted case message: edit, review the exact content, confirm ----

  renderDraftText() {
    const t = TEXT[this.lang];
    const set = (role, value) => { this.q(role).textContent = value; };
    set('draft-title', t.draftTitle);
    set('draft-hint', t.draftHint);
    set('dest-chat-label', t.destChat);
    set('dest-email-label', t.destEmail);
    set('dest-both-label', t.destBoth);
    set('draft-review', t.review);
    set('draft-skip', t.skip);
    set('draft-discard', t.discard);
    set('draft-confirm-note', t.confirmNote);
    set('preview-chat-title', t.previewChat);
    set('preview-email-title', t.previewEmail);
    set('preview-to-label', t.to);
    set('preview-subject-label', t.subject);
    set('draft-send', t.confirmSend);
    set('draft-back', t.back);
  }

  showDraftStep(step) {
    this.q('draft-edit').hidden = step !== 'edit';
    this.q('draft-confirm-screen').hidden = step !== 'confirm';
    this.q('draft-error').textContent = '';
  }

  closeDraft() {
    this.draft = null;
    this.q('draft-panel').hidden = true;
  }

  // The service drafts from the customer's own words and the masked transaction record. Nothing is sent or opened.
  async openDraft() {
    if (this.draftBusy) return;
    this.draftBusy = true;
    try {
      const res = await this.caseCall('POST', '/draft', { conversationId: this.conversationId, tenant: this.getAttribute('tenant') });
      if (!res.ok) { this.addNote(TEXT[this.lang].draftError); return; }
      this.draft = { id: res.body.draftId, token: null };
      this.q('draft-text').value = res.body.text;
      this.q('draft-details').replaceChildren(...res.body.details.map((d) => {
        const li = document.createElement('li');
        li.textContent = `${d.label}: ${d.value}`;
        return li;
      }));
      this.q('dest-chat').checked = true;
      this.q('draft-panel').hidden = false;
      this.showDraftStep('edit');
    } catch { this.addNote(TEXT[this.lang].draftError); } finally { this.draftBusy = false; }
  }

  // What the customer is about to confirm is what the service returns here, never something the widget composes.
  async reviewDraft() {
    if (!this.draft || this.draftBusy) return;
    this.draftBusy = true;
    const destination = this.querySelector('input[name="ba-destination"]:checked')?.value ?? 'chat';
    try {
      const res = await this.caseCall('POST', '/draft/preview', { conversationId: this.conversationId, draftId: this.draft.id, text: this.q('draft-text').value, destination });
      if (!res.ok) { this.q('draft-error').textContent = TEXT[this.lang].draftError; return; }
      const p = res.body;
      this.draft.token = p.previewToken;
      this.q('preview-chat-box').hidden = !p.chat;
      this.q('preview-chat').textContent = p.chat?.text ?? '';
      this.q('preview-email-box').hidden = !p.email;
      this.q('preview-email-to').textContent = p.email?.to ?? '';
      this.q('preview-email-subject').textContent = p.email?.subject ?? '';
      this.q('preview-email-body').textContent = p.email?.body ?? '';
      this.q('draft-warning').hidden = !p.warning;
      this.q('draft-warning').textContent = p.warning?.text ?? '';
      this.showDraftStep('confirm');
    } catch { this.q('draft-error').textContent = TEXT[this.lang].draftError; } finally { this.draftBusy = false; }
  }

  async sendDraft() {
    if (!this.draft?.token || this.draftBusy) return;
    this.draftBusy = true;
    const t = TEXT[this.lang];
    try {
      const res = await this.caseCall('POST', '/draft/confirm', { conversationId: this.conversationId, draftId: this.draft.id, previewToken: this.draft.token });
      if (!res.ok) {
        this.q('draft-error').textContent = res.body.error === 'case_changed' ? t.caseChanged : t.sendError;
        if (res.body.error === 'case_changed') { this.draftBusy = false; this.closeDraft(); await this.openDraft(); this.q('draft-error').textContent = t.caseChanged; }
        return;
      }
      this.closeDraft();
      this.addNote(res.body.confirmation);
      // A chat draft has opened (or joined) the handoff; an email-only message leaves the customer with the assistant.
      if (res.body.destination !== 'email') { this.cursor = 0; this.applyCase(res.body); }
    } catch { this.q('draft-error').textContent = t.sendError; } finally { this.draftBusy = false; }
  }

  async cancelHandoff() {
    const ref = this.caseView?.ref;
    try {
      const res = await this.caseCall('POST', '/case/cancel', { conversationId: this.conversationId });
      if (res.ok) {
        this.applyCase({ state: 'bot', ref: null });
        this.addNote(TEXT[this.lang].cancelled(ref));
      } else await this.poll(); // someone claimed it first: show the truth
    } catch { /* the next poll shows where the case stands */ }
  }

  async answerSolved(solved) {
    try { await this.caseCall('POST', '/case/feedback', { conversationId: this.conversationId, solved }); } catch { /* the prompt goes either way */ }
    this.q('solved-prompt').hidden = true;
    this.addNote(TEXT[this.lang].thanks);
  }

  // Takes a case view from the service: the banner, the agent's new messages, and what to poll next.
  applyCase(view) {
    const before = this.caseView?.state ?? 'bot';
    this.caseView = view;
    for (const m of view.messages ?? []) this.addMessage('agent', m.text);
    if (Number.isInteger(view.next)) this.cursor = view.next;
    if (view.state === 'with_agent' && before !== 'with_agent') this.addNote(TEXT[this.lang].agentJoined(view.agent?.firstName ?? ''));
    if (view.state === 'resolved' && before !== 'resolved') {
      this.addNote(TEXT[this.lang].resolved(view.ref));
      this.q('solved-prompt').hidden = view.askSolved !== true;
    }
    this.renderCase();
    this.schedulePoll();
  }

  schedulePoll() {
    clearTimeout(this.pollTimer);
    const state = this.caseView?.state;
    if (state !== 'waiting' && state !== 'with_agent') return;
    const wait = Number(this.getAttribute('poll-ms') ?? 2000);
    this.pollTimer = setTimeout(() => this.poll(), Number.isFinite(wait) ? wait : 2000);
  }

  async poll() {
    if (!this.isConnected) return;
    try {
      const res = await this.caseCall('GET', `/case?conversationId=${encodeURIComponent(this.conversationId)}&after=${this.cursor}`);
      if (res.ok) { this.applyCase(res.body); return; }
    } catch { /* try again below */ }
    this.schedulePoll();
  }

  addMessage(from, text = '') {
    const el = document.createElement('div');
    el.dataset.role = 'message';
    el.dataset.from = from;
    el.textContent = text;
    this.q('messages').appendChild(el);
    el.scrollIntoView?.({ block: 'end' });
    return el;
  }

  addAutomatedLabel() {
    const el = document.createElement('div');
    el.dataset.role = 'automated-label';
    el.textContent = TEXT[this.lang].automated;
    this.q('messages').appendChild(el);
  }

  // Fixed next-step card from the service (human chip or a form shortcut); the text is never model-written.
  addCard(card) {
    const el = document.createElement('div');
    el.dataset.role = 'next-step';
    el.dataset.kind = card.kind;
    el.textContent = card.text;
    this.q('messages').appendChild(el);
  }

  // "Open and review" card for a page the service validated. Everything shown comes from the service's card data
  // (set as text, never markup); the click only asks the host to go to the page, it submits nothing. The host may
  // handle bank-assistant:navigate with its router and call preventDefault; otherwise the browser goes to the path.
  addActionCard(card) {
    if (card?.kind === 'prefill') return this.addPrefillCard(card);
    if (card?.kind !== 'navigate' || typeof card.path !== 'string' || !PLAIN_PATH.test(card.path)) return;
    const el = document.createElement('div');
    el.dataset.role = 'action-card';
    el.dataset.kind = 'navigate';
    el.dataset.target = String(card.target);
    const label = document.createElement('span');
    label.dataset.role = 'action-label';
    label.textContent = String(card.label);
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = String(card.button);
    button.addEventListener('click', () => {
      const go = new CustomEvent('bank-assistant:navigate', { bubbles: true, cancelable: true, detail: { path: card.path, target: card.target } });
      if (this.dispatchEvent(go)) window.location.assign(card.path);
    });
    el.append(label, button);
    this.q('messages').appendChild(el);
  }

  // "Open and review" card that pre-fills a form. Everything shown comes from the service's card data, set as
  // text. The click asks the host for the page, then fills the form's inputs; it never presses a button.
  addPrefillCard(card) {
    if (typeof card.path !== 'string' || !PLAIN_PATH.test(card.path)) return null;
    // Only plain, non-secret input names survive, whatever the service sent.
    const fields = (Array.isArray(card.fields) ? card.fields : []).map((f) => ({
      field: text(f?.field, 32), label: text(f?.label, 60), value: text(f?.value, 200), display: text(f?.display, 200),
      dom: Array.isArray(f?.dom) ? f.dom.filter((n) => typeof n === 'string' && PLAIN_NAME.test(n) && !SECRET.test(n)) : [],
    })).filter((f) => f.field && PLAIN_NAME.test(f.field) && !SECRET.test(f.field) && f.label && f.value !== null && f.display !== null && f.dom.length > 0);
    const t = TEXT[this.lang];
    const el = document.createElement('div');
    el.dataset.role = 'action-card';
    el.dataset.kind = 'prefill';
    el.dataset.form = String(card.form);
    el.dataset.target = String(card.target);
    const line = (role, value) => {
      if (typeof value !== 'string' || !value) return;
      const p = document.createElement('p');
      p.dataset.role = role;
      p.textContent = value;
      el.append(p);
    };
    const title = document.createElement('span');
    title.dataset.role = 'action-label';
    title.textContent = String(card.title);
    el.append(title);
    line('action-summary', card.summary);
    line('action-beneficiary', card.beneficiary ? `${t.beneficiary}: ${card.beneficiary}` : null);
    line('action-amount', card.amount ? `${t.amount}: ${card.amount.value} ${card.amount.currency}` : null);
    line('double-check', card.doubleCheck); // a plain line: it blocks nothing and adds no click
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = String(card.button);
    const clean = { ...card, fields };
    this.cards.set(el, clean);
    button.addEventListener('click', () => this.openAndFill(clean, el));
    el.append(button);
    this.q('messages').appendChild(el);
    return el;
  }

  async openAndFill(card, cardEl) {
    const go = new CustomEvent('bank-assistant:navigate', { bubbles: true, cancelable: true, detail: { path: card.path, target: card.target } });
    const hostRoutes = !this.dispatchEvent(go);
    if (!hostRoutes && window.location.pathname !== card.path) {
      // A full page load ends this widget: leave a short-lived note so the next one can finish the fill.
      try { sessionStorage.setItem(RESUME_KEY, JSON.stringify({ at: Date.now(), card })); } catch { /* no storage: the page just opens */ }
      window.location.assign(card.path);
      return;
    }
    await this.fillCard(card, cardEl);
  }

  // Picks up the note left before a page load, once, and only if it is fresh.
  resumeFill() {
    let note = null;
    try {
      note = JSON.parse(sessionStorage.getItem(RESUME_KEY) ?? 'null');
      sessionStorage.removeItem(RESUME_KEY);
    } catch { note = null; }
    if (!note || !(Date.now() - note.at < RESUME_MS) || !note.card) return;
    const el = this.addPrefillCard(note.card);
    if (el) this.fillCard(this.cards.get(el), el);
  }

  // The input for one field: the first matching input of the page (outside this widget) that is a plain, enabled,
  // non-secret text input or select.
  findInput(field) {
    for (const name of field.dom) {
      for (const el of document.querySelectorAll(`[name="${name}"]`)) {
        if (this.contains(el)) continue;
        const tag = el.tagName;
        if (tag !== 'INPUT' && tag !== 'SELECT' && tag !== 'TEXTAREA') continue;
        if (el.disabled || el.readOnly) continue;
        if (tag === 'INPUT' && !['text', 'tel', 'number', 'search', ''].includes((el.getAttribute('type') ?? '').toLowerCase())) continue;
        if (SECRET.test(`${el.name} ${el.id}`) || /one-time-code|password/i.test(el.getAttribute('autocomplete') ?? '')) continue;
        if (tag === 'SELECT' && ![...el.options].some((o) => o.value === field.value)) continue;
        return el;
      }
    }
    return null;
  }

  async fillCard(card, cardEl) {
    // The host may do the fill itself with its own hook; then the widget leaves the page alone.
    const bridge = new CustomEvent('bank-assistant:prefill', {
      bubbles: true, cancelable: true, detail: { form: card.form, fields: card.fields.map(({ field, value }) => ({ field, value })) },
    });
    if (!this.dispatchEvent(bridge)) return;
    const waitMs = Number(this.getAttribute('fill-timeout') ?? 3000);
    const deadline = Date.now() + (Number.isFinite(waitMs) ? waitMs : 3000);
    const pending = [...card.fields];
    for (;;) {
      for (const field of [...pending]) {
        const input = this.findInput(field);
        if (!input) continue;
        this.fillInput(input, field);
        pending.splice(pending.indexOf(field), 1);
      }
      if (pending.length === 0 || Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    if (pending.length) this.showCopyValues(cardEl ?? this.q('messages'), pending);
  }

  // Native value setter plus an input (or change) event, so the portal's form library sees a normal edit. The
  // banner is added after the event and goes away the first time the customer edits that field.
  fillInput(input, field) {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set;
    if (!setter) return;
    setter.call(input, field.value);
    input.dispatchEvent(new Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
    const banner = document.createElement('span');
    banner.dataset.role = 'assistant-filled';
    banner.dataset.field = field.field;
    banner.setAttribute('role', 'note');
    banner.style.cssText = 'display:block;font-size:12px;color:#8a5a00';
    banner.textContent = TEXT[this.lang].filled;
    input.insertAdjacentElement('afterend', banner);
    const clear = () => {
      banner.remove();
      input.removeEventListener('input', clear);
      input.removeEventListener('change', clear);
    };
    input.addEventListener('input', clear);
    input.addEventListener('change', clear);
  }

  // Fields the page did not have (or kept locked): the values to copy, as text.
  showCopyValues(cardEl, fields) {
    const t = TEXT[this.lang];
    const box = document.createElement('div');
    box.dataset.role = 'copy-values';
    const heading = document.createElement('p');
    heading.textContent = t.copyTitle;
    const list = document.createElement('ul');
    for (const field of fields) {
      const li = document.createElement('li');
      li.dataset.field = field.field;
      li.append(document.createTextNode(`${field.label}: `));
      const value = document.createElement('code');
      value.textContent = field.value;
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.textContent = t.copy;
      copy.addEventListener('click', () => { navigator.clipboard?.writeText(field.value).catch(() => {}); });
      li.append(value, copy);
      list.append(li);
    }
    box.append(heading, list);
    cardEl.append(box);
  }

  addChip(text) {
    const el = document.createElement('div');
    el.dataset.role = 'guides-used';
    el.textContent = text;
    this.q('messages').appendChild(el);
  }

  // One call, once per session: the service verifies the cli with the backend
  // under the customer's own token and fixes the ids. Chat works without it
  // (how-to help only), so a failure here is not fatal.
  async startSession(token) {
    const cli = this.getCli?.() ?? this.getAttribute('cli');
    if (!cli || this.sessionStarted) return;
    let gating = this.getGating?.();
    try { gating ??= JSON.parse(this.getAttribute('gating') ?? 'null'); } catch { gating = null; }
    try {
      const res = await fetch(`${this.getAttribute('api') ?? ''}/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ cli, tenant: this.getAttribute('tenant'), gating, conversationId: this.conversationId }),
      });
      if (!res.ok) return;
      this.conversationId = (await res.json()).conversationId;
      this.sessionStarted = true;
    } catch { return; /* how-to help still works */ }
    await this.claimPortalFlag(token); // a balance request then needs no PIN prompt
  }

  // The portal checks the PIN once after login and keeps isBalancePinVerified = "1" (and
  // isBalancePinVerified:tel) in sessionStorage. This only passes that flag on: it is a CLIENT CLAIM, not
  // proof. The service accepts it only for the session's own phone, and the backend returns balances to any
  // valid token, so it is a UX safeguard rather than a security control. Without it, the PIN box is used.
  async claimPortalFlag(token = this.getToken?.() ?? this.getAttribute('token') ?? '') {
    let verified = null;
    let tel = null;
    try {
      verified = sessionStorage.getItem('isBalancePinVerified');
      tel = sessionStorage.getItem('isBalancePinVerified:tel');
    } catch { /* storage unavailable: use the PIN box */ }
    if (verified !== '1') return false;
    return this.unlock(token, { portalFlag: { verified, tel } }).then((r) => r.ok, () => false);
  }

  async unlock(token, payload) {
    const res = await fetch(`${this.getAttribute('api') ?? ''}/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ conversationId: this.conversationId, ...payload }),
    });
    return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) };
  }

  // The PIN box sits outside the transcript. The PIN is hashed here (SHA-512 hex, as the portal does),
  // the field is cleared at once, and only the hash is sent: never to the assistant, never into the chat.
  async submitPin() {
    const input = this.q('pin-input');
    const pin = input.value;
    input.value = '';
    if (!pin) return;
    const note = this.q('pin-note');
    const t = TEXT[this.lang];
    try {
      const digest = await globalThis.crypto.subtle.digest('SHA-512', new TextEncoder().encode(pin));
      const pinHash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
      const { ok, status, body } = await this.unlock(this.getToken?.() ?? this.getAttribute('token') ?? '', { pinHash });
      if (ok) {
        note.textContent = '';
        this.q('pin-box').hidden = true;
        const again = this.pendingMessage;
        this.pendingMessage = null;
        if (again) await this.ask(again, { resend: true });
        return;
      }
      note.textContent = status === 403 ? t.pinWrong(body.attemptsLeft) : status === 423 ? t.pinBlocked : status === 401 ? t.pinExpired : t.pinUnavailable;
    } catch {
      note.textContent = t.pinUnavailable;
    }
  }

  showPinBox(message) {
    this.pendingMessage = message;
    this.q('pin-note').textContent = '';
    this.q('pin-box').hidden = false;
    this.q('pin-input').focus?.();
  }

  async submit() {
    const input = this.q('input');
    const message = input.value.trim();
    if (!message || this.busy) return;
    input.value = '';
    await this.ask(message);
  }

  async ask(message, { resend = false } = {}) {
    this.busy = true;
    if (!resend) this.addMessage('user', message);
    let pinNeeded = false;
    this.q('thinking').hidden = false;
    let bubble = null;
    let guides = [];
    let automated = false;
    try {
      const token = this.getToken?.() ?? this.getAttribute('token') ?? '';
      await this.startSession(token);
      const res = await fetch(`${this.getAttribute('api') ?? ''}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ message, conversationId: this.conversationId, tenant: this.getAttribute('tenant') }),
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      for await (const ev of readEvents(res.body)) {
        if (ev.type === 'case') {
          automated = ev.automated === true; // the bot answering while a case waits for an agent
        } else if (ev.type === 'delta') {
          if (!bubble && automated) this.addAutomatedLabel();
          bubble ??= this.addMessage('assistant');
          bubble.textContent += ev.text;
        } else if (ev.type === 'action_card') {
          this.addActionCard(ev);
        } else if (ev.type === 'warning') {
          this.addMessage('assistant', ev.text).dataset.role = 'warning';
        } else if (ev.type === 'refusal' || ev.type === 'blocked') {
          this.addCard(ev.card);
        } else if (ev.type === 'busy') {
          this.addMessage('assistant', ev.text).dataset.role = 'busy';
          this.addCard(ev.card);
        } else if (ev.type === 'chip') {
          // Prominence is sticky for the conversation: a calm turn never hides a raised chip.
          if (ev.prominent) this.q('human-chip').dataset.prominent = 'true';
          if (ev.reasons?.some((r) => DISPUTE_REASONS.includes(r))) this.disputeLike = true;
        } else if (ev.type === 'tool_blocked') {
          if (ev.code === 'session_expired') this.sessionStarted = false;
          if (ev.code === 'pin_required') pinNeeded = true;
        } else if (ev.type === 'guides') {
          guides = ev.guides;
        } else if (ev.type === 'done') {
          this.conversationId = ev.conversationId;
          if (TEXT[ev.language]) { this.lang = ev.language; this.render(); }
          if (guides.length) this.addChip(`${TEXT[this.lang].used}${this.lang === 'fr' ? ' : ' : ': '}${guides.map((g) => g.title).join(', ')}`);
        } else if (ev.type === 'error') {
          throw new Error(ev.code);
        }
      }
    } catch {
      const target = bubble ?? this.addMessage('assistant');
      if (!target.textContent) target.textContent = TEXT[this.lang].error;
    } finally {
      this.q('thinking').hidden = true;
      this.busy = false;
    }
    // A balance needs an unlock: try the portal's flag again (it may have been set since load), else ask for the PIN.
    if (pinNeeded && !resend) {
      if (await this.claimPortalFlag()) await this.ask(message, { resend: true });
      else this.showPinBox(message);
    }
  }
}

async function* readEvents(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let i;
    while ((i = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, i);
      buffer = buffer.slice(i + 2);
      const type = /^event: (.*)$/m.exec(block)?.[1];
      const data = JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? 'null');
      yield { type, ...data };
    }
  }
}

customElements.define('bank-assistant', BankAssistant);
