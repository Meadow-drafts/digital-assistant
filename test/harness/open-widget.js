import { JSDOM } from 'jsdom';

// Loads the demo host page served by a running service into jsdom, running the
// real widget script. Returns helpers to drive it like a customer would.
export async function openWidget(baseUrl) {
  const dom = await JSDOM.fromURL(`${baseUrl}/`, {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = (url, init) => fetch(new URL(url, baseUrl), init);
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
