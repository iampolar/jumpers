/**
 * Marca CastWave: coelho geometrico unido a ondas sonoras.
 *
 * Desenhado como SVG proprio, nao como PNG da logo original: aquele arquivo e
 * escuro sobre claro e vira um borrao abaixo de ~48 px. Aqui as formas sao
 * primitivas grandes -- duas orelhas, uma cabeca, tres arcos -- justamente
 * para sobreviver ao favicon de 16 px, que e onde a maioria das marcas morre.
 *
 * A silhueta herda `currentColor`; so as ondas tem cor propria. Assim a mesma
 * marca funciona no menu escuro, numa impressao em preto e branco e no modo
 * de alto contraste do sistema.
 *
 * Silhueta, nao mascote: sem olho redondo, sem focinho, sem sorriso.
 */

export function CastWaveMark({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      className={className}
      role="img"
      aria-label="CastWave"
    >
      <defs>
        <linearGradient id="cw-wave" x1="1" y1="24" x2="13" y2="9" gradientUnits="userSpaceOnUse">
          <stop stopColor="#16D9E8" />
          <stop offset="0.5" stopColor="#3977FF" />
          <stop offset="1" stopColor="#7C5CFF" />
        </linearGradient>
      </defs>

      {/*
        Ondas: tres arcos concentricos abrindo para a esquerda, peso
        decrescente. Sao o unico elemento colorido -- a parte que diz "audio".
      */}
      <path d="M4.2 9.5a13 13 0 0 0 0 13" stroke="url(#cw-wave)" strokeWidth="2.6" strokeLinecap="round" />
      <path d="M8.8 12.4a7.6 7.6 0 0 0 0 7.2" stroke="url(#cw-wave)" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M13.2 14.8a3.2 3.2 0 0 0 0 2.4" stroke="url(#cw-wave)" strokeWidth="2.2" strokeLinecap="round" />

      {/*
        Orelhas: duas capsulas inclinadas, com angulos diferentes para dar
        atencao em vez de simetria morta. Desenhadas como traco grosso com
        ponta arredondada -- mais robusto em tamanho pequeno que um poligono.
      */}
      <path d="M20.4 12.2 18.6 4.1" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" />
      <path d="M24.1 12.6 25.2 5.4" stroke="currentColor" strokeWidth="3.1" strokeLinecap="round" />

      {/*
        Cabeca: massa unica arredondada, levemente alongada para a direita,
        onde ficaria o focinho. Fecha a silhueta sem precisar de detalhe.
      */}
      <path
        d="M22.1 11.4c3.8 0 6.9 2.6 6.9 6.3 0 3.1-1.8 5.4-4.6 6.4l-4.6 1.7c-1 .4-2-.4-2-1.4v-3.1c-1.9-1-3.1-2.6-3.1-4.6 0-3.4 3.3-5.3 7.4-5.3Z"
        fill="currentColor"
      />
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
