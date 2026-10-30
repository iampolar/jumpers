'use client';

import { CursorGlow } from './cursor-glow';
import { DotGridWave } from './dot-grid-wave';

/**
 * Fundo atmosferico do CastWave.
 *
 * Uma unica implementacao, usada pela tela de entrada E pelo console. O que
 * muda entre as duas e a INTENSIDADE, nunca a composicao -- e por isso que
 * atravessar o login para o painel parece a mesma experiencia, e nao duas
 * telas feitas por equipes diferentes.
 *
 * Quatro camadas, do fundo para a frente:
 *
 *   1. aurora   -- dois brilhos lentos, turquesa e dourado, que respiram;
 *   2. malha    -- os pontos, com a onda plana e os aneis em expansao;
 *   3. vinheta  -- escurece as bordas e empurra o olho para o centro;
 *   4. luz do ponteiro (`CursorGlow`), em camada propria e fixa.
 *
 * Todas ficam em `-z-10` e com `pointer-events: none`: sao decoracao, nao
 * podem interceptar clique nem entrar na ordem de leitura.
 */

export type AmbientIntensity = 'marca' | 'console';

/**
 * Os parametros do efeito, exatamente como vieram do snippet de referencia.
 *
 * O snippet descreve a malha em valores NORMALIZADOS (0 a 1) para espacamento
 * e tamanho do ponto; o restante ja esta na unidade final. Guardar os numeros
 * aqui, com o mesmo nome que tinham no `data-aifx-*`, permite conferir a
 * fidelidade lendo uma coluna -- sem procurar onde cada um virou pixel.
 *
 *   data-aifx-bg-alpha="0.89"   data-aifx-angle="24"
 *   data-aifx-spacing="0.32"    data-aifx-falloff="1"
 *   data-aifx-dot-size="0.24"   data-aifx-mouse="0.88"
 *   data-aifx-wave-scale="2.93"
 *   data-aifx-wave-speed="1.16"
 */
const REFERENCIA = {
  bgAlpha: 0.89,
  spacing: 0.32,
  dotSize: 0.24,
  waveScale: 2.93,
  waveSpeed: 1.16,
  angle: 24,
  falloff: 1,
  mouse: 0.88,
} as const;

/**
 * Normalizado -> pixel.
 *
 * O runtime original interpreta `spacing` e `dot-size` como fracao de uma
 * faixa util, nao como medida absoluta -- e por isso que `0.32` produz uma
 * malha utilizavel em qualquer tela. As faixas abaixo reproduzem esse
 * comportamento: 0 e o limite denso/fino, 1 e o limite esparso/grosso.
 */
const EM_PIXEIS = {
  spacing: 10 + REFERENCIA.spacing * 60, // 0.32 -> 29.2 px
  dotSize: 0.4 + REFERENCIA.dotSize * 3.2, // 0.24 -> 1.17 px
} as const;

/**
 * Malha identica nas duas superficies.
 *
 * Velocidade, angulo, escala, queda e resposta ao ponteiro sao os mesmos
 * numeros nos dois perfis -- o fundo do console NAO e uma versao diferente do
 * fundo da entrada, e o mesmo efeito. A unica coisa que muda de uma tela para
 * a outra e quanta luz ele emite, e isso vive em `PERFIS`.
 */
const MALHA = {
  spacing: EM_PIXEIS.spacing,
  dotSize: EM_PIXEIS.dotSize,
  waveScale: REFERENCIA.waveScale,
  waveSpeed: REFERENCIA.waveSpeed,
  angle: REFERENCIA.angle,
  falloff: REFERENCIA.falloff,
  mouse: REFERENCIA.mouse,
  pulse: 0.95,
  pulseInterval: 2.4,
} as const;

/** Vale -> crista: Azul Noite, Ciano Tech, Branco Absoluto. */
const RAMPA = ['#1B3A5C', '#00D1FF', '#FFFFFF'] as const;

