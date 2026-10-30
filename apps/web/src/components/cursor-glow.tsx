'use client';

import { useEffect } from 'react';

/**
 * Luz ambiente que acompanha o ponteiro.
 *
 * Duas camadas sobrepostas -- um nucleo difuso e um halo largo de opacidade
 * baixa -- desenhadas com `radial-gradient`. Nada de circulo de borda dura:
 * a transicao para o fundo e continua, e o que se percebe e iluminacao do
 * ambiente, nao um ponteiro customizado.
 *
 * **Por que variaveis CSS e nao estado do React.** O ponteiro dispara dezenas
 * de eventos por segundo. Guardar a posicao em `useState` re-renderizaria a
 * arvore inteira a cada movimento -- com tabelas e graficos na tela, isso
 * derruba o quadro. Aqui o movimento escreve duas variaveis CSS no elemento
 * raiz e o compositor do navegador faz o resto; o React nao re-renderiza uma
 * unica vez.
 *
 * **Suavizacao.** A posicao e interpolada por quadro (lerp), nao aplicada
 * direto: o halo persegue o cursor com inercia, o que le como luz com massa
 * em vez de adesivo grudado no ponteiro. O laco so roda enquanto ha distancia
 * a percorrer -- ponteiro parado nao consome quadro.
 *
 * **Toque.** Dispositivos sem ponteiro fino nao recebem o efeito: simular um
 * cursor que nao existe seria ruido, e e custo de bateria num tablet de loja.
 */

export interface CursorGlowProps {
  /** Intensidade geral, 0 a 1. Multiplica a opacidade das duas camadas. */
  strength?: number;
  /** Quanto o halo persegue o cursor por quadro. Menor = mais inercia. */
  easing?: number;
}

export function CursorGlow({ strength = 1, easing = 0.16 }: CursorGlowProps) {
  useEffect(() => {
    // Sem ponteiro fino (toque), o efeito nao se aplica.
    if (!window.matchMedia('(pointer: fine)').matches) return;

    const raiz = document.documentElement;
    const alvo = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    const atual = { ...alvo };
    let frame = 0;
    let rodando = false;

    const aplicar = (): void => {
      raiz.style.setProperty('--cursor-x', `${atual.x.toFixed(1)}px`);
      raiz.style.setProperty('--cursor-y', `${atual.y.toFixed(1)}px`);
    };

    const passo = (): void => {
      const dx = alvo.x - atual.x;
      const dy = alvo.y - atual.y;
      atual.x += dx * easing;
      atual.y += dy * easing;
      aplicar();

      // Parou de se mover: encerra o laco em vez de girar em vazio.
      if (Math.abs(dx) < 0.4 && Math.abs(dy) < 0.4) {
        rodando = false;
        return;
      }
      frame = requestAnimationFrame(passo);
    };

    const onMove = (event: PointerEvent): void => {
      alvo.x = event.clientX;
      alvo.y = event.clientY;
      raiz.style.setProperty('--cursor-presence', String(strength));
      if (!rodando) {
        rodando = true;
        frame = requestAnimationFrame(passo);
      }
    };

    const onLeave = (): void => {
      // Some com transicao; a posicao fica onde parou.
      raiz.style.setProperty('--cursor-presence', '0');
    };

    window.addEventListener('pointermove', onMove, { passive: true });
    document.addEventListener('pointerleave', onLeave);
    window.addEventListener('blur', onLeave);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('blur', onLeave);
      raiz.style.setProperty('--cursor-presence', '0');
    };
  }, [strength, easing]);

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 -z-10 overflow-hidden"
      style={{ contain: 'strict' }}
    >
      {/*
        UMA camada so, larga e fraca.

        Antes eram duas: um halo largo e um nucleo concentrado com o centro
        queimando para branco. O nucleo era o erro. Qualquer gradiente radial
        com centro quente le como LANTERNA -- um disco de luz colado no
        ponteiro --, e baixar a opacidade so produz uma lanterna fraca, porque
        o problema nunca foi a intensidade e sim a forma.

        O que responde ao ponteiro de verdade e a malha: `mouse` acende os
        PONTOS ao redor do cursor, que e como o efeito de referencia sempre
        funcionou. Esta camada nao desenha a luz, ela so tinge o ar em volta --
        pico baixo, raio enorme e queda continua ate zero, sem patamar e sem
        borda. Se ela aparecer como um circulo, esta errada.
      */}
      <div
        className="absolute inset-0 transition-opacity duration-500"
        style={{
          opacity: 'calc(var(--cursor-presence) * var(--glow-strength))',
          background:
            'radial-gradient(var(--glow-halo) circle at var(--cursor-x) var(--cursor-y), ' +
            'color-mix(in oklab, var(--color-cyan) 13%, transparent) 0%, ' +
            'color-mix(in oklab, var(--color-cyan) 9%, transparent) 26%, ' +
            'color-mix(in oklab, var(--color-cyan) 5%, transparent) 48%, ' +
            'color-mix(in oklab, var(--color-cyan) 2%, transparent) 70%, ' +
            'transparent 100%)',
        }}
      />
    </div>
  );
}
