import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

// Agent passwords. Production keeps only a hash in config/support.json: "scrypt$<salt hex>$<hash hex>", made with
// `node scripts/hash-password.js`. The demo may still hold a plain password; the production gate refuses that.
const PREFIX = 'scrypt$';
const KEY_BYTES = 32;

export const isHashed = (stored) => typeof stored === 'string' && /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/.test(stored);

export function hashPassword(password) {
  const salt = randomBytes(16);
  return `${PREFIX}${salt.toString('hex')}$${scryptSync(String(password), salt, KEY_BYTES).toString('hex')}`;
}

export function verifyPassword(given, stored) {
  if (isHashed(stored)) {
    const [, salt, hash] = stored.split('$');
    return timingSafeEqual(scryptSync(String(given), Buffer.from(salt, 'hex'), KEY_BYTES), Buffer.from(hash, 'hex'));
  }
  const digest = (v) => createHash('sha256').update(String(v)).digest();
  return timingSafeEqual(digest(given), digest(stored));
}
