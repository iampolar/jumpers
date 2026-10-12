'use client';

import { useState } from 'react';
import { ListMusic, Plus, Trash2 } from 'lucide-react';
import type { Announcement, MediaAsset, Playlist } from '@castwave/contracts';
import { PageHeader } from '@/components/shell';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Field,
  formatDuration,
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
 * Playlists.
 *
 * A previa chama o MESMO motor de rotacao que o player obedece. Nao e uma
 * simulacao parecida: e o resultado real, com a mesma semente. E quando um
 * item nao entra, a previa diz por que -- "o spot nao tocou" deixa de ser
 * misterio.
 */

const MOTIVO: Record<string, string> = {
  disabled: 'desativado ou sem audio pronto',
  not_yet_valid: 'vigencia ainda nao comecou',
  expired: 'vigencia encerrada',
  daily_cap_reached: 'limite diario atingido',
  zero_duration: 'audio com duracao zero',
  no_music_available: 'nao ha musica suficiente para alcancar o intervalo',
};

const TIPO_LABEL: Record<string, string> = {
  music: 'Musica',
  promo_spot: 'Spot',
  operational_notice: 'Aviso',
  jingle: 'Jingle',
};

export default function PlaylistsPage() {
  const { reasonFor } = useSession();
  const { data, loading, reload } = useApi<{ playlists: Playlist[] }>('/api/v1/playlists');
  const [criando, setCriando] = useState(false);
  const [aberta, setAberta] = useState<string | null>(null);

  const playlists = data?.playlists ?? [];

  if (loading) return <Spinner label="Carregando playlists" />;

  return (
    <>
      <PageHeader
        title="Playlists"
        description="Musica de fundo com spots inseridos em pontos definidos. As regras de rotacao sao as mesmas que o player executa."
        action={
          <Button
            variant="primary"
            icon={<Plus size={15} />}
            disabledReason={reasonFor('playlists:write')}
            onClick={() => setCriando(true)}
          >
            Nova playlist
          </Button>
        }
      />

      {playlists.length === 0 ? (
        <Card>
          <EmptyState
            icon={<ListMusic size={30} />}
            title="Nenhuma playlist"
            description="Uma playlist reune as faixas e define de quanto em quanto tempo um anuncio entra no ar."
            action={
              <Button variant="primary" onClick={() => setCriando(true)} disabledReason={reasonFor('playlists:write')}>
                Criar playlist
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="space-y-4">
          {playlists.map((p) => (
            <PlaylistCard
              key={p.id}
              playlist={p}
              expandida={aberta === p.id}
              onToggle={() => setAberta(aberta === p.id ? null : p.id)}
              onChange={reload}
            />
          ))}
        </div>
      )}

      <ModalNova
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

function PlaylistCard({
  playlist,
  expandida,
  onToggle,
  onChange,
}: {
  playlist: Playlist;
  expandida: boolean;
  onToggle: () => void;
  onChange: () => void;
}) {
  const { reasonFor } = useSession();
  const [adicionando, setAdicionando] = useState(false);
  const { data: previa, reload: recarregarPrevia } = useApi<{
    slots: { slotId: string; title: string; itemType: string; durationMs: number; startsAfterMs: number }[];
    excluded: { title: string; reason: string }[];
  }>(expandida ? `/api/v1/playlists/${playlist.id}/preview?minutes=45` : null, [playlist.updatedAt]);

  const regras = playlist.rotationRules;
  const intervalo =
    regras.insertionMode === 'every_n_tracks'
      ? `1 spot a cada ${regras.everyNTracks} faixas`
      : `1 spot a cada ${regras.everyNMinutes} min`;

  const remover = async (itemId: string) => {
    await api.del(`/api/v1/playlists/${playlist.id}/items/${itemId}`);
    onChange();
    recarregarPrevia();
  };

  return (
    <Card>
      <CardHeader
        title={playlist.name}
        description={`${playlist.musicCount} musicas · ${playlist.spotCount} spots · ${intervalo}`}
        action={
          <div className="flex items-center gap-2">
            <Badge tone={playlist.status === 'active' ? 'success' : 'neutral'}>
              {playlist.status === 'active' ? 'Ativa' : playlist.status === 'draft' ? 'Rascunho' : 'Arquivada'}
            </Badge>
            <Button size="sm" onClick={onToggle}>
              {expandida ? 'Fechar' : 'Abrir'}
            </Button>
          </div>
        }
      />

      {expandida && (
        <>
          <div className="border-b border-line/50 px-5 py-3">
            <Button
              size="sm"
              icon={<Plus size={14} />}
              disabledReason={reasonFor('playlists:write')}
              onClick={() => setAdicionando(true)}
            >
              Adicionar item
            </Button>
          </div>

          {playlist.items.length === 0 ? (
            <div className="px-5 py-8 text-center text-[13px] text-muted">
              Playlist vazia. Adicione faixas da biblioteca e os anuncios que devem entrar na rotacao.
            </div>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Item</Th>
                  <Th>Tipo</Th>
                  <Th numeric>Duracao</Th>
                  <Th numeric>Prioridade</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {playlist.items.map((item) => (
                  <tr key={item.id}>
                    <Td>{item.title}</Td>
                    <Td>
                      <span className="text-muted">{TIPO_LABEL[item.itemType] ?? item.itemType}</span>
                    </Td>
                    <Td numeric>{formatDuration(item.durationMs)}</Td>
                    <Td numeric>{item.priority}</Td>
                    <Td className="text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<Trash2 size={13} />}
                        disabledReason={reasonFor('playlists:write')}
                        onClick={() => void remover(item.id)}
                      >
                        Remover
                      </Button>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}

          {previa && (
            <div className="border-t border-line/60 px-5 py-4">
              <h3 className="mb-1 text-[13px] font-medium text-text">Previa dos proximos 45 minutos</h3>
              <p className="mb-3 text-[12px] text-muted">
                Gerada pelo mesmo motor que o player usa — e exatamente esta a sequencia que vai ao ar.
              </p>

              {previa.slots.length === 0 ? (
                <p className="text-[13px] text-muted">Nada entraria na rotacao agora.</p>
              ) : (
                <ol className="space-y-1">
                  {previa.slots.slice(0, 12).map((slot) => (
                    <li key={slot.slotId} className="flex items-center gap-3 text-[13px]">
                      <span className="w-12 shrink-0 tabular text-[11px] text-muted">
                        +{Math.floor(slot.startsAfterMs / 60_000)}min
                      </span>
                      <span
                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                          slot.itemType === 'music' ? 'bg-muted/50' : 'bg-cyan'
                        }`}
                        aria-hidden
                      />
                      <span className="truncate text-text">{slot.title}</span>
                      <span className="ml-auto shrink-0 text-[11px] text-muted">
                        {TIPO_LABEL[slot.itemType]} · {formatDuration(slot.durationMs)}
                      </span>
                    </li>
                  ))}
                </ol>
              )}

              {previa.excluded.length > 0 && (
                <div className="mt-4 rounded-lg border border-warning/20 bg-warning/5 p-3">
                  <p className="mb-1.5 text-[12px] font-medium text-warning">
                    {previa.excluded.length} {previa.excluded.length === 1 ? 'item ficou' : 'itens ficaram'} de fora
                  </p>
                  <ul className="space-y-0.5 text-[12px] text-muted">
                    {previa.excluded.map((e, i) => (
                      <li key={`${e.title}-${i}`}>
                        <span className="text-text">{e.title}</span> — {MOTIVO[e.reason] ?? e.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </>
      )}

      <ModalItem
        open={adicionando}
        playlistId={playlist.id}
        onClose={() => setAdicionando(false)}
        onDone={() => {
          setAdicionando(false);
          onChange();
          recarregarPrevia();
        }}
      />
    </Card>
  );
}

function ModalNova({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [erro, setErro] = useState<ApiError | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [modo, setModo] = useState<'every_n_tracks' | 'every_n_minutes'>('every_n_tracks');

  const salvar = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setSalvando(true);
    setErro(null);
    try {
      await api.post('/api/v1/playlists', {
        name: form.get('name'),
        description: form.get('description') || null,
        rotationRules: {
          insertionMode: modo,
          everyNTracks: Number(form.get('everyNTracks') ?? 3),
          everyNMinutes: Number(form.get('everyNMinutes') ?? 15),
          musicOrder: form.get('musicOrder'),
          maxSpotPlaysPerHour: Number(form.get('maxSpotPlaysPerHour') ?? 6),
        },
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
      title="Nova playlist"
      description="As regras definem quando um anuncio interrompe a musica."
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button type="submit" form="form-playlist" variant="primary" loading={salvando}>
            Criar playlist
          </Button>
        </>
      }
    >
      <form id="form-playlist" onSubmit={(e) => void salvar(e)} className="space-y-4">
        {erro && <Alert tone="danger" title={erro.message}>{erro.action}</Alert>}

        <Field label="Nome" htmlFor="name" required error={erro?.issueFor('name')}>
          <Input id="name" name="name" required placeholder="Ambiente — horario comercial" />
        </Field>

        <Field label="Descricao" htmlFor="description">
          <Input id="description" name="description" placeholder="Rotacao padrao das lojas" />
        </Field>

        <Field label="Quando inserir spots" htmlFor="insertionMode" required>
          <Select
            id="insertionMode"
            value={modo}
            onChange={(e) => setModo(e.target.value as typeof modo)}
          >
            <option value="every_n_tracks">A cada N faixas</option>
            <option value="every_n_minutes">A cada N minutos</option>
          </Select>
        </Field>

        {modo === 'every_n_tracks' ? (
          <Field label="Faixas entre spots" htmlFor="everyNTracks" required>
            <Input id="everyNTracks" name="everyNTracks" type="number" min={1} max={50} defaultValue={3} />
          </Field>
        ) : (
          <Field label="Minutos entre spots" htmlFor="everyNMinutes" required>
            <Input id="everyNMinutes" name="everyNMinutes" type="number" min={1} max={240} defaultValue={15} />
          </Field>
        )}

        <Field label="Ordem das musicas" htmlFor="musicOrder">
          <Select id="musicOrder" name="musicOrder" defaultValue="shuffle">
            <option value="shuffle">Aleatoria</option>
            <option value="sequential">Sequencial</option>
          </Select>
        </Field>

        <Field
          label="Maximo de execucoes por spot, por hora"
          htmlFor="maxSpotPlaysPerHour"
          hint="Evita que a mesma oferta canse o cliente da loja."
        >
          <Input
            id="maxSpotPlaysPerHour"
            name="maxSpotPlaysPerHour"
            type="number"
            min={1}
            max={60}
            defaultValue={6}
          />
        </Field>
      </form>
    </Modal>
  );
}

function ModalItem({
  open,
  playlistId,
  onClose,
  onDone,
}: {
  open: boolean;
  playlistId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const { data: midia } = useApi<{ media: MediaAsset[] }>(open ? '/api/v1/media?status=ready' : null);
  const { data: anuncios } = useApi<{ announcements: Announcement[] }>(open ? '/api/v1/announcements' : null);
  const [origem, setOrigem] = useState<'media' | 'announcement'>('media');
  const [erro, setErro] = useState<ApiError | null>(null);
  const [salvando, setSalvando] = useState(false);

  const musicas = (midia?.media ?? []).filter((m) => m.kind === 'music');
  const publicaveis = (anuncios?.announcements ?? []).filter((a) => a.currentVersion?.mediaAssetId);

  const salvar = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setSalvando(true);
    setErro(null);
    try {
      await api.post(`/api/v1/playlists/${playlistId}/items`, {
        itemType: origem === 'media' ? 'music' : 'promo_spot',
        mediaAssetId: origem === 'media' ? form.get('mediaAssetId') : null,
        announcementId: origem === 'announcement' ? form.get('announcementId') : null,
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
      title="Adicionar item"
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button type="submit" form="form-item" variant="primary" loading={salvando}>
            Adicionar
          </Button>
        </>
      }
    >
      <form id="form-item" onSubmit={(e) => void salvar(e)} className="space-y-4">
        {erro && <Alert tone="danger" title={erro.message}>{erro.action}</Alert>}

        <Field label="O que adicionar" htmlFor="origem" required>
          <Select id="origem" value={origem} onChange={(e) => setOrigem(e.target.value as typeof origem)}>
            <option value="media">Faixa musical da biblioteca</option>
            <option value="announcement">Anuncio publicado</option>
          </Select>
        </Field>

        {origem === 'media' ? (
          <Field
            label="Faixa"
            htmlFor="mediaAssetId"
            required
            hint={musicas.length === 0 ? 'Nenhuma musica pronta na biblioteca.' : undefined}
          >
            <Select id="mediaAssetId" name="mediaAssetId" required disabled={musicas.length === 0}>
              {musicas.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.title} ({formatDuration(m.durationMs)})
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <Field
            label="Anuncio"
            htmlFor="announcementId"
            required
            hint={
              publicaveis.length === 0
                ? 'Nenhum anuncio com audio vinculado. Vincule a locucao primeiro.'
                : 'So aparecem anuncios que ja tem locucao.'
            }
          >
            <Select id="announcementId" name="announcementId" required disabled={publicaveis.length === 0}>
              {publicaveis.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.title}
                </option>
              ))}
            </Select>
          </Field>
        )}

        <Field
          label="Prioridade"
          htmlFor="priority"
          hint="0 e normal. Maior vence a disputa por um intervalo de spot."
        >
          <Input id="priority" name="priority" type="number" min={0} max={100} defaultValue={0} />
        </Field>
      </form>
    </Modal>
  );
}
