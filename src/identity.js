import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// The bearer token the widget forwards on each request. It is held for that
// request only: it is never stored on a conversation, logged or sent to the model.
export const tokenOf = (req) => /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? null;

// The token's subject, read without verifying the signature: the gateway is
// what verifies it, and every id the assistant uses is then confirmed by a
// gateway call made with that same token. Null when the token is not a JWT.
export function subjectOf(token) {
  try {
    const sub = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).sub;
    return typeof sub === 'string' && sub ? sub : null;
  } catch { return null; }
}

const digest = (value) => createHash('sha256').update(value).digest('hex').slice(0, 12);

// Who a conversation belongs to. A refreshed token keeps the same subject, so
// the conversation survives a refresh; a different customer never matches.
export function ownerOf(token) {
  if (!token) return 'anonymous';
  const sub = subjectOf(token);
  return sub ? `sub-${digest(sub)}` : digest(token);
}

// ---- Signed session id (ticket 38) ----
//
// The token's subject is read without checking the signature, so on its own it proves nothing about who is asking.
// What proves it is the gateway: at session start the backend accepted this very token. From that moment the service
// signs a session id (HMAC with a server-side secret) that names the owner and an expiry, and every customer route
// takes its owner from that id alone. The id is sent in the X-Assistant-Session header next to the bearer token, which
// must still name the same subject, so a stolen id is useless with someone else's token.
//
// A request with no session id is a "guest": how-to chat only, in a separate `guest-` owner namespace that no verified
// session shares, so nothing a guest can forge reaches a verified customer's conversations or cases. A session id that
// is present but bad or expired is never a guest: it is refused, so the widget starts a new session.
export const SESSION_HEADER = 'x-assistant-session';
const DEFAULT_TTL_MS = 8 * 60 * 60_000;

// The token's own expiry (`exp`, seconds), in ms, or null when it has none or is not a JWT.
export function expiryOf(token) {
  try {
    const exp = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).exp;
    return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null;
  } catch { return null; }
}

// Guests are keyed by the token's subject (or the token) so a how-to chat survives a token refresh, but never as a verified owner.
export function guestOwnerOf(token) {
  if (!token) return 'anonymous';
  return `guest-${digest(subjectOf(token) ?? token)}`;
}

export function createIdentity({ secret = randomBytes(32), clock, ttlMs = DEFAULT_TTL_MS }) {
  const sign = (payload) => createHmac('sha256', secret).update(payload).digest('base64url');
  return {
    // Call only after the gateway has accepted `token`. The id ends with the token's expiry if that is sooner than ttlMs.
    issue(token) {
      const expiresAt = Math.min(clock.now() + ttlMs, expiryOf(token) ?? Infinity);
      const payload = Buffer.from(JSON.stringify({ o: ownerOf(token), e: expiresAt })).toString('base64url');
      return { sessionId: `${payload}.${sign(payload)}`, owner: ownerOf(token), expiresAt };
    },
    // { owner, verified: true } for a good session id; { owner: guest, verified: false } when there is none; { error } when it is bad.
    resolve(req) {
      const token = tokenOf(req);
      const header = req.headers[SESSION_HEADER];
      if (header === undefined) return { owner: guestOwnerOf(token), verified: false };
      if (typeof header !== 'string') return { error: 'session_expired' };
      const [payload, signature, ...rest] = header.split('.');
      if (!payload || !signature || rest.length) return { error: 'session_expired' };
      const expected = Buffer.from(sign(payload));
      const given = Buffer.from(signature);
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { error: 'session_expired' };
      let claims;
      try { claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return { error: 'session_expired' }; }
      if (typeof claims?.o !== 'string' || typeof claims.e !== 'number' || clock.now() >= claims.e) return { error: 'session_expired' };
      // The bearer token must name the same customer the session was issued for.
      if (!token || ownerOf(token) !== claims.o) return { error: 'session_expired' };
      return { owner: claims.o, verified: true };
    },
  };
}
