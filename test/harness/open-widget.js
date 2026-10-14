import { JSDOM } from 'jsdom';
import { rawFetch } from './session-fetch.js';
import { createFakeClock } from './fake-clock.js';

// A controllable network for the widget (ticket 50). `offline`: every call fails like a lost connection (and
// navigator.onLine follows it). `hold`: the request reaches the service but its answer is withheld until released or the
// widget gives up on it (slow network). `cutAfterEvents`: the next /chat stream ends in a network error after that many
// events (dropped mid-reply). `requests`: the /chat bodies the widget sent.
export function createNetwork() {
  const net = {
    offline: false, hold: false, cutAfterEvents: null, requests: [],
    setOffline(value, window) {
      net.offline = value;
      Object.defineProperty(window.navigator, 'onLine', { value: !value, configurable: true });
    },
  };
  return net;
}

function withNetwork(net, window, baseUrl) {
  return async (url, init = {}) => {
    if (net.offline) throw new TypeError('Failed to fetch');
    const target = new URL(url, baseUrl);
    if (target.pathname === '/chat') net.requests.push(JSON.parse(init.body));
    // jsdom's AbortSignal is not Node's: pass the request on without it.
    const { signal, ...rest } = init;
    const pending = rawFetch(target, rest);
    if (net.hold && target.pathname === '/chat') {
      await pending;
      await new Promise((resolve, reject) => {
        const stop = () => reject(new DOMException('aborted', 'AbortError'));
        if (signal?.aborted) stop();
        signal?.addEventListener('abort', stop);
        net.release = () => { net.hold = false; resolve(); };
      });
    }
    const res = await pending;
    if (net.cutAfterEvents === null || target.pathname !== '/chat') return res;
    let left = net.cutAfterEvents;
    net.cutAfterEvents = null;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = '';
    const body = new ReadableStream({
      async pull(controller) {
        if (left <= 0) { controller.error(new TypeError('network error')); return; }
        const { done, value } = await reader.read();
        if (done) { controller.close(); return; }
        buffer += decoder.decode(value, { stream: true });
        let out = '';
        let i;
        while (left > 0 && (i = buffer.indexOf('\n\n')) >= 0) { out += buffer.slice(0, i + 2); buffer = buffer.slice(i + 2); left -= 1; }
        if (out) controller.enqueue(encoder.encode(out));
      },
    });
    return new Response(body, { status: res.status, headers: res.headers });
  };
}

// Loads a page (the demo host page by default, or /console) served by a running service into jsdom, running the
// real widget script. Returns helpers to drive it like a customer would.
export async function openWidget(baseUrl, path = '/', { net = createNetwork(), clock = null, attrs = null } = {}) {
  // `attrs` replaces the widget tag's attributes (the demo page's tag carries tenant="demo" and a token).
  const page = attrs ? (await (await rawFetch(`${baseUrl}${path}`)).text()).replace(/<bank-assistant [^>]*>/, `<bank-assistant ${attrs}>`) : null;
  const options = {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    beforeParse(window) {
      // rawFetch: the widget itself must send the session id it was given; the test harness does not do it for it.
      window.fetch = withNetwork(net, window, baseUrl);
      if (clock) {
        window.setTimeout = (fn, ms) => clock.setTimeout(fn, ms);
        window.clearTimeout = (id) => clock.clearTimeout(id);
      }
      window.TextDecoder = TextDecoder;
      window.TextEncoder = TextEncoder;
      Object.defineProperty(window, 'crypto', { value: globalThis.crypto, configurable: true });
    },
  };
  const dom = page ? new JSDOM(page, { ...options, url: `${baseUrl}${path}` }) : await JSDOM.fromURL(`${baseUrl}${path}`, options);
  const { document } = dom.window;
  await new Promise((resolve) => (document.readyState === 'complete' ? resolve() : dom.window.addEventListener('load', resolve)));
  const q = (role) => document.querySelector(`[data-role="${role}"]`);
  const qa = (role) => [...document.querySelectorAll(`[data-role="${role}"]`)];
  return {
    dom,
    net,
    document,
    q,
    qa,
    async send(text) {
      q('input').value = text;
      q('form').dispatchEvent(new dom.window.Event('submit', { cancelable: true, bubbles: true }));
    },
    async until(predicate, ms = 2000) {
      const end = Date.now() + ms;
      while (!predicate()) {
        if (Date.now() > end) throw new Error('timed out waiting for widget state');
        await new Promise((r) => setTimeout(r, 10));
      }
    },
  };
}
