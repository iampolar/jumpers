import { describe, expect, it } from 'vitest';
import { ConfigError, describeConfig, loadConfig } from './config.js';

const prodBase: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://user:senha@db.interno:5432/castwave',
  SESSION_SECRET: 'a'.repeat(48),
  MEDIA_URL_SECRET: 'b'.repeat(48),
  WEB_ORIGIN: 'https://app.castwave.com.br',
  STORAGE_DRIVER: 's3',
  S3_ENDPOINT: 'https://s3.exemplo',
  S3_REGION: 'sa-east-1',
  S3_BUCKET: 'castwave',
  S3_ACCESS_KEY_ID: 'key',
  S3_SECRET_ACCESS_KEY: 'secret',
};

const messageOf = (env: NodeJS.ProcessEnv): string => {
  try {
    loadConfig(env);
    return '(nao lancou)';
  } catch (e) {
    return e instanceof ConfigError ? e.message : `(${(e as Error).name})`;
  }
};

describe('desenvolvimento', () => {
  it('sobe num clone limpo, sem nenhuma variavel definida', () => {
    const config = loadConfig({});
    expect(config.NODE_ENV).toBe('development');
    expect(config.PORT).toBe(4000);
    // PGlite em disco: sem Docker, sem servico, sem setup.
    expect(config.DATABASE_URL).toBe('file://./.data/castwave');
    expect(config.SESSION_SECRET.length).toBeGreaterThanOrEqual(32);
  });

  it('nasce com todas as integracoes externas desligadas', () => {
    const config = loadConfig({});
    expect(config.AI_COPY_PROVIDER).toBe('disabled');
    expect(config.AI_TTS_PROVIDER).toBe('disabled');
    expect(config.PAYMENTS_PROVIDER).toBe('disabled');
    expect(config.SMTP_URL).toBeUndefined();
  });

  it('gera segredos efemeros e os marca como tal', () => {
    const config = loadConfig({});
    expect(describeConfig(config).sessionSecret).toBe('efemero (dev)');
  });

  it('coage tipos de variavel de ambiente corretamente', () => {
    const config = loadConfig({ PORT: '8080', RATE_LIMIT_ENABLED: 'false', DATABASE_SSL: '1' });
    expect(config.PORT).toBe(8080);
    expect(config.RATE_LIMIT_ENABLED).toBe(false);
    expect(config.DATABASE_SSL).toBe(true);
  });

  it('recusa porta invalida com mensagem de campo', () => {
    expect(messageOf({ PORT: '99999' })).toContain('PORT');
    expect(messageOf({ PORT: 'abc' })).toContain('PORT');
  });
});

describe('producao', () => {
  it('aceita uma configuracao completa e coerente', () => {
    const config = loadConfig(prodBase);
    expect(config.isProduction).toBe(true);
    expect(config.STORAGE_DRIVER).toBe('s3');
  });

  it('recusa provider de pagamento falso', () => {
    expect(messageOf({ ...prodBase, PAYMENTS_PROVIDER: 'fake' })).toContain('proibido em producao');
  });

  it('recusa providers de IA mock', () => {
    expect(messageOf({ ...prodBase, AI_COPY_PROVIDER: 'mock' })).toContain('mock');
    expect(messageOf({ ...prodBase, AI_TTS_PROVIDER: 'mock' })).toContain('mock');
  });

  it('recusa segredo efemero de desenvolvimento', () => {
    const env = { ...prodBase };
    delete env.SESSION_SECRET;
    // Sem fallback em producao: falta o segredo, e isso e um erro de campo.
    expect(messageOf(env)).toContain('SESSION_SECRET');
  });

  it('recusa reusar o mesmo segredo para sessao e midia', () => {
    const same = 'c'.repeat(48);
    expect(messageOf({ ...prodBase, SESSION_SECRET: same, MEDIA_URL_SECRET: same })).toContain(
      'precisam ser diferentes',
    );
  });

  it('recusa segredo curto demais', () => {
    expect(messageOf({ ...prodBase, SESSION_SECRET: 'curto' })).toContain('32 caracteres');
  });

  it('recusa banco efemero', () => {
    expect(messageOf({ ...prodBase, DATABASE_URL: 'file://./.data/x' })).toContain('PostgreSQL gerenciado');
    expect(messageOf({ ...prodBase, DATABASE_URL: 'memory://' })).toContain('PostgreSQL gerenciado');
  });

  it('recusa storage local', () => {
    expect(messageOf({ ...prodBase, STORAGE_DRIVER: 'local' })).toContain('nao e suportado em producao');
  });

  it('recusa origem sem https', () => {
    expect(messageOf({ ...prodBase, WEB_ORIGIN: 'http://app.castwave.com.br' })).toContain('https');
  });

  it('exige as variaveis de S3 quando o driver e s3', () => {
    const env = { ...prodBase };
    delete env.S3_BUCKET;
    expect(messageOf(env)).toContain('S3_BUCKET');
  });

  it('acumula todos os problemas em uma unica mensagem', () => {
    // O operador corrige tudo de uma vez, em vez de descobrir um por deploy.
    const message = messageOf({
      ...prodBase,
      PAYMENTS_PROVIDER: 'fake',
      STORAGE_DRIVER: 'local',
      WEB_ORIGIN: 'http://inseguro',
    });
    expect(message).toContain('PAYMENTS_PROVIDER');
    expect(message).toContain('STORAGE_DRIVER');
    expect(message).toContain('https');
  });
});

describe('describeConfig', () => {
  it('mascara a senha da string de conexao', () => {
    const described = describeConfig(loadConfig(prodBase));
    expect(described.database).toBe('postgres://***@db.interno:5432/castwave');
    expect(described.database).not.toContain('senha');
  });

  it('nunca inclui o valor de nenhum segredo', () => {
    const config = loadConfig(prodBase);
    const serialized = JSON.stringify(describeConfig(config));
    expect(serialized).not.toContain(config.SESSION_SECRET);
    expect(serialized).not.toContain(config.MEDIA_URL_SECRET);
    expect(serialized).not.toContain('secret');
  });
});
