'use client';

import { useRef, useState } from 'react';
import { AudioLines, CheckCircle2, Music, Upload } from 'lucide-react';
import type { MediaAsset } from '@castwave/contracts';
import { PageHeader } from '@/components/shell';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  formatBytes,
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
 * Biblioteca de audio.
 *
 * O upload acontece em duas etapas porque a cota do plano e verificada ANTES
 * da transferencia -- nao faz sentido o lojista subir 40 MB para ouvir "nao".
 *
 * A declaracao de direitos e obrigatoria e nao vem pre-marcada: a Jumpers nao
 * distribui catalogo musical, e quem envia e responsavel pela licenca.
 */

const TIPOS = [
  ['music', 'Musica ambiente'],
  ['voice_over', 'Locucao / spot'],
  ['jingle', 'Jingle'],
  ['operational_notice', 'Aviso operacional'],
] as const;

const ESTADO: Record<MediaAsset['status'], { tone: 'success' | 'warning' | 'danger' | 'neutral'; label: string }> = {
  ready: { tone: 'success', label: 'Pronto' },
  processing: { tone: 'warning', label: 'Processando' },
  uploading: { tone: 'neutral', label: 'Enviando' },
  failed: { tone: 'danger', label: 'Falhou' },
  archived: { tone: 'neutral', label: 'Arquivado' },
};

