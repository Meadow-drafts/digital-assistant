import { createHash } from 'node:crypto';

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
