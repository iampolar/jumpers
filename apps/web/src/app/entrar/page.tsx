'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { SessionContext } from '@castwave/contracts';
import { CastWaveStacked } from '@/components/brand';
import { AmbientBackground } from '@/components/ambient-background';
import { Alert, Button, Field, Input } from '@/components/ui';
import { api, ApiError, setCsrfToken } from '@/lib/api';

/**
 * Entrada no console.
 *
 * Login e cadastro na mesma tela, alternando por aba: numa instalacao nova o
 * primeiro acesso E um cadastro, e mandar a pessoa procurar outro link seria
 * atrito gratuito.
 */

type Mode = 'login' | 'register';

export default function EntrarPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('login');
  const [error, setError] = useState<ApiError | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    const form = new FormData(event.currentTarget);
    const payload =
      mode === 'login'
        ? { email: form.get('email'), password: form.get('password') }
        : {
            name: form.get('name'),
            email: form.get('email'),
            password: form.get('password'),
            organizationName: form.get('organizationName'),
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            acceptedTerms: form.get('acceptedTerms') === 'on',
          };

    try {
      const result = await api.post<{ csrfToken: string; session: SessionContext }>(
        mode === 'login' ? '/api/v1/auth/login' : '/api/v1/auth/register',
        payload,
      );
      // O token CSRF vive em memoria: um XSS que leia o storage nao o obtem.
      setCsrfToken(result.csrfToken);
      router.push('/painel');
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError('internal_error', 'Erro inesperado.', 500));
      setSubmitting(false);
    }
  };

  return (
    <div className="relative isolate flex min-h-dvh items-center justify-center overflow-hidden px-6 py-12">
      <AmbientBackground intensity="marca" />

      <div className="w-full max-w-sm rounded-2xl border border-line/60 bg-surface/80 p-7 shadow-2xl backdrop-blur-xl">
        <div className="mb-8 flex flex-col items-center text-center">
          <CastWaveStacked size={64} />
          <p className="mt-4 text-[13px] text-muted">A central de audio das suas lojas.</p>
        </div>

        <div className="mb-5 grid grid-cols-2 gap-1 rounded-lg border border-line bg-surface p-1">
          {(['login', 'register'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => {
                setMode(m);
                setError(null);
              }}
              aria-pressed={mode === m}
              className={`rounded-md py-1.5 text-[13px] transition-colors ${
                mode === m ? 'bg-elevated font-medium text-text' : 'text-muted hover:text-text'
              }`}
            >
              {m === 'login' ? 'Entrar' : 'Criar conta'}
            </button>
          ))}
        </div>

        {error && (
          <div className="mb-4">
            <Alert tone="danger" title={error.message}>
              {error.action}
            </Alert>
          </div>
        )}

        <form onSubmit={(e) => void submit(e)} className="space-y-4">
          {mode === 'register' && (
            <>
              <Field label="Seu nome" htmlFor="name" required error={error?.issueFor('name')}>
                <Input id="name" name="name" autoComplete="name" required placeholder="Marina Prado" />
              </Field>
              <Field
                label="Nome da rede"
                htmlFor="organizationName"
                required
                hint="Aparece no painel e nos relatorios."
                error={error?.issueFor('organizationName')}
              >
                <Input id="organizationName" name="organizationName" required placeholder="Rede Aurora" />
              </Field>
            </>
          )}

          <Field label="E-mail" htmlFor="email" required error={error?.issueFor('email')}>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              placeholder="voce@suaempresa.com.br"
            />
          </Field>

          <Field
            label="Senha"
            htmlFor="password"
            required
            hint={mode === 'register' ? 'Use ao menos 12 caracteres.' : undefined}
            error={error?.issueFor('password')}
          >
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              required
              minLength={mode === 'register' ? 12 : undefined}
            />
          </Field>

          {mode === 'register' && (
            <label className="flex items-start gap-2.5 text-[12px] leading-relaxed text-muted">
              <input
                type="checkbox"
                name="acceptedTerms"
                required
                className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded border-line bg-ink accent-cyan"
              />
              <span>
                Concordo com os termos de uso e confirmo que tenho direito de executar os audios que
                enviar.
              </span>
            </label>
          )}

          <Button type="submit" variant="primary" loading={submitting} className="w-full">
            {mode === 'login' ? 'Entrar' : 'Criar conta e comecar'}
          </Button>
        </form>

        {mode === 'login' && (
          <p className="mt-4 text-center text-[12px] text-muted">
            <a href="/recuperar-senha" className="hover:text-text">
              Esqueci minha senha
            </a>
          </p>
        )}
      </div>
    </div>
  );
}
