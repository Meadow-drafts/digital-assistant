// Unsigned JWT-shaped token for tests: the service only reads `sub` from it;
// the (fake) gateway is the one that would verify it.
export function makeToken(sub, extra = '') {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64({ sub })}.sig${extra}`;
}
