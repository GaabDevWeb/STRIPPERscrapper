/**
 * Token local do bridge (≠ credenciais Infnet).
 * Gera/carrega `.bridge-token` na raiz do projecto.
 */
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';

/**
 * @param {string} tokenPath
 * @returns {Promise<string>}
 */
export async function loadOrCreateBridgeToken(tokenPath) {
  const resolved = path.resolve(tokenPath);
  try {
    const existing = (await fs.readFile(resolved, 'utf8')).trim();
    if (existing && existing.length >= 16) return existing;
  } catch {
    /* gera novo */
  }

  const token = crypto.randomBytes(32).toString('hex');
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  return token;
}

/**
 * Comparação timing-safe.
 * @param {string | null | undefined} provided
 * @param {string} expected
 */
export function tokensMatch(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
