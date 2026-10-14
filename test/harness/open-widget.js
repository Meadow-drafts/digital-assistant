import { JSDOM } from 'jsdom';
import { rawFetch } from './session-fetch.js';

// Loads a page (the demo host page by default, or /console) served by a running service into jsdom, running the
// real widget script. Returns helpers to drive it like a customer would.
export async function openWidget(baseUrl, path = '/') {
  const dom = await JSDOM.fromURL(`${baseUrl}${path}`, {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    beforeParse(window) {
      // rawFetch: the widget itself must send the session id it was given; the test harness does not do it for it.
      window.fetch = (url, init) => rawFetch(new URL(url, baseUrl), init);
      window.TextDecoder = TextDecoder;
      window.TextEncoder = TextEncoder;
      Object.defineProperty(window, 'crypto', { value: globalThis.crypto, configurable: true });
    },
  });
  const { document } = dom.window;
  await new Promise((resolve) => (document.readyState === 'complete' ? resolve() : dom.window.addEventListener('load', resolve)));
  const q = (role) => document.querySelector(`[data-role="${role}"]`);
  const qa = (role) => [...document.querySelectorAll(`[data-role="${role}"]`)];
  return {
    dom,
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
