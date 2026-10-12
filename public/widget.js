// <bank-assistant> chat widget. Mounted by one script tag; talks only to the
// assistant service (never to a model). Attributes: api (service base URL,
// default same origin), tenant, token (demo only; the portal sets
// el.getToken = () => userToken instead).
const TEXT = {
  en: {
    title: 'Assistant',
    placeholder: 'Ask how to do something…',
    send: 'Send',
    thinking: 'Thinking…',
    used: 'What I used',
    error: 'The assistant is unavailable right now. Please try again.',
    disclaimer: 'Automated assistant, it may make mistakes. It will never ask for your PIN or OTP.',
  },
  fr: {
    title: 'Assistant',
    placeholder: 'Demandez comment faire…',
    send: 'Envoyer',
    thinking: 'Réflexion en cours…',
    used: "Ce que j'ai utilisé",
    error: "L'assistant est indisponible pour le moment. Veuillez réessayer.",
    disclaimer: 'Assistant automatique, il peut se tromper. Il ne vous demandera jamais votre PIN ni votre OTP.',
  },
};

class BankAssistant extends HTMLElement {
  connectedCallback() {
    this.lang = this.getAttribute('lang') === 'fr' ? 'fr' : 'en';
    this.conversationId = null;
    this.innerHTML = `
      <section class="ba-root" aria-label="Assistant">
        <header data-role="title"></header>
        <div data-role="messages" aria-live="polite"></div>
        <div data-role="thinking" hidden></div>
        <form data-role="form">
          <input data-role="input" type="text" maxlength="1000" autocomplete="off" />
          <button data-role="send" type="submit"></button>
        </form>
        <p data-role="disclaimer"></p>
      </section>`;
    this.q = (r) => this.querySelector(`[data-role="${r}"]`);
    this.q('form').addEventListener('submit', (e) => { e.preventDefault(); this.submit(); });
    this.render();
  }

  render() {
    const t = TEXT[this.lang];
    this.q('title').textContent = t.title;
    this.q('input').placeholder = t.placeholder;
    this.q('send').textContent = t.send;
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

  addChip(text) {
    const el = document.createElement('div');
    el.dataset.role = 'guides-used';
    el.textContent = text;
    this.q('messages').appendChild(el);
  }

  async submit() {
    const input = this.q('input');
    const message = input.value.trim();
    if (!message || this.busy) return;
    input.value = '';
    this.busy = true;
    this.addMessage('user', message);
    this.q('thinking').hidden = false;
    let bubble = null;
    let guides = [];
    try {
      const token = this.getToken?.() ?? this.getAttribute('token') ?? '';
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
