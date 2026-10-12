'use client';

import { useState } from 'react';
import { Download, FileBarChart } from 'lucide-react';
import type { OverviewMetrics, Store } from '@castwave/contracts';
import { BarList, LineChart, StatTile } from '@/components/charts';
import { PageHeader } from '@/components/shell';
import {
  Alert,
  Button,
  Card,
  CardHeader,
  EmptyState,
  fmtInt,
  formatDuration,
  Input,
  Select,
  Spinner,
  Table,
  Td,
  Th,
} from '@/components/ui';
import { useApi, useSession } from '@/lib/session';

/**
 * Relatorios.
 *
 * O recorte (periodo, loja, fuso) acompanha o resultado em toda parte. Um
 * numero sozinho numa tela e uma afirmacao sem contexto -- e e assim que
 * relatorio vira discussao.
 */

const diasAtras = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

export default function RelatoriosPage() {
  const { can } = useSession();
  const [de, setDe] = useState(diasAtras(29));
  const [ate, setAte] = useState(diasAtras(0));
  const [lojaId, setLojaId] = useState('');

  const { data: lojas } = useApi<{ stores: Store[] }>('/api/v1/stores');
  const filtro = `from=${de}&to=${ate}${lojaId ? `&storeId=${lojaId}` : ''}`;

  const { data, loading, error } = useApi<OverviewMetrics>(`/api/v1/analytics/overview?${filtro}`, [filtro]);
  const { data: linhas } = useApi<{
    rows: {
      localTime: string;
      storeName: string;
      zoneName: string;
      deviceName: string;
      title: string;
      eventType: string;
      playedMs: number;
      campaignName: string | null;
      errorCode: string | null;
    }[];
  }>(`/api/v1/analytics/playback?${filtro}&limit=100`, [filtro]);

  return (
    <>
      <PageHeader
        title="Relatorios"
        description="Execucoes confirmadas pelos players. O numero mede reproducao, nao audiencia."
        action={
          can('analytics:export') ? (
            <a href={`/api/v1/analytics/export.csv?${filtro}`} download>
              <Button icon={<Download size={15} />}>Exportar CSV</Button>
            </a>
          ) : (
            <Button icon={<Download size={15} />} disabledReason="Seu perfil nao permite exportar dados.">
              Exportar CSV
            </Button>
          )
        }
      />

      {/* Filtros numa unica linha acima dos graficos. */}
      <div className="mb-5 flex flex-wrap items-end gap-3 rounded-xl border border-line bg-surface p-4">
        <div>
          <label htmlFor="de" className="mb-1 block text-[12px] text-muted">
            De
          </label>
          <Input id="de" type="date" value={de} max={ate} onChange={(e) => setDe(e.target.value)} className="w-auto" />
        </div>
        <div>
          <label htmlFor="ate" className="mb-1 block text-[12px] text-muted">
            Ate
          </label>
          <Input id="ate" type="date" value={ate} min={de} onChange={(e) => setAte(e.target.value)} className="w-auto" />
        </div>
        <div className="min-w-48">
          <label htmlFor="loja" className="mb-1 block text-[12px] text-muted">
            Loja
          </label>
          <Select id="loja" value={lojaId} onChange={(e) => setLojaId(e.target.value)}>
            <option value="">Todas as lojas</option>
            {(lojas?.stores ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="ml-auto flex gap-1.5">
          {[
            [7, '7 dias'],
            [30, '30 dias'],
            [90, '90 dias'],
          ].map(([dias, label]) => (
            <Button
              key={label}
              size="sm"
              onClick={() => {
                setDe(diasAtras(Number(dias) - 1));
                setAte(diasAtras(0));
              }}
            >
              {label}
            </Button>
          ))}
        </div>
      </div>

      {loading && <Spinner label="Calculando" />}
      {error && <Alert tone="danger" title={error.message}>{error.action}</Alert>}

      {data && (
        <>
          <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile label="Concluidas" value={fmtInt.format(data.playback.completed)} />
            <StatTile label="Iniciadas" value={fmtInt.format(data.playback.started)} />
            <StatTile
              label="Falhas"
              value={fmtInt.format(data.playback.failed)}
              tone={data.playback.failed > 0 ? 'warning' : 'neutral'}
            />
            <StatTile
              label="Tempo total no ar"
              value={formatDuration(data.playback.totalPlayedMs)}
              sublabel={
                data.playback.completionRate === null
                  ? 'sem execucao no periodo'
                  : `${Math.round(data.playback.completionRate * 100)}% de conclusao`
              }
            />
          </div>

          <Card className="mb-5">
            <CardHeader
              title="Execucoes por dia"
              description={`${data.period.from} a ${data.period.to} · agregado pelo dia local de cada loja`}
            />
            <div className="p-5">
              <LineChart data={data.daily} series={['completed', 'failed']} valueLabel="Execucoes" />
            </div>
          </Card>

          <div className="mb-5 grid gap-5 lg:grid-cols-2">
            <Card>
              <CardHeader title="Anuncios mais executados" />
              <div className="p-5">
                <BarList items={data.topAnnouncements.map((a) => ({ label: a.title, value: a.completed }))} />
              </div>
            </Card>

            <Card>
              <CardHeader title="Por loja" description="Cada loja agregada no proprio fuso." />
              <div className="p-5">
                <BarList
                  items={data.storeBreakdown.map((s) => ({
                    label: s.storeName,
                    value: s.completed,
                    sublabel: `${s.timezone}${s.failed > 0 ? ` · ${s.failed} falha(s)` : ''}`,
                  }))}
                />
              </div>
            </Card>
          </div>

          <Card>
            <CardHeader
              title="Ultimas execucoes"
              description="Horario na hora local de cada loja, nao no fuso do seu navegador."
            />
            {(linhas?.rows ?? []).length === 0 ? (
              <EmptyState
                icon={<FileBarChart size={28} />}
                title="Nenhuma execucao no periodo"
                description="Ajuste o periodo ou confirme que os players estao sincronizando."
              />
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Hora local</Th>
                    <Th>Loja / zona</Th>
                    <Th>Item</Th>
                    <Th>Campanha</Th>
                    <Th>Evento</Th>
                    <Th numeric>Tocado</Th>
                  </tr>
                </thead>
                <tbody>
                  {linhas!.rows.map((r, i) => (
                    <tr key={`${r.localTime}-${i}`}>
                      <Td>
                        <span className="tabular text-[12px]">{r.localTime}</span>
                      </Td>
                      <Td>
                        <span className="text-muted">
                          {r.storeName} · {r.zoneName}
                        </span>
                      </Td>
                      <Td>{r.title}</Td>
                      <Td>
                        <span className="text-muted">{r.campaignName ?? '—'}</span>
                      </Td>
                      <Td>
                        <span className={r.eventType === 'failed' ? 'text-danger' : 'text-muted'}>
                          {
                            { started: 'Iniciou', completed: 'Concluiu', failed: 'Falhou', skipped: 'Pulou' }[
                              r.eventType
                            ]
                          }
                          {r.errorCode ? ` (${r.errorCode})` : ''}
                        </span>
                      </Td>
                      <Td numeric>{formatDuration(r.playedMs)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>

          <p className="mt-5 text-[12px] leading-relaxed text-muted/70">
            Os numeros refletem eventos confirmados pelos players — quantas vezes o audio foi
            executado. O CastWave nao mede quantas pessoas ouviram, e nao usa microfone.
          </p>
        </>
      )}
    </>
  );
}
