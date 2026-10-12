'use client';

import { useMemo, useState } from 'react';
import { Megaphone, Sparkles, Wand2 } from 'lucide-react';
import type { Announcement, AnnouncementTemplate, MediaAsset } from '@castwave/contracts';
import { PageHeader } from '@/components/shell';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  formatDuration,
  Input,
  Modal,
  Select,
  Spinner,
  Table,
  Td,
  Textarea,
  Th,
} from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { useApi, useSession } from '@/lib/session';

/**
 * Anuncios.
 *
 * O criador funciona inteiro SEM IA: modelo pronto, texto manual e upload de
 * audio. O botao de IA aparece desabilitado com o motivo, em vez de sumir --
 * esconder a funcionalidade faria o lojista achar que ela nao existe.
 *
 * As acoes disponiveis vem da maquina de estados do servidor
 * (`availableActions`), nao de um `if` local. A UI nunca oferece um botao que
 * a API vai recusar.
 */

const ESTADO: Record<string, { tone: 'success' | 'warning' | 'danger' | 'info' | 'neutral'; label: string }> = {
  draft: { tone: 'neutral', label: 'Rascunho' },
  pending_approval: { tone: 'warning', label: 'Aguardando aprovacao' },
  approved: { tone: 'info', label: 'Aprovado' },
  scheduled: { tone: 'info', label: 'Agendado' },
  active: { tone: 'success', label: 'No ar' },
  paused: { tone: 'warning', label: 'Pausado' },
  rejected: { tone: 'danger', label: 'Rejeitado' },
  cancelled: { tone: 'neutral', label: 'Cancelado' },
  expired: { tone: 'neutral', label: 'Expirado' },
  completed: { tone: 'neutral', label: 'Concluido' },
  failed: { tone: 'danger', label: 'Falhou' },
};

const ACAO_LABEL: Record<string, string> = {
  submit_approval: 'Enviar para aprovacao',
  approve: 'Aprovar',
  reject: 'Rejeitar',
  schedule: 'Agendar',
  activate: 'Colocar no ar',
  pause: 'Pausar',
  resume: 'Retomar',
  cancel: 'Cancelar',
  reopen: 'Reabrir',
};

