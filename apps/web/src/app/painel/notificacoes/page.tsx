'use client';

import Link from 'next/link';
import { Bell } from 'lucide-react';
import type { Notification } from '@castwave/contracts';
import { PageHeader } from '@/components/shell';
import { Badge, Card, EmptyState, formatRelative, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { useApi } from '@/lib/session';

/**
 * Notificacoes internas.
 *
 * Funcionam sem SMTP: sem e-mail configurado, o aviso vive aqui e o sistema
 * registra `not_configured` -- nunca reporta uma entrega que nao aconteceu.
 */

const SEVERIDADE = {
  info: { tone: 'info' as const, label: 'Informacao' },
  success: { tone: 'success' as const, label: 'Concluido' },
  warning: { tone: 'warning' as const, label: 'Atencao' },
  critical: { tone: 'danger' as const, label: 'Critico' },
};

export default function NotificacoesPage() {
  const { data, loading, reload } = useApi<{ notifications: Notification[] }>('/api/v1/notifications');
  const itens = data?.notifications ?? [];

  const marcarLida = async (id: string) => {
    await api.patch(`/api/v1/notifications/${id}/read`);
    reload();
  };

  if (loading) return <Spinner label="Carregando notificacoes" />;

  return (
    <>
      <PageHeader
        title="Notificacoes"
        description="Avisos da operacao da sua rede. Ficam aqui mesmo quando o envio por e-mail nao esta configurado."
      />

      <Card>
        {itens.length === 0 ? (
          <EmptyState
            icon={<Bell size={30} />}
            title="Nada por aqui"
            description="Avisos sobre players offline, falhas de processamento e limites de plano aparecem nesta lista."
          />
        ) : (
          <ul className="divide-y divide-line/40">
            {itens.map((n) => {
              const s = SEVERIDADE[n.severity];
              return (
                <li
                  key={n.id}
                  className={`flex items-start gap-4 px-5 py-4 ${n.readAt ? 'opacity-60' : ''}`}
                >
                  <Badge tone={s.tone}>{s.label}</Badge>
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-medium text-text">{n.title}</p>
                    <p className="mt-0.5 text-[13px] leading-relaxed text-muted">{n.body}</p>
                    <div className="mt-2 flex items-center gap-3 text-[12px]">
                      <span className="text-muted/70">{formatRelative(n.createdAt)}</span>
                      {n.href && (
                        <Link href={n.href} className="text-cyan hover:underline">
                          Resolver
                        </Link>
                      )}
                      {!n.readAt && (
                        <button
                          type="button"
                          onClick={() => void marcarLida(n.id)}
                          className="text-muted hover:text-text"
                        >
                          Marcar como lida
                        </button>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </>
  );
}
