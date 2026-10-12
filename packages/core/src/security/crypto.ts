import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * Hash de senha com scrypt.
 *
 * Argon2id seria a primeira escolha, mas exige compilacao nativa (node-gyp) e
 * trava o `npm install` em maquinas sem toolchain -- inaceitavel para um
 * projeto que precisa subir com um comando. scrypt e memory-hard, esta no
 * `node:crypto` desde sempre e e explicitamente aceito pelo OWASP Password
 * Storage Cheat Sheet nestes parametros. O formato carrega os parametros, de
 * modo que migrar para Argon2id depois e um rehash no proximo login, nao uma
 * migracao de banco. Ver docs/adr/0004.
 */
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keylen: 32, maxmem: 96 * 1024 * 1024 } as const;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password.normalize('NFKC'), salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts as [string, string, string, string, string, string];
  const salt = Buffer.from(saltRaw, 'base64url');
  const expected = Buffer.from(hashRaw, 'base64url');
  let derived: Buffer;
  try {
    derived = await scryptAsync(password.normalize('NFKC'), salt, expected.length, {
      N: Number(nRaw),
      r: Number(rRaw),
      p: Number(pRaw),
      maxmem: SCRYPT.maxmem,
    });
  } catch {
    return false;
  }
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/** `true` quando a senha deve ser reprocessada com os parametros atuais. */
export function needsRehash(stored: string): boolean {
  const parts = stored.split('$');
  return parts[0] !== 'scrypt' || Number(parts[1]) < SCRYPT.N;
}

// --------------------------------------------------------------------------
// Tokens opacos
// --------------------------------------------------------------------------

/**
 * Token de sessao/dispositivo/pairing: so o hash vai para o banco. Um dump de
 * banco nao da acesso a nada. SHA-256 basta -- o segredo tem 256 bits de
 * entropia, nao e uma senha humana sujeita a dicionario.
 */
export const hashToken = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex');

export const sha256Hex = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

/** Comparacao em tempo constante para qualquer segredo em string. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) {
    // Compara contra si mesmo para manter o custo constante antes de recusar.
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

// --------------------------------------------------------------------------
// URLs assinadas
// --------------------------------------------------------------------------

export interface SignedUrlClaims {
  readonly key: string;
  readonly expiresAt: number; // epoch seconds
  /** Amarra a URL ao dispositivo: um link vazado nao serve a outro player. */
  readonly audience: string;
}

/**
 * Assina um claim compacto com HMAC-SHA256. Nao e JWT de proposito: nao ha
 * `alg` negociavel, portanto nao ha a classe de ataque de confusao de
 * algoritmo. O payload e opaco e curto o bastante para caber numa query.
 */
export function signUrlToken(claims: SignedUrlClaims, secret: string): string {
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const mac = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${mac}`;
}

export function verifyUrlToken(
  token: string,
  secret: string,
  nowSeconds: number,
): SignedUrlClaims | null {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  if (!safeEqual(mac, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as SignedUrlClaims;
    if (typeof claims.expiresAt !== 'number' || claims.expiresAt < nowSeconds) return null;
    if (typeof claims.key !== 'string' || typeof claims.audience !== 'string') return null;
    return claims;
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------
// Minimizacao de dado pessoal
// --------------------------------------------------------------------------

/**
 * Trunca IP antes de persistir em auditoria: /24 em IPv4 e /48 em IPv6.
 * Mantem utilidade forense e reduz o dado pessoal retido (LGPD, art. 6, III).
 */
export function truncateIp(ip: string | undefined | null): string | null {
  if (!ip) return null;
  const clean = ip.replace(/^::ffff:/, '').split('%')[0] ?? '';
  if (clean.includes(':')) {
    const groups = clean.split(':').filter(Boolean).slice(0, 3);
    return groups.length ? `${groups.join(':')}::/48` : null;
  }
  const octets = clean.split('.');
  if (octets.length !== 4) return null;
  return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
}

/** Remove segredos de objetos antes do log estruturado. */
const SECRET_KEY_RE = /(token|secret|password|authorization|cookie|apikey|api_key|signature)/i;

export function redact<T>(value: T, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY_RE.test(k) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}
