'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PlayerManifest } from '@castwave/contracts';
import { CastWaveMark } from '@/components/brand';

/**
 * CastWave Player.
 *
 * Interface deliberadamente minima: fica num tablet preso na parede de uma
 * loja, visto de longe, e nao tem nenhuma funcao administrativa.
 *
 * Quatro honestidades que esta tela mantem:
 *
 *  1. **Nunca diz "tocando" sem estar tocando.** Sem manifesto, sem arquivo
 *     em cache ou sem gesto inicial, o estado mostrado e o real.
 *  2. **O gesto inicial e explicito.** Nenhum navegador moderno deixa um
 *     `<audio>` comecar sozinho; em vez de falhar em silencio, pedimos um
 *     toque e explicamos por que.
 *  3. **Eventos nao se perdem nem duplicam.** Cada um nasce com um UUID no
 *     proprio player, fica em buffer local se a rede cair e e reenviado na
 *     reconexao -- o servidor descarta repetidos pela chave primaria.
 *  4. **O token fica em `localStorage` por necessidade.** E um dispositivo
 *     dedicado que precisa sobreviver a reinicio sem alguem digitar codigo de
 *     novo. O escopo e minimo (uma zona) e a revogacao corta na proxima
 *     sincronizacao.
 */

const TOKEN_KEY = 'castwave.device.token';
const BUFFER_KEY = 'castwave.pending.events';

interface PendingEvent {
  eventId: string;
  slotId: string;
  mediaAssetId: string;
  announcementVersionId: string | null;
  campaignId: string | null;
  eventType: 'started' | 'completed' | 'failed' | 'skipped';
  occurredAt: string;
  playedMs: number;
  errorCode?: string | null;
}

function readBuffer(): PendingEvent[] {
  try {
    return JSON.parse(localStorage.getItem(BUFFER_KEY) ?? '[]') as PendingEvent[];
  } catch {
    return [];
  }
}

function writeBuffer(events: PendingEvent[]): void {
  try {
    // Teto no buffer: um player meses offline nao pode estourar a cota do
    // navegador e travar a propria reproducao.
    localStorage.setItem(BUFFER_KEY, JSON.stringify(events.slice(-2000)));
  } catch {
    /* storage cheio ou bloqueado: seguimos tocando */
  }
}

