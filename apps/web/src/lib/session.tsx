'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import type { Permission, SessionContext as Session } from '@castwave/contracts';
import { api, ApiError, setCsrfToken } from './api';

/**
 * Sessao no cliente.
 *
 * Guarda papel e permissoes apenas para DESABILITAR botoes com explicacao --
 * nunca como controle de acesso. A API decide tudo de novo, em toda rota. Se
 * alguem editar o estado no devtools, consegue clicar e recebe 403.
 */

interface SessionState {
  session: Session | null;
  loading: boolean;
  can: (permission: Permission) => boolean;
  /** Motivo textual quando a acao esta bloqueada. Alimenta o `title` do botao. */
  reasonFor: (permission: Permission) => string | null;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const Ctx = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  const refresh = useCallback(async () => {
    try {
      const data = await api.get<{ session: Session; csrfToken: string | null }>('/api/v1/auth/me');
      // Recarregar a pagina zera a memoria; aqui o par cookie+CSRF se refaz.
      setCsrfToken(data.csrfToken);
      setSession(data.session);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) setSession(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    await api.post('/api/v1/auth/logout').catch(() => undefined);
    setCsrfToken(null);
    setSession(null);
    router.push('/entrar');
  }, [router]);

  const value = useMemo<SessionState>(() => {
    const permissions = new Set(session?.permissions ?? []);
    return {
      session,
      loading,
      can: (p) => permissions.has(p),
      reasonFor: (p) =>
        permissions.has(p) ? null : `Seu perfil (${session?.role ?? 'sem acesso'}) nao permite esta acao.`,
      refresh,
      logout,
    };
  }, [session, loading, refresh, logout]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useSession precisa estar dentro de <SessionProvider>.');
  return ctx;
}

/**
 * Carrega dados da API com estados de carregando/erro explicitos.
 *
 * Deliberadamente simples: o produto nao precisa de cache entre telas, e um
 * hook de 40 linhas que a equipe inteira entende vale mais que uma dependencia
 * de data fetching aqui.
 */
export function useApi<T>(path: string | null, deps: readonly unknown[] = []): {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  reload: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!path) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    api
      .get<T>(path, controller.signal)
      .then((result) => {
        setData(result);
        setError(null);
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        setError(e instanceof ApiError ? e : new ApiError('internal_error', 'Erro inesperado.', 500));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
    /*
     * `deps` entra espalhado de proposito: quem chama decide o que invalida a
     * busca. O plugin react-hooks nao esta neste projeto, entao a decisao fica
     * documentada aqui em vez de silenciada por um disable.
     */
  }, [path, nonce, ...deps]);

  return { data, error, loading, reload: () => setNonce((n) => n + 1) };
}