const PERFIS = {
  /**
   * Telas de marca -- entrada, pagina inicial. Recebe o `bg-alpha` do snippet
   * sem desconto: nao ha tabela nem grafico disputando atencao aqui.
   */
  marca: {
    opacity: REFERENCIA.bgAlpha,
    aurora: 0.38,
    glow: 1,
    vinheta: 82,
  },
  /**
   * Console. O MESMO efeito, um degrau abaixo em emissao de luz.
   *
   * A versao anterior deste perfil era conservadora demais: metade da
   * opacidade, onda tres vezes mais lenta, pulsos a cada 4,5 s e `mouse: 0`.
   * Vista lado a lado com a entrada, nao era "a mesma tela mais contida" --
   * era outra tela. Desligar o ponteiro, em particular, mudava o
   * COMPORTAMENTO do fundo e nao a sua forca: atravessar o login dava a
   * impressao de que o efeito tinha acabado.
   *
   * O medo era competir com tabela e grafico. Nao compete: cartao, menu e
   * cabecalho sao superficies proprias (`bg-surface/80` com desfoque), e a
   * malha so aparece nas calhas entre eles. Entao o desconto e de 0.89 para
   * 0.74 -- o suficiente para texto longo repousar, longe de descaracterizar
   * o efeito.
   */
  console: {
    opacity: 0.74,
    aurora: 0.3,
    glow: 0.9,
    // Mais leve que na entrada de proposito. A vinheta escurece as BORDAS, e
    // e exatamente ali que o console tem suas calhas -- em volta do menu, do
    // cabecalho e das colunas. Com 82% o fundo morria justamente onde ainda
    // aparecia, e a tela voltava a parecer chapada.
    vinheta: 55,
  },
} as const;

export function AmbientBackground({ intensity = 'console' }: { intensity?: AmbientIntensity }) {
  const perfil = PERFIS[intensity];

  return (
    <>
      <div aria-hidden="true" className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
        {/*
          Aurora: dois brilhos amplos que se deslocam devagar. A animacao e
          longa de proposito (28 s e 36 s, periodos diferentes) para que o
          fundo nunca repita o mesmo quadro de forma perceptivel -- parece
          vivo sem chamar atencao para si.
        */}
        <div
          className="absolute -top-1/3 left-1/2 h-[900px] w-[1400px] -translate-x-1/2 rounded-full blur-3xl animate-[aurora-a_28s_ease-in-out_infinite]"
          style={{
            opacity: perfil.aurora,
            background:
              'radial-gradient(closest-side, color-mix(in oklab, var(--color-cyan) 60%, transparent), transparent)',
          }}
        />
        <div
          className="absolute -bottom-1/4 right-0 h-[700px] w-[1000px] rounded-full blur-3xl animate-[aurora-b_36s_ease-in-out_infinite]"
          style={{
            opacity: perfil.aurora * 0.55,
            background:
              'radial-gradient(closest-side, color-mix(in oklab, var(--color-text) 16%, transparent), transparent)',
          }}
        />

        <div className="absolute inset-0">
          <DotGridWave
            colors={RAMPA}
            spacing={MALHA.spacing}
            dotSize={MALHA.dotSize}
            waveScale={MALHA.waveScale}
            waveSpeed={MALHA.waveSpeed}
            angle={MALHA.angle}
            mouse={MALHA.mouse}
            falloff={MALHA.falloff}
            pulse={MALHA.pulse}
            pulseInterval={MALHA.pulseInterval}
            opacity={perfil.opacity}
          />
        </div>

        {/* Vinheta: segura a atencao no centro e impede que a aurora clareie
            demais as bordas, onde ficam menu e cabecalho. */}
        <div
          className="absolute inset-0"
          style={{
            background:
              `radial-gradient(130% 110% at 50% 40%, transparent 42%, color-mix(in oklab, var(--color-ink) ${perfil.vinheta}%, transparent) 100%)`,
          }}
        />
      </div>

      <CursorGlow strength={perfil.glow} />

      <style>{`
        @keyframes aurora-a {
          0%, 100% { transform: translate(-50%, 0) scale(1); }
          50%      { transform: translate(-46%, 4%) scale(1.12); }
        }
        @keyframes aurora-b {
          0%, 100% { transform: translate(6%, 0) scale(1.05); }
          50%      { transform: translate(-2%, -6%) scale(0.92); }
        }
      `}</style>
    </>
  );
}
