/**
 * Geradores de identificador. Usam Web Crypto (`globalThis.crypto`), disponivel
 * em Node >= 19 e em todos os navegadores alvo, para que `@castwave/contracts`
 * continue importavel tanto na API quanto no bundle do browser.
 */

const webcrypto = globalThis.crypto;

/** UUID v4 para chaves primarias. Alinha com `gen_random_uuid()` do Postgres. */
export const newId = (): string => webcrypto.randomUUID();

const randomByteArray = (length: number): Uint8Array =>
  webcrypto.getRandomValues(new Uint8Array(length));

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 simbolos, sem I, O, 0, 1

/**
 * Codigo de pareamento legivel na tela da loja. CSPRNG com rejeicao de modulo
 * (descarta >= 248 = 8 * 31) para manter distribuicao uniforme entre 32 simbolos.
 */
export function newPairingCode(length = 8): string {
  let out = '';
  while (out.length < length) {
    for (const byte of randomByteArray(length * 2)) {
      if (byte >= 248) continue;
      out += CODE_ALPHABET[byte % CODE_ALPHABET.length];
      if (out.length === length) break;
    }
  }
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Token opaco base64url. 32 bytes = 256 bits de entropia. */
export function newOpaqueToken(bytes = 32): string {
  let out = '';
  for (const byte of randomByteArray(bytes)) out += BASE64URL[byte & 63];
  return out;
}

export function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}