export default function PlayerPage() {
  const [token, setToken] = useState<string | null>(null);
  const [manifest, setManifest] = useState<PlayerManifest | null>(null);
  const [indice, setIndice] = useState(0);
  const [iniciado, setIniciado] = useState(false);
  const [online, setOnline] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [pendentes, setPendentes] = useState(0);
  const [ultimaSync, setUltimaSync] = useState<Date | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    setToken(localStorage.getItem(TOKEN_KEY));
    setPendentes(readBuffer().length);
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    setOnline(navigator.onLine);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  const authFetch = useCallback(
    async (path: string, init?: RequestInit) => {
      const res = await fetch(path, {
        ...init,
        headers: { ...(init?.headers ?? {}), authorization: `Bearer ${token ?? ''}` },
      });
      if (res.status === 403) {
        // Revogado: a credencial e terminal, exige novo pareamento.
        localStorage.removeItem(TOKEN_KEY);
        setToken(null);
        setErro('Este player foi removido da loja. Peca um novo codigo no painel.');
      }
      return res;
    },
    [token],
  );

  /** Drena o buffer local. Reenvio nao duplica: o servidor deduplica por id. */
  const enviarEventos = useCallback(async () => {
    const buffer = readBuffer();
    if (buffer.length === 0 || !token) return;
    try {
      const res = await authFetch('/api/v1/player/events', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ events: buffer.slice(0, 200) }),
      });
      if (!res.ok) return;
      const restante = buffer.slice(200);
      writeBuffer(restante);
      setPendentes(restante.length);
    } catch {
      /* sem rede: o buffer fica para a proxima tentativa */
    }
  }, [authFetch, token]);

  const registrarEvento = useCallback(
    (evento: Omit<PendingEvent, 'eventId' | 'occurredAt'>) => {
      const buffer = readBuffer();
      buffer.push({ ...evento, eventId: crypto.randomUUID(), occurredAt: new Date().toISOString() });
      writeBuffer(buffer);
      setPendentes(buffer.length);
      void enviarEventos();
    },
    [enviarEventos],
  );

  const buscarManifesto = useCallback(async () => {
    if (!token) return;
    try {
      const res = await authFetch('/api/v1/player/manifest');
      if (!res.ok) return;
      const data = (await res.json()) as PlayerManifest;
      setManifest((anterior) => {
        // Revisao igual = programacao igual: nao reinicia a faixa atual.
        if (anterior && anterior.revision === data.revision) return anterior;
        setIndice(0);
        return data;
      });
      setUltimaSync(new Date());
      setErro(null);
    } catch {
      setErro('Sem conexao com o servidor. Tocando o que ja esta em cache.');
    }
  }, [authFetch, token]);

  useEffect(() => {
    if (!token) return;
    void buscarManifesto();
    const id = setInterval(() => void buscarManifesto(), 120_000);
    return () => clearInterval(id);
  }, [token, buscarManifesto]);

  // Heartbeat: e o unico sinal de vida. Uma aba congelada nao avisa nada.
  useEffect(() => {
    if (!token) return;
    const bater = async () => {
      try {
        await authFetch('/api/v1/player/heartbeat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            appVersion: '1.0.0',
            online: navigator.onLine,
            manifestRevision: manifest?.revision ?? null,
            currentSlotId: manifest?.items[indice]?.slotId ?? null,
            cachedItems: manifest?.items.length ?? 0,
            pendingEvents: readBuffer().length,
          }),
        });
      } catch {
        /* heartbeat perdido nao interrompe a reproducao */
      }
    };
    void bater();
    const id = setInterval(() => void bater(), 45_000);
    return () => clearInterval(id);
  }, [token, authFetch, manifest, indice]);

  useEffect(() => {
    if (online) void enviarEventos();
  }, [online, enviarEventos]);

  const itemAtual = manifest?.items[indice] ?? null;

  // Reproducao serial: cada item dispara o proximo ao terminar.
  useEffect(() => {
    if (!iniciado || !itemAtual) return;
    const audio = audioRef.current;
    if (!audio) return;

    audio.src = itemAtual.url;
    audio.volume = ((manifest?.device.volume ?? 80) / 100) * (itemAtual.gain / 100);

    const avancar = () => setIndice((i) => (manifest && i + 1 < manifest.items.length ? i + 1 : 0));

    const onPlay = () =>
      registrarEvento({
        slotId: itemAtual.slotId,
        mediaAssetId: itemAtual.mediaAssetId,
        announcementVersionId: itemAtual.announcementVersionId,
        campaignId: itemAtual.campaignId,
        eventType: 'started',
        playedMs: 0,
      });

    const onEnded = () => {
      registrarEvento({
        slotId: itemAtual.slotId,
        mediaAssetId: itemAtual.mediaAssetId,
        announcementVersionId: itemAtual.announcementVersionId,
        campaignId: itemAtual.campaignId,
        eventType: 'completed',
        playedMs: Math.round(audio.duration * 1000) || itemAtual.durationMs,
      });
      avancar();
    };

    const onError = () => {
      registrarEvento({
        slotId: itemAtual.slotId,
        mediaAssetId: itemAtual.mediaAssetId,
        announcementVersionId: itemAtual.announcementVersionId,
        campaignId: itemAtual.campaignId,
        eventType: 'failed',
        playedMs: 0,
        errorCode: 'media_load_failed',
      });
      avancar();
    };

    audio.addEventListener('play', onPlay);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('error', onError);
    void audio.play().catch(() => setIniciado(false));

    return () => {
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('error', onError);
    };
  }, [iniciado, itemAtual, manifest, registrarEvento]);

  if (!token) return <TelaPareamento erro={erro} onPareado={setToken} />;

  return (
    <div className="flex min-h-dvh flex-col bg-ink p-6 text-text">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <CastWaveMark size={22} className="text-text" />
          <span className="text-[13px] text-muted">
            {manifest?.device.storeName ?? '—'} · {manifest?.device.zoneName ?? '—'}
          </span>
        </div>
        <div className="flex items-center gap-4 text-[12px] text-muted">
          <span className="inline-flex items-center gap-1.5">
            <span
              className={`h-1.5 w-1.5 rounded-full ${online ? 'bg-success' : 'bg-warning'}`}
              aria-hidden
            />
            {online ? 'conectado' : 'offline'}
          </span>
          {pendentes > 0 && <span>{pendentes} evento(s) na fila</span>}
        </div>
      </header>

      <main className="flex flex-1 flex-col items-center justify-center text-center">
        {!iniciado ? (
          <>
            <h1 className="text-xl font-semibold tracking-tight">Pronto para comecar</h1>
            <p className="mt-2 max-w-sm text-[13px] leading-relaxed text-muted">
              O navegador exige um toque antes de liberar o audio. Toque no botao e deixe esta tela
              aberta.
            </p>
            <button
              type="button"
              onClick={() => setIniciado(true)}
              className="mt-7 rounded-full bg-cyan px-9 py-3.5 text-base font-medium text-ink transition-colors hover:bg-cyan/90"
            >
              Iniciar audio
            </button>
          </>
        ) : itemAtual ? (
          <>
            <p className="text-[11px] uppercase tracking-[0.2em] text-cyan-soft">
              {itemAtual.itemType === 'music' ? 'Tocando agora' : 'Anuncio no ar'}
            </p>
            <h1 className="mt-3 max-w-2xl text-balance text-2xl font-semibold tracking-tight">
              {itemAtual.title}
            </h1>
            {manifest?.items[indice + 1] && (
              <p className="mt-6 text-[13px] text-muted">
                A seguir: {manifest.items[indice + 1]!.title}
              </p>
            )}
          </>
        ) : (
          /* Sem item: dizemos o motivo real, nao uma animacao de "tocando". */
          <>
            <h1 className="text-xl font-semibold tracking-tight text-muted">Sem programacao agora</h1>
            <p className="mt-2 max-w-sm text-[13px] leading-relaxed text-muted/70">
              {
                {
                  no_schedule: 'Nenhuma agenda cobre este horario.',
                  outside_opening_hours: 'A loja esta fora do horario de funcionamento.',
                  blackout: 'Ha um bloqueio programado para hoje.',
                  empty_playlist: 'A playlist desta janela esta vazia.',
                  no_ready_media: 'Nenhum audio pronto para tocar nesta playlist.',
                }[manifest?.idleReason ?? 'no_schedule']
              }
            </p>
          </>
        )}

        {erro && <p className="mt-6 max-w-sm text-[13px] text-warning">{erro}</p>}
      </main>

      <footer className="flex items-center justify-between text-[11px] text-muted/60">
        <span>
          {ultimaSync
            ? `sincronizado as ${ultimaSync.toLocaleTimeString('pt-BR')}`
            : 'aguardando primeira sincronizacao'}
        </span>
        <span>{manifest ? `${manifest.items.length} itens em cache` : ''}</span>
      </footer>

      {/* `playsInline` evita que o iOS abra o player em tela cheia. */}
      <audio ref={audioRef} playsInline />
    </div>
  );
}

