import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { DomainError, type ObjectStorage, type StoredObject } from '@castwave/contracts';
import { sha256Hex, signUrlToken } from '@castwave/core';
import type { AppConfig } from '@castwave/runtime';

/**
 * Storage de objetos em disco local.
 *
 * Driver de desenvolvimento, com as MESMAS regras de seguranca do driver S3:
 * chave saneada, escrita fora do web root e leitura so por URL assinada de
 * TTL curto. Nao ha rota que sirva um arquivo pelo nome -- o unico caminho e
 * um token HMAC que carrega chave, expiracao e o dispositivo de destino.
 */

/** Rejeita `..`, caminho absoluto e separador invertido antes de tocar o disco. */
function assertSafeKey(key: string): void {
  if (!key || key.length > 400) {
    throw new DomainError('validation_failed', 'Chave de storage invalida.');
  }
  const normalized = normalize(key).replace(/\\/g, '/');
  if (
    normalized.startsWith('/') ||
    normalized.startsWith('..') ||
    normalized.includes('../') ||
    /^[a-zA-Z]:/.test(normalized) ||
    normalized.includes('\0')
  ) {
    throw new DomainError('validation_failed', 'Chave de storage invalida.', {
      logContext: { rejected: 'path_traversal', key },
    });
  }
}

export class LocalObjectStorage implements ObjectStorage {
  readonly driver = 'local';

  constructor(
    private readonly root: string,
    private readonly urlSecret: string,
    private readonly publicBaseUrl: string,
  ) {}

  private pathFor(key: string): string {
    assertSafeKey(key);
    const full = resolve(this.root, key);
    // Defesa em profundidade: mesmo apos sanear, confirmamos que o caminho
    // resolvido continua dentro da raiz.
    const rootResolved = resolve(this.root);
    if (!full.startsWith(rootResolved + sep) && full !== rootResolved) {
      throw new DomainError('validation_failed', 'Chave de storage invalida.', {
        logContext: { rejected: 'escapes_root', key },
      });
    }
    return full;
  }

  async put(key: string, body: Uint8Array, contentType: string): Promise<StoredObject> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
    await writeFile(`${path}.meta`, JSON.stringify({ contentType }), 'utf8');
    return { key, sizeBytes: body.byteLength, contentType, checksumSha256: sha256Hex(body) };
  }

  async get(key: string): Promise<Uint8Array> {
    try {
      return new Uint8Array(await readFile(this.pathFor(key)));
    } catch {
      throw new DomainError('not_found', 'Arquivo de audio nao encontrado.');
    }
  }

  async head(key: string): Promise<{ sizeBytes: number; contentType: string } | null> {
    const path = this.pathFor(key);
    try {
      const info = await stat(path);
      let contentType = 'application/octet-stream';
      try {
        const meta = JSON.parse(await readFile(`${path}.meta`, 'utf8')) as { contentType?: string };
        if (meta.contentType) contentType = meta.contentType;
      } catch {
        /* metadado ausente nao invalida o objeto */
      }
      return { sizeBytes: info.size, contentType };
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    const path = this.pathFor(key);
    await rm(path, { force: true });
    await rm(`${path}.meta`, { force: true });
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async signedReadUrl(key: string, ttlSeconds: number): Promise<string> {
    assertSafeKey(key);
    const token = signUrlToken(
      {
        key,
        expiresAt: Math.floor(Date.now() / 1000) + ttlSeconds,
        // Preenchido com o id do dispositivo pela camada de playback; aqui
        // fica generico para uso administrativo (previa no painel).
        audience: 'console',
      },
      this.urlSecret,
    );
    return `${this.publicBaseUrl}/api/v1/media/stream?token=${encodeURIComponent(token)}`;
  }

  /** Escreve e apaga um objeto de teste. Alimenta o readiness. */
  async ping(): Promise<boolean> {
    try {
      const key = '.healthcheck/probe';
      await this.put(key, new Uint8Array([1]), 'application/octet-stream');
      await this.delete(key);
      return true;
    } catch {
      return false;
    }
  }
}

export function createStorage(config: AppConfig): LocalObjectStorage {
  if (config.STORAGE_DRIVER === 's3') {
    // O adapter S3 entra junto com o deploy; a porta ja esta definida em
    // @castwave/contracts e o dominio nao muda uma linha.
    throw new DomainError('dependency_unavailable', 'Driver de storage S3 ainda nao implementado.', {
      action: 'Use STORAGE_DRIVER=local ate o adapter S3 ser concluido.',
    });
  }
  return new LocalObjectStorage(
    join(process.cwd(), config.STORAGE_LOCAL_PATH),
    config.MEDIA_URL_SECRET,
    config.WEB_ORIGIN,
  );
}
