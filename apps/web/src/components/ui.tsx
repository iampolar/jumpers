'use client';

import { clsx } from 'clsx';
import { AlertTriangle, Check, Info, Loader2, X } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { twMerge } from 'tailwind-merge';

/**
 * Kit de interface.
 *
 * Construido a mao, sem biblioteca de componentes, por tres motivos:
 * controle total do foco e do contraste (meta WCAG 2.2 AA), superficie de
 * dependencia menor, e porque o produto tem poucas formas repetidas -- nao
 * compensa carregar um design system inteiro para usar 10% dele.
 *
 * Regra que atravessa tudo aqui: **estado nunca e comunicado so por cor**.
 * Todo badge, alerta e indicador carrega texto ou icone junto.
 */

export const cn = (...classes: Parameters<typeof clsx>): string => twMerge(clsx(...classes));

// --------------------------------------------------------------------------
// Botao
// --------------------------------------------------------------------------

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

interface ButtonProps extends Omit<ComponentProps<'button'>, 'className'> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  loading?: boolean;
  /**
   * Motivo de o botao estar desabilitado. Vira `title` e texto para leitor de
   * tela -- um botao cinza sem explicacao e a reclamacao numero um de
   * qualquer painel B2B.
   */
  disabledReason?: string | null;
  icon?: ReactNode;
  className?: string;
}

/**
 * Uma acao primaria por tela.
 *
 * A primaria e a unica que ganha LUZ: alem do preenchimento turquesa, um halo
 * da propria cor da marca que so acende no hover. E o mesmo vocabulario do
 * fundo -- a interface toda ilumina em turquesa -- aplicado ao unico elemento
 * que deve puxar o clique. A secundaria e translucida como o cartao, para
 * pertencer a mesma superficie de vidro em vez de parecer colada por cima.
 */
