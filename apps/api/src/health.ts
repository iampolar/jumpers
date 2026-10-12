import { access, constants } from 'node:fs/promises';
import { DomainError, type HealthReport, type IntegrationStatus } from '@castwave/contracts';
import { pingDatabase, type SqlClient } from '@castwave/db';
import type { AppConfig } from '@castwave/runtime';

/**
 * Saude e estado das integracoes.
 *
 * Distincao que importa na pratica:
 *  - **liveness**: o processo esta vivo? Se responder, nao reinicie.
 *  - **readiness**: da para mandar trafego? Depende de Postgres e storage.
 *
 * Dependencia OPCIONAL (FFmpeg, SMTP, IA, gateway) degrada o relatorio mas
 * nao derruba o readiness: um orquestrador nao pode tirar a API do ar porque
 * o lojista ainda nao conectou um provedor de voz.
 */

export interface HealthDeps {
  readonly db: SqlClient;
  readonly config: AppConfig;
  readonly startedAt: number;
  readonly version: string;
  readonly storagePing: () => Promise<boolean>;
}

type CheckStatus = 'ok' | 'degraded' | 'down';

interface Check {
  readonly name: string;
  readonly status: CheckStatus;
  readonly latencyMs: number | null;
  readonly detail: string | null;
  readonly required: boolean;
}

async function checkFfprobe(config: AppConfig): Promise<Check> {
  if (!config.FFPROBE_PATH) {
    return {
      name: 'ffprobe',
      status: 'degraded',
      latencyMs: null,
      // Honestidade: dizemos o que perdemos, nao fingimos que esta tudo bem.
      detail: 'Nao configurado. A duracao e lida pela sonda nativa; nao ha medicao de loudness.',
      required: false,
    };
  }
  const started = performance.now();
  try {
    await access(config.FFPROBE_PATH, constants.X_OK);
    return {
      name: 'ffprobe',
      status: 'ok',
      latencyMs: Math.round(performance.now() - started),
      detail: null,
      required: false,
    };
  } catch {
    return {
      name: 'ffprobe',
      status: 'down',
      latencyMs: null,
      detail: 'FFPROBE_PATH aponta para um executavel inacessivel.',
      required: false,
    };
  }
}

export async function buildHealthReport(deps: HealthDeps): Promise<HealthReport> {
  const { db, config } = deps;

  const dbPing = await pingDatabase(db);
  const checks: Check[] = [
    {
      name: 'postgres',
      status: dbPing.ok ? 'ok' : 'down',
      latencyMs: dbPing.latencyMs,
      detail: dbPing.ok ? null : 'Banco inacessivel.',
      required: true,
    },
  ];

  const storageStarted = performance.now();
  const storageOk = await deps.storagePing().catch(() => false);
  checks.push({
    name: `storage:${config.STORAGE_DRIVER}`,
    status: storageOk ? 'ok' : 'down',
    latencyMs: Math.round(performance.now() - storageStarted),
    detail: storageOk ? null : 'Storage de audio inacessivel para escrita.',
    required: true,
  });

  checks.push(await checkFfprobe(config));

  checks.push({
    name: 'email',
    status: config.SMTP_URL ? 'ok' : 'degraded',
    latencyMs: null,
    detail: config.SMTP_URL ? null : 'SMTP nao configurado. Notificacoes ficam apenas dentro do app.',
    required: false,
  });

  const requiredDown = checks.some((c) => c.required && c.status === 'down');
  const anyDegraded = checks.some((c) => c.status !== 'ok');

  return {
    status: requiredDown ? 'down' : anyDegraded ? 'degraded' : 'ok',
    version: deps.version,
    uptimeSeconds: Math.floor((Date.now() - deps.startedAt) / 1000),
    checks,
  };
}

/** Lanca 503 quando uma dependencia obrigatoria esta fora. */
export function assertReady(report: HealthReport): void {
  if (report.status === 'down') {
    const broken = report.checks.filter((c) => c.required && c.status === 'down').map((c) => c.name);
    throw new DomainError('dependency_unavailable', 'Servico temporariamente indisponivel.', {
      logContext: { broken },
    });
  }
}

/**
 * Estado das integracoes para a UI.
 *
 * Nunca expoe valor de variavel de ambiente: diz apenas *se* esta configurado,
 * qual driver esta ativo e o que fica indisponivel enquanto nao estiver.
 */
