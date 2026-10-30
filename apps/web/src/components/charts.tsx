'use client';

import { useId, useState } from 'react';
import { cn, fmtInt } from './ui';
import { colorForSeries, SERIES_LABELS_PT } from '@/lib/chart-palette';

/**
 * Graficos em SVG puro.
 *
 * Sem biblioteca: as formas aqui sao tres, e cada uma cabe em ~80 linhas com
 * controle total de acessibilidade. Uma dependencia de grafico traria 40 kB e
 * tiraria justamente o controle de foco, contraste e rotulo que importa.
 *
 * Regras seguidas (ver lib/chart-palette.ts para a validacao da paleta):
 *  - uma unica escala por eixo, nunca dois eixos y;
 *  - cor segue a IDENTIDADE da serie, nao a posicao na lista;
 *  - legenda sempre presente com 2+ series, e identidade nunca so por cor;
 *  - grade e eixos recessivos; marcas finas;
 *  - camada de hover por padrao;
 *  - tabela equivalente disponivel para leitor de tela.
 */

export interface SeriesPoint {
  readonly date: string;
  readonly [key: string]: string | number;
}

interface ChartProps {
  data: readonly SeriesPoint[];
  series: readonly string[];
  height?: number;
  /** Rotulo do eixo y, para quem le a tabela equivalente. */
  valueLabel?: string;
}

const PADDING = { top: 12, right: 12, bottom: 26, left: 40 };

function niceMax(value: number): number {
  if (value <= 5) return 5;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / magnitude) * magnitude;
}

const shortDate = (iso: string): string => {
  const [, m, d] = iso.split('-');
  return `${d}/${m}`;
};