const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-cyan text-ink hover:bg-cyan/90 active:bg-cyan/80 font-medium ' +
    'shadow-[0_1px_0_0_rgba(255,255,255,0.08)_inset] ' +
    'hover:shadow-[0_1px_0_0_rgba(255,255,255,0.08)_inset,0_0_20px_-4px_var(--color-cyan)]',
  secondary:
    'bg-elevated/70 text-text border border-line backdrop-blur-sm hover:border-cyan/40 hover:bg-elevated',
  ghost: 'text-muted hover:text-text hover:bg-elevated/60',
  danger: 'bg-danger/10 text-danger border border-danger/25 hover:bg-danger/20',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  disabledReason,
  icon,
  children,
  disabled,
  className,
  ...rest
}: ButtonProps) {
  const isDisabled = disabled || loading || Boolean(disabledReason);
  return (
    <button
      type="button"
      disabled={isDisabled}
      title={disabledReason ?? undefined}
      aria-disabled={isDisabled}
      className={cn(
        // Cor E sombra na mesma duracao: o halo da primaria tem que acender
        // junto com o preenchimento, nunca depois dele.
        'inline-flex items-center justify-center gap-2 rounded-lg',
        'transition-[color,background-color,border-color,box-shadow] duration-[var(--motion-base)] ease-[var(--ease-out)]',
        'disabled:cursor-not-allowed disabled:opacity-45',
        size === 'sm' ? 'h-8 px-3 text-[13px]' : 'h-9 px-4 text-sm',
        BUTTON_VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 size={15} className="animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
}

// --------------------------------------------------------------------------
// Campos
// --------------------------------------------------------------------------

interface FieldProps {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string | null;
  required?: boolean;
  children: ReactNode;
}

export function Field({ label, htmlFor, hint, error, required, children }: FieldProps) {
  return (
    <div className="space-y-1.5">
      {/* Label real, associada por `for`: leitor de tela e clique no texto. */}
      <label htmlFor={htmlFor} className="block text-[13px] font-medium text-text">
        {label}
        {required && <span className="ml-1 text-danger">*</span>}
      </label>
      {children}
      {error ? (
        <p className="flex items-start gap-1.5 text-[12px] text-danger" role="alert">
          <AlertTriangle size={13} className="mt-px shrink-0" aria-hidden />
          {error}
        </p>
      ) : hint ? (
        <p className="text-[12px] text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

const CONTROL_BASE =
  'w-full rounded-lg border bg-ink/60 px-3 text-sm text-text placeholder:text-muted/50 ' +
  'transition-colors focus:border-cyan/60 disabled:cursor-not-allowed disabled:opacity-50';

export function Input({ className, invalid, ...rest }: ComponentProps<'input'> & { invalid?: boolean }) {
  return (
    <input
      className={cn(CONTROL_BASE, 'h-9', invalid ? 'border-danger/60' : 'border-line', className)}
      aria-invalid={invalid}
      {...rest}
    />
  );
}

export function Textarea({ className, invalid, ...rest }: ComponentProps<'textarea'> & { invalid?: boolean }) {
  return (
    <textarea
      className={cn(CONTROL_BASE, 'min-h-24 py-2 leading-relaxed', invalid ? 'border-danger/60' : 'border-line', className)}
      aria-invalid={invalid}
      {...rest}
    />
  );
}

export function Select({ className, children, ...rest }: ComponentProps<'select'>) {
  return (
    <select className={cn(CONTROL_BASE, 'h-9 border-line pr-8', className)} {...rest}>
      {children}
    </select>
  );
}

// --------------------------------------------------------------------------
// Superficies
// --------------------------------------------------------------------------

/**
 * Superficie elevada do console.
 *
 * Translucida de proposito, com desfoque e sombra -- exatamente o tratamento
 * do cartao da tela de entrada. Um cartao opaco corta o fundo em retangulos e
 * o painel passa a parecer outro produto; deixando a atmosfera atravessar a
 * 20%, a malha e a aurora continuam legiveis ATRAS do conteudo e as duas telas
 * leem como o mesmo sistema. A sombra e o que mantem a hierarquia: sem ela, a
 * superficie translucida se dissolveria no fundo em vez de flutuar sobre ele.
 */
export function Card({ className, children, ...rest }: ComponentProps<'section'>) {
  return (
    <section
      className={cn(
        'rounded-xl border border-line/70 bg-surface/80 shadow-xl shadow-ink/40 backdrop-blur-xl',
        className,
      )}
      {...rest}
    >
      {children}
    </section>
  );
}

export function CardHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <header className="flex items-start justify-between gap-4 border-b border-line/70 px-5 py-4">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold tracking-tight text-text">{title}</h2>
        {description && <p className="mt-1 text-[13px] leading-relaxed text-muted">{description}</p>}
      </div>
      {action}
    </header>
  );
}

// --------------------------------------------------------------------------
// Estado
// --------------------------------------------------------------------------

type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: 'bg-muted/10 text-muted border-muted/20',
  success: 'bg-success/10 text-success border-success/25',
  warning: 'bg-warning/10 text-warning border-warning/25',
  danger: 'bg-danger/10 text-danger border-danger/25',
  info: 'bg-cyan/10 text-cyan-soft border-cyan/25',
};

/** O texto do badge JA diz o estado; a cor so reforca. */
export function Badge({
  tone = 'neutral',
  children,
  className,
}: {
  tone?: BadgeTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap',
        BADGE_TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Ponto de status SEMPRE acompanhado do rotulo textual. */
export function StatusDot({ tone, label }: { tone: BadgeTone; label: string }) {
  const color = {
    neutral: 'bg-muted',
    success: 'bg-success',
    warning: 'bg-warning',
    danger: 'bg-danger',
    info: 'bg-cyan',
  }[tone];
  return (
    <span className="inline-flex items-center gap-1.5 text-[13px] text-muted">
      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', color)} aria-hidden />
      {label}
    </span>
  );
}

export function Alert({
  tone = 'info',
  title,
  children,
  action,
}: {
  tone?: 'info' | 'warning' | 'danger' | 'success';
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  const styles = {
    info: { box: 'border-cyan/25 bg-cyan/5', text: 'text-cyan-soft', Icon: Info },
    warning: { box: 'border-warning/25 bg-warning/5', text: 'text-warning', Icon: AlertTriangle },
    danger: { box: 'border-danger/25 bg-danger/5', text: 'text-danger', Icon: AlertTriangle },
    success: { box: 'border-success/25 bg-success/5', text: 'text-success', Icon: Check },
  }[tone];

  return (
    <div className={cn('rounded-xl border p-4', styles.box)} role={tone === 'danger' ? 'alert' : 'status'}>
      <div className="flex gap-3">
        <styles.Icon size={16} className={cn('mt-0.5 shrink-0', styles.text)} aria-hidden />
        <div className="min-w-0 flex-1">
          <p className={cn('text-[13px] font-medium', styles.text)}>{title}</p>
          {children && <div className="mt-1 text-[13px] leading-relaxed text-muted">{children}</div>}
          {action && <div className="mt-3">{action}</div>}
        </div>
      </div>
    </div>
  );
}

/**
 * Estado vazio com proxima acao.
 *
 * Uma tabela vazia sem instrucao e um beco sem saida: o usuario nao sabe se
 * esta carregando, se filtrou errado ou se precisa criar algo.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      {/*
        Medalhao em vez de icone solto. Um glifo a 40% de opacidade no meio do
        vazio le como conteudo que FALHOU em carregar; dentro de um circulo com
        borda, le como um estado previsto pelo produto.
      */}
      {icon && (
        <div
          className="mb-4 flex size-12 items-center justify-center rounded-full border border-line bg-elevated/50 text-cyan-soft"
          aria-hidden
        >
          {icon}
        </div>
      )}
      <h3 className="text-sm font-medium text-text">{title}</h3>
      <p className="mt-1.5 max-w-sm text-[13px] leading-relaxed text-muted">{description}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-elevated', className)} aria-hidden />;
}

export function Spinner({ label = 'Carregando' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-muted">
      <Loader2 size={15} className="animate-spin" aria-hidden />
      <span role="status">{label}...</span>
    </div>
  );
}

// --------------------------------------------------------------------------
// Tabela
// --------------------------------------------------------------------------

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className="overflow-x-auto">
      <table className={cn('w-full border-collapse text-left text-[13px]', className)}>{children}</table>
    </div>
  );
}

export function Th({ children, numeric, className }: { children?: ReactNode; numeric?: boolean; className?: string }) {
  return (
    <th
      scope="col"
      className={cn(
        'border-b border-line/70 px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-muted',
        numeric && 'text-right',
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Td({ children, numeric, className }: { children: ReactNode; numeric?: boolean; className?: string }) {
  return (
    <td
      className={cn(
        'border-b border-line/40 px-4 py-3 align-middle text-text',
        // Numero em tabela alinha pela coluna, nao pela largura do glifo.
        numeric && 'text-right tabular',
        className,
      )}
    >
      {children}
    </td>
  );
}

// --------------------------------------------------------------------------
// Dialogo
// --------------------------------------------------------------------------

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/80 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <div className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-xl border border-line bg-surface shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-line/70 px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-text">{title}</h2>
            {description && <p className="mt-1 text-[13px] text-muted">{description}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar"
            className="rounded-md p-1 text-muted transition-colors hover:bg-elevated hover:text-text"
          >
            <X size={16} aria-hidden />
          </button>
        </header>
        <div className="px-5 py-4">{children}</div>
        {footer && <footer className="flex justify-end gap-2 border-t border-line/70 px-5 py-4">{footer}</footer>}
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------
// Formatadores
// --------------------------------------------------------------------------

export const fmtInt = new Intl.NumberFormat('pt-BR');

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

/** "ha 3 min". Tempo relativo e mais legivel que carimbo em painel de operacao. */
export function formatRelative(iso: string | null): string {
  if (!iso) return 'nunca';
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'agora';
  if (seconds < 3600) return `ha ${Math.floor(seconds / 60)} min`;
  if (seconds < 86_400) return `ha ${Math.floor(seconds / 3600)} h`;
  return `ha ${Math.floor(seconds / 86_400)} d`;
}

/**
 * Le um campo de formulario como texto.
 *
 * `FormData.get` devolve `string | File`: passar o resultado direto para
 * `String()` transforma um upload em "[object File]" silenciosamente. Este
 * helper estreita o tipo e deixa o caso de arquivo explicito.
 */
export function fieldText(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}