export default function BibliotecaPage() {
  const { reasonFor } = useSession();
  const { data, loading, reload } = useApi<{ media: MediaAsset[] }>('/api/v1/media');
  const [enviando, setEnviando] = useState(false);
  const [tocando, setTocando] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const media = data?.media ?? [];
  const prontos = media.filter((m) => m.status === 'ready');

  const ouvir = async (asset: MediaAsset) => {
    if (tocando === asset.id) {
      audioRef.current?.pause();
      setTocando(null);
      return;
    }
    const { url } = await api.get<{ url: string }>(`/api/v1/media/${asset.id}/stream-url`);
    if (!audioRef.current) audioRef.current = new Audio();
    audioRef.current.src = url;
    audioRef.current.onended = () => setTocando(null);
    await audioRef.current.play();
    setTocando(asset.id);
  };

  if (loading) return <Spinner label="Carregando biblioteca" />;

  return (
    <>
      <PageHeader
        title="Biblioteca de audio"
        description="Musicas, locucoes, jingles e avisos. Validamos cada arquivo pelo conteudo real — nao pela extensao."
        action={
          <Button
            variant="primary"
            icon={<Upload size={15} />}
            disabledReason={reasonFor('media:upload')}
            onClick={() => setEnviando(true)}
          >
            Enviar audio
          </Button>
        }
      />

      <Card>
        {media.length === 0 ? (
          <EmptyState
            icon={<AudioLines size={30} />}
            title="Biblioteca vazia"
            description="O CastWave nao distribui catalogo musical. Envie as faixas, locucoes e jingles sobre os quais sua rede tem direito de execucao."
            action={
              <Button variant="primary" onClick={() => setEnviando(true)} disabledReason={reasonFor('media:upload')}>
                Enviar o primeiro audio
              </Button>
            }
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Titulo</Th>
                <Th>Tipo</Th>
                <Th>Estado</Th>
                <Th numeric>Duracao</Th>
                <Th numeric>Tamanho</Th>
                <Th>Tecnico</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {media.map((asset) => {
                const estado = ESTADO[asset.status];
                return (
                  <tr key={asset.id}>
                    <Td>
                      <span className="font-medium">{asset.title}</span>
                      <p className="text-[11px] text-muted">{asset.originalFilename}</p>
                      {asset.processingError && (
                        <p className="mt-0.5 text-[11px] text-danger">{asset.processingError}</p>
                      )}
                    </Td>
                    <Td>
                      <span className="text-muted">
                        {TIPOS.find(([v]) => v === asset.kind)?.[1] ?? asset.kind}
                      </span>
                    </Td>
                    <Td>
                      <Badge tone={estado.tone}>{estado.label}</Badge>
                    </Td>
                    <Td numeric>{formatDuration(asset.durationMs)}</Td>
                    <Td numeric>{formatBytes(asset.sizeBytes)}</Td>
                    <Td>
                      <span className="text-[11px] text-muted">
                        {asset.sampleRate ? `${(asset.sampleRate / 1000).toFixed(1)} kHz` : '—'}
                        {asset.channels ? ` · ${asset.channels === 1 ? 'mono' : 'estereo'}` : ''}
                      </span>
                      {/* Honestidade sobre a origem do dado tecnico. */}
                      {asset.loudnessLufs === null && asset.status === 'ready' && (
                        <p className="text-[10px] text-muted/60">lido do cabecalho</p>
                      )}
                    </Td>
                    <Td className="text-right">
                      {asset.status === 'ready' && (
                        <Button size="sm" variant="ghost" onClick={() => void ouvir(asset)}>
                          {tocando === asset.id ? 'Parar' : 'Ouvir'}
                        </Button>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>

      {prontos.length > 0 && (
        <p className="mt-4 text-[12px] text-muted">
          {prontos.length} {prontos.length === 1 ? 'arquivo pronto' : 'arquivos prontos'} ·{' '}
          {formatBytes(prontos.reduce((sum, m) => sum + m.sizeBytes, 0))} em uso
        </p>
      )}

      <ModalUpload
        open={enviando}
        onClose={() => setEnviando(false)}
        onDone={() => {
          setEnviando(false);
          reload();
        }}
      />
    </>
  );
}

function ModalUpload({
  open,
  onClose,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [arquivo, setArquivo] = useState<File | null>(null);
  const [erro, setErro] = useState<ApiError | null>(null);
  const [etapa, setEtapa] = useState<'form' | 'enviando' | 'ok'>('form');
  const [resultado, setResultado] = useState<{ asset: MediaAsset; probedBy: string } | null>(null);

  const enviar = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!arquivo) return;
    const form = new FormData(event.currentTarget);
    setEtapa('enviando');
    setErro(null);

    try {
      // Etapa 1: ticket. A cota e conferida aqui, antes de transferir bytes.
      const ticket = await api.post<{ mediaAssetId: string }>('/api/v1/media/uploads', {
        filename: arquivo.name,
        sizeBytes: arquivo.size,
        kind: form.get('kind'),
        title: form.get('title') || undefined,
        rightsAttested: true,
      });

      // Etapa 2: os bytes. O servidor valida magic bytes, duracao e checksum.
      const bytes = await arquivo.arrayBuffer();
      const result = await api.upload<{ asset: MediaAsset; probedBy: string }>(
        `/api/v1/media/uploads/${ticket.mediaAssetId}/complete`,
        bytes,
      );
      setResultado(result);
      setEtapa('ok');
    } catch (e) {
      setErro(e instanceof ApiError ? e : null);
      setEtapa('form');
    }
  };

  const fechar = () => {
    setArquivo(null);
    setErro(null);
    setEtapa('form');
    setResultado(null);
    onClose();
  };

  if (etapa === 'ok' && resultado) {
    return (
      <Modal
        open={open}
        onClose={fechar}
        title="Audio adicionado"
        footer={
          <>
            <Button onClick={fechar}>Fechar</Button>
            <Button
              variant="primary"
              onClick={() => {
                setArquivo(null);
                setResultado(null);
                setEtapa('form');
              }}
            >
              Enviar outro
            </Button>
          </>
        }
      >
        <div className="flex items-start gap-3 rounded-lg border border-success/25 bg-success/5 p-4">
          <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-success" aria-hidden />
          <div className="min-w-0 text-[13px]">
            <p className="font-medium text-text">{resultado.asset.title}</p>
            <p className="mt-1 text-muted">
              {formatDuration(resultado.asset.durationMs)} · {formatBytes(resultado.asset.sizeBytes)} ·{' '}
              {resultado.asset.mimeType}
            </p>
            <p className="mt-2 text-[12px] text-muted">
              Duracao e formato{' '}
              {resultado.probedBy === 'ffprobe'
                ? 'medidos com FFmpeg.'
                : 'lidos do cabecalho do arquivo. Sem FFmpeg instalado nao ha medicao de volume (LUFS).'}
            </p>
          </div>
        </div>
        <div className="mt-4" onClick={onDone} />
      </Modal>
    );
  }

  return (
    <Modal
      open={open}
      onClose={fechar}
      title="Enviar audio"
      description="MP3, WAV, OGG, FLAC ou M4A, ate 64 MB."
      footer={
        <>
          <Button onClick={fechar}>Cancelar</Button>
          <Button
            type="submit"
            form="form-upload"
            variant="primary"
            loading={etapa === 'enviando'}
            disabledReason={!arquivo ? 'Escolha um arquivo primeiro.' : null}
          >
            Enviar
          </Button>
        </>
      }
    >
      <form id="form-upload" onSubmit={(e) => void enviar(e)} className="space-y-4">
        {erro && (
          <Alert tone="danger" title={erro.message}>
            {erro.action}
          </Alert>
        )}

        <Field label="Arquivo" htmlFor="file" required>
          <input
            id="file"
            type="file"
            accept="audio/*,.mp3,.wav,.ogg,.flac,.m4a"
            required
            onChange={(e) => setArquivo(e.target.files?.[0] ?? null)}
            className="w-full rounded-lg border border-line bg-ink/60 p-2 text-[13px] text-muted file:mr-3 file:rounded-md file:border-0 file:bg-elevated file:px-3 file:py-1.5 file:text-[13px] file:text-text"
          />
        </Field>

        {arquivo && (
          <p className="flex items-center gap-2 text-[12px] text-muted">
            <Music size={13} aria-hidden />
            {arquivo.name} · {formatBytes(arquivo.size)}
          </p>
        )}

        <Field label="Tipo" htmlFor="kind" required hint="Define o limite de duracao e onde o item pode entrar.">
          <Select id="kind" name="kind" required defaultValue="voice_over">
            {TIPOS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Titulo" htmlFor="title" hint="Em branco, usamos o nome do arquivo.">
          <Input id="title" name="title" placeholder="Oferta do dia — cafe" />
        </Field>

        {/* Nao vem pre-marcado de proposito: e uma declaracao, nao um aceite. */}
        <label className="flex items-start gap-2.5 rounded-lg border border-line bg-elevated/40 p-3 text-[12px] leading-relaxed text-muted">
          <input type="checkbox" required className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-cyan" />
          <span>
            Confirmo que a minha organizacao possui os direitos de execucao publica deste audio. O
            CastWave nao fornece catalogo musical licenciado.
          </span>
        </label>
      </form>
    </Modal>
  );
}
