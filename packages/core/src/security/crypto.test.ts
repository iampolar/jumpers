import { describe, expect, it } from 'vitest';
import {
  hashPassword,
  hashToken,
  needsRehash,
  randomToken,
  redact,
  safeEqual,
  signUrlToken,
  truncateIp,
  verifyPassword,
  verifyUrlToken,
} from './crypto';

describe('senhas', () => {
  it('aceita a senha correta e recusa a errada', async () => {
    const stored = await hashPassword('senha-muito-longa-123');
    expect(await verifyPassword('senha-muito-longa-123', stored)).toBe(true);
    expect(await verifyPassword('senha-muito-longa-124', stored)).toBe(false);
  });

  it('gera hashes diferentes para a mesma senha (salt aleatorio)', async () => {
    const a = await hashPassword('mesma-senha-aqui');
    const b = await hashPassword('mesma-senha-aqui');
    expect(a).not.toBe(b);
    expect(await verifyPassword('mesma-senha-aqui', a)).toBe(true);
    expect(await verifyPassword('mesma-senha-aqui', b)).toBe(true);
  });

  it('carrega os parametros no proprio hash', async () => {
    const stored = await hashPassword('parametros-no-hash');
    expect(stored.startsWith('scrypt$32768$8$1$')).toBe(true);
    expect(stored.split('$')).toHaveLength(6);
  });

  it('normaliza unicode: a mesma senha digitada em NFD e NFC confere', async () => {
    const nfc = 'sença-com-cedilha';
    const nfd = 'sença-com-cedilha';
    const stored = await hashPassword(nfc);
    expect(await verifyPassword(nfd, stored)).toBe(true);
  });

  it('recusa hash malformado sem lancar excecao', async () => {
    expect(await verifyPassword('x', 'lixo')).toBe(false);
    expect(await verifyPassword('x', '')).toBe(false);
    expect(await verifyPassword('x', 'bcrypt$1$2$3$4$5')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$a$b$c$d$e')).toBe(false);
  });

  it('sinaliza rehash para algoritmo ou custo antigos', () => {
    expect(needsRehash('scrypt$32768$8$1$aa$bb')).toBe(false);
    expect(needsRehash('scrypt$1024$8$1$aa$bb')).toBe(true);
    expect(needsRehash('md5$deadbeef')).toBe(true);
  });
});

describe('tokens', () => {
  it('hash de token e estavel e nao reversivel por tamanho', () => {
    const t = randomToken();
    expect(hashToken(t)).toBe(hashToken(t));
    expect(hashToken(t)).toHaveLength(64);
    expect(hashToken(t)).not.toContain(t);
  });

  it('tokens aleatorios nao colidem', () => {
    const set = new Set(Array.from({ length: 500 }, () => randomToken(16)));
    expect(set.size).toBe(500);
  });

  it('comparacao segura trata tamanhos diferentes sem lancar', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcdef')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });
});

describe('URLs assinadas', () => {
  const secret = 'segredo-de-teste-apenas';
  const now = 1_800_000_000;

  it('assina e valida um claim valido', () => {
    const token = signUrlToken({ key: 'media/abc.mp3', expiresAt: now + 300, audience: 'device-1' }, secret);
    const claims = verifyUrlToken(token, secret, now);
    expect(claims?.key).toBe('media/abc.mp3');
    expect(claims?.audience).toBe('device-1');
  });

  it('recusa token expirado', () => {
    const token = signUrlToken({ key: 'k', expiresAt: now - 1, audience: 'd' }, secret);
    expect(verifyUrlToken(token, secret, now)).toBeNull();
  });

  it('recusa assinatura de outro segredo', () => {
    const token = signUrlToken({ key: 'k', expiresAt: now + 300, audience: 'd' }, 'outro-segredo');
    expect(verifyUrlToken(token, secret, now)).toBeNull();
  });

  it('recusa payload adulterado', () => {
    const token = signUrlToken({ key: 'media/a.mp3', expiresAt: now + 300, audience: 'd' }, secret);
    const [payload, mac] = token.split('.');
    const tampered = Buffer.from(
      JSON.stringify({ key: 'media/SEGREDO.mp3', expiresAt: now + 300, audience: 'd' }),
      'utf8',
    ).toString('base64url');
    expect(verifyUrlToken(`${tampered}.${mac}`, secret, now)).toBeNull();
    expect(payload).not.toBe(tampered);
  });

  it('recusa token malformado sem lancar', () => {
    for (const bad of ['', '.', 'semponto', 'a.b', '....', 'YWJj.xxx']) {
      expect(verifyUrlToken(bad, secret, now)).toBeNull();
    }
  });
});

describe('minimizacao de dado pessoal', () => {
  it('trunca IPv4 em /24 e IPv6 em /48', () => {
    expect(truncateIp('201.17.44.187')).toBe('201.17.44.0/24');
    expect(truncateIp('::ffff:201.17.44.187')).toBe('201.17.44.0/24');
    expect(truncateIp('2804:14d:1::abcd:1234')).toBe('2804:14d:1::/48');
    expect(truncateIp(null)).toBeNull();
    expect(truncateIp('nao-e-ip')).toBeNull();
  });

  it('redige segredos em objetos de log, em qualquer profundidade', () => {
    const out = redact({
      userId: 'u1',
      deviceToken: 'super-secreto',
      nested: { authorization: 'Bearer abc', apiKey: 'k', ok: 1 },
      list: [{ password: 'p' }],
    }) as Record<string, unknown>;

    expect(out.userId).toBe('u1');
    expect(out.deviceToken).toBe('[redacted]');
    expect((out.nested as Record<string, unknown>).authorization).toBe('[redacted]');
    expect((out.nested as Record<string, unknown>).apiKey).toBe('[redacted]');
    expect((out.nested as Record<string, unknown>).ok).toBe(1);
    expect(((out.list as unknown[])[0] as Record<string, unknown>).password).toBe('[redacted]');
  });

  it('nao entra em loop com estrutura profunda', () => {
    let deep: Record<string, unknown> = { v: 1 };
    for (let i = 0; i < 50; i += 1) deep = { child: deep };
    expect(() => redact(deep)).not.toThrow();
  });
});
