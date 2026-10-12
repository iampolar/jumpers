#!/usr/bin/env tsx
/**
 * Gera `docs/openapi.json` a partir dos MESMOS schemas Zod que validam a
 * entrada em runtime.
 *
 * Escrever o OpenAPI a mao garante que ele envelheca: a especificacao diz uma
 * coisa, a validacao faz outra, e a divergencia so aparece quando um cliente
 * integra. Aqui `z.toJSONSchema` deriva o contrato do codigo que de fato
 * roda -- se o schema mudar e o documento nao for regerado, a CI falha com o
 * diff na mao.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z, type ZodType } from 'zod';
import {
  ERROR_CODES,
  zCreateAnnouncementInput,
  zCreateCampaignInput,
  zCreatePairingCodeInput,
  zCreatePlaylistInput,
  zCreateScheduleInput,
  zCreateStoreInput,
  zCreateUploadInput,
  zCreateZoneInput,
  zHeartbeatInput,
  zInviteMemberInput,
  zLoginInput,
  zPairDeviceInput,
  zPlaybackEventBatch,
  zRegisterInput,
} from '@castwave/contracts';
import { API_VERSION } from '../app';

const schemaOf = (schema: ZodType): unknown =>
  z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input', unrepresentable: 'any' });

interface Endpoint {
  readonly method: 'get' | 'post' | 'patch' | 'delete';
  readonly path: string;
  readonly summary: string;
  readonly tag: string;
  readonly body?: ZodType;
  /** `device` = Bearer do player; `session` = cookie; `public` = sem credencial. */
  readonly auth: 'session' | 'device' | 'public';
  readonly permission?: string;
}

