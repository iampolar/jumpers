'use client';

import Link from 'next/link';
import { AlertTriangle, LibraryBig, MonitorSpeaker, Radio, Store } from 'lucide-react';
import type { OverviewMetrics } from '@castwave/contracts';
import { BarList, LineChart, StatTile } from '@/components/charts';
import { PageHeader } from '@/components/shell';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  fmtInt,
  formatBytes,
  Spinner,
  StatusDot,
  Table,
  Td,
  Th,
} from '@/components/ui';
import { useApi } from '@/lib/session';

/**
 * Visao geral.
 *
 * Nao e um mural de cartoes decorativos: cada numero aqui responde a uma
 * pergunta que um gerente de rede faz de manha -- as lojas estao tocando?
 * algo falhou? o que mais tocou? -- e leva para a tela que resolve.
 */

function periodoPadrao(): { from: string; to: string } {
  const hoje = new Date();
  const inicio = new Date(hoje.getTime() - 13 * 86_400_000);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { from: iso(inicio), to: iso(hoje) };
}

export default function VisaoGeralPage() {
  const { from, to } = periodoPadrao();
  const { data, error, loading } = useApi<OverviewMetrics>(
    `/api/v1/analytics/overview?from=${from}&to=${to}`,
  );

  if (loading) return <Spinner label="Carregando a visao geral" />;
  if (error) {
    return <Alert tone="danger" title={error.message}>{error.action}</Alert>;
  }
  if (!data) return null;

  const { devices, playback, stores, media, campaigns } = data;
  const semAtividade = playback.started === 0;
  const playersForaDoAr = devices.offline + devices.degraded;

  return (
    <>
      <PageHeader
        title="Visao geral"
        description={`Ultimos 14 dias · fuso de referencia ${data.period.timezone}`}
      />

      {/* O alerta vem ANTES dos numeros: se ha loja muda, e isso que importa. */}
      {playersForaDoAr > 0 && (
        <div className="mb-5">
          <Alert
            tone="warning"
            title={`${playersForaDoAr} ${playersForaDoAr === 1 ? 'player esta' : 'players estao'} sem sincronizar`}
            action={
              <Link href="/painel/players">
                <Button size="sm">Ver players</Button>
              </Link>
            }
          >
            Sem heartbeat recente, nao e possivel confirmar que o audio esta tocando na loja.
          </Alert>
        </div>
      )}

      {media.failed > 0 && (
        <div className="mb-5">
          <Alert
            tone="danger"
            title={`${media.failed} ${media.failed === 1 ? 'arquivo falhou' : 'arquivos falharam'} no processamento`}
            action={
              <Link href="/painel/biblioteca?status=failed">
                <Button size="sm">Revisar biblioteca</Button>
              </Link>
            }
          >
            Esses audios nao entram em nenhuma playlist ate serem reenviados.
          </Alert>
        </div>
      )}

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Players no ar"
          value={`${devices.online}/${devices.total}`}
          sublabel={devices.total === 0 ? 'nenhum player pareado' : `${devices.offline} offline`}
          tone={devices.total > 0 && devices.online === 0 ? 'danger' : devices.offline > 0 ? 'warning' : 'success'}
          icon={<MonitorSpeaker size={15} />}
        />
        <StatTile
          label="Execucoes concluidas"
          value={fmtInt.format(playback.completed)}
          sublabel={
            playback.completionRate === null
              ? 'sem execucao no periodo'
              : `${Math.round(playback.completionRate * 100)}% das iniciadas`
          }
          icon={<Radio size={15} />}
        />
        <StatTile
          label="Falhas de reproducao"
          value={fmtInt.format(playback.failed)}
          tone={playback.failed > 0 ? 'warning' : 'neutral'}
          sublabel={playback.failed === 0 ? 'nenhuma no periodo' : 'ver relatorio para detalhe'}
          icon={<AlertTriangle size={15} />}
        />
        <StatTile
          label="Campanhas no ar"
          value={fmtInt.format(campaigns.running)}
          sublabel={`${campaigns.scheduled} agendada(s)`}
          icon={<Store size={15} />}
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title="Execucoes por dia"
            description="Eventos confirmados pelos players. Nao mede quantas pessoas ouviram."
          />
          <div className="p-5">
            {semAtividade ? (
              <EmptyState
                icon={<Radio size={28} />}
                title="Nenhuma execucao registrada ainda"
                description="Quando um player parear e comecar a tocar, os eventos aparecem aqui em tempo quase real."
                action={
                  <Link href="/painel/players">
                    <Button variant="primary" size="sm">
                      Parear o primeiro player
                    </Button>
                  </Link>
                }
              />
            ) : (
              <LineChart
                data={data.daily}
                series={['completed', 'started', 'failed']}
                valueLabel="Execucoes"
              />
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="Mais tocados" description="Anuncios com mais execucoes concluidas." />
          <div className="p-5">
            <BarList
              items={data.topAnnouncements.map((a) => ({
                label: a.title,
                value: a.completed,
              }))}
            />
          </div>
        </Card>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title="Lojas"
            description="Disponibilidade e execucoes por unidade, no fuso de cada loja."
            action={
              <Link href="/painel/lojas">
                <Button size="sm">Gerenciar</Button>
              </Link>
            }
          />
          {data.storeBreakdown.length === 0 ? (
            <EmptyState
              icon={<Store size={28} />}
              title="Nenhuma loja cadastrada"
              description="Cadastre a primeira loja com o fuso horario correto para montar a programacao."
              action={
                <Link href="/painel/lojas">
                  <Button variant="primary" size="sm">
                    Cadastrar loja
                  </Button>
                </Link>
              }
            />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Loja</Th>
                  <Th>Fuso</Th>
                  <Th>Players</Th>
                  <Th numeric>Concluidas</Th>
                  <Th numeric>Falhas</Th>
                </tr>
              </thead>
              <tbody>
                {data.storeBreakdown.map((store) => (
                  <tr key={store.storeId}>
                    <Td>{store.storeName}</Td>
                    <Td>
                      <span className="text-[12px] text-muted">{store.timezone}</span>
                    </Td>
                    <Td>
                      <StatusDot
                        tone={
                          store.totalDevices === 0
                            ? 'neutral'
                            : store.onlineDevices === 0
                              ? 'danger'
                              : store.onlineDevices < store.totalDevices
                                ? 'warning'
                                : 'success'
                        }
                        label={
                          store.totalDevices === 0
                            ? 'sem player'
                            : `${store.onlineDevices}/${store.totalDevices} no ar`
                        }
                      />
                    </Td>
                    <Td numeric>{fmtInt.format(store.completed)}</Td>
                    <Td numeric>
                      {store.failed > 0 ? (
                        <span className="text-warning">{fmtInt.format(store.failed)}</span>
                      ) : (
                        <span className="text-muted">0</span>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        <Card>
          <CardHeader title="Biblioteca" description="Audio disponivel para programar." />
          <div className="space-y-3 p-5">
            <div className="flex items-center justify-between text-[13px]">
              <span className="text-muted">Prontos para tocar</span>
              <span className="tabular text-text">{fmtInt.format(media.ready)}</span>
            </div>
            <div className="flex items-center justify-between text-[13px]">
              <span className="text-muted">Em processamento</span>
              <span className="tabular text-text">{fmtInt.format(media.processing)}</span>
            </div>
            <div className="flex items-center justify-between text-[13px]">
              <span className="text-muted">Com falha</span>
              <span className={`tabular ${media.failed > 0 ? 'text-danger' : 'text-text'}`}>
                {fmtInt.format(media.failed)}
              </span>
            </div>
            <div className="flex items-center justify-between border-t border-line/60 pt-3 text-[13px]">
              <span className="text-muted">Espaco usado</span>
              <span className="tabular text-text">{formatBytes(media.storageBytes)}</span>
            </div>

            {media.ready === 0 && (
              <div className="pt-2">
                <Link href="/painel/biblioteca">
                  <Button variant="primary" size="sm" className="w-full" icon={<LibraryBig size={14} />}>
                    Enviar o primeiro audio
                  </Button>
                </Link>
              </div>
            )}
          </div>
        </Card>
      </div>

      <p className="mt-6 flex items-center gap-2 text-[12px] text-muted/70">
        <Badge tone="neutral">Periodo</Badge>
        {data.period.from} a {data.period.to}, agregado pelo dia local de cada loja.
      </p>

      <span className="sr-only">{stores.total} lojas cadastradas.</span>
    </>
  );
}
