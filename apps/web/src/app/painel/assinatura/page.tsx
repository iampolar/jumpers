'use client';

import { useState } from 'react';
import { CreditCard } from 'lucide-react';
import type { Plan, Subscription } from '@castwave/contracts';
import { Meter } from '@/components/charts';
import { PageHeader } from '@/components/shell';
import { Alert, Badge, Button, Card, CardHeader, fmtInt, formatBytes, Spinner } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { useApi, useSession } from '@/lib/session';

/**
 * Plano e uso.
 *
 * Tudo aqui funciona sem gateway: os limites sao aplicados no servidor, os
 * medidores refletem o uso real e a troca de plano acontece internamente,
 * auditada. O que NAO acontece e cobranca -- e a tela diz isso com todas as
 * letras, em vez de mostrar um botao de pagar que falharia.
 */

const STATUS_LABEL: Record<string, { tone: 'success' | 'warning' | 'danger' | 'neutral'; label: string }> = {
  trialing: { tone: 'success', label: 'Em avaliacao' },
  active: { tone: 'success', label: 'Ativa' },
  past_due: { tone: 'warning', label: 'Pagamento pendente' },
  paused: { tone: 'warning', label: 'Pausada' },
  cancelled: { tone: 'neutral', label: 'Cancelada' },
  expired: { tone: 'danger', label: 'Expirada' },
  incomplete: { tone: 'warning', label: 'Incompleta' },
};

const UNIDADE = {
  count: (n: number) => fmtInt.format(n),
  bytes: (n: number) => formatBytes(n),
  seconds: (n: number) => `${fmtInt.format(Math.round(n / 60))} min`,
};

export default function AssinaturaPage() {
  const { can, reasonFor } = useSession();
  const { data, loading, reload } = useApi<{ subscription: Subscription }>('/api/v1/billing/subscription');
  const { data: catalogo } = useApi<{ plans: Plan[] }>('/api/v1/billing/plans');
  const [erro, setErro] = useState<ApiError | null>(null);
  const [trocando, setTrocando] = useState<string | null>(null);

  const assinatura = data?.subscription;
  const planos = catalogo?.plans ?? [];
  const semGateway = assinatura?.providerState === 'not_configured';

  const trocarPlano = async (planCode: string) => {
    setTrocando(planCode);
    setErro(null);
    try {
      await api.post('/api/v1/billing/change-plan', { planCode });
      reload();
    } catch (e) {
      setErro(e instanceof ApiError ? e : null);
    } finally {
      setTrocando(null);
    }
  };

  if (loading) return <Spinner label="Carregando assinatura" />;
  if (!assinatura) return null;

  const status = STATUS_LABEL[assinatura.status] ?? STATUS_LABEL.active!;

  return (
    <>
      <PageHeader
        title="Plano e uso"
        description="Limites, consumo e estado da assinatura."
      />

      {semGateway && (
        <div className="mb-5">
          {/* Honestidade: o estado real, com a consequencia pratica. */}
          <Alert tone="info" title="Pagamento online nao esta conectado">
            Planos, limites e medicao de uso funcionam normalmente. A cobranca sera habilitada
            quando um gateway for configurado — ate la, mudancas de plano sao feitas internamente e
            ficam registradas na auditoria.
          </Alert>
        </div>
      )}

      {erro && (
        <div className="mb-5">
          <Alert tone="danger" title={erro.message}>{erro.action}</Alert>
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title="Consumo do periodo"
            description={`${new Date(assinatura.currentPeriodStart).toLocaleDateString('pt-BR')} a ${new Date(assinatura.currentPeriodEnd).toLocaleDateString('pt-BR')}`}
          />
          <div className="space-y-5 p-5">
            {assinatura.meters.map((m) => (
              <Meter
                key={m.metric}
                label={m.label}
                used={m.used}
                limit={m.limit}
                format={UNIDADE[m.unit]}
              />
            ))}
          </div>
        </Card>

        <Card>
          <CardHeader title="Assinatura" />
          <div className="space-y-3 p-5 text-[13px]">
            <div className="flex items-center justify-between">
              <span className="text-muted">Plano</span>
              <span className="font-medium text-text">{assinatura.plan.name}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted">Estado</span>
              <Badge tone={status.tone}>{status.label}</Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted">Cobranca</span>
              <Badge tone={semGateway ? 'neutral' : 'success'}>
                {semGateway ? 'Nao conectada' : assinatura.provider}
              </Badge>
            </div>
            {assinatura.trialEndsAt && (
              <div className="flex items-center justify-between">
                <span className="text-muted">Avaliacao ate</span>
                <span className="tabular text-text">
                  {new Date(assinatura.trialEndsAt).toLocaleDateString('pt-BR')}
                </span>
              </div>
            )}
            <div className="flex items-center justify-between border-t border-line/60 pt-3">
              <span className="text-muted">Valor de referencia</span>
              <span className="tabular text-text">
                {(assinatura.plan.priceCents / 100).toLocaleString('pt-BR', {
                  style: 'currency',
                  currency: assinatura.plan.currency,
                })}
                <span className="text-muted">/mes</span>
              </span>
            </div>
            {semGateway && (
              <p className="text-[11px] leading-relaxed text-muted/70">
                Valor exibido para referencia. Nenhuma cobranca e processada enquanto o gateway
                nao estiver conectado.
              </p>
            )}
          </div>
        </Card>
      </div>

      <Card className="mt-5">
        <CardHeader title="Planos disponiveis" description="Preco e limites vem sempre do servidor." />
        <div className="grid gap-4 p-5 md:grid-cols-3">
          {planos.map((plano) => {
            const atual = plano.code === assinatura.plan.code;
            return (
              <div
                key={plano.id}
                className={`rounded-xl border p-4 ${atual ? 'border-cyan/40 bg-cyan/5' : 'border-line bg-ink/40'}`}
              >
                <div className="flex items-baseline justify-between">
                  <h3 className="text-sm font-semibold text-text">{plano.name}</h3>
                  {atual && <Badge tone="info">Atual</Badge>}
                </div>
                <p className="mt-1 text-[12px] leading-relaxed text-muted">{plano.description}</p>
                <p className="mt-3 text-xl font-semibold tabular text-text">
                  {(plano.priceCents / 100).toLocaleString('pt-BR', {
                    style: 'currency',
                    currency: plano.currency,
                  })}
                  <span className="text-[12px] font-normal text-muted">/mes</span>
                </p>

                <ul className="mt-3 space-y-1 text-[12px] text-muted">
                  <li>{fmtInt.format(plano.quotas.maxStores)} lojas</li>
                  <li>{fmtInt.format(plano.quotas.maxDevices)} players</li>
                  <li>{formatBytes(plano.quotas.maxStorageBytes)} de audio</li>
                  {plano.features.slice(0, 2).map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>

                {!atual && (
                  <Button
                    size="sm"
                    variant={semGateway ? 'secondary' : 'primary'}
                    icon={<CreditCard size={14} />}
                    className="mt-4 w-full"
                    loading={trocando === plano.code}
                    disabledReason={reasonFor('billing:manage')}
                    onClick={() => void trocarPlano(plano.code)}
                  >
                    {semGateway ? 'Mudar para este plano' : 'Assinar'}
                  </Button>
                )}
              </div>
            );
          })}
        </div>

        {!can('billing:manage') && (
          <p className="border-t border-line/60 px-5 py-3 text-[12px] text-muted">
            Apenas o proprietario da organizacao pode alterar o plano.
          </p>
        )}
      </Card>
    </>
  );
}