const ENDPOINTS: readonly Endpoint[] = [
  // Sessao
  { method: 'post', path: '/auth/register', summary: 'Cria conta e organizacao', tag: 'Sessao', body: zRegisterInput, auth: 'public' },
  { method: 'post', path: '/auth/login', summary: 'Autentica e abre sessao', tag: 'Sessao', body: zLoginInput, auth: 'public' },
  { method: 'post', path: '/auth/logout', summary: 'Encerra a sessao atual', tag: 'Sessao', auth: 'session' },
  { method: 'get', path: '/auth/me', summary: 'Identidade, papel, permissoes e token CSRF', tag: 'Sessao', auth: 'session' },
  { method: 'post', path: '/auth/revoke-sessions', summary: 'Encerra as demais sessoes do usuario', tag: 'Sessao', auth: 'session' },
  { method: 'post', path: '/auth/password/forgot', summary: 'Solicita recuperacao (resposta uniforme)', tag: 'Sessao', auth: 'public' },
  { method: 'post', path: '/auth/password/reset', summary: 'Redefine a senha e derruba sessoes', tag: 'Sessao', auth: 'public' },

  // Organizacao
  { method: 'get', path: '/organization', summary: 'Dados da organizacao', tag: 'Organizacao', auth: 'session', permission: 'org:read' },
  { method: 'patch', path: '/organization', summary: 'Atualiza a organizacao', tag: 'Organizacao', auth: 'session', permission: 'org:update' },
  { method: 'get', path: '/members', summary: 'Lista a equipe', tag: 'Organizacao', auth: 'session', permission: 'members:read' },
  { method: 'post', path: '/members', summary: 'Convida alguem para a equipe', tag: 'Organizacao', body: zInviteMemberInput, auth: 'session', permission: 'members:manage' },

  // Lojas
  { method: 'get', path: '/stores', summary: 'Lista lojas do escopo', tag: 'Lojas', auth: 'session', permission: 'stores:read' },
  { method: 'post', path: '/stores', summary: 'Cadastra loja com fuso IANA', tag: 'Lojas', body: zCreateStoreInput, auth: 'session', permission: 'stores:manage' },
  { method: 'delete', path: '/stores/{id}', summary: 'Arquiva a loja (nunca apaga)', tag: 'Lojas', auth: 'session', permission: 'stores:manage' },
  { method: 'post', path: '/stores/{id}/zones', summary: 'Cria zona de audio', tag: 'Lojas', body: zCreateZoneInput, auth: 'session', permission: 'zones:manage' },

  // Players
  { method: 'post', path: '/devices/pairing-codes', summary: 'Emite codigo de uso unico', tag: 'Players', body: zCreatePairingCodeInput, auth: 'session', permission: 'devices:pair' },
  { method: 'post', path: '/devices/pair', summary: 'Troca o codigo por credencial de dispositivo', tag: 'Players', body: zPairDeviceInput, auth: 'public' },
  { method: 'get', path: '/devices', summary: 'Lista players com estado real', tag: 'Players', auth: 'session', permission: 'devices:read' },
  { method: 'post', path: '/devices/{id}/revoke', summary: 'Revoga a credencial do player', tag: 'Players', auth: 'session', permission: 'devices:manage' },

  // Midia
  { method: 'get', path: '/media', summary: 'Biblioteca de audio', tag: 'Midia', auth: 'session', permission: 'media:read' },
  { method: 'post', path: '/media/uploads', summary: 'Abre upload (verifica cota antes)', tag: 'Midia', body: zCreateUploadInput, auth: 'session', permission: 'media:upload' },
  { method: 'post', path: '/media/uploads/{id}/complete', summary: 'Envia os bytes e valida por conteudo', tag: 'Midia', auth: 'session', permission: 'media:upload' },
  { method: 'get', path: '/media/{id}/stream-url', summary: 'URL assinada de TTL curto', tag: 'Midia', auth: 'session', permission: 'media:read' },

  // Conteudo
  { method: 'get', path: '/announcements', summary: 'Lista anuncios', tag: 'Anuncios', auth: 'session', permission: 'announcements:read' },
  { method: 'post', path: '/announcements', summary: 'Cria anuncio como rascunho', tag: 'Anuncios', body: zCreateAnnouncementInput, auth: 'session', permission: 'announcements:write' },
  { method: 'post', path: '/announcements/{id}/actions', summary: 'Aplica ACAO na maquina de estados', tag: 'Anuncios', auth: 'session', permission: 'announcements:write' },
  { method: 'get', path: '/announcements/templates', summary: 'Modelos prontos (sem IA)', tag: 'Anuncios', auth: 'session', permission: 'announcements:read' },

  // Programacao
  { method: 'get', path: '/playlists', summary: 'Lista playlists', tag: 'Programacao', auth: 'session', permission: 'playlists:read' },
  { method: 'post', path: '/playlists', summary: 'Cria playlist com regras de rotacao', tag: 'Programacao', body: zCreatePlaylistInput, auth: 'session', permission: 'playlists:write' },
  { method: 'get', path: '/playlists/{id}/preview', summary: 'Previa pelo motor real de rotacao', tag: 'Programacao', auth: 'session', permission: 'playlists:read' },
  { method: 'post', path: '/schedules', summary: 'Cria janela recorrente (hora local)', tag: 'Programacao', body: zCreateScheduleInput, auth: 'session', permission: 'schedules:write' },
  { method: 'get', path: '/schedules/calendar', summary: 'Grade resolvida, dia a dia', tag: 'Programacao', auth: 'session', permission: 'schedules:read' },
  { method: 'get', path: '/schedules/now', summary: 'O que toca agora e ate quando', tag: 'Programacao', auth: 'session', permission: 'schedules:read' },
  { method: 'post', path: '/campaigns', summary: 'Cria campanha com vigencia', tag: 'Programacao', body: zCreateCampaignInput, auth: 'session', permission: 'campaigns:write' },

  // Player
  { method: 'get', path: '/player/manifest', summary: 'Manifesto de reproducao assinado', tag: 'Player', auth: 'device' },
  { method: 'post', path: '/player/heartbeat', summary: 'Sinal de vida do dispositivo', tag: 'Player', body: zHeartbeatInput, auth: 'device' },
  { method: 'post', path: '/player/events', summary: 'Lote de eventos idempotentes', tag: 'Player', body: zPlaybackEventBatch, auth: 'device' },

  // Dados
  { method: 'get', path: '/analytics/overview', summary: 'Metricas agregadas do periodo', tag: 'Relatorios', auth: 'session', permission: 'analytics:read' },
  { method: 'get', path: '/analytics/export.csv', summary: 'Exportacao CSV com escape seguro', tag: 'Relatorios', auth: 'session', permission: 'analytics:export' },

  // Plano
  { method: 'get', path: '/billing/plans', summary: 'Catalogo de planos', tag: 'Plano', auth: 'public' },
  { method: 'get', path: '/billing/subscription', summary: 'Assinatura e medidores', tag: 'Plano', auth: 'session', permission: 'billing:read' },
  { method: 'post', path: '/billing/checkout', summary: 'Checkout (503 sem gateway)', tag: 'Plano', auth: 'session', permission: 'billing:manage' },

  // IA
  { method: 'get', path: '/ai/status', summary: 'Estado dos provedores de IA', tag: 'IA', auth: 'session', permission: 'announcements:read' },
  { method: 'post', path: '/ai/copy', summary: 'Gera roteiro (503 sem provedor)', tag: 'IA', auth: 'session', permission: 'ai:generate' },

  // Operacao
  { method: 'get', path: '/status/integrations', summary: 'Estado das dependencias', tag: 'Operacao', auth: 'public' },
  { method: 'get', path: '/audit', summary: 'Trilha da propria organizacao', tag: 'Operacao', auth: 'session', permission: 'audit:read' },
  { method: 'get', path: '/jumpers/overview', summary: 'Operacao Jumpers (404 para cliente)', tag: 'Jumpers', auth: 'session', permission: 'plataforma' },
];

