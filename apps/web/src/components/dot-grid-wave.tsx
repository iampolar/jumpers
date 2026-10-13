'use client';

import { useEffect, useRef } from 'react';

/**
 * Malha de pontos com ondas.
 *
 * Reimplementacao nativa do efeito `aifx/dot-grid-wave`. O snippet original
 * carregava um runtime de terceiros por CDN, com acesso total ao DOM -- na
 * MESMA pagina em que o lojista digita a senha. Trocar um efeito visual por
 * esse risco nao se paga: o mesmo resultado sai daqui, sem dependencia
 * externa, sem afrouxar a CSP e sem um terceiro podendo mudar o comportamento
 * da pagina a qualquer momento.
 *
 * Tres camadas de movimento se somam em cada ponto:
 *
 *   1. **onda plana** -- varre a tela na direcao de `angle`, continua;
 *   2. **pulsos** -- aneis que nascem sozinhos e se expandem, iguais ao halo
 *      do ponteiro mas sem depender de ninguem mexer o mouse;
 *   3. **ponteiro** -- halo que segue o cursor.
 *
 * Cuidados que um efeito decorativo precisa ter para nao virar problema:
 *
 *  - **`prefers-reduced-motion`** desliga a animacao e desenha um quadro
 *    estatico. Movimento continuo em tela cheia provoca enjoo em quem tem
 *    sensibilidade vestibular.
 *  - **Para quando ninguem esta vendo.** `IntersectionObserver` e
 *    `visibilitychange` cortam o laco fora da tela ou em aba oculta -- isso
 *    importa num tablet de loja ligado 24 horas.
 *  - **`aria-hidden`** e `pointer-events-none`: nao entra na ordem de leitura
 *    nem rouba clique de ninguem.
 */

export interface DotGridWaveProps {
  /** Cores da onda, do vale a crista. Padrao: ciano -> azul -> violeta. */
  colors?: readonly string[];
  /** Distancia entre pontos, em pixels. */
  spacing?: number;
  /** Raio base do ponto, em pixels. */
  dotSize?: number;
  /** Quantos ciclos da onda plana cabem na diagonal da tela. */
  waveScale?: number;
  /** Voltas por segundo da onda plana. */
  waveSpeed?: number;
  /** Direcao de propagacao da onda plana, em graus. */
  angle?: number;
  /** Intensidade do halo do ponteiro, de 0 a 1. Zero desliga. */
  mouse?: number;
  /** Intensidade dos pulsos automaticos, de 0 a 1. Zero desliga. */
  pulse?: number;
  /** Segundos entre o nascimento de um pulso e o proximo. */
  pulseInterval?: number;
  /** Opacidade geral. Fundo e fundo: nunca deve competir com o conteudo. */
  opacity?: number;
  className?: string;
}

