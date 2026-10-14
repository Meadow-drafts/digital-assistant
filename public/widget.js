// <bank-assistant> chat widget. Mounted by one script tag; talks only to the
// assistant service (never to a model). Attributes: api (service base URL,
// default same origin), tenant, brand-name, brand-primary and brand-secondary
// (display-only tenant configuration), token (demo only; the portal sets
// el.getToken = () => userToken instead). For account reads the host also
// provides the customer's cli once (cli attribute or el.getCli) and, until the
// backend can supply them, gating data (gating attribute or el.getGating).
// Host event: bank-assistant:navigate {path, target} when a card asks for a page. The widget never fills portal forms.
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
    launcher: 'Open BPay assistant', newChat: 'New chat', more: 'More options', minimize: 'Minimize assistant', messageLabel: 'Ask about BPay',
    welcome: 'How can I help with BPay?', welcomeHint: 'Browse a topic below or ask in your own words. I’ll guide you using information available for your account.',
    helpTopics: 'Popular how-to topics', searchTopics: 'Search help topics', noTopics: 'No matching topics are available. Ask your question below.', loadingTopics: 'Loading available help topics…',
    quickOverview: 'Quick help for', contextualOverview: 'See balance and recent activity guidance', genericHelp: 'Browse help topics or ask a question',
    help: 'Help and privacy', home: 'Help topics',
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
    caseWaiting: 'Waiting for an agent',
    caseWithAgent: 'With an agent',
    caseRef: (ref) => `Case ${ref}`,
    cancel: 'Cancel',
    humanBadge: 'human agent',
    automated: 'Automated reply',
    cancelled: (ref) => `Case ${ref} closed: cancelled by you. Back to the assistant.`,
    solvedQ: 'Was this solved?',
    rateAnswer: 'Rate this answer',
    thumbsUp: 'Helpful',
    thumbsDown: 'Not helpful',
    feedbackSaved: 'Thank you for your feedback.',
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
    launcher: 'Ouvrir l’assistant BPay', newChat: 'Nouvelle discussion', more: 'Plus d’options', minimize: 'Réduire l’assistant', messageLabel: 'Posez une question sur BPay',
    welcome: 'Comment puis-je vous aider avec BPay ?', welcomeHint: 'Parcourez les sujets ou posez votre question avec vos mots. Je vous guiderai selon les informations disponibles pour votre compte.',
    helpTopics: 'Guides pratiques populaires', searchTopics: 'Rechercher des sujets', noTopics: 'Aucun sujet correspondant n’est disponible. Posez votre question ci-dessous.', loadingTopics: 'Chargement des sujets disponibles…',
    quickOverview: 'Aide rapide pour', contextualOverview: 'Consulter les conseils sur le solde et l’activité récente', genericHelp: 'Parcourez les sujets ou posez une question',
    help: 'Aide et confidentialité', home: 'Sujets d’aide',
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
    caseWaiting: "En attente d'un agent",
    caseWithAgent: 'Avec un agent',
    caseRef: (ref) => `Dossier ${ref}`,
    cancel: 'Annuler',
    humanBadge: 'agent humain',
    automated: 'Réponse automatique',
    cancelled: (ref) => `Dossier ${ref} fermé : annulé par vous. Retour à l'assistant.`,
    solvedQ: 'Cela a-t-il résolu votre problème ?',
    rateAnswer: 'Évaluer cette réponse',
    thumbsUp: 'Utile',
    thumbsDown: 'Pas utile',
    feedbackSaved: 'Merci pour votre avis.',
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
// Chip reasons for a disputed transaction (a dispute, a wrong transfer, a reversal, a debit with no credit): the chip
// click starts a drafted message. Fraud cues and plain "contact the bank" endings keep opening the handoff directly.
const DISPUTE_REASONS = ['dispute', 'wrong_transfer', 'reversal', 'debit_without_credit', 'reversal_in_progress'];
// Poor connections (ticket 50): a failed or stalled send is retried after these delays (ms), then the customer decides.
const BACKOFF = [1000, 2000, 4000, 8000, 16000];
const SLOW_MS = 8000; // no byte for this long: say so
const STALL_MS = 30000; // no byte for this long: give up on the request and retry it
const newId = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`);
const lost = (e) => Object.assign(e instanceof Error ? e : new Error(String(e)), { retriable: true });
const transientStatus = (status) => status === 408 || status === 429 || status >= 500;
const brandColor = (value) => {
  if (typeof value !== 'string') return null;
  const color = value.trim();
  if (/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(color)) return color;
  const channels = /^(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})$/.exec(color);
  if (!channels || channels.slice(1).some((channel) => Number(channel) > 255)) return null;
  return `rgb(${channels.slice(1).join(' ')})`;
};

class BankAssistant extends HTMLElement {
  static get observedAttributes() { return ['brand-name', 'brand-primary', 'brand-secondary']; }

  connectedCallback() {
    this.lang = this.getAttribute('lang') === 'fr' ? 'fr' : 'en';
    this.conversationId = null;
    this.caseView = null;
    this.cursor = 0;
    this.outbox = []; // messages typed but not yet answered, oldest first
    this.onOnline = () => { clearTimeout(this.retryTimer); this.retryTimer = null; this.pump(); };
    window.addEventListener('online', this.onOnline);
    this.innerHTML = `
      <style>
        .ba-root { --ba-accent: var(--ba-brand-primary, #ce6d0d); display:block;max-width:none;padding:0;border:0;border-radius:0;background:transparent;font: 14px/1.45 Inter, ui-sans-serif, system-ui, sans-serif; color:#272a30; }
        .ba-root *, .ba-root *::before, .ba-root *::after { box-sizing:border-box; }
        .ba-root button, .ba-root input { font:inherit; }
        .ba-root button { cursor:pointer; }
        .ba-root button:focus-visible, .ba-root input:focus-visible { outline:3px solid #e7a563; outline-offset:2px; }
        .ba-root [hidden] { display:none !important; }
        .ba-shell { position:fixed; z-index:2147483000; right:24px; bottom:20px; width:min(460px,calc(100vw - 24px)); height:min(760px,calc(100dvh - 32px)); background:#fff; border:1px solid #e6e7ea; border-radius:22px; box-shadow:0 18px 60px #1b202933; display:flex; flex-direction:column; overflow:hidden; }
        .ba-header { flex:none; display:flex; align-items:center; gap:10px; padding:12px 15px; border-bottom:1px solid #eceef0; }
        .ba-mark { display:grid; place-items:center; width:34px;height:34px;border-radius:12px;background:#fff0e2;color:var(--ba-accent);font-weight:800; }
        .ba-heading { flex:1; min-width:0; color:var(--ba-accent); font-weight:650; }
        .ba-head-actions { display:flex; gap:3px; }
        .ba-head-actions button { width:34px;height:34px;border:0;border-radius:9px;background:transparent;color:#565b63;font-size:19px; }
        .ba-head-actions button:hover { background:#f3f4f6; }
        .ba-menu { position:absolute;z-index:4;right:52px;top:58px;width:190px;padding:6px;background:#fff;border:1px solid #e4e5e8;border-radius:12px;box-shadow:0 10px 30px #171a2022; }
        .ba-menu button { width:100%;padding:10px;border:0;border-radius:8px;background:#fff;text-align:left;color:#353940; }
        .ba-menu button:hover { background:#f5f6f7; }
        .ba-home { flex:1; min-height:0; overflow:auto; padding:20px 24px 12px; }
        .ba-welcome { text-align:center;margin:7px auto 21px; }
        .ba-welcome h2 { margin:0 0 7px;font-size:23px;letter-spacing:-.4px; }
        .ba-welcome p { margin:auto;max-width:350px;color:#747982;font-size:13px; }
        .ba-context { display:flex;align-items:center;gap:10px;padding:10px 12px;margin-bottom:15px;background:#fff8f1;border:1px solid #f7e6d6;border-radius:12px;text-align:left;color:#30343a; }
        .ba-context button { width:100%;border:0;background:transparent;text-align:left;color:inherit; }
        .ba-context strong,.ba-context small { display:block; }
        .ba-context small { color:#737780; }
        .ba-search { display:flex;align-items:center;gap:8px;padding:0 12px;height:42px;border:1px solid #e1e3e6;background:#fafafb;border-radius:11px;margin-bottom:12px; }
        .ba-search input { width:100%;min-width:0;border:0;outline:0;background:transparent;color:#30343b; }
        .ba-home h3 { margin:12px 0 5px;color:#6d727a;font-size:11px;letter-spacing:.05em;text-transform:uppercase; }
        .ba-topic { width:100%;display:flex;align-items:center;gap:10px;padding:9px 5px;border:0;border-radius:9px;background:transparent;text-align:left;color:#30343a; }
        .ba-topic:hover { background:#f7f7f8; }
        .ba-topic span:nth-child(2) { flex:1; }
        .ba-topic .ba-topic-icon { color:#777e87; }
        .ba-empty { color:#777e87;padding:12px 3px; }
        .ba-body { flex:1;min-height:0;overflow:auto;padding:16px 20px;display:none; }
        .ba-body[data-active="true"] { display:block; }
        .ba-body [data-role="messages"] { display:flex;flex-direction:column;gap:8px; }
        .ba-root [data-role="message"] { max-width:88%;padding:10px 13px;border-radius:15px;background:#f3f4f6; }
        .ba-root [data-from="user"] { align-self:flex-end;background:#fff0e2;border-top-right-radius:5px; }
        .ba-root [data-from="assistant"] { align-self:flex-start;border-top-left-radius:5px; }
        .ba-chips { flex:none;display:flex;gap:7px;overflow:auto;padding:10px 14px;border-top:1px solid #f0f1f2; }
        .ba-chip { flex:none;padding:7px 11px;border-radius:999px;border:1px solid #e1e2e5;background:white;color:#575c64;font-size:12px; }
        .ba-chip[data-role="human-chip"] { border-color:#e7b27f;background:#fff9f3;color:#9b500d; }
        .ba-chip[data-role="human-chip"]::before { content:'👤';margin-right:5px; }
        .ba-compose { flex:none;padding:0 14px 7px; }
        .ba-compose form { display:flex;gap:7px;align-items:center;padding:6px 7px 6px 12px;border:1px solid #d9dce0;border-radius:14px; }
        .ba-compose [data-role="input"] { flex:1;min-width:0;border:0;outline:0;background:transparent;padding:5px 0; }
        .ba-root [data-role="send"] { background:var(--ba-accent);border:0;border-radius:10px;color:white;padding:8px 12px; }
        .ba-disclaimer { flex:none;text-align:center;color:#858991;font-size:10px;margin:0 0 8px;padding:0 8px; }
        .ba-launcher { position:fixed;z-index:2147483000;right:24px;bottom:20px;display:flex;align-items:center;gap:8px;padding:12px 16px;border:0;border-radius:999px;background:var(--ba-brand-primary,#ce6d0d);color:#fff;box-shadow:0 8px 26px #171a2033;font-weight:650; }
        @media (max-width:600px) { .ba-shell { right:8px;bottom:max(8px,env(safe-area-inset-bottom));width:calc(100vw - 16px);height:calc(100dvh - 16px - env(safe-area-inset-top));border-radius:18px; } .ba-launcher { right:14px;bottom:max(14px,env(safe-area-inset-bottom)); } .ba-home { padding:18px 17px 10px; } }
        @media (prefers-reduced-motion: reduce) { .ba-shell,.ba-launcher { scroll-behavior:auto;transition:none; } }
        .ba-root [data-role="title"] { color: var(--ba-brand-primary, #2458a8); font-weight: 650; }
        .ba-root [data-role="send"] { background: var(--ba-brand-primary, #2458a8); border: 1px solid var(--ba-brand-primary, #2458a8); border-radius: .35rem; color: #fff; padding: .4rem .75rem; }
        .ba-root [data-role="human-chip"] { border-color: var(--ba-brand-secondary, #607080); }
        .ba-root [data-role="human-chip"][data-prominent="true"] { background: var(--ba-brand-primary, #2458a8); border-color: var(--ba-brand-primary, #2458a8); color: #fff; }
        .ba-root [data-role="clarification-options"] { display: flex; flex-wrap: wrap; gap: .4rem; margin: .4rem 0; }
        .ba-root [data-role="quick-replies"] { display: flex; flex-wrap: wrap; gap: .4rem; margin: .4rem 0; }
      </style>
      <section class="ba-root" data-role="root" aria-label="Assistant">
        <button class="ba-launcher" data-role="launcher" type="button" aria-label="Open BPay assistant" hidden><span aria-hidden="true">✦</span><span data-role="launcher-label">BPay</span></button>
        <div class="ba-shell" data-role="shell">
        <header class="ba-header"><div class="ba-mark" aria-hidden="true">B</div><div class="ba-heading" data-role="title"></div><div class="ba-head-actions"><button data-role="new-chat" type="button" aria-label="New chat" title="New chat">＋</button><button data-role="more" type="button" aria-label="More options" aria-expanded="false">…</button><button data-role="minimize" type="button" aria-label="Minimize assistant" title="Minimize">×</button></div>
        <nav class="ba-menu" data-role="menu" hidden aria-label="More options"><button data-role="menu-cases" type="button"></button><button data-role="menu-help" type="button"></button></nav>
        </header>
        <section class="ba-home" data-role="home"><div class="ba-welcome"><h2 data-role="welcome" tabindex="-1"></h2><p data-role="welcome-hint"></p></div><div data-role="context-card" class="ba-context" hidden><button data-role="context-button" type="button"><strong data-role="context-title"></strong><small data-role="context-copy"></small></button></div><label class="ba-search"><span aria-hidden="true">⌕</span><input data-role="topic-search" type="search" aria-label="Search help topics" /></label><h3 data-role="topics-title"></h3><p data-role="topics-loading" aria-live="polite" hidden></p><div data-role="topics" aria-live="polite" aria-busy="false"></div><p class="ba-empty" data-role="topics-empty" hidden></p></section>
        <div class="ba-body" data-role="body">
        <button data-role="my-cases-button" type="button"></button>
        <section data-role="my-cases-panel" hidden>
          <h3 data-role="my-cases-title" tabindex="-1"></h3>
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
        <button class="ba-chip" data-role="human-chip" type="button" data-prominent="false"></button>
        </div>
        <p class="ba-disclaimer" data-role="disclaimer"></p>
        <div class="ba-chips" data-role="chips"></div>
        <div class="ba-compose"><form data-role="form"><input data-role="input" type="text" maxlength="1000" autocomplete="off" /><button data-role="send" type="submit"></button></form></div>
        </div>
      </section>`;
    this.q = (r) => this.querySelector(`[data-role="${r}"]`);
    this.q('menu').id = `ba-menu-${newId()}`;
    this.q('more').setAttribute('aria-controls', this.q('menu').id);
    this.q('chips').append(this.q('human-chip'));
    this.q('launcher').hidden = false;
    this.q('shell').hidden = true;
    this.q('launcher').addEventListener('click', () => this.openPanel());
    this.q('minimize').addEventListener('click', () => this.minimizePanel());
    this.q('new-chat').addEventListener('click', () => this.newChat());
    this.q('more').addEventListener('click', () => this.toggleMenu());
    this.q('menu-cases').addEventListener('click', () => { this.closeMenu(); this.showMyCases(); });
    this.q('menu-help').addEventListener('click', () => { this.closeMenu(); this.q('my-cases-panel').hidden = true; this.showHome(); });
    this.q('topic-search').addEventListener('input', () => this.renderTopics());
    this.q('context-button').addEventListener('click', () => { const key = this.contextTopic?.key; if (key) this.selectTopic(key); });
    this.onRouteChange = () => this.refreshTopics();
    window.addEventListener('popstate', this.onRouteChange);
    window.addEventListener('hashchange', this.onRouteChange);
    window.addEventListener('bank-assistant:page-change', this.onRouteChange);
    this.installHistoryWatcher();
    this.addEventListener('bank-assistant:navigate', () => setTimeout(this.onRouteChange, 0));
    this.onEscape = (event) => { if (event.key === 'Escape') { if (!this.q('menu').hidden) this.closeMenu(true); else if (!this.q('shell').hidden) this.minimizePanel(); } };
    window.addEventListener('keydown', this.onEscape);
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
    this.refreshTopics();
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
    window.removeEventListener('popstate', this.onRouteChange);
    window.removeEventListener('hashchange', this.onRouteChange);
    window.removeEventListener('bank-assistant:page-change', this.onRouteChange);
    for (const [name, original, wrapped] of this.historyMethods ?? []) {
      if (window.history[name] === wrapped) window.history[name] = original;
    }
    window.removeEventListener('keydown', this.onEscape);
    clearTimeout(this.retryTimer);
  }

  render() {
    const t = TEXT[this.lang];
    this.setConnection(this.connection ?? null);
    this.q('title').textContent = t.title;
    this.q('launcher-label').textContent = 'BPay';
    this.q('launcher').setAttribute('aria-label', t.launcher);
    this.q('new-chat').setAttribute('aria-label', t.newChat);
    this.q('new-chat').title = t.newChat;
    this.q('more').setAttribute('aria-label', t.more);
    this.q('menu').setAttribute('aria-label', t.more);
    this.q('menu-cases').textContent = t.myCases;
    this.q('menu-help').textContent = t.home;
    this.q('minimize').setAttribute('aria-label', t.minimize);
    this.q('welcome').textContent = t.welcome;
    this.q('welcome-hint').textContent = t.welcomeHint;
    this.q('topics-title').textContent = t.helpTopics;
    this.q('topic-search').placeholder = t.searchTopics;
    this.q('topic-search').setAttribute('aria-label', t.searchTopics);
    this.q('topics-empty').textContent = t.noTopics;
    this.q('topics-loading').textContent = t.loadingTopics;
    this.q('input').placeholder = t.placeholder;
    this.q('input').setAttribute('aria-label', t.messageLabel);
    this.q('send').textContent = t.send;
    this.q('pin-title').textContent = t.pinTitle;
    this.q('pin-input').placeholder = t.pinPlaceholder;
    this.q('pin-submit').textContent = t.pinSubmit;
    this.q('human-chip').textContent = t.human;
    this.q('human-chip').setAttribute('aria-label', t.human);
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
    this.renderTopics();
  }

  openPanel() {
    this.q('shell').hidden = false;
    this.q('launcher').hidden = true;
    this.refreshTopics();
    this.q('topic-search').focus();
  }

  minimizePanel() {
    this.closeMenu();
    this.q('shell').hidden = true;
    this.q('launcher').hidden = false;
    this.q('launcher').focus();
  }

  toggleMenu() {
    const menu = this.q('menu');
    menu.hidden = !menu.hidden;
    this.q('more').setAttribute('aria-expanded', String(!menu.hidden));
  }

  closeMenu(returnFocus = false) {
    this.q('menu').hidden = true;
    this.q('more').setAttribute('aria-expanded', 'false');
    if (returnFocus) this.q('more').focus();
  }

  installHistoryWatcher() {
    this.historyMethods = [];
    for (const name of ['pushState', 'replaceState']) {
      const original = window.history[name];
      const wrapped = function (...args) {
        const result = original.apply(this, args);
        window.dispatchEvent(new CustomEvent('bank-assistant:page-change'));
        return result;
      };
      try { window.history[name] = wrapped; this.historyMethods.push([name, original, wrapped]); } catch { /* host can dispatch bank-assistant:page-change */ }
    }
  }

  showHome() {
    this.chatActive = false;
    this.q('home').hidden = false;
    this.q('body').dataset.active = 'false';
    this.q('welcome').focus();
  }

  newChat() {
    if (this.pumping) return;
    clearTimeout(this.pollTimer);
    this.q('messages').replaceChildren();
    this.q('my-cases-panel').hidden = true;
    this.q('case-banner').hidden = true;
    this.closeMenu();
    this.q('input').value = '';
    this.q('topic-search').value = '';
    this.q('pin-box').hidden = true;
    this.q('pin-input').value = '';
    this.q('pin-note').textContent = '';
    this.q('draft-panel').hidden = true;
    this.q('solved-prompt').hidden = true;
    this.draft = null;
    this.pendingMessage = null;
    this.caseView = null;
    this.renderCase();
    this.conversationId = null;
    this.sessionId = null;
    this.sessionStarted = false;
    this.cursor = 0;
    this.outbox = [];
    this.showHome();
    this.openPanel();
  }

  async refreshTopics() {
    const token = this.token();
    this.q('topics').setAttribute('aria-busy', 'true');
    this.q('topics-loading').hidden = false;
    this.q('topics-loading').textContent = TEXT[this.lang].loadingTopics;
    try {
      await this.startSession(token);
      if (!this.sessionId || !this.conversationId) { this.topics = []; this.contextTopic = null; this.finishTopicLoad(); return; }
      const path = window.location.pathname;
      const query = new URLSearchParams({ language: this.lang, path, conversationId: this.conversationId });
      const res = await fetch(`${this.getAttribute('api') ?? ''}/help/topics?${query}`, { headers: this.authHeaders(token) });
      if (!res.ok) throw new Error('topics');
      const data = await res.json();
      this.topics = Array.isArray(data.topics) ? data.topics.filter((item) => typeof item.key === 'string' && typeof item.title === 'string') : [];
      this.contextTopic = data.context?.topics?.[0] ?? null;
      this.contextLabel = data.context?.label ?? '';
      this.finishTopicLoad();
    } catch { this.topics = []; this.contextTopic = null; this.finishTopicLoad(); }
  }

  finishTopicLoad() {
    this.q('topics').setAttribute('aria-busy', 'false');
    this.q('topics-loading').hidden = true;
    this.renderTopics();
  }

  renderTopics() {
    const box = this.q?.('topics');
    if (!box) return;
    const q = this.q('topic-search').value.trim().toLocaleLowerCase(this.lang);
    const visible = (this.topics ?? []).filter((item) => item.title.toLocaleLowerCase(this.lang).includes(q));
    box.replaceChildren(...visible.map((item) => {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'ba-topic'; button.dataset.topicKey = item.key;
      button.dataset.role = 'topic';
      const icon = document.createElement('span'); icon.className = 'ba-topic-icon'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = '♧';
      const title = document.createElement('span'); title.textContent = item.title;
      const arrow = document.createElement('span'); arrow.setAttribute('aria-hidden', 'true'); arrow.textContent = '›';
      button.append(icon, title, arrow); button.addEventListener('click', () => this.selectTopic(item.key)); return button;
    }));
    this.q('topics-empty').hidden = visible.length > 0;
    const context = this.q('context-card');
    context.hidden = !this.contextTopic;
    if (this.contextTopic) {
      this.q('context-title').textContent = `${TEXT[this.lang].quickOverview} ${this.contextLabel}`;
      this.q('context-copy').textContent = this.contextTopic.title;
    }
  }

  selectTopic(key) {
    const topic = (this.topics ?? []).find((item) => item.key === key);
    if (!topic) return;
    this.q('input').value = topic.title;
    this.chatActive = true;
    this.q('home').hidden = true;
    this.q('body').dataset.active = 'true';
    this.q('input').focus();
    this.submit({ guideKey: key });
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

  attachAnswerFeedback(message, answerId) {
    if (!message || typeof answerId !== 'string' || !answerId) return;
    message.dataset.answerId = answerId;
    const t = TEXT[this.lang];
    const controls = document.createElement('div');
    controls.dataset.role = 'answer-feedback';
    controls.dataset.answerId = answerId;
    const label = document.createElement('span');
    label.textContent = t.rateAnswer;
    controls.append(label);
    for (const [rating, text] of [['up', t.thumbsUp], ['down', t.thumbsDown]]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.role = rating === 'up' ? 'thumbs-up' : 'thumbs-down';
      button.setAttribute('aria-label', text);
      button.textContent = rating === 'up' ? '👍' : '👎';
      button.addEventListener('click', async () => {
        if (button.disabled) return;
        controls.querySelectorAll('button').forEach((item) => { item.disabled = true; });
        try {
          const res = await this.caseCall('POST', '/feedback', { conversationId: this.conversationId, answerId, rating });
          if (!res.ok) throw new Error('feedback');
          label.textContent = t.feedbackSaved;
        } catch {
          label.textContent = t.rateAnswer;
          controls.querySelectorAll('button').forEach((item) => { item.disabled = false; });
        }
      });
      controls.append(button);
    }
    message.parentNode.insertBefore(controls, message.nextSibling);
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
    this.q('home').hidden = true;
    this.q('body').dataset.active = 'true';
    this.q('my-cases-panel').hidden = false;
    this.q('my-case-detail').hidden = true;
    this.q('my-cases-list').hidden = false;
    this.q('my-cases-error').textContent = '';
    this.q('my-cases-empty').hidden = true;
    this.q('my-cases-list').replaceChildren();
    this.q('my-cases-loading').textContent = t.myCasesLoading;
    this.q('my-cases-title').focus();
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
    this.q('home').hidden = true;
    this.q('body').dataset.active = 'true';
    if (conversationId === this.conversationId && this.caseView && (this.caseView.state === 'waiting' || this.caseView.state === 'with_agent')) return;
    try {
      const res = await this.caseCall('GET', `/case?conversationId=${encodeURIComponent(conversationId)}&after=0`);
      if (!res.ok) throw new Error('chat');
      if (conversationId !== this.conversationId) this.q('messages').replaceChildren();
      this.conversationId = conversationId;
      this.caseView = null;
      this.cursor = 0;
      this.applyCase(res.body);
      this.q('input').focus();
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
    this.caseView = view;
    for (const m of view.messages ?? []) { if (m.from === 'system') this.addNote(m.text); else this.addMessage('agent', m.text); }
    if (Number.isInteger(view.next)) this.cursor = view.next;
    if (view.state === 'resolved') this.q('solved-prompt').hidden = view.askSolved !== true;
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

  addClarification(event) {
    const question = this.addMessage('assistant', event.question);
    question.dataset.role = 'clarification-question';
    const choices = document.createElement('div');
    choices.dataset.role = 'clarification-options';
    for (const option of event.options ?? []) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.role = 'clarification-option';
      button.textContent = option;
      button.addEventListener('click', () => {
        for (const choice of choices.querySelectorAll('button')) choice.disabled = true;
        this.q('input').value = option;
        this.submit();
      });
      choices.appendChild(button);
    }
    this.q('messages').appendChild(choices);
  }

  addQuickReplies(event) {
    const container = this.q('chips');
    const humanChip = this.q('human-chip');
    container.replaceChildren();
    const choices = document.createElement('div');
    choices.dataset.role = 'quick-replies';
    choices.style.display = 'contents';
    for (const option of event.options ?? []) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.role = 'quick-reply';
      button.className = 'ba-chip';
      button.textContent = option;
      button.addEventListener('click', () => {
        if (/^(talk to (?:a )?human agent|talk to an agent|parler à un agent)$/i.test(option)) {
          this.q('human-chip').click();
          return;
        }
        this.q('input').value = option;
        this.q('input').focus();
      });
      choices.appendChild(button);
    }
    container.append(choices, humanChip);
  }

  // Fixed next-step card from the service (human chip or a form shortcut); the text is never model-written.
  addCard(card) {
    const el = document.createElement('div');
    el.dataset.role = 'next-step';
    el.dataset.kind = card.kind;
    el.textContent = card.text;
    this.q('messages').appendChild(el);
  }

  // Navigation card for a page the service validated. Clicking only opens the page; it never fills or submits a form.
  addActionCard(card) {
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
      if (transientStatus(res.status)) { this.sessionDown = true; return; }
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

  async submit({ guideKey = null } = {}) {
    const input = this.q('input');
    const message = input.value.trim();
    if (!message) return;
    input.value = '';
    this.q('chips').replaceChildren(this.q('human-chip'));
    this.chatActive = true;
    this.q('home').hidden = true;
    this.q('body').dataset.active = 'true';
    const turn = { id: newId(), message, guideKey, attempts: 0, bubble: this.addMessage('user', message) };
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
      arm();
      let res;
      try {
        const capturedAt = new Date().toISOString();
        const pageContext = this.q('my-cases-panel').hidden
          ? { path: window.location.pathname, capturedAt }
          : { surface: 'my-cases', capturedAt };
        res = await fetch(`${this.getAttribute('api') ?? ''}/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...this.authHeaders(token) },
          body: JSON.stringify({ message, messageId: turn.id, conversationId: this.conversationId, tenant: this.getAttribute('tenant'), pageContext, ...(turn.guideKey ? { guideKey: turn.guideKey } : {}) }),
          signal: ctl.signal,
        });
      } catch (e) { throw lost(e); }
      if (res.status === 401) { this.dropSession(); expired = true; } // no silent retry: the next message starts a new session
      if (transientStatus(res.status)) throw lost(new Error(`HTTP ${res.status}`));
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
          // Keep a partial answer visible while a retry is still connecting. Replace it only once
          // the resumed stream actually delivers new answer text.
          if (!bubble && turn.reply?.dataset.incomplete) turn.reply.remove();
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
        } else if (ev.type === 'clarification') {
          this.addClarification(ev);
        } else if (ev.type === 'quick_replies') {
          this.addQuickReplies(ev);
        } else if (ev.type === 'done') {
          finished = true;
          this.conversationId = ev.conversationId;
          if (TEXT[ev.language]) { this.lang = ev.language; this.render(); }
          this.attachAnswerFeedback(bubble, ev.answerId);
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