const paths: Record<string, Record<string, unknown>> = {};

for (const e of ENDPOINTS) {
  const full = `/api/v1${e.path}`;
  paths[full] ??= {};

  const parameters = [...e.path.matchAll(/\{(\w+)\}/g)].map(([, name]) => ({
    name,
    in: 'path',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  }));

  paths[full][e.method] = {
    tags: [e.tag],
    summary: e.summary,
    description: [
      e.auth === 'device'
        ? 'Autenticado por Bearer de dispositivo. Credencial de player NAO abre rota administrativa.'
        : e.auth === 'public'
          ? 'Rota publica: nao exige credencial nem token CSRF.'
          : 'Exige cookie de sessao. Metodos mutaveis exigem o cabecalho `x-csrf-token`.',
      e.permission ? `Permissao: \`${e.permission}\`.` : null,
      e.auth === 'session'
        ? 'Recurso de outra organizacao responde **404**, nunca 403 — nao confirmamos a existencia.'
        : null,
    ]
      .filter(Boolean)
      .join(' '),
    ...(parameters.length > 0 ? { parameters } : {}),
    ...(e.body
      ? {
          requestBody: {
            required: true,
            content: { 'application/json': { schema: schemaOf(e.body) } },
          },
        }
      : {}),
    responses: {
      '200': { description: 'Sucesso' },
      '400': { $ref: '#/components/responses/Erro' },
      '401': { $ref: '#/components/responses/Erro' },
      '403': { $ref: '#/components/responses/Erro' },
      '404': { $ref: '#/components/responses/Erro' },
    },
    security: e.auth === 'public' ? [] : e.auth === 'device' ? [{ deviceToken: [] }] : [{ sessionCookie: [] }],
  };
}

const document = {
  openapi: '3.1.0',
  info: {
    title: 'CastWave API',
    version: API_VERSION,
    description: [
      'API da central de audio CastWave.',
      '',
      '**Escopo nunca vem do cliente.** Nenhuma rota le `organization_id` do corpo,',
      'da query ou de cabecalho: ele sai sempre da credencial autenticada.',
      '',
      '**Erros tem codigo estavel.** Trate pelo campo `error.code`, nunca pela mensagem,',
      'que pode mudar sem aviso. Codigos conhecidos: ' +
        Object.keys(ERROR_CODES)
          .map((c) => `\`${c}\``)
          .join(', ') +
        '.',
      '',
      'Este documento e GERADO a partir dos schemas Zod que validam a entrada em',
      'runtime (`npm run openapi`). Especificacao e validacao nao divergem.',
    ].join('\n'),
  },
  servers: [{ url: 'http://127.0.0.1:4000', description: 'Desenvolvimento' }],
  components: {
    securitySchemes: {
      sessionCookie: { type: 'apiKey', in: 'cookie', name: 'castwave_session' },
      deviceToken: { type: 'http', scheme: 'bearer', description: 'Token entregue no pareamento.' },
    },
    responses: {
      Erro: {
        description: 'Erro com codigo estavel e identificador de requisicao.',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['error'],
              properties: {
                error: {
                  type: 'object',
                  required: ['code', 'message', 'requestId'],
                  properties: {
                    code: { type: 'string', enum: Object.keys(ERROR_CODES) },
                    message: { type: 'string', description: 'Segura para exibir. Nunca contem stack ou SQL.' },
                    action: { type: 'string', description: 'Como o usuario resolve, quando aplicavel.' },
                    issues: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          path: { type: 'string' },
                          code: { type: 'string' },
                          message: { type: 'string' },
                        },
                      },
                    },
                    requestId: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  paths,
};

const out = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../docs/openapi.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
console.log(`openapi gerado: ${ENDPOINTS.length} rotas -> docs/openapi.json`);
