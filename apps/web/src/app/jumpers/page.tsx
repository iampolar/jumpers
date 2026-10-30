'use client';

import Link from 'next/link';
import { ArrowLeft, ShieldCheck } from 'lucide-react';
import type { AuditLogEntry, IntegrationStatus, JobRecord } from '@castwave/contracts';
import { CastWaveMark } from '@/components/brand';
import { StatTile } from '@/components/charts';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  fmtInt,
  formatBytes,
  formatRelative,
  Spinner,
  Table,
  Td,
  Th,
} from '@/components/ui';
import { api } from '@/lib/api';
import { SessionProvider, useApi, useSession } from '@/lib/session';

/**
 * Painel Jumpers.
 *
 * Layout e rotas separados do console do cliente, de proposito. O que aparece
 * aqui e metadado de OPERACAO -- contagens, filas, saude, auditoria. Conteudo
 * do cliente (roteiro, audio, relatorio comercial) nao entra: suporte legitimo
 * nao precisa, e acesso excepcional exigiria um fluxo proprio com motivo
 * registrado.
 *
 * Para quem nao e da equipe, a API responde 404 -- nem a existencia desta
 * area vaza.
 */

export default function JumpersPage() {
  return (
    <SessionProvider>
      <PainelOperacao />
    </SessionProvider>
  );
}