/** `#16D9E8` -> `[22, 217, 232]`. */
function parseHex(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((c) => c + c)
          .join('')
      : clean;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

/** Interpola a rampa inteira: `t` em [0,1] percorre todas as cores. */
function sampleRamp(ramp: readonly [number, number, number][], t: number): [number, number, number] {
  if (ramp.length === 1) return ramp[0]!;
  const scaled = Math.min(0.9999, Math.max(0, t)) * (ramp.length - 1);
  const index = Math.floor(scaled);
  const frac = scaled - index;
  const a = ramp[index]!;
  const b = ramp[index + 1]!;
  return [a[0] + (b[0] - a[0]) * frac, a[1] + (b[1] - a[1]) * frac, a[2] + (b[2] - a[2]) * frac];
}

/** Anel que nasce num ponto e se expande ate sumir. */
interface Pulso {
  x: number;
  y: number;
  nascimento: number;
}

export function DotGridWave({
  // Identidade CastWave: ciano, azul e violeta da paleta da marca.
  colors = ['#16D9E8', '#3977FF', '#7C5CFF'],
  spacing = 26,
  dotSize = 1.6,
  waveScale = 3,
  waveSpeed = 0.16,
  angle = 72,
  mouse = 0.7,
  pulse = 0.85,
  pulseInterval = 2.6,
  opacity = 0.5,
  className,
}: DotGridWaveProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;

    const ramp = colors.map(parseHex);
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let width = 0;
    let height = 0;
    let frame = 0;
    let visible = true;
    let running = true;

    // Ponteiro fora da tela ate o primeiro movimento: sem halo fantasma.
    const ponteiro = { x: -9999, y: -9999, ativo: false };

    const pulsos: Pulso[] = [];
    let proximoPulso = 0.4;

    /** Velocidade e vida do anel: largura da tela em ~4,5 s. */
    const PULSO_VIDA = 4.5;
    const PULSO_BANDA = 130; // espessura do anel, em pixels

    const resize = (): void => {
      const rect = canvas.parentElement?.getBoundingClientRect();
      width = Math.ceil(rect?.width ?? window.innerWidth);
      height = Math.ceil(rect?.height ?? window.innerHeight);
      // Limita a 2x: em telas 3x o ganho visual e nulo e o custo triplica.
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, width * dpr);
      canvas.height = Math.max(1, height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const draw = (t: number): void => {
      ctx.clearRect(0, 0, width, height);

      const radians = (angle * Math.PI) / 180;
      const dirX = Math.cos(radians);
      const dirY = Math.sin(radians);
      const diagonal = Math.hypot(width, height) || 1;
      // Numero de onda: `waveScale` ciclos completos ao longo da diagonal.
      const k = (Math.PI * 2 * waveScale) / diagonal;
      const fase = t * waveSpeed * Math.PI * 2;

      // Nasce um pulso novo de tempos em tempos, em posicao aleatoria.
      if (pulse > 0 && t >= proximoPulso) {
        pulsos.push({
          x: Math.random() * width,
          y: Math.random() * height,
          nascimento: t,
        });
        // Intervalo com variacao: ritmo regular demais parece mecanico.
        proximoPulso = t + pulseInterval * (0.7 + Math.random() * 0.6);
      }
      // Descarta os que ja terminaram, para o laco nao crescer sem limite.
      while (pulsos.length > 0 && t - pulsos[0]!.nascimento > PULSO_VIDA) pulsos.shift();

      const velocidadePulso = diagonal / PULSO_VIDA;
      const raioPonteiro = spacing * 7;
      const cols = Math.ceil(width / spacing) + 1;
      const rows = Math.ceil(height / spacing) + 1;

      for (let row = 0; row < rows; row += 1) {
        for (let col = 0; col < cols; col += 1) {
          const x = col * spacing;
          const y = row * spacing;

          // 1. Onda plana viajando na direcao `angle`.
          const onda = Math.sin((x * dirX + y * dirY) * k + fase);
          const nivel = onda * 0.5 + 0.5; // [0,1]

          let realce = 0;

          // 2. Aneis em expansao.
          for (const p of pulsos) {
            const idade = t - p.nascimento;
            const raio = idade * velocidadePulso;
            const distancia = Math.hypot(x - p.x, y - p.y);
            const delta = Math.abs(distancia - raio);
            if (delta > PULSO_BANDA) continue;
            // Perfil suave dentro da banda, sem borda dura.
            const perfil = Math.cos((delta / PULSO_BANDA) * Math.PI * 0.5) ** 2;
            // E some conforme envelhece, para a onda "se dissolver".
            const esmaecimento = Math.max(0, 1 - idade / PULSO_VIDA);
            realce += perfil * esmaecimento * pulse;
          }

          // 3. Halo do ponteiro.
          if (ponteiro.ativo && mouse > 0) {
            const distancia = Math.hypot(x - ponteiro.x, y - ponteiro.y);
            if (distancia < raioPonteiro) {
              const queda = Math.cos((distancia / raioPonteiro) * Math.PI * 0.5) ** 2;
              realce += queda * mouse;
            }
          }

          realce = Math.min(1.6, realce);

          const radius = dotSize * (0.45 + nivel * 0.55 + realce * 0.9);
          if (radius <= 0.1) continue;

          const [r, g, b] = sampleRamp(ramp, Math.min(1, nivel * 0.55 + realce * 0.55));
          const alpha = (0.16 + nivel * 0.46 + realce * 0.5) * opacity;

          ctx.fillStyle = `rgba(${r | 0}, ${g | 0}, ${b | 0}, ${alpha.toFixed(3)})`;
          ctx.beginPath();
          ctx.arc(x, y, radius, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    };

    const inicio = performance.now();
    const loop = (agora: number): void => {
      if (!running) return;
      if (visible) draw((agora - inicio) / 1000);
      frame = requestAnimationFrame(loop);
    };

    resize();

    if (reduceMotion) {
      // Quadro unico: a textura continua ali, o movimento nao.
      draw(0);
    } else {
      frame = requestAnimationFrame(loop);
    }

    const onPointerMove = (event: PointerEvent): void => {
      const rect = canvas.getBoundingClientRect();
      ponteiro.x = event.clientX - rect.left;
      ponteiro.y = event.clientY - rect.top;
      ponteiro.ativo = true;
    };
    const onPointerLeave = (): void => {
      ponteiro.ativo = false;
    };
    const onVisibility = (): void => {
      visible = document.visibilityState === 'visible';
    };

    const resizeObserver = new ResizeObserver(() => {
      resize();
      if (reduceMotion) draw(0);
    });
    if (canvas.parentElement) resizeObserver.observe(canvas.parentElement);

    // Fora da tela, nao ha o que animar.
    const intersectionObserver = new IntersectionObserver(
      ([entry]) => {
        visible = Boolean(entry?.isIntersecting) && document.visibilityState === 'visible';
      },
      { threshold: 0 },
    );
    intersectionObserver.observe(canvas);

    if (mouse > 0 && !reduceMotion) {
      window.addEventListener('pointermove', onPointerMove, { passive: true });
      window.addEventListener('pointerleave', onPointerLeave, { passive: true });
    }
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      running = false;
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerleave', onPointerLeave);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [colors, spacing, dotSize, waveScale, waveSpeed, angle, mouse, pulse, pulseInterval, opacity]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      // Decorativo: fora da ordem de leitura e sem interceptar clique.
      aria-hidden="true"
      style={{ pointerEvents: 'none', display: 'block' }}
    />
  );
}
