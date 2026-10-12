import { DEFAULT_ROTATION_RULES, slugify } from '@castwave/contracts';
import { hashPassword } from '@castwave/core';
import type { SqlClient } from './client.js';

/**
 * Seed de desenvolvimento.
 *
 * Regras que este arquivo obedece, por design:
 *  - **nunca destrutivo**: so insere o que falta (ON CONFLICT DO NOTHING ou
 *    checagem previa). Rodar duas vezes nao apaga nem duplica nada;
 *  - **nunca em producao**: a funcao recusa com NODE_ENV=production;
 *  - **nunca mente**: nao cria `media_assets` com status 'ready' apontando
 *    para um arquivo que nao existe no storage. A biblioteca de audio nasce
 *    vazia e o usuario faz o primeiro upload de verdade. Playlist com faixa
 *    fantasma seria uma demo bonita e um produto quebrado.
 */

export interface SeedResult {
  readonly plans: number;
  readonly organizationId: string | null;
  readonly ownerEmail: string | null;
  readonly ownerPassword: string | null;
  readonly stores: number;
  readonly zones: number;
  readonly playlists: number;
  readonly schedules: number;
  readonly notes: readonly string[];
}

const GB = 1024 * 1024 * 1024;

/** Catalogo de planos. Preco e cota vivem no servidor, nunca no frontend. */
const PLANS = [
  {
    code: 'starter',
    name: 'Starter',
    description: 'Uma loja, ate dois pontos de audio. Para comecar.',
    priceCents: 14_900,
    sortOrder: 1,
    quotas: {
      maxStores: 1,
      maxDevices: 2,
      maxUsers: 3,
      maxStorageBytes: 2 * GB,
      maxActiveCampaigns: 3,
      monthlyAiCopyGenerations: 0,
      monthlyAiTtsSeconds: 0,
    },
    features: [
      'Programacao por horario e dia da semana',
      'Anuncios manuais e modelos prontos',
      'Relatorios de execucao',
    ],
  },
  {
    code: 'growth',
    name: 'Growth',
    description: 'Ate cinco lojas com zonas separadas e campanhas simultaneas.',
    priceCents: 49_900,
    sortOrder: 2,
    quotas: {
      maxStores: 5,
      maxDevices: 15,
      maxUsers: 15,
      maxStorageBytes: 20 * GB,
      maxActiveCampaigns: 20,
      monthlyAiCopyGenerations: 300,
      monthlyAiTtsSeconds: 3600,
    },
    features: [
      'Tudo do Starter',
      'Zonas de audio por loja',
      'Campanhas com vigencia e prioridade',
      'Exportacao CSV e escopo por loja',
    ],
  },
  {
    code: 'network',
    name: 'Network',
    description: 'Rede com muitas filiais, governanca e aprovacao de conteudo.',
    priceCents: 149_900,
    sortOrder: 3,
    quotas: {
      maxStores: 100,
      maxDevices: 400,
      maxUsers: 100,
      maxStorageBytes: 200 * GB,
      maxActiveCampaigns: 200,
      monthlyAiCopyGenerations: 3000,
      monthlyAiTtsSeconds: 36_000,
    },
    features: [
      'Tudo do Growth',
      'Fluxo de aprovacao obrigatoria',
      'Trilha de auditoria completa',
      'Suporte prioritario',
    ],
  },
] as const;

async function seedPlans(db: SqlClient): Promise<number> {
  let count = 0;
  for (const plan of PLANS) {
    const { rowCount } = await db.query(
      `insert into plans (code, name, description, price_cents, currency, interval, quotas, features, sort_order)
       values ($1,$2,$3,$4,'BRL','month',$5::jsonb,$6::jsonb,$7)
       on conflict (code) do nothing`,
      [
        plan.code,
        plan.name,
        plan.description,
        plan.priceCents,
        JSON.stringify(plan.quotas),
        JSON.stringify(plan.features),
        plan.sortOrder,
      ],
    );
    count += rowCount;
  }
  return count;
}

export interface SeedOptions {
  /** Cria a organizacao de demonstracao. Desligue para semear so o catalogo. */
  readonly withDemoOrganization?: boolean;
  readonly ownerEmail?: string;
  readonly ownerPassword?: string;
}

