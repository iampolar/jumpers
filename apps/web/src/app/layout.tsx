import type { Metadata, Viewport } from 'next';
import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';
import './globals.css';

/**
 * Geist entra pelo pacote `geist`, que empacota os arquivos de fonte
 * localmente: o build nao depende de rede, e nenhuma requisicao do usuario vai
 * para um CDN de terceiros -- o que tambem evita a discussao de LGPD sobre IP
 * do visitante trafegando para fora.
 */

export const metadata: Metadata = {
  title: {
    default: 'CastWave — central de audio do varejo',
    template: '%s · CastWave',
  },
  description:
    'Musica ambiente, ofertas e avisos no horario certo, em todas as lojas da rede, a partir de um unico painel.',
  applicationName: 'CastWave',
  // O painel nao deve aparecer em busca: e ferramenta interna de cliente.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: '#081020',
  colorScheme: 'dark',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="min-h-dvh bg-ink text-text antialiased">
        {/* Primeiro alvo de tabulacao: pular direto ao conteudo (WCAG 2.4.1). */}
        <a
          href="#conteudo"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-elevated focus:px-4 focus:py-2 focus:text-sm focus:text-text"
        >
          Pular para o conteudo
        </a>
        {children}
      </body>
    </html>
  );
}