/** Tabela equivalente: identidade e valor sem depender de cor nem de mouse. */
function DataTable({ data, series, valueLabel }: ChartProps) {
  return (
    <details className="mt-3">
      <summary className="cursor-pointer text-[12px] text-muted hover:text-text">
        Ver os dados em tabela
      </summary>
      <div className="mt-2 max-h-56 overflow-auto rounded-lg border border-line/60">
        <table className="w-full text-left text-[12px]">
          <caption className="sr-only">{valueLabel ?? 'Serie temporal'}</caption>
          <thead className="sticky top-0 bg-surface">
            <tr>
              <th scope="col" className="px-3 py-1.5 font-medium text-muted">Data</th>
              {series.map((s) => (
                <th key={s} scope="col" className="px-3 py-1.5 text-right font-medium text-muted">
                  {SERIES_LABELS_PT[s] ?? s}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.map((row) => (
              <tr key={row.date}>
                <th scope="row" className="px-3 py-1 font-normal text-muted">{shortDate(row.date)}</th>
                {series.map((s) => (
                  <td key={s} className="px-3 py-1 text-right tabular text-text">
                    {fmtInt.format(Number(row[s] ?? 0))}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

export function Legend({ series }: { series: readonly string[] }) {
  // Com uma unica serie o titulo ja a nomeia; caixa de legenda seria ruido.
  if (series.length < 2) return null;
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
      {series.map((s) => (
        <li key={s} className="flex items-center gap-1.5 text-[12px] text-muted">
          <span
            className="h-2 w-2 shrink-0 rounded-[2px]"
            style={{ background: colorForSeries(s) }}
            aria-hidden
          />
          {SERIES_LABELS_PT[s] ?? s}
        </li>
      ))}
    </ul>
  );
}

// --------------------------------------------------------------------------
// Linha com crosshair
// --------------------------------------------------------------------------

export function LineChart({ data, series, height = 220, valueLabel }: ChartProps) {
  const gradientId = useId();
  const [hover, setHover] = useState<number | null>(null);

  if (data.length === 0) {
    return <p className="py-10 text-center text-[13px] text-muted">Sem dados no periodo.</p>;
  }

  const width = 760;
  const plotW = width - PADDING.left - PADDING.right;
  const plotH = height - PADDING.top - PADDING.bottom;

  const max = niceMax(
    Math.max(1, ...data.flatMap((row) => series.map((s) => Number(row[s] ?? 0)))),
  );
  const x = (i: number) => PADDING.left + (data.length === 1 ? plotW / 2 : (i / (data.length - 1)) * plotW);
  const y = (v: number) => PADDING.top + plotH - (v / max) * plotH;

  const ticks = [0, 0.5, 1].map((t) => Math.round(max * t));
  const hovered = hover !== null ? data[hover] : null;

  return (
    <figure className="m-0">
      <Legend series={series} />
      <div className="relative mt-3">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="w-full"
          style={{ height }}
          role="img"
          aria-label={`${valueLabel ?? 'Execucoes'} por dia`}
          onMouseLeave={() => setHover(null)}
        >
          <defs>
            {series.map((s) => (
              <linearGradient key={s} id={`${gradientId}-${s}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={colorForSeries(s)} stopOpacity="0.18" />
                <stop offset="100%" stopColor={colorForSeries(s)} stopOpacity="0" />
              </linearGradient>
            ))}
          </defs>

          {/* Grade recessiva: orienta sem competir com os dados. */}
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={PADDING.left}
                x2={width - PADDING.right}
                y1={y(t)}
                y2={y(t)}
                stroke="currentColor"
                className="text-line"
                strokeWidth="1"
              />
              <text
                x={PADDING.left - 8}
                y={y(t) + 3}
                textAnchor="end"
                className="fill-muted text-[10px] tabular"
              >
                {fmtInt.format(t)}
              </text>
            </g>
          ))}

          {series.map((s) => {
            const points = data.map((row, i) => [x(i), y(Number(row[s] ?? 0))] as const);
            const line = points.map(([px, py], i) => `${i === 0 ? 'M' : 'L'}${px},${py}`).join(' ');
            const area = `${line} L${points.at(-1)![0]},${y(0)} L${points[0]![0]},${y(0)} Z`;
            return (
              <g key={s}>
                <path d={area} fill={`url(#${gradientId}-${s})`} />
                {/* Marca fina: 2px e o peso que le bem sem engordar o grafico. */}
                <path
                  d={line}
                  fill="none"
                  stroke={colorForSeries(s)}
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </g>
            );
          })}

          {hover !== null && (
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={PADDING.top}
              y2={PADDING.top + plotH}
              stroke="currentColor"
              className="text-muted"
              strokeWidth="1"
              strokeDasharray="3 3"
            />
          )}

          {hover !== null &&
            series.map((s) => (
              <circle
                key={s}
                cx={x(hover)}
                cy={y(Number(data[hover]![s] ?? 0))}
                r="4"
                fill={colorForSeries(s)}
                // Anel na cor da superficie separa marcas sobrepostas.
                stroke="#0e1a2e"
                strokeWidth="2"
              />
            ))}

          {/* Alvos de hover maiores que as marcas. */}
          {data.map((row, i) => (
            <rect
              key={row.date}
              x={x(i) - plotW / Math.max(1, data.length) / 2}
              y={PADDING.top}
              width={plotW / Math.max(1, data.length)}
              height={plotH}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
            />
          ))}

          {data.map((row, i) =>
            i % Math.ceil(data.length / 7) === 0 ? (
              <text
                key={row.date}
                x={x(i)}
                y={height - 8}
                textAnchor="middle"
                className="fill-muted text-[10px] tabular"
              >
                {shortDate(row.date)}
              </text>
            ) : null,
          )}
        </svg>

        {hovered && (
          <div
            className="pointer-events-none absolute top-0 rounded-lg border border-line bg-elevated px-3 py-2 text-[12px] shadow-xl"
            style={{ left: `${(x(hover!) / width) * 100}%`, transform: 'translateX(-50%)' }}
          >
            <p className="mb-1 font-medium text-text">{shortDate(hovered.date)}</p>
            {series.map((s) => (
              <p key={s} className="flex items-center gap-2 text-muted">
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ background: colorForSeries(s) }}
                  aria-hidden
                />
                {SERIES_LABELS_PT[s] ?? s}
                <span className="ml-auto tabular text-text">{fmtInt.format(Number(hovered[s] ?? 0))}</span>
              </p>
            ))}
          </div>
        )}
      </div>
      <DataTable data={data} series={series} valueLabel={valueLabel} />
    </figure>
  );
}

// --------------------------------------------------------------------------
// Barras horizontais
// --------------------------------------------------------------------------

export function BarList({
  items,
  valueLabel = 'execucoes',
}: {
  items: readonly { label: string; value: number; sublabel?: string }[];
  valueLabel?: string;
}) {
  if (items.length === 0) {
    return <p className="py-8 text-center text-[13px] text-muted">Sem dados no periodo.</p>;
  }
  const max = Math.max(1, ...items.map((i) => i.value));

  return (
    <ul className="space-y-2.5">
      {items.map((item) => (
        <li key={item.label}>
          <div className="mb-1 flex items-baseline justify-between gap-3 text-[13px]">
            <span className="truncate text-text">{item.label}</span>
            {/* Rotulo direto: o numero fica legivel sem hover. */}
            <span className="shrink-0 tabular text-muted">
              {fmtInt.format(item.value)} <span className="text-muted/60">{valueLabel}</span>
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-elevated">
            <div
              className="h-full rounded-full"
              style={{ width: `${(item.value / max) * 100}%`, background: colorForSeries('completed') }}
            />
          </div>
          {item.sublabel && <p className="mt-1 text-[11px] text-muted/70">{item.sublabel}</p>}
        </li>
      ))}
    </ul>
  );
}

// --------------------------------------------------------------------------
// Numero de destaque
// --------------------------------------------------------------------------

export function StatTile({
  label,
  value,
  sublabel,
  tone = 'neutral',
  icon,
}: {
  label: string;
  value: string;
  sublabel?: string;
  tone?: 'neutral' | 'success' | 'warning' | 'danger';
  icon?: React.ReactNode;
}) {
  const accent = {
    neutral: 'text-text',
    success: 'text-success',
    warning: 'text-warning',
    danger: 'text-danger',
  }[tone];

  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[12px] text-muted">{label}</p>
        {icon && <span className="text-muted/40">{icon}</span>}
      </div>
      <p className={cn('mt-2 text-2xl font-semibold tracking-tight tabular', accent)}>{value}</p>
      {sublabel && <p className="mt-1 text-[12px] text-muted">{sublabel}</p>}
    </div>
  );
}

/** Medidor de cota. O numero acompanha a barra -- nunca so a barra. */
export function Meter({
  label,
  used,
  limit,
  format = (n: number) => fmtInt.format(n),
}: {
  label: string;
  used: number;
  limit: number | null;
  format?: (n: number) => string;
}) {
  const ratio = limit && limit > 0 ? Math.min(1, used / limit) : 0;
  const tone = ratio >= 1 ? 'bg-danger' : ratio >= 0.8 ? 'bg-warning' : 'bg-cyan';

  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-3 text-[13px]">
        <span className="text-text">{label}</span>
        <span className="tabular text-muted">
          {format(used)}
          {limit !== null && <span className="text-muted/60"> / {format(limit)}</span>}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-elevated">
        <div className={cn('h-full rounded-full transition-all', tone)} style={{ width: `${ratio * 100}%` }} />
      </div>
      {ratio >= 0.8 && (
        <p className={cn('mt-1 text-[11px]', ratio >= 1 ? 'text-danger' : 'text-warning')}>
          {ratio >= 1 ? 'Limite atingido.' : 'Perto do limite do plano.'}
        </p>
      )}
    </div>
  );
}