export async function seed(db: SqlClient, options: SeedOptions = {}): Promise<SeedResult> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('O seed de desenvolvimento e proibido com NODE_ENV=production.');
  }

  const notes: string[] = [];
  const plans = await seedPlans(db);

  if (options.withDemoOrganization === false) {
    return {
      plans,
      organizationId: null,
      ownerEmail: null,
      ownerPassword: null,
      stores: 0,
      zones: 0,
      playlists: 0,
      schedules: 0,
      notes,
    };
  }

  const ownerEmail = (options.ownerEmail ?? 'owner@aurora.exemplo.br').toLowerCase();
  const ownerPassword = options.ownerPassword ?? 'castwave-demo-2026';

  const existing = await db.query<{ id: string }>('select id from organizations where slug = $1', ['aurora']);
  if (existing.rows[0]) {
    notes.push('Organizacao de demonstracao ja existia: nada foi alterado.');
    return {
      plans,
      organizationId: existing.rows[0].id,
      ownerEmail,
      ownerPassword: null,
      stores: 0,
      zones: 0,
      playlists: 0,
      schedules: 0,
      notes,
    };
  }

  return db.transaction(async (tx) => {
    const orgId = (
      await tx.query<{ id: string }>(
        `insert into organizations (name, slug, timezone, requires_approval)
         values ('Rede Aurora', 'aurora', 'America/Sao_Paulo', false) returning id`,
      )
    ).rows[0]!.id;

    const passwordHash = await hashPassword(ownerPassword);
    const userId = (
      await tx.query<{ id: string }>(
        `insert into users (name, email, password_hash) values ('Marina Prado', $1, $2) returning id`,
        [ownerEmail, passwordHash],
      )
    ).rows[0]!.id;

    await tx.query(
      `insert into organization_memberships (organization_id, user_id, role, status)
       values ($1, $2, 'owner', 'active')`,
      [orgId, userId],
    );

    // Assinatura interna ativa, SEM gateway: o produto funciona inteiro assim.
    const growthPlanId = (await tx.query<{ id: string }>("select id from plans where code = 'growth'")).rows[0]!.id;
    await tx.query(
      `insert into subscriptions (organization_id, plan_id, status, current_period_end, provider)
       values ($1, $2, 'trialing', now() + interval '30 days', 'disabled')`,
      [orgId, growthPlanId],
    );

    /*
     * Duas lojas em fusos diferentes de proposito: e a configuracao que expoe
     * qualquer bug de agendamento. "Abre as 09:00" acontece em dois instantes
     * UTC distintos, e os relatorios precisam agregar pelo dia LOCAL de cada
     * uma.
     */
    const storeSpecs = [
      {
        name: 'Aurora Centro',
        timezone: 'America/Sao_Paulo',
        city: 'Sao Paulo',
        state: 'SP',
        zones: ['Salao', 'Caixas'],
      },
      {
        name: 'Aurora Manaus',
        timezone: 'America/Manaus',
        city: 'Manaus',
        state: 'AM',
        zones: ['Salao'],
      },
    ] as const;

    const openingHours = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
      weekday,
      opensAt: weekday === 0 ? '10:00' : '08:00',
      closesAt: weekday === 0 ? '18:00' : '22:00',
      closed: false,
    }));

    let zones = 0;
    const storeIds: string[] = [];
    for (const spec of storeSpecs) {
      const storeId = (
        await tx.query<{ id: string }>(
          `insert into stores (organization_id, name, slug, timezone, city, state, opening_hours)
           values ($1,$2,$3,$4,$5,$6,$7::jsonb) returning id`,
          [orgId, spec.name, slugify(spec.name), spec.timezone, spec.city, spec.state, JSON.stringify(openingHours)],
        )
      ).rows[0]!.id;
      storeIds.push(storeId);

      for (const zoneName of spec.zones) {
        await tx.query(
          'insert into audio_zones (organization_id, store_id, name, default_volume) values ($1,$2,$3,$4)',
          [orgId, storeId, zoneName, zoneName === 'Caixas' ? 65 : 80],
        );
        zones += 1;
      }
    }

    // Playlists vazias e propositais: a biblioteca comeca sem audio porque
    // nao embutimos musica licenciada de terceiros (blueprint 16).
    const playlistSpecs = [
      { name: 'Ambiente - dia', description: 'Rotacao padrao do horario comercial.' },
      { name: 'Avisos operacionais', description: 'Abertura, fechamento e chamadas de caixa.' },
    ];
    const playlistIds: string[] = [];
    for (const p of playlistSpecs) {
      const id = (
        await tx.query<{ id: string }>(
          `insert into playlists (organization_id, name, description, status, rotation_rules, created_by)
           values ($1,$2,$3,'active',$4::jsonb,$5) returning id`,
          [orgId, p.name, p.description, JSON.stringify(DEFAULT_ROTATION_RULES), userId],
        )
      ).rows[0]!.id;
      playlistIds.push(id);
    }

    let schedules = 0;
    for (const storeId of storeIds) {
      await tx.query(
        `insert into schedules (organization_id, store_id, playlist_id, name, weekdays,
           start_local_time, end_local_time, priority)
         values ($1,$2,$3,'Comercial',$4,'09:00','21:00',0)`,
        [orgId, storeId, playlistIds[0], [1, 2, 3, 4, 5, 6]],
      );
      schedules += 1;
    }

    // Feriado nacional como exemplo de excecao, na loja de Sao Paulo.
    await tx.query(
      `insert into schedule_exceptions (organization_id, store_id, local_date, kind, label, created_by)
       values ($1,$2,'2026-04-21','blackout','Tiradentes - loja fechada',$3)`,
      [orgId, storeIds[0], userId],
    );

    await tx.query(
      `insert into notifications (organization_id, severity, title, body, href, dedupe_key)
       values ($1,'info','Comece pela biblioteca de audio',
               'Envie suas musicas e locucoes para montar a primeira playlist. Voce precisa ter direito de execucao sobre o que enviar.',
               '/biblioteca','onboarding-media')`,
      [orgId],
    );

    notes.push('Biblioteca de audio vazia: nenhuma musica licenciada e distribuida junto.');
    notes.push('Assinatura criada em trial, com gateway desabilitado.');

    return {
      plans,
      organizationId: orgId,
      ownerEmail,
      ownerPassword,
      stores: storeIds.length,
      zones,
      playlists: playlistIds.length,
      schedules,
      notes,
    };
  });
}
