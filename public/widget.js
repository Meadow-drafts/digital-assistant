// <bank-assistant> chat widget. Mounted by one script tag; talks only to the
// assistant service (never to a model). Attributes: api (service base URL,
// default same origin), tenant, brand-name, brand-primary and brand-secondary
// (display-only tenant configuration), token (demo only; the portal sets
// el.getToken = () => userToken instead). For account reads the host also
// provides the customer's cli once (cli attribute or el.getCli) and, until the
// backend can supply them, gating data (gating attribute or el.getGating).
// Host events (all cancelable): bank-assistant:navigate {path, target} when a card asks for a page, and
// bank-assistant:prefill {form, fields} when a pre-fill card has a page to fill. A host that cancels the second one
// owns the fill (the production hook); otherwise the widget fills matching inputs of the page itself.
// fill-timeout (attribute, ms): how long to wait for the form to appear after navigating. Without it a card may ask
// for a longer wait (waitMs, for a form behind several choices the customer makes); the default is 3000.
// Handoff: only a click on the human chip asks the service for a case (the host also hears
// bank-assistant:handoff-request). The widget then shows the case banner and polls the service every poll-ms
// (attribute, default 2000) for the case state and the agent's messages.
// Session: with a customer id (cli) the widget starts a session once; the service answers with a signed session id,
// which the widget sends as X-Assistant-Session on every later call, next to the bearer token. A 401 drops it and the
// next call starts a new session. Without a customer id the chat still answers how-to questions as a guest, but
// 'My cases' needs the session.
// 'My cases' (a button under the title): the customer's own cases, newest first, with the state as they see it. The
// service decides whose they are from the token alone. Selecting one shows its status and, if it is still open, a button
// that brings that chat back (banner, agent messages and polling continue as for any open case).
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
    reconnecting: 'Reconnecting…',
    slow: 'Slow connection, still trying…',
    incomplete: 'This reply was cut off.',
    notSent: 'Your message has not been sent yet.',
    retry: 'Try again',
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
    noAccount: 'The assistant is not connected to your account (no customer id was found for this sign-in), so links to your pages and your account data are not available. Try signing in again.',
    tx: { date: 'Date', id: 'Id', from: 'From', to: 'To', member: 'Member', nature: 'Nature', type: 'Type', amount: 'Amount', status: 'Status',
      emission: 'Emission', acquisition: 'Acquisition', success: 'Completed', failed: 'Failed', pending: 'Pending', unknown: 'Pending' },
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
    myCases: 'My cases',
    myCasesLoading: 'Loading your cases…',
    myCasesEmpty: 'You have no cases yet.',
    myCasesError: 'We could not load your cases. Please try again.',
    caseOpened: 'Opened',
    caseUpdated: 'Last update',
    caseStates: { waiting: 'Waiting for an agent', with_agent: 'With an agent', resolved: 'Resolved', cancelled: 'Cancelled', emailed: 'Emailed to support' },
    caseOpenChat: 'Back to this chat',
    caseListBack: 'Back to the list',
    myCasesClose: 'Close',
    caseOpenError: 'We could not open that chat. Please try again.',
    myCasesSignIn: 'Sign in to see your cases.',
    caseEmailed: 'Emailed to support',
    caseEmailedNote: 'You emailed this to support. Its progress cannot be tracked here.',
  },
  fr: {
    title: 'Assistant',
    placeholder: 'Demandez comment faire…',
    send: 'Envoyer',
    human: 'Parler à un agent',
    thinking: 'Réflexion en cours…',
    used: "Ce que j'ai utilisé",
    error: "L'assistant est indisponible pour le moment. Veuillez réessayer.",
    reconnecting: 'Reconnexion…',
    slow: 'Connexion lente, nouvelle tentative…',
    incomplete: 'Cette réponse a été interrompue.',
    notSent: "Votre message n'a pas encore été envoyé.",
    retry: 'Réessayer',
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
    noAccount: "L'assistant n'est pas connecté à votre compte (aucun identifiant client trouvé pour cette connexion) : les liens vers vos pages et vos données de compte ne sont pas disponibles. Essayez de vous reconnecter.",
    tx: { date: 'Date', id: 'Id', from: 'De', to: 'Vers', member: 'Membre', nature: 'Nature', type: 'Type', amount: 'Montant', status: 'Statut',
      emission: 'Émission', acquisition: 'Acquisition', success: 'Terminé', failed: 'Échoué', pending: 'En attente', unknown: 'En attente' },
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
    myCases: 'Mes dossiers',
    myCasesLoading: 'Chargement de vos dossiers…',
    myCasesEmpty: "Vous n'avez pas encore de dossier.",
    myCasesError: "Nous n'avons pas pu charger vos dossiers. Veuillez réessayer.",
    caseOpened: 'Ouvert',
    caseUpdated: 'Dernière mise à jour',
    caseStates: { waiting: "En attente d'un agent", with_agent: 'Avec un agent', resolved: 'Résolu', cancelled: 'Annulé', emailed: "Envoyé par e-mail à l'assistance" },
    caseOpenChat: 'Retour à ce chat',
    caseListBack: 'Retour à la liste',
    myCasesClose: 'Fermer',
    caseOpenError: "Nous n'avons pas pu ouvrir ce chat. Veuillez réessayer.",
    myCasesSignIn: 'Connectez-vous pour voir vos dossiers.',
    caseEmailed: "Envoyé par e-mail à l'assistance",
    caseEmailedNote: "Vous avez envoyé ceci par e-mail à l'assistance. Son avancement ne peut pas être suivi ici.",
  },
};

