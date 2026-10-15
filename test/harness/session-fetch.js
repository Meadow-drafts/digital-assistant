// Test stand-in for what the real widget does with the signed session id (ticket 38): it keeps the id the service
// returns from POST /session and sends it back, as the X-Assistant-Session header, on later calls made with the same
// bearer token to the same service. Tests then keep their shape (open a session, call with the token) while a test
// that wants to be a stranger sends its request through `rawFetch`, which never adds the header.
export const rawFetch = globalThis.__rawFetch ?? globalThis.fetch;
const sessions = new Map(); // `${origin}|${authorization}` -> session id

if (!globalThis.__rawFetch) {
  globalThis.__rawFetch = rawFetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const headers = new Headers(init.headers);
    const key = `${url.origin}|${headers.get('authorization')}`;
    if (url.pathname !== '/session' && !headers.has('x-assistant-session') && sessions.has(key)) headers.set('x-assistant-session', sessions.get(key));
    const res = await rawFetch(input, { ...init, headers });
    if (url.pathname === '/session' && res.ok) {
      const id = (await res.clone().json().catch(() => null))?.sessionId;
      if (typeof id === 'string') sessions.set(key, id);
    }
    return res;
  };
}