export function describeIntegrations(config: AppConfig): IntegrationStatus[] {
  return [
    {
      key: 'ai_copy',
      label: 'Geracao de roteiro por IA',
      state: config.AI_COPY_PROVIDER === 'disabled' ? 'not_configured' : 'configured',
      driver: config.AI_COPY_PROVIDER,
      message:
        config.AI_COPY_PROVIDER === 'disabled'
          ? 'Nenhum provedor conectado. Escreva o roteiro manualmente ou use um modelo pronto.'
          : `Provedor ativo: ${config.AI_COPY_PROVIDER}.`,
      action:
        config.AI_COPY_PROVIDER === 'disabled'
          ? 'Configure AI_COPY_PROVIDER e a credencial do fornecedor escolhido.'
          : null,
      disabledFeatures: config.AI_COPY_PROVIDER === 'disabled' ? ['Botao "Gerar roteiro com IA"'] : [],
    },
    {
      key: 'ai_tts',
      label: 'Locucao sintetizada',
      state: config.AI_TTS_PROVIDER === 'disabled' ? 'not_configured' : 'configured',
      driver: config.AI_TTS_PROVIDER,
      message:
        config.AI_TTS_PROVIDER === 'disabled'
          ? 'Nenhum provedor de voz conectado. Envie o audio gravado pela biblioteca.'
          : `Provedor ativo: ${config.AI_TTS_PROVIDER}.`,
      action:
        config.AI_TTS_PROVIDER === 'disabled'
          ? 'Configure AI_TTS_PROVIDER e a credencial do fornecedor escolhido.'
          : null,
      disabledFeatures: config.AI_TTS_PROVIDER === 'disabled' ? ['Botao "Gerar locucao"', 'Catalogo de vozes'] : [],
    },
    {
      key: 'payments',
      label: 'Gateway de pagamento',
      state: config.PAYMENTS_PROVIDER === 'disabled' ? 'not_configured' : 'configured',
      driver: config.PAYMENTS_PROVIDER,
      message:
        config.PAYMENTS_PROVIDER === 'disabled'
          ? 'Nenhum gateway conectado. Planos, limites e consumo seguem funcionando; nao ha cobranca.'
          : `Gateway ativo: ${config.PAYMENTS_PROVIDER}.`,
      action:
        config.PAYMENTS_PROVIDER === 'disabled'
          ? 'Escolha um gateway, implemente o adapter e configure PAYMENTS_PROVIDER.'
          : null,
      disabledFeatures: config.PAYMENTS_PROVIDER === 'disabled' ? ['Checkout', 'Troca de plano pelo painel'] : [],
    },
    {
      key: 'email',
      label: 'Envio de e-mail',
      state: config.SMTP_URL ? 'configured' : 'not_configured',
      driver: config.SMTP_URL ? 'smtp' : 'none',
      message: config.SMTP_URL
        ? 'SMTP configurado.'
        : 'Sem SMTP. Convites e alertas ficam na central de notificacoes do app.',
      action: config.SMTP_URL ? null : 'Defina SMTP_URL para habilitar envio externo.',
      disabledFeatures: config.SMTP_URL ? [] : ['Convite por e-mail', 'Alerta de player offline por e-mail'],
    },
    {
      key: 'storage',
      label: 'Armazenamento de audio',
      state: 'configured',
      driver: config.STORAGE_DRIVER,
      message:
        config.STORAGE_DRIVER === 'local'
          ? 'Disco local. Adequado para desenvolvimento; use S3 em producao.'
          : 'Bucket S3 configurado.',
      action: null,
      disabledFeatures: [],
    },
    {
      key: 'ffmpeg',
      label: 'Processamento de audio',
      state: config.FFPROBE_PATH ? 'configured' : 'degraded',
      driver: config.FFPROBE_PATH ? 'ffprobe' : 'native-header',
      message: config.FFPROBE_PATH
        ? 'FFmpeg disponivel: duracao exata e normalizacao de volume.'
        : 'Sem FFmpeg. A duracao e lida do cabecalho do arquivo; nao ha normalizacao de volume.',
      action: config.FFPROBE_PATH ? null : 'Instale o FFmpeg e defina FFPROBE_PATH e FFMPEG_PATH.',
      disabledFeatures: config.FFPROBE_PATH ? [] : ['Normalizacao de volume', 'Medicao de loudness (LUFS)'],
    },
  ];
}