const PLAIN_PATH = /^\/(?!\/)[A-Za-z0-9\-/]*$/;
const PLAIN_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
// Never filled, whatever a card says: PIN, OTP, password, voucher and code inputs (by name, id or type).
const SECRET = /pin|otp|pass|voucher|code|cvv|token|secret|mdp/i;
// Chip reasons for a disputed transaction (a dispute, a wrong transfer, a reversal, a debit with no credit): the chip
// click starts a drafted message. Fraud cues and plain "contact the bank" endings keep opening the handoff directly.
const DISPUTE_REASONS = ['dispute', 'wrong_transfer', 'reversal', 'debit_without_credit', 'reversal_in_progress'];
// Poor connections (ticket 50): a failed or stalled send is retried after these delays (ms), then the customer decides.
const BACKOFF = [1000, 2000, 4000, 8000, 16000];
const SLOW_MS = 8000; // no byte for this long: say so
const STALL_MS = 30000; // no byte for this long: give up on the request and retry it
const newId = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`);
const lost = (e) => Object.assign(e instanceof Error ? e : new Error(String(e)), { retriable: true });
const brandColor = (value) => {
  if (typeof value !== 'string') return null;
  const color = value.trim();
  if (/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(color)) return color;
  const channels = /^(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})$/.exec(color);
  if (!channels || channels.slice(1).some((channel) => Number(channel) > 255)) return null;
  return `rgb(${channels.slice(1).join(' ')})`;
};
const RESUME_KEY = 'bank-assistant:prefill';
const RESUME_MS = 60_000;
const text = (v, max) => (typeof v === 'string' && v.length <= max ? v : null);

class BankAssistant extends HTMLElement {
  static get observedAttributes() { return ['brand-name', 'brand-primary', 'brand-secondary']; }

  connectedCallback() {
    this.lang = this.getAttribute('lang') === 'fr' ? 'fr' : 'en';
    this.conversationId = null;
    this.caseView = null;
    this.cursor = 0;
    this.cards = new WeakMap();
    this.outbox = []; // messages typed but not yet answered, oldest first
    this.onOnline = () => { clearTimeout(this.retryTimer); this.retryTimer = null; this.pump(); };
    window.addEventListener('online', this.onOnline);
    this.innerHTML = `
      <style>
        .ba-root [data-role="title"] { color: var(--ba-brand-primary, #2458a8); font-weight: 650; }
        .ba-root [data-role="send"] { background: var(--ba-brand-primary, #2458a8); border: 1px solid var(--ba-brand-primary, #2458a8); border-radius: .35rem; color: #fff; padding: .4rem .75rem; }
        .ba-root [data-role="human-chip"] { border-color: var(--ba-brand-secondary, #607080); }
        .ba-root [data-role="human-chip"][data-prominent="true"] { background: var(--ba-brand-primary, #2458a8); border-color: var(--ba-brand-primary, #2458a8); color: #fff; }
      </style>
      <section class="ba-root" data-role="root" aria-label="Assistant">
        <header data-role="title"></header>
        <button data-role="my-cases-button" type="button"></button>
        <section data-role="my-cases-panel" hidden>
          <h3 data-role="my-cases-title"></h3>
          <p data-role="my-cases-loading" aria-live="polite"></p>
          <p data-role="my-cases-error" aria-live="polite"></p>
          <p data-role="my-cases-empty" hidden></p>
          <ul data-role="my-cases-list"></ul>
          <div data-role="my-case-detail" hidden>
            <p data-role="my-case-detail-text"></p>
            <button data-role="my-case-open-chat" type="button" hidden></button>
            <button data-role="my-case-back" type="button"></button>
          </div>
          <button data-role="my-cases-close" type="button"></button>
        </section>
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
        <p data-role="connection" aria-live="polite" hidden></p>
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
    this.applyBranding();
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
    this.q('my-cases-button').addEventListener('click', () => this.showMyCases());
    this.q('my-cases-close').addEventListener('click', () => { this.q('my-cases-panel').hidden = true; });
    this.q('my-case-back').addEventListener('click', () => this.showCaseList());
    this.q('solved-yes').addEventListener('click', () => this.answerSolved(true));
    this.q('solved-no').addEventListener('click', () => this.answerSolved(false));
    this.render();
    this.resumeFill();
  }

  attributeChangedCallback() {
    if (this.q) this.applyBranding();
  }

  // Branding is data on the host tag; tenant identity never selects code or relaxes service policy.
  applyBranding() {
    const name = this.getAttribute('brand-name')?.trim().slice(0, 60) || 'Assistant';
    const primary = brandColor(this.getAttribute('brand-primary'));
    const secondary = brandColor(this.getAttribute('brand-secondary'));
    this.q('title').textContent = name;
    this.q('title').setAttribute('aria-label', name);
    this.q('root').setAttribute('aria-label', name);
    if (primary) this.style.setProperty('--ba-brand-primary', primary);
    else this.style.removeProperty('--ba-brand-primary');
    if (secondary) this.style.setProperty('--ba-brand-secondary', secondary);
    else this.style.removeProperty('--ba-brand-secondary');
  }

  disconnectedCallback() {
    window.removeEventListener('online', this.onOnline);
    clearTimeout(this.retryTimer);
  }

  render() {
    const t = TEXT[this.lang];
    this.setConnection(this.connection ?? null);
    this.q('title').textContent = t.title;
    this.q('input').placeholder = t.placeholder;
    this.q('send').textContent = t.send;
    this.q('pin-title').textContent = t.pinTitle;
    this.q('pin-input').placeholder = t.pinPlaceholder;
    this.q('pin-submit').textContent = t.pinSubmit;
    this.q('human-chip').textContent = t.human;
    this.q('my-cases-button').textContent = t.myCases;
    this.q('my-cases-title').textContent = t.myCases;
    this.q('my-cases-empty').textContent = t.myCasesEmpty;
    this.q('my-case-open-chat').textContent = t.caseOpenChat;
    this.q('my-case-back').textContent = t.caseListBack;
    this.q('my-cases-close').textContent = t.myCasesClose;
    this.q('thinking').textContent = t.thinking;
    this.q('disclaimer').textContent = t.disclaimer;
    this.q('disclaimer').hidden = false;
    this.q('solved-text').textContent = t.solvedQ;
    this.q('solved-yes').textContent = t.yes;
    this.q('solved-no').textContent = t.no;
    this.renderDraftText();
    this.renderCase();
    this.applyBranding();
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

  // The bearer token and, once a session has started, the signed session id the service gave us for it.
  authHeaders(token = this.token()) {
    return { authorization: `Bearer ${token}`, ...(this.sessionId ? { 'x-assistant-session': this.sessionId } : {}) };
  }

  // A 401 means the session id is no longer good (expired, or not ours): forget it so the next call starts a new session.
  dropSession() { this.sessionId = null; this.sessionStarted = false; }

  async caseCall(method, path, body) {
    const res = await fetch(`${this.getAttribute('api') ?? ''}${path}`, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...this.authHeaders() },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) this.dropSession();
    return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) };
  }

  async startHandoff() {
    if (this.handoffBusy || this.caseView?.state === 'waiting' || this.caseView?.state === 'with_agent') return;
    this.handoffBusy = true;
    try {
      await this.startSession(this.token()); // a customer with a customer id gets a verified case, even before the first message
      const res = await this.caseCall('POST', '/handoff', { conversationId: this.conversationId, tenant: this.getAttribute('tenant') });
      if (!res.ok) { this.addNote(TEXT[this.lang].handoffError); return; }
      this.conversationId = res.body.conversationId;
      this.cursor = 0;
      this.applyCase(res.body);
    } catch { this.addNote(TEXT[this.lang].handoffError); } finally { this.handoffBusy = false; }
  }

  // ---- my cases: the customer's own cases, newest first (ticket 38) ----

  // Everything shown comes from the service's answer, set as text. The service decides whose cases these are.
  async showMyCases() {
    const t = TEXT[this.lang];
    this.q('my-cases-panel').hidden = false;
    this.q('my-case-detail').hidden = true;
    this.q('my-cases-list').hidden = false;
    this.q('my-cases-error').textContent = '';
    this.q('my-cases-empty').hidden = true;
    this.q('my-cases-list').replaceChildren();
    this.q('my-cases-loading').textContent = t.myCasesLoading;
    try {
      await this.startSession(this.token()); // the list belongs to a verified session
      if (!this.sessionId) { this.q('my-cases-error').textContent = t.myCasesSignIn; return; }
      const res = await this.caseCall('GET', '/case/mine');
      if (!res.ok || !Array.isArray(res.body.cases)) throw new Error('list');
      this.q('my-cases-list').replaceChildren(...res.body.cases.map((c) => this.caseRow(c)));
      this.q('my-cases-empty').hidden = res.body.cases.length > 0;
    } catch { this.q('my-cases-error').textContent = t.myCasesError; } finally { this.q('my-cases-loading').textContent = ''; }
  }

  showCaseList() {
    this.q('my-case-detail').hidden = true;
    this.q('my-cases-list').hidden = false;
  }

  stamp(label, iso) {
    const el = document.createElement('span');
    const time = document.createElement('time');
    time.dateTime = iso;
    const at = new Date(iso);
    time.textContent = Number.isNaN(at.getTime()) ? '' : at.toLocaleString(this.lang);
    el.append(`${label}: `, time);
    return el;
  }

  caseRow(c) {
    const t = TEXT[this.lang];
    const li = document.createElement('li');
    const row = document.createElement('button');
    row.type = 'button';
    row.dataset.role = 'my-case';
    const ref = document.createElement('strong');
    ref.textContent = String(c.ref);
    const state = document.createElement('span');
    state.dataset.role = 'my-case-state';
    state.textContent = t.caseStates[c.state] ?? '';
    // An emailed-only case has no chat to follow: say so, and show no "last update" that would suggest otherwise.
    row.append(ref, ' ', state, ' ', this.stamp(t.caseOpened, c.openedAt));
    if (c.state === 'emailed') { const note = document.createElement('small'); note.textContent = ` ${t.caseEmailedNote}`; row.append(note); } else row.append(' ', this.stamp(t.caseUpdated, c.updatedAt));
    row.addEventListener('click', () => this.showCase(c.ref));
    li.append(row);
    return li;
  }

  async showCase(ref) {
    const t = TEXT[this.lang];
    this.q('my-cases-error').textContent = '';
    try {
      const res = await this.caseCall('GET', `/case/mine/${encodeURIComponent(ref)}`);
      if (!res.ok) throw new Error('case');
      const c = res.body;
      this.q('my-case-detail-text').textContent = `${t.caseRef(c.ref)}: ${t.caseStates[c.state] ?? ''}${c.state === 'emailed' ? `. ${t.caseEmailedNote}` : ''}`;
      // Only a case that is still open has a chat to go back to.
      const back = this.q('my-case-open-chat');
      back.hidden = typeof c.conversationId !== 'string';
      back.onclick = () => this.openCaseChat(c.conversationId);
      this.q('my-cases-list').hidden = true;
      this.q('my-case-detail').hidden = false;
    } catch { this.q('my-cases-error').textContent = t.myCasesError; }
  }

  // Returns to the chat of an open case: the banner, the agent's messages and the polling carry on from there.
  async openCaseChat(conversationId) {
    if (typeof conversationId !== 'string') return;
    this.q('my-cases-panel').hidden = true;
    if (conversationId === this.conversationId && this.caseView && (this.caseView.state === 'waiting' || this.caseView.state === 'with_agent')) return;
    try {
      const res = await this.caseCall('GET', `/case?conversationId=${encodeURIComponent(conversationId)}&after=0`);
      if (!res.ok) throw new Error('chat');
      if (conversationId !== this.conversationId) this.q('messages').replaceChildren();
      this.conversationId = conversationId;
      this.caseView = null;
      this.cursor = 0;
      this.applyCase(res.body);
    } catch { this.addNote(TEXT[this.lang].caseOpenError); }
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
    let res = null;
    try { res = await this.caseCall('POST', '/case/feedback', { conversationId: this.conversationId, solved }); } catch { /* the prompt goes either way */ }
    this.q('solved-prompt').hidden = true;
    this.addNote(TEXT[this.lang].thanks);
    // "No" asks for a person again: the service answers with the case that is now open, as it does for the chip.
    if (!solved && res?.ok && res.body?.state) {
      this.cursor = 0;
      this.applyCase(res.body);
    }
  }

  // Takes a case view from the service: the banner, the agent's new messages, and what to poll next.
  applyCase(view) {
    const before = this.caseView?.state ?? 'bot';
    this.caseView = view;
    for (const m of view.messages ?? []) { if (m.from === 'system') this.addNote(m.text); else this.addMessage('agent', m.text); }
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

  // The customer's own recent transactions, laid out like the portal's History table. Full values: this is their
  // own data on their own screen (the model and the audit log only ever see the masked form). Text only, no markup.
  addTransactions(rows, language = this.lang) {
    const lang = TEXT[language] ? language : this.lang;
    const T = TEXT[lang].tx;
    const wrap = document.createElement('div');
    wrap.dataset.role = 'transactions';
    // The chat area is a grid, which squeezes or overlaps a scroll container that is itself a grid item. So the grid
    // item is a plain box (min-width 0 so it never widens the panel) and the sideways scrolling happens inside it.
    wrap.style.cssText = 'min-width:0;max-width:100%';
    const scroller = document.createElement('div');
    scroller.dataset.role = 'transactions-scroll';
    scroller.style.cssText = 'overflow-x:auto;max-width:100%';
    const table = document.createElement('table');
    table.style.cssText = 'border-collapse:collapse;font-size:.75rem;width:100%';
    const cell = (tag, text, right = false) => {
      const c = document.createElement(tag);
      c.textContent = text ?? '';
      c.style.cssText = `padding:.2rem .4rem;border-bottom:1px solid #d0d4da;white-space:nowrap;text-align:${right ? 'right' : 'left'}`;
      return c;
    };
    const head = document.createElement('tr');
    for (const k of ['date', 'id', 'from', 'to', 'member', 'nature', 'type', 'amount', 'status']) head.appendChild(cell('th', T[k], k === 'amount'));
    table.appendChild(head);
    for (const r of rows.slice(0, 50)) {
      const tr = document.createElement('tr');
      tr.dataset.status = String(r.status ?? '');
      const nature = lang === 'fr' ? r.nature?.fr : r.nature?.en;
      // The bank's `dev` is often a numeric code (59); the portal shows XAF for these.
      const currency = /^[A-Za-z]{3}$/.test(String(r.currency ?? '')) ? r.currency : 'XAF';
      const amount = r.amount == null ? '' : `${Number(r.amount).toLocaleString(lang === 'fr' ? 'fr-FR' : 'en-US')} ${currency}`;
      const values = [r.date, r.id, r.from, r.to, r.member, nature ?? r.nature?.code, T[r.type] ?? r.type, amount, T[r.status] ?? T.unknown];
      values.forEach((v, i) => tr.appendChild(cell('td', v == null ? '' : String(v), i === 7)));
      table.appendChild(tr);
    }
    scroller.appendChild(table);
    wrap.appendChild(scroller);
    this.q('messages').appendChild(wrap);
    scroller.scrollLeft = 0;
    wrap.scrollIntoView?.({ block: 'nearest', inline: 'start' });
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
    line('action-directions', card.directions); // what the customer does first, when the form is behind choices
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = String(card.button);
    const clean = { ...card, fields, mode: card.mode === 'directions' ? 'directions' : 'fill', directions: text(card.directions, 500), waitMs: Number.isFinite(card.waitMs) ? Math.min(Math.max(card.waitMs, 0), 300000) : null };
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
    // A form behind several choices (the card says so): nothing is filled and nothing is waited for. The customer is
    // sent to the page and given the values to enter, which they already have in the card's directions.
    if (card.mode === 'directions') {
      if (card.fields.length) this.showCopyValues(cardEl ?? this.q('messages'), [...card.fields]);
      return;
    }
    // The host may do the fill itself with its own hook; then the widget leaves the page alone.
    const bridge = new CustomEvent('bank-assistant:prefill', {
      bubbles: true, cancelable: true, detail: { form: card.form, fields: card.fields.map(({ field, value }) => ({ field, value })) },
    });
    if (!this.dispatchEvent(bridge)) return;
    // How long to keep looking for the inputs: the host's fill-timeout if it set one, else the card's own wait (a form
    // behind choices the customer makes first), else 3 s. Only this customer's browser waits; the service is not involved.
    const attr = this.getAttribute('fill-timeout');
    const waitMs = attr !== null && Number.isFinite(Number(attr)) ? Number(attr) : (card.waitMs ?? 3000);
    const started = Date.now();
    const deadline = started + waitMs;
    // The wait ends early, with nothing more done, when the customer sends another message, leaves the page or the
    // widget goes away: a form must never fill itself long after the customer moved on.
    const run = Symbol('fill');
    this.fillRun = run;
    const page = window.location.pathname;
    const stale = () => this.fillRun !== run || !this.isConnected || window.location.pathname !== page;
    const pending = [...card.fields];
    for (;;) {
      for (const field of [...pending]) {
        const input = this.findInput(field);
        if (!input) continue;
        this.fillInput(input, field);
        pending.splice(pending.indexOf(field), 1);
      }
      if (pending.length === 0 || Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, Date.now() - started < 3000 ? 50 : 300));
      if (stale()) return;
    }
    if (this.fillRun === run) this.fillRun = null;
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
  async startSession(token, signal) {
    const cli = this.getCli?.() ?? this.getAttribute('cli');
    if (!cli && this.getCli && !this.noAccountShown) {
      // A host that supplies a customer id (the portal) gave none: say so once, instead of failing silently.
      this.noAccountShown = true;
      this.addNote(TEXT[this.lang].noAccount);
    }
    if (!cli || this.sessionStarted) return;
    let gating = this.getGating?.();
    try { gating ??= JSON.parse(this.getAttribute('gating') ?? 'null'); } catch { gating = null; }
    try {
      const res = await fetch(`${this.getAttribute('api') ?? ''}/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ cli, tenant: this.getAttribute('tenant'), gating, conversationId: this.conversationId }),
        signal,
      });
      if (res.status >= 500 || res.status === 429) { this.sessionDown = true; return; }
      if (!res.ok) return;
      const started = await res.json();
      this.conversationId = started.conversationId;
      this.sessionId = typeof started.sessionId === 'string' ? started.sessionId : null;
      this.sessionStarted = true;
    } catch { this.sessionDown = true; return; /* the chat call retries it; how-to help works without a session */ }
    await this.claimPortalFlag(token, signal); // a balance request then needs no PIN prompt
  }

  // The portal checks the PIN once after login and keeps isBalancePinVerified = "1" (and
  // isBalancePinVerified:tel) in sessionStorage. This only passes that flag on: it is a CLIENT CLAIM, not
  // proof. The service accepts it only for the session's own phone, and the backend returns balances to any
  // valid token, so it is a UX safeguard rather than a security control. Without it, the PIN box is used.
  async claimPortalFlag(token = this.getToken?.() ?? this.getAttribute('token') ?? '', signal) {
    let verified = null;
    let tel = null;
    try {
      verified = sessionStorage.getItem('isBalancePinVerified');
      tel = sessionStorage.getItem('isBalancePinVerified:tel');
    } catch { /* storage unavailable: use the PIN box */ }
    if (verified !== '1') return false;
    return this.unlock(token, { portalFlag: { verified, tel } }, signal).then((r) => r.ok, () => false);
  }

  async unlock(token, payload, signal) {
    const res = await fetch(`${this.getAttribute('api') ?? ''}/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.authHeaders(token) },
      body: JSON.stringify({ conversationId: this.conversationId, ...payload }),
      signal,
    });
    if (res.status === 401) this.dropSession();
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
        if (again) { this.outbox.unshift(this.resendTurn(again)); await this.pump(); }
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
    if (!message) return;
    input.value = '';
    const turn = { id: newId(), message, attempts: 0, bubble: this.addMessage('user', message) };
    if (this.outbox.length || this.pumping) turn.bubble.dataset.state = 'queued';
    this.outbox.push(turn);
    await this.pump();
  }

  resendTurn(message) { return { id: newId(), message, attempts: 0, bubble: null, resend: true }; }

  // Sends the outbox in order, one message at a time. A message stays at the head until it is answered, so nothing is
  // lost or sent out of order; it keeps its id across retries, so the service never runs it twice.
  async pump() {
    if (this.pumping || this.retryTimer || this.outbox[0]?.failed) return;
    this.pumping = true;
    try {
      while (this.outbox.length) {
        const turn = this.outbox[0];
        if (globalThis.navigator?.onLine === false) { // wait for the browser's 'online' event
          this.setConnection('reconnecting');
          if (turn.bubble) turn.bubble.dataset.state = 'queued';
          return;
        }
        if (turn.bubble) delete turn.bubble.dataset.state;
        const result = await this.attempt(turn);
        if (result.retry) {
          if (turn.attempts >= BACKOFF.length) { this.giveUp(turn); return; }
          this.setConnection('reconnecting');
          this.retryTimer = setTimeout(() => { this.retryTimer = null; this.pump(); }, BACKOFF[turn.attempts]);
          turn.attempts += 1;
          return;
        }
        this.outbox.shift();
        this.setConnection(null);
        // A balance needs an unlock: try the portal's flag again (it may have been set since load), else ask for the PIN.
        if (result.pinNeeded && !turn.resend) {
          if (await this.claimPortalFlag()) this.outbox.unshift(this.resendTurn(turn.message));
          else this.showPinBox(turn.message);
        }
      }
    } finally { this.pumping = false; }
  }

  setConnection(state) {
    this.connection = state;
    const el = this.q('connection');
    if (!el) return;
    el.hidden = !state;
    el.dataset.state = state ?? '';
    el.textContent = state ? TEXT[this.lang][state === 'slow' ? 'slow' : 'reconnecting'] : '';
  }

  // Out of retries: the reply (or the message) is shown as not finished, and the customer chooses when to try again.
  giveUp(turn) {
    const t = TEXT[this.lang];
    turn.failed = true;
    this.setConnection(null);
    if (turn.reply) turn.reply.dataset.incomplete = 'true';
    const box = document.createElement('div');
    box.dataset.role = 'retry-box';
    const note = document.createElement('span');
    note.dataset.role = 'incomplete';
    note.textContent = turn.reply ? t.incomplete : t.notSent;
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.role = 'retry';
    button.textContent = t.retry;
    button.addEventListener('click', () => { box.remove(); turn.failed = false; turn.attempts = 0; this.pump(); });
    box.append(note, button);
    this.q('messages').appendChild(box);
  }

  // One delivery of one message. Returns { retry: true } when the connection failed (the same id is sent again later),
  // otherwise { pinNeeded } when the turn ended, whether it answered or showed an error.
  async attempt(turn) {
    const { message } = turn;
    const messages = this.q('messages');
    // A repeat delivery draws the reply again from the start: drop what the failed one added (never the typed messages).
    if (turn.before) for (const c of [...messages.children]) if (!turn.before.has(c) && c.dataset.from !== 'user') c.remove();
    this.fillRun = null; // a waiting pre-fill ends when the customer moves on to something else
    let pinNeeded = false;
    this.q('thinking').hidden = false;
    let bubble = null;
    let guides = [];
    let automated = false;
    let expired = false;
    let finished = false;
    let retry = false;
    const ctl = new AbortController();
    let slowTimer;
    let stallTimer;
    const arm = () => {
      clearTimeout(slowTimer);
      clearTimeout(stallTimer);
      if (this.connection === 'slow') this.setConnection(null);
      slowTimer = setTimeout(() => this.setConnection('slow'), SLOW_MS);
      stallTimer = setTimeout(() => ctl.abort(), STALL_MS);
    };
    try {
      const token = this.getToken?.() ?? this.getAttribute('token') ?? '';
      this.sessionDown = false;
      arm();
      await this.startSession(token, ctl.signal);
      if (this.sessionDown) throw lost(new Error('session')); // never fall back to a guest chat because the network blinked
      turn.before = new Set(messages.children);
      arm();
      let res;
      try {
        res = await fetch(`${this.getAttribute('api') ?? ''}/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...this.authHeaders(token) },
          body: JSON.stringify({ message, messageId: turn.id, conversationId: this.conversationId, tenant: this.getAttribute('tenant') }),
          signal: ctl.signal,
        });
      } catch (e) { throw lost(e); }
      if (res.status === 401) { this.dropSession(); expired = true; } // no silent retry: the next message starts a new session
      if (res.status >= 500 || res.status === 429) throw lost(new Error(`HTTP ${res.status}`));
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      for await (const ev of readEvents(res.body)) {
        arm();
        if (this.connection) this.setConnection(null);
        if (ev.type === 'thinking') {
          if (ev.conversationId) this.conversationId = ev.conversationId; // a drop before the end can still resume this chat
        } else if (ev.type === 'case') {
          automated = ev.automated === true; // the bot answering while a case waits for an agent
        } else if (ev.type === 'delta') {
          if (!bubble && automated) this.addAutomatedLabel();
          bubble ??= this.addMessage('assistant');
          turn.reply = bubble;
          bubble.textContent += ev.text;
        } else if (ev.type === 'action_card') {
          this.addActionCard(ev);
        } else if (ev.type === 'next_step') {
          // The closing step is already in the reply text; when it is a page link it also comes as a validated card.
          if (ev.card) this.addActionCard(ev.card);
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
        } else if (ev.type === 'tool' && Array.isArray(ev.display?.transactions) && ev.display.transactions.length) {
          this.addTransactions(ev.display.transactions, ev.language);
        } else if (ev.type === 'tool_blocked') {
          if (ev.code === 'session_expired') this.dropSession();
          if (ev.code === 'pin_required') pinNeeded = true;
        } else if (ev.type === 'guides') {
          guides = ev.guides;
        } else if (ev.type === 'done') {
          finished = true;
          this.conversationId = ev.conversationId;
          if (TEXT[ev.language]) { this.lang = ev.language; this.render(); }
          if (guides.length) this.addChip(`${TEXT[this.lang].used}${this.lang === 'fr' ? ' : ' : ': '}${guides.map((g) => g.title).join(', ')}`);
        } else if (ev.type === 'error') {
          throw new Error(ev.code);
        }
      }
      if (!finished) throw lost(new Error('cut off')); // the stream ended without its closing event
    } catch (err) {
      if (err?.retriable || err?.name === 'AbortError') {
        retry = true;
        if (bubble) bubble.dataset.incomplete = 'true';
      } else {
        const target = bubble ?? this.addMessage('assistant');
        if (!target.textContent) target.textContent = expired ? TEXT[this.lang].pinExpired : TEXT[this.lang].error;
      }
    } finally {
      clearTimeout(slowTimer);
      clearTimeout(stallTimer);
      this.q('thinking').hidden = true;
    }
    return { retry, pinNeeded };
  }
}

async function* readEvents(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    let chunk;
    try { chunk = await reader.read(); } catch (e) { throw lost(e); }
    const { done, value } = chunk;
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
