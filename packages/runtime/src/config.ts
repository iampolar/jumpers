import { z } from 'zod';

/**
 * Configuracao da aplicacao.
 *
 * Unico ponto do codigo que le `process.env` (ha uma regra de ESLint que
 * recusa leituras de segredo fora daqui). O processo valida tudo na
 * inicializacao e morre com uma mensagem util se algo estiver faltando --
 * falhar no boot e infinitamente melhor que descobrir em producao, as tres da
 * manha, que `SESSION_SECRET` estava vazio e as sessoes nunca foram seguras.
 */

/** Segredo tem piso de entropia; em dev aceitamos um valor gerado na hora. */
const zSecret = z
  .string()
  .min(32, 'Use ao menos 32 caracteres. Gere com: openssl rand -base64 48');

const zBool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  HOST: z.string().default('127.0.0.1'),

  /**
   * `memory://`, `file://<caminho>` ou `postgres://...`
   * O padrao e um PGlite em disco: sobe sem Docker, sem servico, sem setup.
   */
  DATABASE_URL: z.string().default('file://./.data/castwave'),
  DATABASE_MAX_CONNECTIONS: z.coerce.number().int().min(1).max(100).default(10),
  DATABASE_SSL: zBool.default(false),

  /** Assina cookie de sessao. Rotacionar invalida todas as sessoes. */
  SESSION_SECRET: zSecret,
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(24 * 14),
  /** Assina URLs de audio. Separado do de sessao: comprometer um nao da o outro. */
  MEDIA_URL_SECRET: zSecret,
  MEDIA_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),

  /** Origem do painel. Usada no CORS e no cookie `SameSite`. */
  WEB_ORIGIN: z.string().default('http://localhost:3000'),

  /** `local` grava em disco; `s3` exige as variaveis S3_*. */
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_PATH: z.string().default('./.data/storage'),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),

  /** `inline` roda os jobs no proprio processo (dev); `postgres` usa a tabela. */
  QUEUE_DRIVER: z.enum(['inline', 'postgres']).default('postgres'),

  /**
   * Integracoes externas. O padrao e desligado em TODAS: o produto inteiro
   * funciona assim, e um provedor so entra quando o operador o configura.
   */
  AI_COPY_PROVIDER: z.enum(['disabled', 'mock']).default('disabled'),
  AI_TTS_PROVIDER: z.enum(['disabled', 'mock']).default('disabled'),
  PAYMENTS_PROVIDER: z.enum(['disabled', 'fake']).default('disabled'),
  SMTP_URL: z.string().optional(),

  /** Caminho do ffprobe. Ausente = sonda nativa e readiness degradada. */
  FFPROBE_PATH: z.string().optional(),
  FFMPEG_PATH: z.string().optional(),

  /** Segundos sem heartbeat ate um player ser considerado offline. */
  DEVICE_OFFLINE_AFTER_SECONDS: z.coerce.number().int().min(30).max(3600).default(180),

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  RATE_LIMIT_ENABLED: zBool.default(true),
});

export type AppConfig = Readonly<z.infer<typeof schema>> & {
  readonly isProduction: boolean;
  readonly isTest: boolean;
};

/**
 * Em desenvolvimento geramos segredos efemeros para que `npm run dev` funcione
 * num clone limpo. Em producao isso e proibido: um segredo que muda a cada
 * reinicio derrubaria todas as sessoes e, pior, daria a falsa impressao de
 * estar configurado.
 */
function developmentFallbacks(env: NodeJS.ProcessEnv): Record<string, string> {
  // Le o NODE_ENV do proprio `env` recebido, nao do ambiente do processo:
  // `loadConfig(env)` precisa ser funcao pura do argumento, senao o teste
  // valida um caminho de codigo diferente do que roda em producao.
  if (env.NODE_ENV === 'production') return {};
  const ephemeral = (label: string): string =>
    `dev-only-${label}-${'x'.repeat(24)}`.slice(0, 48);
  return {
    ...(env.SESSION_SECRET ? {} : { SESSION_SECRET: ephemeral('session') }),
    ...(env.MEDIA_URL_SECRET ? {} : { MEDIA_URL_SECRET: ephemeral('media') }),
  };
}

export class ConfigError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Configuracao invalida:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse({ ...env, ...developmentFallbacks(env) });

  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`),
    );
  }

  const value = parsed.data;
  const problems: string[] = [];

  // Coerencias que o schema sozinho nao expressa.
  if (value.STORAGE_DRIVER === 's3') {
    for (const key of ['S3_ENDPOINT', 'S3_REGION', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const) {
      if (!value[key]) problems.push(`${key} e obrigatorio quando STORAGE_DRIVER=s3.`);
    }
  }

  if (value.NODE_ENV === 'production') {
    // Provider falso em producao e exatamente o cenario que o blueprint proibe.
    if (value.PAYMENTS_PROVIDER === 'fake') {
      problems.push('PAYMENTS_PROVIDER=fake e proibido em producao.');
    }
    if (value.AI_COPY_PROVIDER === 'mock' || value.AI_TTS_PROVIDER === 'mock') {
      problems.push('Providers de IA mock sao proibidos em producao.');
    }
    if (value.DATABASE_URL.startsWith('file://') || value.DATABASE_URL.startsWith('memory:')) {
      problems.push('Em producao DATABASE_URL precisa apontar para um PostgreSQL gerenciado.');
    }
    if (value.STORAGE_DRIVER === 'local') {
      problems.push('STORAGE_DRIVER=local nao e suportado em producao; use s3.');
    }
    if (value.SESSION_SECRET.startsWith('dev-only-') || value.MEDIA_URL_SECRET.startsWith('dev-only-')) {
      problems.push('Segredos de desenvolvimento nao podem ser usados em producao.');
    }
    if (value.SESSION_SECRET === value.MEDIA_URL_SECRET) {
      problems.push('SESSION_SECRET e MEDIA_URL_SECRET precisam ser diferentes.');
    }
    if (!value.WEB_ORIGIN.startsWith('https://')) {
      problems.push('WEB_ORIGIN precisa usar https em producao.');
    }
  }

  if (problems.length > 0) throw new ConfigError(problems);

  return Object.freeze({
    ...value,
    isProduction: value.NODE_ENV === 'production',
    isTest: value.NODE_ENV === 'test',
  });
}

/** Visao segura da configuracao: nomes e estados, jamais valores de segredo. */
export function describeConfig(config: AppConfig): Record<string, string> {
  return {
    nodeEnv: config.NODE_ENV,
    port: String(config.PORT),
    database: config.DATABASE_URL.replace(/:\/\/[^@]*@/, '://***@'),
    storageDriver: config.STORAGE_DRIVER,
    queueDriver: config.QUEUE_DRIVER,
    aiCopyProvider: config.AI_COPY_PROVIDER,
    aiTtsProvider: config.AI_TTS_PROVIDER,
    paymentsProvider: config.PAYMENTS_PROVIDER,
    email: config.SMTP_URL ? 'configurado' : 'nao configurado',
    ffprobe: config.FFPROBE_PATH ?? 'nao configurado',
    sessionSecret: config.SESSION_SECRET.startsWith('dev-only-') ? 'efemero (dev)' : 'definido',
    mediaUrlSecret: config.MEDIA_URL_SECRET.startsWith('dev-only-') ? 'efemero (dev)' : 'definido',
  };
}
