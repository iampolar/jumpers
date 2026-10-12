import { createHash } from 'node:crypto';
import type { AnnouncementTemplate } from '@castwave/contracts';

/**
 * Estimativa de duracao de locucao em pt-BR.
 *
 * Locutor comercial brasileiro fica entre 150 e 170 palavras por minuto; 160 e
 * a mediana pratica. Numeros e siglas sao lidos por extenso e custam mais: "R$
 * 19,90" leva ~1,6 s, nao os 0,4 s que uma contagem ingenua de palavras daria.
 * A estimativa serve para avisar o lojista *antes* de gravar que o spot vai
 * estourar o intervalo -- nunca e apresentada como duracao real. Assim que
 * existe audio, a duracao medida substitui a estimativa.
 */

const WORDS_PER_MINUTE = 160;
const MS_PER_WORD = 60_000 / WORDS_PER_MINUTE;
/** Pausa natural em pontuacao forte. */
const PAUSE_MS = 280;

export function estimateScriptDurationMs(script: string): number {
  const text = script.trim();
  if (!text) return 0;

  const tokens = text.split(/\s+/);
  let ms = 0;

  for (const token of tokens) {
    const digits = (token.match(/\d/g) ?? []).length;
    if (digits > 0) {
      // Cada digito vira uma silaba falada ("dezenove", "noventa").
      ms += MS_PER_WORD * (0.6 + digits * 0.45);
      continue;
    }
    // Sigla em caixa alta e soletrada.
    if (token.length >= 2 && token === token.toUpperCase() && /^[A-ZÁÉÍÓÚÂÊÔÃÕÇ]+$/.test(token)) {
      ms += MS_PER_WORD * token.length * 0.5;
      continue;
    }
    ms += MS_PER_WORD;
  }

  const pauses = (text.match(/[.,;:!?]/g) ?? []).length;
  return Math.round(ms + pauses * PAUSE_MS);
}

export function countWords(script: string): number {
  const t = script.trim();
  return t ? t.split(/\s+/).length : 0;
}

/**
 * Hash do conteudo publicado. Prova, numa auditoria, que a versao aprovada e
 * exatamente a que foi ao ar -- texto, dicionario de pronuncia e audio.
 */
export function contentHash(input: {
  scriptText: string;
  mediaAssetId: string | null;
  pronunciationDictionary: readonly { term: string; pronunciation: string }[];
}): string {
  const canonical = JSON.stringify({
    s: input.scriptText.trim(),
    m: input.mediaAssetId,
    p: [...input.pronunciationDictionary]
      .map((e) => [e.term.trim(), e.pronunciation.trim()])
      .sort((a, b) => (a[0]! < b[0]! ? -1 : 1)),
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** Aplica `{{placeholders}}`. Chave ausente permanece visivel, nao vira vazio. */
export function renderTemplate(body: string, values: Readonly<Record<string, string>>): string {
  return body.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key: string) => values[key] ?? match);
}

/**
 * Modelos prontos. Existem para que o produto seja util no primeiro minuto,
 * sem IA: o lojista preenche tres campos e tem um roteiro publicavel.
 */
export const ANNOUNCEMENT_TEMPLATES: readonly AnnouncementTemplate[] = [
  {
    id: 'oferta-do-dia',
    name: 'Oferta do dia',
    type: 'promo_spot',
    description: 'Desconto com validade curta. Fecha com chamada para acao.',
    body: 'Atencao, clientes {{loja}}! Hoje, {{produto}} por apenas {{preco}}. {{condicao}} Aproveite enquanto durar o estoque.',
    fields: [
      { key: 'loja', label: 'Nome da loja', example: 'Supermercado Aurora' },
      { key: 'produto', label: 'Produto em oferta', example: 'cafe torrado 500g' },
      { key: 'preco', label: 'Preco', example: 'R$ 19,90' },
      { key: 'condicao', label: 'Condicao', example: 'Limite de 3 unidades por cliente.' },
    ],
  },
  {
    id: 'leve-mais-pague-menos',
    name: 'Leve mais, pague menos',
    type: 'promo_spot',
    description: 'Promocao por volume, com enfase na economia.',
    body: 'Promocao {{loja}}: na compra de {{quantidade}} unidades de {{produto}}, voce paga {{preco}}. Corredor {{setor}}.',
    fields: [
      { key: 'loja', label: 'Nome da loja', example: 'Aurora' },
      { key: 'quantidade', label: 'Quantidade', example: '3' },
      { key: 'produto', label: 'Produto', example: 'iogurte natural' },
      { key: 'preco', label: 'Preco total', example: 'R$ 10,00' },
      { key: 'setor', label: 'Setor', example: '4' },
    ],
  },
  {
    id: 'aviso-fechamento',
    name: 'Aviso de fechamento',
    type: 'operational_notice',
    description: 'Comunicado operacional de encerramento do expediente.',
    body: 'Senhores clientes, nossa loja encerra o atendimento em {{minutos}} minutos. Dirija-se aos caixas. Agradecemos a preferencia.',
    fields: [{ key: 'minutos', label: 'Minutos para o fechamento', example: '15' }],
  },
  {
    id: 'chamada-caixa',
    name: 'Abertura de caixa',
    type: 'operational_notice',
    description: 'Reduz fila direcionando o fluxo.',
    body: 'Caixa {{numero}} livre para atendimento. Caixa {{numero}}, por favor.',
    fields: [{ key: 'numero', label: 'Numero do caixa', example: '7' }],
  },
  {
    id: 'institucional-marca',
    name: 'Mensagem institucional',
    type: 'institutional',
    description: 'Reforco de marca entre blocos musicais.',
    body: '{{loja}}: {{posicionamento}}. Siga a gente em {{redes}}.',
    fields: [
      { key: 'loja', label: 'Nome da marca', example: 'Aurora' },
      { key: 'posicionamento', label: 'Posicionamento', example: 'perto de voce ha 30 anos' },
      { key: 'redes', label: 'Redes sociais', example: '@aurora' },
    ],
  },
  {
    id: 'crianca-perdida',
    name: 'Localizacao de acompanhante',
    type: 'operational_notice',
    description: 'Protocolo de seguranca. Sem dado pessoal no ar.',
    body: 'Solicitamos que o responsavel pela crianca {{nome}} compareca ao balcao de informacoes. Repetindo: balcao de informacoes.',
    fields: [{ key: 'nome', label: 'Primeiro nome', example: 'Helena' }],
  },
];
