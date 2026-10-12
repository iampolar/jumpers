'use client';

import { useState } from 'react';
import { Megaphone, Plus } from 'lucide-react';
import type { Announcement, Campaign, Store } from '@castwave/contracts';
import { PageHeader } from '@/components/shell';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  fieldText,
  fmtInt,
  Input,
  Modal,
  Spinner,
  Table,
  Td,
  Th,
} from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { useApi, useSession } from '@/lib/session';

/**
 * Campanhas.
 *
 * Uma campanha e uma janela de vigencia com lojas-alvo. Ela nao "empurra"
 * conteudo: o motor consulta a vigencia ao montar cada manifesto, e por isso
 * campanha vencida para de tocar sozinha -- sem job, sem clique, sem atraso.
 */

const ESTADO: Record<string, { tone: 'success' | 'warning' | 'info' | 'neutral'; label: string }> = {
  draft: { tone: 'neutral', label: 'Rascunho' },
  scheduled: { tone: 'info', label: 'Agendada' },
  running: { tone: 'success', label: 'No ar' },
  paused: { tone: 'warning', label: 'Pausada' },
  finished: { tone: 'neutral', label: 'Encerrada' },
  cancelled: { tone: 'neutral', label: 'Cancelada' },
};

const ACAO: Record<string, string> = {
  publish: 'Publicar',
  start: 'Iniciar',
  pause: 'Pausar',
  resume: 'Retomar',
  finish: 'Encerrar',
  cancel: 'Cancelar',
};

