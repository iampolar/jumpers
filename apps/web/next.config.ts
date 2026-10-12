import type { NextConfig } from 'next';

const apiOrigin = process.env.CASTWAVE_API_ORIGIN ?? 'http://127.0.0.1:4000';

const config: NextConfig = {
  reactStrictMode: true,

  /*
   * Pacotes do workspace sao consumidos como codigo TypeScript, e seus imports
   * relativos vao SEM extensao.
   *
   * Isso nao e descuido: e a unica forma que tsx, tsup, vitest e Turbopack
   * resolvem do mesmo jeito. Com `./errors.js` apontando para `errors.ts`, o
   * Turbopack nao acha o arquivo e o build quebra -- mas so no primeiro import
   * de VALOR, porque import de tipo desaparece na compilacao e esconde o
   * problema por semanas.
   */
  transpilePackages: ['@castwave/contracts', '@castwave/core'],

  typedRoutes: false,

  async rewrites() {
    // O painel fala com a API pela mesma origem: o cookie de sessao e
    // SameSite=Lax e nao atravessaria origens diferentes em producao.
    return [
      { source: '/api/v1/:path*', destination: `${apiOrigin}/api/v1/:path*` },
      { source: '/health/:path*', destination: `${apiOrigin}/health/:path*` },
    ];
  },

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          // O produto nunca pede microfone, camera ou localizacao. A politica
          // declara isso ao navegador, nao so na documentacao.
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
          },
        ],
      },
    ];
  },
};

export default config;