function PainelOperacao() {
  const { session, loading: carregandoSessao } = useSession();
  const { data, loading, error } = useApi<{
    organizations: { active: number; suspended: number };
    users: { active: number };
    stores: number;
    devices: { online: number; offline: number };
    jobs: { pending: number; failed: number; dead: number };
    media: { failed: number };
    support: { open: number };
    webhooks: { invalidSignatures: number };
    integrations: IntegrationStatus[];
  }>('/api/v1/jumpers/overview');

  const { data: jobs } = useApi<{ jobs: JobRecord[] }>('/api/v1/jumpers/jobs?status=dead');
  const { data: orgs } = useApi<{
    organizations: {
      id: string;
      name: string;
      slug: string;
      status: string;
      planCode: string | null;
      subscriptionStatus: string | null;
      stores: number;
      devices: number;
      members: number;
      storageBytes: number;
    }[];
  }>('/api/v1/jumpers/organizations');
  const { data: auditoria } = useApi<{ entries: AuditLogEntry[] }>('/api/v1/jumpers/audit?limit=20');

  if (carregandoSessao || loading) return <Spinner label="Carregando operacao" />;

  if (error) {
    return (
      <div className="mx-auto max-w-lg px-6 py-20">
        <Alert tone="danger" title="Area indisponivel">
          Esta area e restrita a equipe Jumpers.
        </Alert>
        <div className="mt-4">
          <Link href="/painel">
            <Button icon={<ArrowLeft size={15} />}>Voltar ao painel</Button>
          </Link>
        </div>
      </div>
    );
  }
  if (!data) return null;

  const requeue = async (id: string) => {
    await api.post(`/api/v1/jumpers/jobs/${id}/requeue`);
    window.location.reload();
  };

  return (
    <div className="min-h-dvh">
      {/* Barra dourada: sinal visual permanente de que este NAO e o console do cliente. */}
      <header className="border-b border-titanium/25 bg-titanium/5">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-3">
          <div className="flex items-center gap-2.5">
            <CastWaveMark size={20} className="text-text" />
            <span className="text-[13px] font-semibold tracking-tight text-text">Operacao Jumpers</span>
            <Badge tone="info" className="border-titanium/30 bg-titanium/10 text-titanium">
              {session?.user.platformRole === 'superadmin' ? 'Superadmin' : 'Suporte'}
            </Badge>
          </div>
          <Link href="/painel" className="text-[13px] text-muted hover:text-text">
            Voltar ao console
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-7">
        <div className="mb-6 flex items-center gap-2.5">
          <ShieldCheck size={18} className="text-titanium" aria-hidden />
          <h1 className="text-xl font-semibold tracking-tight">Visao de operacao</h1>
        </div>

        <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile label="Organizacoes ativas" value={fmtInt.format(data.organizations.active)} />
          <StatTile
            label="Players online"
            value={`${data.devices.online}/${data.devices.online + data.devices.offline}`}
            tone={data.devices.offline > data.devices.online ? 'warning' : 'neutral'}
          />
          <StatTile
            label="Jobs mortos"
            value={fmtInt.format(data.jobs.dead)}
            tone={data.jobs.dead > 0 ? 'danger' : 'neutral'}
            sublabel={`${data.jobs.pending} na fila`}
          />
          <StatTile
            label="Webhooks invalidos"
            value={fmtInt.format(data.webhooks.invalidSignatures)}
            tone={data.webhooks.invalidSignatures > 0 ? 'warning' : 'neutral'}
            sublabel="assinatura recusada"
          />
        </div>

        <Card className="mb-5">
          <CardHeader
            title="Integracoes"
            description="Estado operacional. Nenhum valor de variavel de ambiente aparece aqui."
          />
          <div className="grid gap-3 p-5 md:grid-cols-2">
            {data.integrations.map((i) => (
              <div key={i.key} className="rounded-lg border border-line bg-ink/40 p-3">
                <div className="flex items-start justify-between gap-2">
                  <span className="text-[13px] font-medium text-text">{i.label}</span>
                  <Badge
                    tone={
                      i.state === 'configured' ? 'success' : i.state === 'degraded' ? 'warning' : 'neutral'
                    }
                  >
                    {i.state === 'configured'
                      ? 'Conectado'
                      : i.state === 'degraded'
                        ? 'Degradado'
                        : 'Nao conectado'}
                  </Badge>
                </div>
                <p className="mt-1 text-[12px] leading-relaxed text-muted">{i.message}</p>
                {i.action && <p className="mt-1.5 text-[11px] text-cyan-soft">{i.action}</p>}
              </div>
            ))}
          </div>
        </Card>

        <Card className="mb-5">
          <CardHeader title="Organizacoes" description="Contadores por conta. Conteudo do cliente nao e exposto." />
          <Table>
            <thead>
              <tr>
                <Th>Organizacao</Th>
                <Th>Plano</Th>
                <Th numeric>Lojas</Th>
                <Th numeric>Players</Th>
                <Th numeric>Usuarios</Th>
                <Th numeric>Audio</Th>
              </tr>
            </thead>
            <tbody>
              {(orgs?.organizations ?? []).map((o) => (
                <tr key={o.id}>
                  <Td>
                    <span className="font-medium">{o.name}</span>
                    <p className="text-[11px] text-muted">{o.slug}</p>
                  </Td>
                  <Td>
                    <span className="text-muted">{o.planCode ?? '—'}</span>
                    {o.subscriptionStatus && (
                      <p className="text-[11px] text-muted/70">{o.subscriptionStatus}</p>
                    )}
                  </Td>
                  <Td numeric>{o.stores}</Td>
                  <Td numeric>{o.devices}</Td>
                  <Td numeric>{o.members}</Td>
                  <Td numeric>{formatBytes(o.storageBytes)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>

        <div className="grid gap-5 lg:grid-cols-2">
          <Card>
            <CardHeader title="Jobs mortos" description="Esgotaram as tentativas. Reprocessamento fica auditado." />
            {(jobs?.jobs ?? []).length === 0 ? (
              <EmptyState title="Nenhum job morto" description="Todas as filas drenaram normalmente." />
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Fila</Th>
                    <Th>Erro</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {jobs!.jobs.map((j) => (
                    <tr key={j.id}>
                      <Td>
                        <span className="font-mono text-[12px]">{j.queue}</span>
                        <p className="text-[11px] text-muted">{j.payloadSummary}</p>
                      </Td>
                      <Td>
                        <span className="line-clamp-2 text-[12px] text-danger">{j.lastError}</span>
                      </Td>
                      <Td className="text-right">
                        <Button
                          size="sm"
                          disabledReason={
                            session?.user.platformRole === 'superadmin'
                              ? null
                              : 'Apenas superadmin reprocessa job.'
                          }
                          onClick={() => void requeue(j.id)}
                        >
                          Reprocessar
                        </Button>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>

          <Card>
            <CardHeader title="Auditoria recente" description="Inclui as tentativas negadas." />
            <Table>
              <thead>
                <tr>
                  <Th>Acao</Th>
                  <Th>Ator</Th>
                  <Th>Resultado</Th>
                  <Th>Quando</Th>
                </tr>
              </thead>
              <tbody>
                {(auditoria?.entries ?? []).map((e) => (
                  <tr key={e.id}>
                    <Td>
                      <span className="font-mono text-[11px]">{e.action}</span>
                    </Td>
                    <Td>
                      <span className="text-[12px] text-muted">{e.actorName ?? e.actorType}</span>
                    </Td>
                    <Td>
                      <Badge tone={e.outcome === 'success' ? 'success' : e.outcome === 'denied' ? 'warning' : 'danger'}>
                        {e.outcome === 'success' ? 'Sucesso' : e.outcome === 'denied' ? 'Negado' : 'Erro'}
                      </Badge>
                    </Td>
                    <Td>
                      <span className="text-[12px] text-muted">{formatRelative(e.createdAt)}</span>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
        </div>
      </main>
    </div>
  );
}
