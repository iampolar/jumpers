/**
 * Paleta de series dos graficos.
 *
 * NAO e a paleta da marca, e a diferenca e deliberada. O Ciano Tech #00D1FF e
 * claro demais para conviver com outras series: numa mesma faixa de
 * luminosidade ele domina, e fora dela quebra a regra de que series
 * categoricas devem ter peso visual equivalente. Marca e identidade; paleta de
 * dados e leitura.
 *
 * Estes quatro valores passam os seis checks em TODOS os pares, contra a
 * superficie escura #0E1A2E -- o primeiro deles e da familia do ciano, para
 * que a serie principal ainda pertenca a identidade:
 *
 *   Lightness band    4/4 dentro de L 0.48-0.67
 *   Chroma floor      4/4 >= 0.10
 *   CVD separation    pior par DeltaE 9.3 (deutan) / 8.7 (tritan)
 *   Normal vision     pior par DeltaE 15.2
 *   Contraste         4/4 >= 3:1
 *
 * Para reproduzir, a partir da pasta da skill dataviz:
 *   node scripts/validate_palette.js \
 *     "#13A4B8,#C77F14,#7357F5,#D44F66" --mode dark --surface "#0E1A2E" --pairs all
 *
 * Verde ficou de fora de proposito: ele e cor de STATUS (sucesso) e cores de
 * status nao viram "serie 4". Reusa-lo criaria ambiguidade entre "esta serie"
 * e "esta tudo bem", alem de colidir com rosa sob deuteranopia.
 */

/** Ordem FIXA. Uma serie nova recebe o proximo slot, nunca uma cor sorteada. */
export const SERIES_COLORS = ['#13A4B8', '#C77F14', '#7357F5', '#D44F66'] as const;

export type SeriesColor = (typeof SERIES_COLORS)[number];

/**
 * Cor por identidade da serie, nao por posicao na lista.
 *
 * Filtrar de 4 series para 2 nao pode repintar as sobreviventes: o leitor
 * perderia a correspondencia que acabou de construir.
 */
const SERIES_SLOTS: Record<string, number> = {
  completed: 0,
  music: 0,
  started: 1,
  promo_spot: 1,
  skipped: 2,
  operational_notice: 2,
  failed: 3,
  jingle: 3,
};

export function colorForSeries(key: string): string {
  const slot = SERIES_SLOTS[key];
  return SERIES_COLORS[slot ?? 0]!;
}

/** Status: reservadas, sempre com rotulo ou icone junto -- nunca so cor. */
export const STATUS_COLORS = {
  good: '#3FA98A',
  warning: '#D8A84E',
  critical: '#D96A6A',
  neutral: '#8495A7',
} as const;

export const SERIES_LABELS_PT: Record<string, string> = {
  completed: 'Concluidas',
  started: 'Iniciadas',
  failed: 'Falhas',
  skipped: 'Puladas',
  music: 'Musica',
  promo_spot: 'Spot promocional',
  operational_notice: 'Aviso operacional',
  jingle: 'Jingle',
};
