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
  },
};

const PLAIN_PATH = /^\/(?!\/)[A-Za-z0-9\-/]*$/;
const PLAIN_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
// Never filled, whatever a card says: PIN, OTP, password, voucher and code inputs (by name, id or type).
const SECRET = /pin|otp|pass|voucher|code|cvv|token|secret|mdp/i;
const RESUME_KEY = 'bank-assistant:prefill';
const RESUME_MS = 60_000;
const text = (v, max) => (typeof v === 'string' && v.length <= max ? v : null);

class BankAssistant extends HTMLElement {
  connectedCallback() {
    this.lang = this.getAttribute('lang') === 'fr' ? 'fr' : 'en';
    this.conversationId = null;
    this.cards = new WeakMap();
    this.innerHTML = `
      <section class="ba-root" aria-label="Assistant">
        <header data-role="title"></header>
        <div data-role="messages" aria-live="polite"></div>
        <div data-role="thinking" hidden></div>
        <form data-role="pin-box" hidden>
          <p data-role="pin-title"></p>
          <input data-role="pin-input" type="password" inputmode="numeric" autocomplete="off" maxlength="12" />
          <button data-role="pin-submit" type="submit"></button>
          <p data-role="pin-note" aria-live="polite"></p>
        </form>
        <button data-role="human-chip" type="button" data-prominent="false"></button>
        <form data-role="form">
          <input data-role="input" type="text" maxlength="1000" autocomplete="off" />
          <button data-role="send" type="submit"></button>
        </form>
        <p data-role="disclaimer"></p>
      </section>`;
    this.q = (r) => this.querySelector(`[data-role="${r}"]`);
    this.q('form').addEventListener('submit', (e) => { e.preventDefault(); this.submit(); });
    // The chip only announces the customer's request; the host page starts any handoff.
    this.q('pin-box').addEventListener('submit', (e) => { e.preventDefault(); this.submitPin(); });
    this.q('human-chip').addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent('bank-assistant:handoff-request', { bubbles: true, detail: { conversationId: this.conversationId } }));
    });
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
        if (ev.type === 'delta') {
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
