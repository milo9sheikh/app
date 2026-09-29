import crypto from 'node:crypto';

const DEV_KEY = 'change-this';

function key(): Buffer {
  const secret = process.env.ROUTER_ENCRYPTION_KEY ?? DEV_KEY;
  if (process.env.NODE_ENV === 'production' && (secret === DEV_KEY || secret.length < 16)) {
    throw new Error('ROUTER_ENCRYPTION_KEY must be set to a strong secret in production');
  }
  return crypto.createHash('sha256').update(secret).digest();
}

/** AES-256-GCM. Output: iv:tag:ciphertext (hex). */
export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('hex')).join(':');
}

export function decryptSecret(stored: string): string {
  const [iv, tag, enc] = stored.split(':').map((h) => Buffer.from(h, 'hex'));
  const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  return `${salt.toString('hex')}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [s, h] = stored.split(':');
  const expected = Buffer.from(h, 'hex');
  return crypto.timingSafeEqual(expected, crypto.scryptSync(password, Buffer.from(s, 'hex'), expected.length));
}

export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