function TelaPareamento({
  erro,
  onPareado,
}: {
  erro: string | null;
  onPareado: (token: string) => void;
}) {
  const [codigo, setCodigo] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [falha, setFalha] = useState<string | null>(null);

  const parear = async (event: React.FormEvent) => {
    event.preventDefault();
    setEnviando(true);
    setFalha(null);
    try {
      const res = await fetch('/api/v1/devices/pair', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: codigo, userAgent: navigator.userAgent }),
      });
      const body = (await res.json()) as { deviceToken?: string; error?: { message: string } };
      if (!res.ok || !body.deviceToken) {
        setFalha(body.error?.message ?? 'Codigo invalido ou expirado.');
        return;
      }
      localStorage.setItem(TOKEN_KEY, body.deviceToken);
      onPareado(body.deviceToken);
    } catch {
      setFalha('Sem conexao com o servidor.');
    } finally {
      setEnviando(false);
    }
  };

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-ink px-6 text-center">
      <CastWaveMark size={44} className="text-text" />
      <h1 className="mt-5 text-lg font-semibold tracking-tight">Parear este player</h1>
      <p className="mt-2 max-w-xs text-[13px] leading-relaxed text-muted">
        Peca um codigo no painel, em Players, e digite-o abaixo.
      </p>

      {(erro ?? falha) && (
        <p className="mt-5 max-w-xs rounded-lg border border-danger/25 bg-danger/5 px-4 py-2.5 text-[13px] text-danger">
          {erro ?? falha}
        </p>
      )}

      <form onSubmit={(e) => void parear(e)} className="mt-7 w-full max-w-xs">
        <label htmlFor="codigo" className="sr-only">
          Codigo de pareamento
        </label>
        <input
          id="codigo"
          value={codigo}
          onChange={(e) => setCodigo(e.target.value.toUpperCase())}
          placeholder="XXXX-XXXX"
          autoFocus
          autoComplete="off"
          className="w-full rounded-xl border border-line bg-surface px-4 py-3.5 text-center font-mono text-2xl tracking-[0.2em] text-text placeholder:text-muted/30"
        />
        <button
          type="submit"
          disabled={enviando || codigo.replace(/[^A-Z0-9]/g, '').length !== 8}
          className="mt-3 w-full rounded-xl bg-cyan py-3 text-sm font-medium text-ink transition-colors hover:bg-cyan/90 disabled:opacity-40"
        >
          {enviando ? 'Pareando...' : 'Parear'}
        </button>
      </form>
    </div>
  );
}
