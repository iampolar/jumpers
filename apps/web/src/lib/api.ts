'use client';

/**
 * Cliente da API.
 *
 * O token CSRF fica em memoria, nunca em `localStorage`: um XSS que consiga
 * ler o storage teria o token e o cookie viajaria junto automaticamente,
 * anulando a protecao. Em memoria, o token morre com a aba.
 *
 * Todo erro vira `ApiError` com o `code` estavel da API, para que a UI decida
 * pelo codigo -- e nao por casar substring de mensagem, que quebra na
 * primeira correcao de texto.
 */

import type { ApiErrorBody, ErrorCode, FieldIssue } from '@castwave/contracts';

let csrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export function getCsrfToken(): string | null {
  return csrfToken;
}

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode | 'network_error',
    message: string,
    readonly status: number,
    readonly action?: string,
    readonly issues?: readonly FieldIssue[],
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Mensagem pronta para exibir: inclui a acao quando houver. */
  get displayMessage(): string {
    return this.action ? `${this.message} ${this.action}` : this.message;
  }

  /** Erro de campo, para destacar o input certo no formulario. */
  issueFor(path: string): string | null {
    return this.issues?.find((i) => i.path === path)?.message ?? null;
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Corpo binario (upload de audio). Ignora `body`. */
  raw?: BodyInit;
  contentType?: string;
  signal?: AbortSignal;
}

export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (csrfToken) headers['x-csrf-token'] = csrfToken;

  let body: BodyInit | undefined;
  if (options.raw !== undefined) {
    body = options.raw;
    headers['content-type'] = options.contentType ?? 'application/octet-stream';
  } else if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers['content-type'] = 'application/json';
  }

  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? 'GET',
      headers,
      body,
      // O cookie de sessao e HttpOnly: o browser o envia, o JS nunca o le.
      credentials: 'same-origin',
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch {
    throw new ApiError('network_error', 'Nao foi possivel falar com o servidor.', 0, 'Verifique a conexao e tente de novo.');
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const parsed: unknown = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const payload = parsed as ApiErrorBody | null;
    const error = payload?.error;
    throw new ApiError(
      error?.code ?? 'internal_error',
      error?.message ?? 'Algo deu errado.',
      response.status,
      error?.action,
      error?.issues,
      error?.requestId,
    );
  }

  return parsed as T;
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) =>
    apiFetch<T>(path, signal ? { signal } : {}),
  post: <T>(path: string, body?: unknown) => apiFetch<T>(path, { method: 'POST', body }),
  patch: <T>(path: string, body?: unknown) => apiFetch<T>(path, { method: 'PATCH', body }),
  del: <T>(path: string) => apiFetch<T>(path, { method: 'DELETE' }),
  upload: <T>(path: string, bytes: ArrayBuffer | Blob) =>
    apiFetch<T>(path, { method: 'POST', raw: bytes, contentType: 'application/octet-stream' }),
};
