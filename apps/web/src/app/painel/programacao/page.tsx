'use client';

import { useState } from 'react';
import { CalendarDays, CalendarOff, Plus } from 'lucide-react';
import type { Playlist, Schedule, Store } from '@castwave/contracts';
import { PageHeader } from '@/components/shell';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Field,
  Input,
  Modal,
  Select,
  Spinner,
  Table,
  Td,
  Th,
} from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { useApi, useSession } from '@/lib/session';

/**
 * Programacao.
 *
 * O calendario e renderizado a partir do resolvedor do servidor -- os blocos
 * sao os mesmos que o player vai obedecer, resolvidos no fuso IANA da loja.
 * Nao ha uma segunda implementacao de "que horas toca o que" no frontend que
 * pudesse divergir da realidade.
 */

const DIAS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab'];

const BLOCO_COR: Record<string, string> = {
  program: 'bg-cyan/20 border-cyan/40 text-cyan-soft',
  blackout: 'bg-danger/10 border-danger/30 text-danger',
  closed: 'bg-elevated border-line text-muted',
  gap: 'bg-surface border-line/50 text-muted/60',
};

function minutos(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export default function ProgramacaoPage() {
  const { reasonFor } = useSession();
  const { data: lojas, loading } = useApi<{ stores: Store[] }>('/api/v1/stores');
  const [lojaId, setLojaId] = useState<string>('');
  const [criandoAgenda, setCriandoAgenda] = useState(false);
  const [criandoExcecao, setCriandoExcecao] = useState(false);

  const stores = lojas?.stores ?? [];
  const selecionada = lojaId || stores[0]?.id || '';
  const loja = stores.find((s) => s.id === selecionada);

  const hoje = new Date().toISOString().slice(0, 10);
  const fim = new Date(Date.now() + 6 * 86_400_000).toISOString().slice(0, 10);

  const { data: calendario, reload: recarregarCal } = useApi<{
    timezone: string;
    days: {
      localDate: string;
      blocks: { startLocalTime: string; endLocalTime: string; kind: string; label: string; playlistName: string | null }[];
    }[];
  }>(selecionada ? `/api/v1/schedules/calendar?storeId=${selecionada}&from=${hoje}&to=${fim}` : null, [selecionada]);

  const { data: agendas, reload: recarregarAgendas } = useApi<{ schedules: Schedule[] }>(
    selecionada ? `/api/v1/schedules?storeId=${selecionada}` : null,
    [selecionada],
  );

  const { data: agora } = useApi<{
    playing: boolean;
    playlistName: string | null;
    idleReason: string | null;
    windowEndsAt: string;
    localTime: string;
    timezone: string;
  }>(selecionada ? `/api/v1/schedules/now?storeId=${selecionada}` : null, [selecionada]);

  if (loading) return <Spinner label="Carregando programacao" />;

  if (stores.length === 0) {
    return (
      <>
        <PageHeader title="Programacao" />
        <Card>
          <EmptyState
            icon={<CalendarDays size={30} />}
            title="Cadastre uma loja primeiro"
            description="A grade e resolvida no fuso de cada loja, entao e preciso ter ao menos uma cadastrada."
          />
        </Card>
      </>
    );
  }

  const recarregar = () => {
    recarregarCal();
    recarregarAgendas();
  };

  return (
    <>
      <PageHeader
        title="Programacao"
        description="O que toca, em cada loja, em cada horario. Tudo resolvido no fuso local da unidade."
        action={
          <div className="flex gap-2">
            <Button
              icon={<CalendarOff size={15} />}
              disabledReason={reasonFor('schedules:write')}
              onClick={() => setCriandoExcecao(true)}
            >
              Excecao
            </Button>
            <Button
              variant="primary"
              icon={<Plus size={15} />}
              disabledReason={reasonFor('schedules:write')}
              onClick={() => setCriandoAgenda(true)}
            >
              Nova agenda
            </Button>
          </div>
        }
      />

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <label htmlFor="loja" className="text-[13px] text-muted">
          Loja
        </label>
        <Select
          id="loja"
          value={selecionada}
          onChange={(e) => setLojaId(e.target.value)}
          className="w-auto min-w-56"
        >
          {stores.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} · {s.timezone}
            </option>
          ))}
        </Select>
        {calendario && <Badge tone="neutral">{calendario.timezone}</Badge>}
      </div>

      {agora && (
        <div className="mb-5">
          <Card>
            <div className="flex flex-wrap items-center justify-between gap-4 p-5">
              <div>
                <p className="text-[11px] uppercase tracking-wider text-muted">Agora na loja</p>
                <p className="mt-1 text-lg font-semibold tracking-tight">
                  {agora.playing ? (
                    <span className="text-text">{agora.playlistName}</span>
                  ) : (
                    /* Nunca dizemos "tocando" quando nao ha o que tocar. */
                    <span className="text-muted">Sem programacao</span>
                  )}
                </p>
                {!agora.playing && (
                  <p className="mt-0.5 text-[12px] text-muted">
                    {
                      {
                        no_schedule: 'Nenhuma agenda cobre este horario.',
                        outside_opening_hours: 'Fora do horario de funcionamento.',
                        blackout: 'Ha um bloqueio programado para hoje.',
                        empty_playlist: 'A playlist desta janela esta vazia.',
                        no_ready_media: 'Nenhum audio pronto nesta playlist.',
                      }[agora.idleReason ?? 'no_schedule']
                    }
                  </p>
                )}
              </div>
              <div className="text-right text-[12px] text-muted">
                <p>
                  Hora local: <span className="tabular text-text">{agora.localTime}</span>
                </p>
                <p className="mt-0.5">
                  Proxima mudanca:{' '}
                  <span className="tabular text-text">
                    {new Date(agora.windowEndsAt).toLocaleTimeString('pt-BR', {
                      timeZone: agora.timezone,
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </p>
              </div>
            </div>
          </Card>
        </div>
      )}

      <Card className="mb-5">
        <CardHeader
          title="Proximos 7 dias"
          description="Cada faixa e um bloco resolvido pelo servidor — e exatamente o que o player vai executar."
        />
        <div className="overflow-x-auto p-5">
          <div className="flex min-w-[640px] gap-2">
            {calendario?.days.map((dia) => {
              const data = new Date(`${dia.localDate}T12:00:00Z`);
              return (
                <div key={dia.localDate} className="flex-1">
                  <div className="mb-2 text-center">
                    <p className="text-[11px] uppercase tracking-wider text-muted">
                      {DIAS[data.getUTCDay()]}
                    </p>
                    <p className="text-[13px] tabular text-text">{dia.localDate.slice(8)}</p>
                  </div>
                  {/* Altura proporcional ao tempo: 24h = 288px. */}
                  <div className="relative h-72 overflow-hidden rounded-lg border border-line/60 bg-ink/40">
                    {dia.blocks.map((b, i) => {
                      const inicio = minutos(b.startLocalTime);
                      const fimB = b.endLocalTime === '24:00' ? 1440 : minutos(b.endLocalTime);
                      const altura = ((fimB - inicio) / 1440) * 100;
                      return (
                        <div
                          key={`${dia.localDate}-${i}`}
                          className={`absolute inset-x-0 overflow-hidden border-y px-1.5 py-0.5 ${BLOCO_COR[b.kind] ?? BLOCO_COR.gap}`}
                          style={{ top: `${(inicio / 1440) * 100}%`, height: `${altura}%` }}
                          title={`${b.startLocalTime}–${b.endLocalTime} · ${b.playlistName ?? b.label}`}
                        >
                          {altura > 8 && (
                            <p className="truncate text-[10px] leading-tight">
                              {b.playlistName ?? b.label}
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="mt-4 flex flex-wrap gap-4 text-[11px] text-muted">
            {(
              [
                ['program', 'Programacao'],
                ['closed', 'Fora do horario'],
                ['blackout', 'Bloqueio'],
                ['gap', 'Sem agenda'],
              ] as const
            ).map(([kind, label]) => (
              <span key={kind} className="flex items-center gap-1.5">
                <span className={`h-2 w-3 rounded-sm border ${BLOCO_COR[kind]}`} aria-hidden />
                {label}
              </span>
            ))}
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title="Agendas desta loja" description="Janelas recorrentes. Maior prioridade vence sobreposicao." />
        {(agendas?.schedules ?? []).length === 0 ? (
          <EmptyState
            icon={<CalendarDays size={28} />}
            title="Nenhuma agenda nesta loja"
            description="Sem agenda, o player nao recebe programacao e informa isso na tela."
            action={
              <Button variant="primary" size="sm" onClick={() => setCriandoAgenda(true)} disabledReason={reasonFor('schedules:write')}>
                Criar agenda
              </Button>
            }
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Agenda</Th>
                <Th>Playlist</Th>
                <Th>Dias</Th>
                <Th>Horario local</Th>
                <Th numeric>Prioridade</Th>
              </tr>
            </thead>
            <tbody>
              {agendas!.schedules.map((s) => (
                <tr key={s.id}>
                  <Td>{s.name}</Td>
                  <Td>
                    <span className="text-muted">{s.playlistName}</span>
                  </Td>
                  <Td>
                    <span className="text-[12px] text-muted">
                      {s.weekdays.map((d) => DIAS[d]).join(', ')}
                    </span>
                  </Td>
                  <Td>
                    <span className="tabular">
                      {s.startLocalTime}–{s.endLocalTime}
                    </span>
                  </Td>
                  <Td numeric>{s.priority}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <ModalAgenda
        open={criandoAgenda}
        storeId={selecionada}
        storeName={loja?.name ?? ''}
        onClose={() => setCriandoAgenda(false)}
        onDone={() => {
          setCriandoAgenda(false);
          recarregar();
        }}
      />

      <ModalExcecao
        open={criandoExcecao}
        storeId={selecionada}
        onClose={() => setCriandoExcecao(false)}
        onDone={() => {
          setCriandoExcecao(false);
          recarregar();
        }}
      />
    </>
  );
}

function ModalAgenda({
  open,
  storeId,
  storeName,
  onClose,
  onDone,
}: {
  open: boolean;
  storeId: string;
  storeName: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const { data: pls } = useApi<{ playlists: Playlist[] }>(open ? '/api/v1/playlists' : null);
  const [dias, setDias] = useState<number[]>([1, 2, 3, 4, 5, 6]);
  const [erro, setErro] = useState<ApiError | null>(null);
  const [salvando, setSalvando] = useState(false);

  const playlists = pls?.playlists ?? [];

  const salvar = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setSalvando(true);
    setErro(null);
    try {
      await api.post('/api/v1/schedules', {
        name: form.get('name'),
        storeId,
        playlistId: form.get('playlistId'),
        weekdays: dias,
        startLocalTime: form.get('startLocalTime'),
        endLocalTime: form.get('endLocalTime'),
        priority: Number(form.get('priority') ?? 0),
      });
      onDone();
    } catch (e) {
      setErro(e instanceof ApiError ? e : null);
    } finally {
      setSalvando(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Nova agenda em ${storeName}`}
      description="Horarios em hora LOCAL da loja."
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button
            type="submit"
            form="form-agenda"
            variant="primary"
            loading={salvando}
            disabledReason={playlists.length === 0 ? 'Crie uma playlist antes de agendar.' : null}
          >
            Criar agenda
          </Button>
        </>
      }
    >
      <form id="form-agenda" onSubmit={(e) => void salvar(e)} className="space-y-4">
        {erro && <Alert tone="danger" title={erro.message}>{erro.action}</Alert>}

        <Field label="Nome" htmlFor="name" required>
          <Input id="name" name="name" required placeholder="Comercial" />
        </Field>

        <Field label="Playlist" htmlFor="playlistId" required>
          <Select id="playlistId" name="playlistId" required disabled={playlists.length === 0}>
            {playlists.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>

        <fieldset>
          <legend className="mb-2 text-[13px] font-medium text-text">Dias da semana</legend>
          <div className="flex gap-1.5">
            {DIAS.map((dia, index) => (
              <button
                key={dia}
                type="button"
                aria-pressed={dias.includes(index)}
                onClick={() =>
                  setDias((d) => (d.includes(index) ? d.filter((x) => x !== index) : [...d, index].sort()))
                }
                className={`h-9 flex-1 rounded-lg border text-[12px] transition-colors ${
                  dias.includes(index)
                    ? 'border-cyan/50 bg-cyan/15 text-cyan-soft'
                    : 'border-line bg-ink/60 text-muted hover:text-text'
                }`}
              >
                {dia}
              </button>
            ))}
          </div>
        </fieldset>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Inicio (local)" htmlFor="startLocalTime" required>
            <Input id="startLocalTime" name="startLocalTime" type="time" required defaultValue="09:00" />
          </Field>
          <Field label="Fim (local)" htmlFor="endLocalTime" required>
            <Input id="endLocalTime" name="endLocalTime" type="time" required defaultValue="21:00" />
          </Field>
        </div>

        <Field
          label="Prioridade"
          htmlFor="priority"
          hint="Quando duas agendas se sobrepoem, a de maior prioridade vence."
        >
          <Input id="priority" name="priority" type="number" min={0} max={100} defaultValue={0} />
        </Field>
      </form>
    </Modal>
  );
}

function ModalExcecao({
  open,
  storeId,
  onClose,
  onDone,
}: {
  open: boolean;
  storeId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const { data: pls } = useApi<{ playlists: Playlist[] }>(open ? '/api/v1/playlists' : null);
  const [tipo, setTipo] = useState<'blackout' | 'override_playlist' | 'special_hours'>('blackout');
  const [erro, setErro] = useState<ApiError | null>(null);
  const [salvando, setSalvando] = useState(false);

  const salvar = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setSalvando(true);
    setErro(null);
    try {
      await api.post('/api/v1/schedules/exceptions', {
        storeId,
        localDate: form.get('localDate'),
        kind: tipo,
        label: form.get('label'),
        overridePlaylistId: tipo === 'override_playlist' ? form.get('overridePlaylistId') : null,
        startLocalTime: tipo === 'special_hours' ? form.get('startLocalTime') : null,
        endLocalTime: tipo === 'special_hours' ? form.get('endLocalTime') : null,
      });
      onDone();
    } catch (e) {
      setErro(e instanceof ApiError ? e : null);
    } finally {
      setSalvando(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Excecao de calendario"
      description="Feriado, horario especial ou troca de playlist em uma data."
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button type="submit" form="form-excecao" variant="primary" loading={salvando}>
            Salvar excecao
          </Button>
        </>
      }
    >
      <form id="form-excecao" onSubmit={(e) => void salvar(e)} className="space-y-4">
        {erro && <Alert tone="danger" title={erro.message}>{erro.action}</Alert>}

        <Field label="Tipo" htmlFor="kind" required>
          <Select id="kind" value={tipo} onChange={(e) => setTipo(e.target.value as typeof tipo)}>
            <option value="blackout">Bloqueio — nao toca nada</option>
            <option value="override_playlist">Trocar a playlist do dia</option>
            <option value="special_hours">Horario especial</option>
          </Select>
        </Field>

        <Field
          label="Data (local da loja)"
          htmlFor="localDate"
          required
          hint="Um feriado nao e um instante UTC: e um dia no calendario da loja."
        >
          <Input id="localDate" name="localDate" type="date" required />
        </Field>

        <Field label="Rotulo" htmlFor="label" required hint="Aparece no calendario e no player.">
          <Input id="label" name="label" required placeholder="Tiradentes — loja fechada" />
        </Field>

        {tipo === 'override_playlist' && (
          <Field label="Playlist do dia" htmlFor="overridePlaylistId" required>
            <Select id="overridePlaylistId" name="overridePlaylistId" required>
              {(pls?.playlists ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
        )}

        {tipo === 'special_hours' && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Abre" htmlFor="startLocalTime" required>
              <Input id="startLocalTime" name="startLocalTime" type="time" required defaultValue="08:00" />
            </Field>
            <Field label="Fecha" htmlFor="endLocalTime" required>
              <Input id="endLocalTime" name="endLocalTime" type="time" required defaultValue="14:00" />
            </Field>
          </div>
        )}
      </form>
    </Modal>
  );
}
