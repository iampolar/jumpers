import { CastWaveLockup, CastWaveMark } from '@/components/brand';

/**
 * Pagina de estado do ambiente.
 *
 * Nao e uma landing de marketing: e a primeira tela util do repositorio, e
 * mostra o estado REAL dos servicos lendo a propria API. Enquanto o console
 * nao existe, ela responde a pergunta que importa para quem acabou de subir o
 * projeto -- "o que ja funciona aqui?" -- sem prometer tela que nao existe.
 */

interface IntegrationStatus {
  key: string;
  label: string;
  state: 'not_configured' | 'configured' | 'degraded' | 'error';
  driver: string;
  message: string;
  action: string | null;
  disabledFeatures: string[];
}

const API = process.env.CASTWAVE_API_ORIGIN ?? 'http://127.0.0.1:4000';

async function fetchIntegrations(): Promise<{ data: IntegrationStatus[] | null; error: string | null }> {
  try {
    const res = await fetch(`${API}/api/v1/status/integrations`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return { data: null, error: `A API respondeu ${res.status}.` };
    const body = (await res.json()) as { integrations: IntegrationStatus[] };
    return { data: body.integrations, error: null };
  } catch {
    return { data: null, error: 'API fora do ar. Rode `npm run dev:api` em outro terminal.' };
  }
}

const STATE_STYLE: Record<IntegrationStatus['state'], { dot: string; label: string; text: string }> = {
  configured: { dot: 'bg-success', label: 'Conectado', text: 'text-success' },
  degraded: { dot: 'bg-warning', label: 'Degradado', text: 'text-warning' },
  not_configured: { dot: 'bg-muted', label: 'Nao conectado', text: 'text-muted' },
  error: { dot: 'bg-danger', label: 'Erro', text: 'text-danger' },
};

export default async function Home() {
  const { data, error } = await fetchIntegrations();

  return (
    <div className="relative isolate min-h-dvh overflow-hidden">
      {/* Brilho de fundo discreto; sem glassmorphism em toda superficie. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 left-1/2 h-[480px] w-[900px] -translate-x-1/2 rounded-full opacity-[0.14] blur-3xl"
        style={{ background: 'radial-gradient(circle, #16D9E8 0%, #3977FF 45%, transparent 70%)' }}
      />

      <header className="mx-auto flex max-w-5xl items-center justify-between px-6 py-6">
        <CastWaveLockup />
        <span className="rounded-full border border-line px-3 py-1 text-xs text-muted">
          ambiente de desenvolvimento
        </span>
      </header>

      <main id="conteudo" className="mx-auto max-w-5xl px-6 pb-24">
        <section className="pt-10 pb-14">
          <p className="mb-4 text-xs font-medium uppercase tracking-[0.18em] text-cyan">
            Central de audio do varejo
          </p>
          <h1 className="max-w-2xl text-balance text-4xl font-semibold leading-[1.1] tracking-tight sm:text-5xl">
            Sua loja no ritmo certo.
            <br />
            <span className="text-muted">Musica, ofertas e avisos no momento certo.</span>
          </h1>
          <p className="mt-6 max-w-xl text-[15px] leading-relaxed text-muted">
            O nucleo do produto funciona sem IA e sem gateway de pagamento. As duas integracoes
            entram depois, atras de contratos ja definidos — nao como alicerce.
          </p>
        </section>

        <section aria-labelledby="integracoes">
          <div className="mb-5 flex items-baseline justify-between gap-4">
            <h2 id="integracoes" className="text-sm font-semibold tracking-tight">
              Estado das dependencias
            </h2>
            <span className="text-xs text-muted">lido da API em tempo real</span>
          </div>

          {error ? (
            <div className="rounded-xl border border-warning/25 bg-warning/5 p-5">
              <p className="text-sm text-warning">{error}</p>
              <p className="mt-2 text-xs text-muted">
                Esta pagina nao inventa um estado quando nao consegue falar com a API.
              </p>
            </div>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2">
              {data?.map((item) => {
                const style = STATE_STYLE[item.state];
                return (
                  <li
                    key={item.key}
                    className="rounded-xl border border-line bg-surface p-5 transition-colors hover:border-line/80"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <h3 className="text-sm font-medium">{item.label}</h3>
                      <span className={`flex shrink-0 items-center gap-1.5 text-xs ${style.text}`}>
                        {/* Estado nunca comunicado so por cor: ha rotulo textual. */}
                        <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} aria-hidden />
                        {style.label}
                      </span>
                    </div>
                    <p className="mt-2 text-[13px] leading-relaxed text-muted">{item.message}</p>
                    {item.disabledFeatures.length > 0 && (
                      <p className="mt-3 text-[12px] text-muted/70">
                        Indisponivel: {item.disabledFeatures.join(', ')}.
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="mt-14 rounded-xl border border-line bg-surface/50 p-6">
          <h2 className="text-sm font-semibold tracking-tight">Console do lojista</h2>
          <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-muted">
            Ainda nao construido. As telas de programacao, anuncios, biblioteca, playlists,
            campanhas, lojas, players e relatorios entram sobre a API e o motor de rotacao que ja
            estao no repositorio e cobertos por testes.
          </p>
          <div className="mt-5 flex flex-wrap gap-2 text-[12px]">
            {[
              'banco + migrations',
              'motor de agenda e fuso',
              'motor de rotacao',
              'RBAC e isolamento',
              'fila de jobs',
              'health e integracoes',
            ].map((done) => (
              <span
                key={done}
                className="rounded-md border border-success/20 bg-success/5 px-2.5 py-1 text-success"
              >
                {done}
              </span>
            ))}
          </div>
        </section>
      </main>

      <footer className="border-t border-line/60">
        <div className="mx-auto flex max-w-5xl items-center gap-2 px-6 py-6 text-xs text-muted">
          <CastWaveMark size={16} className="text-muted" />
          JUMPERS · CastWave
        </div>
      </footer>
    </div>
  );
}