export default function AnunciosPage() {
  const { reasonFor } = useSession();
  const { data, loading, reload } = useApi<{ announcements: Announcement[] }>('/api/v1/announcements');
  const { data: iaStatus } = useApi<{ copy: { state: string }; disabledReason: string | null }>(
    '/api/v1/ai/status',
  );
  const [criando, setCriando] = useState(false);
  const [agindo, setAgindo] = useState<string | null>(null);

  const anuncios = data?.announcements ?? [];

  const executar = async (id: string, action: string) => {
    setAgindo(id + action);
    try {
      await api.post(`/api/v1/announcements/${id}/actions`, { action });
      reload();
    } finally {
      setAgindo(null);
    }
  };

  if (loading) return <Spinner label="Carregando anuncios" />;

  return (
    <>
      <PageHeader
        title="Anuncios"
        description="Ofertas, avisos e jingles. Cada edicao cria uma versao nova — a aprovada fica registrada com hash do conteudo."
        action={
          <Button
            variant="primary"
            icon={<Megaphone size={15} />}
            disabledReason={reasonFor('announcements:write')}
            onClick={() => setCriando(true)}
          >
            Novo anuncio
          </Button>
        }
      />

      {iaStatus?.disabledReason && (
        <div className="mb-5">
          <Alert tone="info" title="Geracao por IA nao esta conectada">
            {iaStatus.disabledReason}
          </Alert>
        </div>
      )}

      <Card>
        {anuncios.length === 0 ? (
          <EmptyState
            icon={<Megaphone size={30} />}
            title="Nenhum anuncio criado"
            description="Escreva o texto do zero ou parta de um modelo pronto. Depois vincule a locucao gravada e coloque na programacao."
            action={
              <Button variant="primary" onClick={() => setCriando(true)} disabledReason={reasonFor('announcements:write')}>
                Criar o primeiro anuncio
              </Button>
            }
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Anuncio</Th>
                <Th>Estado</Th>
                <Th numeric>Versoes</Th>
                <Th numeric>Duracao</Th>
                <Th>Audio</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {anuncios.map((a) => {
                const estado = ESTADO[a.status] ?? ESTADO.draft!;
                const temAudio = Boolean(a.currentVersion?.mediaAssetId);
                return (
                  <tr key={a.id}>
                    <Td>
                      <span className="font-medium">{a.title}</span>
                      {a.currentVersion && (
                        <p className="mt-0.5 line-clamp-1 max-w-md text-[11px] text-muted">
                          {a.currentVersion.scriptText}
                        </p>
                      )}
                      {a.rejectionReason && (
                        <p className="mt-0.5 text-[11px] text-danger">Motivo: {a.rejectionReason}</p>
                      )}
                    </Td>
                    <Td>
                      <Badge tone={estado.tone}>{estado.label}</Badge>
                    </Td>
                    <Td numeric>{a.versionCount}</Td>
                    <Td numeric>
                      {a.currentVersion
                        ? formatDuration(
                            a.currentVersion.mediaDurationMs ?? a.currentVersion.estimatedDurationMs,
                          )
                        : '—'}
                      {!a.currentVersion?.mediaDurationMs && a.currentVersion && (
                        <span className="ml-1 text-[10px] text-muted/60">est.</span>
                      )}
                    </Td>
                    <Td>
                      {temAudio ? (
                        <Badge tone="success">Vinculado</Badge>
                      ) : (
                        <Badge tone="warning">Sem audio</Badge>
                      )}
                    </Td>
                    <Td className="text-right">
                      <div className="flex justify-end gap-1.5">
                        {/* Botoes vem da maquina de estados do servidor. */}
                        {a.availableActions
                          .filter((act) => ACAO_LABEL[act])
                          .slice(0, 2)
                          .map((act) => (
                            <Button
                              key={act}
                              size="sm"
                              variant={act === 'approve' || act === 'activate' ? 'primary' : 'ghost'}
                              loading={agindo === a.id + act}
                              disabledReason={
                                act === 'activate' && !temAudio
                                  ? 'Vincule a locucao antes de colocar no ar.'
                                  : reasonFor(act === 'approve' || act === 'reject' ? 'announcements:approve' : 'announcements:write')
                              }
                              onClick={() => void executar(a.id, act)}
                            >
                              {ACAO_LABEL[act]}
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

      <ModalCriador
        open={criando}
        iaDisponivel={iaStatus?.copy.state === 'configured'}
        iaMotivo={iaStatus?.disabledReason ?? null}
        onClose={() => setCriando(false)}
        onDone={() => {
          setCriando(false);
          reload();
        }}
      />
    </>
  );
}

function ModalCriador({
  open,
  iaDisponivel,
  iaMotivo,
  onClose,
  onDone,
}: {
  open: boolean;
  iaDisponivel: boolean;
  iaMotivo: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { data: modelos } = useApi<{ templates: AnnouncementTemplate[] }>(
    open ? '/api/v1/announcements/templates' : null,
  );
  const { data: midia } = useApi<{ media: MediaAsset[] }>(open ? '/api/v1/media?status=ready' : null);

  const [texto, setTexto] = useState('');
  const [modeloId, setModeloId] = useState('');
  const [valores, setValores] = useState<Record<string, string>>({});
  const [erro, setErro] = useState<ApiError | null>(null);
  const [salvando, setSalvando] = useState(false);

  const templates = modelos?.templates ?? [];
  const locucoes = (midia?.media ?? []).filter((m) => m.kind !== 'music');
  const modelo = templates.find((t) => t.id === modeloId) ?? null;

  /** Preenche o modelo ao vivo: o lojista ve o roteiro se formando. */
  const textoDoModelo = useMemo(() => {
    if (!modelo) return '';
    return modelo.body.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (m, key: string) => valores[key] || m);
  }, [modelo, valores]);

  const roteiro = modelo ? textoDoModelo : texto;
  const palavras = roteiro.trim() ? roteiro.trim().split(/\s+/).length : 0;
  const duracaoEstimada = Math.round((palavras / 160) * 60);

  const salvar = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setSalvando(true);
    setErro(null);
    try {
      await api.post('/api/v1/announcements', {
        title: form.get('title'),
        type: form.get('type'),
        scriptText: roteiro,
        mediaAssetId: form.get('mediaAssetId') || null,
        source: modelo ? 'template' : 'manual',
      });
      setTexto('');
      setModeloId('');
      setValores({});
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
      title="Novo anuncio"
      description="Parta de um modelo ou escreva do zero. A locucao pode ser vinculada agora ou depois."
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button
            type="submit"
            form="form-anuncio"
            variant="primary"
            loading={salvando}
            disabledReason={roteiro.trim().length === 0 ? 'Escreva o roteiro primeiro.' : null}
          >
            Criar como rascunho
          </Button>
        </>
      }
    >
      <form id="form-anuncio" onSubmit={(e) => void salvar(e)} className="space-y-4">
        {erro && <Alert tone="danger" title={erro.message}>{erro.action}</Alert>}

        <Field label="Titulo interno" htmlFor="title" required hint="So aparece no painel, nao e falado.">
          <Input id="title" name="title" required placeholder="Oferta do dia — cafe" />
        </Field>

        <Field label="Tipo" htmlFor="type" required>
          <Select id="type" name="type" required defaultValue="promo_spot">
            <option value="promo_spot">Spot promocional</option>
            <option value="operational_notice">Aviso operacional</option>
            <option value="jingle">Jingle</option>
            <option value="institutional">Institucional</option>
          </Select>
        </Field>

        <Field label="Modelo pronto" htmlFor="modelo" hint="Opcional. Preenche o roteiro para voce.">
          <Select
            id="modelo"
            value={modeloId}
            onChange={(e) => {
              setModeloId(e.target.value);
              setValores({});
            }}
          >
            <option value="">Escrever do zero</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>

        {modelo && (
          <div className="space-y-3 rounded-lg border border-line bg-elevated/40 p-3">
            <p className="text-[12px] text-muted">{modelo.description}</p>
            {modelo.fields.map((f) => (
              <Field key={f.key} label={f.label} htmlFor={`campo-${f.key}`}>
                <Input
                  id={`campo-${f.key}`}
                  value={valores[f.key] ?? ''}
                  placeholder={f.example}
                  onChange={(e) => setValores((v) => ({ ...v, [f.key]: e.target.value }))}
                />
              </Field>
            ))}
          </div>
        )}

        <Field
          label="Roteiro"
          htmlFor="roteiro"
          required
          hint={
            palavras > 0
              ? `${palavras} palavras · leitura estimada em ${duracaoEstimada}s. A duracao real vem do audio gravado.`
              : 'O que sera falado na loja.'
          }
          error={erro?.issueFor('scriptText')}
        >
          <Textarea
            id="roteiro"
            value={roteiro}
            readOnly={Boolean(modelo)}
            onChange={(e) => setTexto(e.target.value)}
            placeholder="Atencao, clientes! Hoje, cafe torrado por R$ 19,90."
            className={modelo ? 'opacity-80' : ''}
          />
        </Field>

        {/* Desabilitado COM motivo visivel, nunca escondido. */}
        <Button
          variant="secondary"
          icon={iaDisponivel ? <Sparkles size={14} /> : <Wand2 size={14} />}
          disabledReason={iaDisponivel ? null : (iaMotivo ?? 'Nenhum provedor de IA conectado.')}
          className="w-full"
        >
          Gerar roteiro com IA
        </Button>

        <Field
          label="Locucao gravada"
          htmlFor="mediaAssetId"
          hint={
            locucoes.length === 0
              ? 'Nenhuma locucao na biblioteca ainda. Voce pode vincular depois.'
              : 'O anuncio so vai ao ar com audio vinculado.'
          }
        >
          <Select id="mediaAssetId" name="mediaAssetId" disabled={locucoes.length === 0}>
            <option value="">Vincular depois</option>
            {locucoes.map((m) => (
              <option key={m.id} value={m.id}>
                {m.title} ({formatDuration(m.durationMs)})
              </option>
            ))}
          </Select>
        </Field>
      </form>
    </Modal>
  );
}
