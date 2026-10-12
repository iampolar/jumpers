/**
 * Marca CastWave: coelho geometrico unido a ondas sonoras.
 *
 * Desenhado como SVG proprio, nao como PNG da logo: o PNG original e escuro
 * sobre claro e ilegivel abaixo de ~48 px. Aqui a silhueta e solida, as ondas
 * tem peso de traco fixo e tudo herda `currentColor`, entao a mesma marca
 * funciona no menu lateral escuro, no favicon de 16 px e numa impressao.
 *
 * Silhueta, nao mascote: sem olho redondo, sem sorriso, sem traco infantil.
 */

export function CastWaveMark({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      className={className}
      role="img"
      aria-label="CastWave"
    >
      <defs>
        <linearGradient id="cw-wave" x1="2" y1="34" x2="20" y2="12" gradientUnits="userSpaceOnUse">
          <stop stopColor="#16D9E8" />
          <stop offset="0.55" stopColor="#3977FF" />
          <stop offset="1" stopColor="#7C5CFF" />
        </linearGradient>
      </defs>

      {/* Ondas sonoras: tres arcos concentricos, peso decrescente. */}
      <path
        d="M9 12.5a22 22 0 0 0 0 23"
        stroke="url(#cw-wave)"
        strokeWidth="3.4"
        strokeLinecap="round"
      />
      <path
        d="M15.5 17.5a13 13 0 0 0 0 13"
        stroke="url(#cw-wave)"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <path
        d="M21.5 21.5a5.5 5.5 0 0 1 0 5"
        stroke="url(#cw-wave)"
        strokeWidth="2.6"
        strokeLinecap="round"
      />

      {/* Cabeca e orelhas em uma unica silhueta solida. */}
      <path
        d="M30.2 4.2c.9-.5 2 .1 2.1 1.1l1.2 11.2 4.6 2.6c3.9 2.2 6 6.6 5.2 11l-.3 1.8c-.6 3.3-3.1 5.9-6.4 6.6l-9.8 2c-1 .2-2-.5-2-1.6l-.3-5.3-3.9-6.9a9.4 9.4 0 0 1 1.5-11.2l8.1-11.3Z"
        fill="currentColor"
      />
      {/* Recorte do olho: vazado, nao desenhado, para nao virar mascote. */}
      <path d="M36.6 23.1a1.9 2.6 0 1 0 0 .01Z" fill="#070A12" opacity="0.92" />
    </svg>
  );
}

export function CastWaveWordmark({ className }: { className?: string }) {
  return (
    <span className={className}>
      <span className="font-semibold tracking-tight text-text">JUMPERS</span>
      <span className="mx-1.5 text-muted/40">/</span>
      <span className="font-semibold tracking-tight text-cyan">CastWave</span>
    </span>
  );
}

export function CastWaveLockup({ size = 32 }: { size?: number }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <CastWaveMark size={size} className="text-text" />
      <CastWaveWordmark className="text-[15px]" />
    </span>
  );
}