export default function CampanhasPage() {
  const { reasonFor } = useSession();
  const { data, loading, reload } = useApi<{ campaigns: Campaign[] }>('/api/v1/campaigns');
  const [criando, setCriando] = useState(false);
  const [agindo, setAgindo] = useState<string | null>(null);

  const campanhas = data?.campaigns ?? [];

  const executar = async (id: string, action: string) => {
    setAgindo(id + action);
    try {
      await api.post(`/api/v1/campaigns/${id}/actions`, { action });
      reload();
    } finally {
      setAgindo(null);
    }
  };

  if (loading) return <Spinner label="Carregando campanhas" />;

  return (
    <>
      <PageHeader
        title="Campanhas"
        description="Periodo de vigencia, lojas participantes e anuncios. Conteudo vencido sai do ar automaticamente."
        action={
          <Button
            variant="primary"
            icon={<Plus size={15} />}
            disabledReason={reasonFor('campaigns:write')}
            onClick={() => setCriando(true)}
          >
            Nova campanha
          </Button>
        }
      />

      <Card>
        {campanhas.length === 0 ? (
          <EmptyState
            icon={<Megaphone size={30} />}
            title="Nenhuma campanha"
            description="Use campanhas para colocar uma oferta no ar em lojas especificas, com data para comecar e terminar."
            action={
              <Button variant="primary" onClick={() => setCriando(true)} disabledReason={reasonFor('campaigns:write')}>
                Criar campanha
              </Button>
            }
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Campanha</Th>
                <Th>Vigencia</Th>
                <Th>Lojas</Th>
                <Th>Estado</Th>
                <Th numeric>Execucoes</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {campanhas.map((c) => {
                const estado = ESTADO[c.status] ?? ESTADO.draft!;
                return (
                  <tr key={c.id}>
                    <Td>
                      <span className="font-medium">{c.name}</span>
                      {c.objective && <p className="text-[11px] text-muted">{c.objective}</p>}
                    </Td>
                    <Td>
                      <span className="text-[12px] tabular text-muted">
                        {new Date(c.startsAt).toLocaleDateString('pt-BR')} a{' '}
                        {new Date(c.endsAt).toLocaleDateString('pt-BR')}
                      </span>
                    </Td>
                    <Td>
                      <span className="text-muted">{c.storeNames.slice(0, 2).join(', ')}</span>
                      {c.storeNames.length > 2 && (
                        <span className="text-muted"> +{c.storeNames.length - 2}</span>
                      )}
                    </Td>
                    <Td>
                      <Badge tone={estado.tone}>{estado.label}</Badge>
                    </Td>
                    <Td numeric>{c.stats ? fmtInt.format(c.stats.completed) : '—'}</Td>
                    <Td className="text-right">
                      <div className="flex justify-end gap-1.5">
                        {/* Acoes vem da maquina de estados, nao de um if local. */}
                        {c.availableActions
                          .filter((a) => ACAO[a])
                          .slice(0, 2)
                          .map((a) => (
                            <Button
                              key={a}
                              size="sm"
                              variant={a === 'publish' || a === 'start' ? 'primary' : 'ghost'}
                              loading={agindo === c.id + a}
                              disabledReason={reasonFor('campaigns:write')}
                              onClick={() => void executar(c.id, a)}
                            >
                              {ACAO[a]}
                            </Button>
                          ))}
                      </div>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>

      <ModalCampanha
        open={criando}
        onClose={() => setCriando(false)}
        onDone={() => {
          setCriando(false);
          reload();
        }}
      />
    </>
  );
}

function ModalCampanha({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const { data: lojas } = useApi<{ stores: Store[] }>(open ? '/api/v1/stores' : null);
  const { data: anuncios } = useApi<{ announcements: Announcement[] }>(open ? '/api/v1/announcements' : null);
  const [lojasSel, setLojas] = useState<string[]>([]);
  const [anunciosSel, setAnuncios] = useState<string[]>([]);
  const [erro, setErro] = useState<ApiError | null>(null);
  const [salvando, setSalvando] = useState(false);

  const stores = lojas?.stores ?? [];
  const publicaveis = (anuncios?.announcements ?? []).filter((a) => a.currentVersion?.mediaAssetId);

  const salvar = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setSalvando(true);
    setErro(null);
    try {
      await api.post('/api/v1/campaigns', {
        name: form.get('name'),
        objective: form.get('objective') || null,
        startsAt: new Date(fieldText(form, 'startsAt')).toISOString(),
        endsAt: new Date(fieldText(form, 'endsAt')).toISOString(),
        storeIds: lojasSel,
        announcementIds: anunciosSel,
        priority: Number(form.get('priority') ?? 10),
      });
      setLojas([]);
      setAnuncios([]);
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
      title="Nova campanha"
      description="A campanha entra e sai do ar sozinha, pelas datas."
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button
            type="submit"
            form="form-campanha"
            variant="primary"
            loading={salvando}
            disabledReason={lojasSel.length === 0 ? 'Escolha ao menos uma loja.' : null}
          >
            Criar como rascunho
          </Button>
        </>
      }
    >
      <form id="form-campanha" onSubmit={(e) => void salvar(e)} className="space-y-4">
        {erro && <Alert tone="danger" title={erro.message}>{erro.action}</Alert>}

        <Field label="Nome" htmlFor="name" required>
          <Input id="name" name="name" required placeholder="Semana do cafe" />
        </Field>

        <Field label="Objetivo" htmlFor="objective">
          <Input id="objective" name="objective" placeholder="Girar estoque de torrado e moido" />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Comeca em" htmlFor="startsAt" required>
            <Input id="startsAt" name="startsAt" type="datetime-local" required />
          </Field>
          <Field label="Termina em" htmlFor="endsAt" required>
            <Input id="endsAt" name="endsAt" type="datetime-local" required />
          </Field>
        </div>

        <fieldset>
          <legend className="mb-2 text-[13px] font-medium text-text">Lojas participantes</legend>
          <div className="max-h-36 space-y-1.5 overflow-y-auto">
            {stores.map((s) => (
              <label key={s.id} className="flex items-center gap-2.5 text-[13px] text-text">
                <input
                  type="checkbox"
                  checked={lojasSel.includes(s.id)}
                  onChange={(e) => setLojas((l) => (e.target.checked ? [...l, s.id] : l.filter((x) => x !== s.id)))}
                  className="h-3.5 w-3.5 accent-cyan"
                />
                {s.name}
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend className="mb-2 text-[13px] font-medium text-text">Anuncios da campanha</legend>
          {publicaveis.length === 0 ? (
            <p className="text-[12px] text-muted">
              Nenhum anuncio com locucao vinculada. Voce pode criar a campanha e associar depois.
            </p>
          ) : (
            <div className="max-h-36 space-y-1.5 overflow-y-auto">
              {publicaveis.map((a) => (
                <label key={a.id} className="flex items-center gap-2.5 text-[13px] text-text">
                  <input
                    type="checkbox"
                    checked={anunciosSel.includes(a.id)}
                    onChange={(e) =>
                      setAnuncios((l) => (e.target.checked ? [...l, a.id] : l.filter((x) => x !== a.id)))
                    }
                    className="h-3.5 w-3.5 accent-cyan"
                  />
                  {a.title}
                </label>
              ))}
            </div>
          )}
        </fieldset>

        <Field label="Prioridade" htmlFor="priority" hint="Maior vence a disputa por um intervalo de spot.">
          <Input id="priority" name="priority" type="number" min={0} max={100} defaultValue={10} />
        </Field>
      </form>
    </Modal>
  );
}
