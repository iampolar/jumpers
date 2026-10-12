import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  announcementMachine,
  DomainError,
  zAnnouncementActionInput,
  zCreateAnnouncementInput,
  zCreateVersionInput,
  type Announcement,
  type AnnouncementAction,
  type AnnouncementStatus,
  type AnnouncementVersion,
} from '@castwave/contracts';
import { ANNOUNCEMENT_TEMPLATES, contentHash, estimateScriptDurationMs } from '@castwave/core';
import { AUDIT_ACTIONS } from '../../audit.js';
import { authorize, created, type AppServices } from '../../http/context.js';
import { idOf, parseBody, parseQuery } from '../../http/validate.js';

/**
 * Anuncios e versionamento.
 *
 * Tres regras que o codigo faz valer, nao a UI:
 *
 *  1. **Versao e imutavel.** Editar cria uma nova linha em
 *     `announcement_versions`. A versao aprovada carrega um `content_hash`
 *     que prova, numa auditoria, que o texto no ar e o que foi aprovado.
 *  2. **O cliente envia ACAO, nunca status.** `{"action":"approve"}`, e a
 *     maquina de estados decide o destino. Nao existe caminho em que o
 *     frontend empurre `status: "active"`.
 *  3. **Aprovacao e politica da organizacao.** Com `requires_approval`, quem
 *     tem apenas `announcements:write` submete; publicar exige
 *     `announcements:approve`. Sem a politica, o mesmo editor publica direto.
 */

function mapVersion(row: Record<string, unknown>): AnnouncementVersion {
  return {
    id: row.id as string,
    announcementId: row.announcement_id as string,
    versionNumber: Number(row.version_number),
    scriptText: row.script_text as string,
    locale: row.locale as string,
    pronunciationDictionary: (row.pronunciation_dictionary as AnnouncementVersion['pronunciationDictionary']) ?? [],
    mediaAssetId: (row.media_asset_id as string | null) ?? null,
    mediaTitle: (row.media_title as string | null) ?? null,
    mediaDurationMs: row.media_duration_ms === null || row.media_duration_ms === undefined ? null : Number(row.media_duration_ms),
    estimatedDurationMs: Number(row.estimated_duration_ms),
    contentHash: row.content_hash as string,
    source: row.source as AnnouncementVersion['source'],
    createdByName: (row.created_by_name as string | null) ?? null,
    createdAt: new Date(row.created_at as string).toISOString(),
  };
}

const VERSION_SELECT = `
  select v.id, v.announcement_id, v.version_number, v.script_text, v.locale,
         v.pronunciation_dictionary, v.media_asset_id, v.estimated_duration_ms,
         v.content_hash, v.source, v.created_at,
         m.title as media_title, m.duration_ms as media_duration_ms,
         u.name  as created_by_name
    from announcement_versions v
    left join media_assets m on m.id = v.media_asset_id
    left join users u        on u.id = v.created_by`;

async function loadAnnouncement(
  services: AppServices,
  organizationId: string,
  announcementId: string,
): Promise<Announcement> {
  const { db } = services;
  const { rows } = await db.query<Record<string, unknown>>(
    `select a.id, a.organization_id, a.title, a.type, a.status, a.valid_from, a.valid_until,
            a.current_version_id, a.approved_at, a.rejection_reason, a.created_at, a.updated_at,
            cu.name as created_by_name, au.name as approved_by_name,
            (select count(*) from announcement_versions v where v.announcement_id = a.id) as version_count,
            (select coalesce(array_agg(s.store_id), '{}') from announcement_stores s where s.announcement_id = a.id) as store_ids
       from announcements a
       left join users cu on cu.id = a.created_by
       left join users au on au.id = a.approved_by
      where a.id = $1 and a.organization_id = $2`,
    [announcementId, organizationId],
  );
  const a = rows[0];
  if (!a) throw new DomainError('not_found', 'Anuncio nao encontrado.');

  let currentVersion: AnnouncementVersion | null = null;
  if (a.current_version_id) {
    const v = await db.query(`${VERSION_SELECT} where v.id = $1`, [a.current_version_id]);
    if (v.rows[0]) currentVersion = mapVersion(v.rows[0]);
  }

  const status = a.status as AnnouncementStatus;
  return {
    id: a.id as string,
    organizationId: a.organization_id as string,
    title: a.title as string,
    type: a.type as Announcement['type'],
    status,
    currentVersion,
    versionCount: Number(a.version_count),
    validFrom: a.valid_from ? new Date(a.valid_from as string).toISOString() : null,
    validUntil: a.valid_until ? new Date(a.valid_until as string).toISOString() : null,
    storeIds: (a.store_ids as string[]) ?? [],
    createdByName: (a.created_by_name as string | null) ?? null,
    approvedByName: (a.approved_by_name as string | null) ?? null,
    approvedAt: a.approved_at ? new Date(a.approved_at as string).toISOString() : null,
    rejectionReason: (a.rejection_reason as string | null) ?? null,
    // A UI habilita botao por esta lista: nunca oferece acao que vai falhar.
    availableActions: announcementMachine.actionsFrom(status),
    createdAt: new Date(a.created_at as string).toISOString(),
    updatedAt: new Date(a.updated_at as string).toISOString(),
  };
}

/** Confere que todo id de loja informado pertence a organizacao da sessao. */
async function assertStoresBelong(
  services: AppServices,
  organizationId: string,
  storeIds: readonly string[],
): Promise<void> {
  if (storeIds.length === 0) return;
  const { rowCount } = await services.db.query(
    "select 1 from stores where organization_id = $1 and id = any($2::uuid[]) and status <> 'archived'",
    [organizationId, storeIds],
  );
  if (rowCount !== storeIds.length) {
    throw new DomainError('validation_failed', 'Uma ou mais lojas informadas nao existem.');
  }
}

/** Confere que o audio e da organizacao e esta pronto para tocar. */
async function assertMediaUsable(
  services: AppServices,
  organizationId: string,
  mediaAssetId: string,
): Promise<void> {
  const { rows } = await services.db.query<{ status: string }>(
    'select status from media_assets where id = $1 and organization_id = $2',
    [mediaAssetId, organizationId],
  );
  const asset = rows[0];
  if (!asset) throw new DomainError('not_found', 'Audio nao encontrado na biblioteca.');
  if (asset.status !== 'ready') {
    throw new DomainError('conflict', 'Este audio ainda nao esta pronto para uso.', {
      action: 'Aguarde o processamento terminar ou envie o arquivo novamente.',
    });
  }
}

export function registerAnnouncementRoutes(server: FastifyInstance, services: AppServices): void {
  const { db, audit } = services;

  // -------------------------------------------------------------------------
  // Modelos prontos (sem IA)
  // -------------------------------------------------------------------------

  server.get('/api/v1/announcements/templates', (req) => {
    authorize(req, 'announcements:read');
    // Existem para o produto ser util no primeiro minuto, sem provedor de IA.
    return { templates: ANNOUNCEMENT_TEMPLATES };
  });

  // -------------------------------------------------------------------------
  // CRUD
  // -------------------------------------------------------------------------

  server.get('/api/v1/announcements', async (req) => {
    const principal = authorize(req, 'announcements:read');
    const query = parseQuery(
      req,
      z.object({
        status: z.string().max(40).optional(),
        storeId: z.uuid().optional(),
        search: z.string().trim().max(120).optional(),
      }),
    );

    const { rows } = await db.query<{ id: string }>(
      `select a.id
         from announcements a
        where a.organization_id = $1
          and ($2::text is null or a.status = $2::text)
          and ($3::text is null or a.title ilike '%' || $3::text || '%')
          and ($4::uuid is null or exists (
                select 1 from announcement_stores s
                 where s.announcement_id = a.id and s.store_id = $4::uuid))
        order by a.updated_at desc
        limit 300`,
      [principal.organizationId, query.status ?? null, query.search ?? null, query.storeId ?? null],
    );

    const announcements = await Promise.all(
      rows.map((r) => loadAnnouncement(services, principal.organizationId, r.id)),
    );
    return { announcements };
  });

  server.get('/api/v1/announcements/:id', async (req) => {
    const principal = authorize(req, 'announcements:read');
    const announcement = await loadAnnouncement(services, principal.organizationId, idOf(req));

    const versions = await db.query(
      `${VERSION_SELECT} where v.announcement_id = $1 order by v.version_number desc`,
      [announcement.id],
    );
    return { announcement, versions: versions.rows.map(mapVersion) };
  });

  server.post('/api/v1/announcements', async (req, reply) => {
    const principal = authorize(req, 'announcements:write');
    const input = parseBody(req, zCreateAnnouncementInput);

    await assertStoresBelong(services, principal.organizationId, input.storeIds);
    if (input.mediaAssetId) {
      await assertMediaUsable(services, principal.organizationId, input.mediaAssetId);
    }

    const dictionary = input.pronunciationDictionary ?? [];
    const announcementId = await db.transaction(async (tx) => {
      const announcement = await tx.query<{ id: string }>(
        `insert into announcements (organization_id, title, type, status, valid_from, valid_until, created_by)
         values ($1,$2,$3,'draft',$4,$5,$6) returning id`,
        [
          principal.organizationId,
          input.title,
          input.type,
          input.validFrom ?? null,
          input.validUntil ?? null,
          principal.userId,
        ],
      );
      const id = announcement.rows[0]!.id;

      const version = await tx.query<{ id: string }>(
        `insert into announcement_versions
           (organization_id, announcement_id, version_number, script_text, locale,
            pronunciation_dictionary, media_asset_id, estimated_duration_ms, content_hash, source, created_by)
         values ($1,$2,1,$3,$4,$5::jsonb,$6,$7,$8,$9,$10) returning id`,
        [
          principal.organizationId,
          id,
          input.scriptText,
          input.locale,
          JSON.stringify(dictionary),
          input.mediaAssetId ?? null,
          estimateScriptDurationMs(input.scriptText),
          contentHash({
            scriptText: input.scriptText,
            mediaAssetId: input.mediaAssetId ?? null,
            pronunciationDictionary: dictionary,
          }),
          input.source,
          principal.userId,
        ],
      );

      await tx.query('update announcements set current_version_id = $2 where id = $1', [
        id,
        version.rows[0]!.id,
      ]);

      for (const storeId of input.storeIds) {
        await tx.query(
          'insert into announcement_stores (announcement_id, store_id, organization_id) values ($1,$2,$3)',
          [id, storeId, principal.organizationId],
        );
      }
      return id;
    });

    await audit.write({
      organizationId: principal.organizationId,
      actorType: 'user',
      actorId: principal.userId,
      action: AUDIT_ACTIONS.announcementCreated,
      resourceType: 'announcement',
      resourceId: announcementId,
      requestId: req.id,
      // O roteiro NAO entra na auditoria: e conteudo comercial do cliente.
      metadata: { type: input.type, hasMedia: Boolean(input.mediaAssetId), stores: input.storeIds.length },
      ip: req.ip,
    });

    return created(reply, {
      announcement: await loadAnnouncement(services, principal.organizationId, announcementId),
    });
  });

  /** Nova versao. A anterior permanece intacta e consultavel. */
  server.post('/api/v1/announcements/:id/versions', async (req, reply) => {
    const principal = authorize(req, 'announcements:write');
    const announcementId = idOf(req);
    const input = parseBody(req, zCreateVersionInput);

    const current = await loadAnnouncement(services, principal.organizationId, announcementId);
    if (announcementMachine.isTerminal(current.status)) {
      throw new DomainError('invalid_state_transition', 'Este anuncio foi encerrado e nao aceita novas versoes.');
    }
    if (input.mediaAssetId) {
      await assertMediaUsable(services, principal.organizationId, input.mediaAssetId);
    }

    const dictionary = input.pronunciationDictionary ?? [];
    const versionId = await db.transaction(async (tx) => {
      const next = await tx.query<{ n: number }>(
        'select coalesce(max(version_number), 0) + 1 as n from announcement_versions where announcement_id = $1',
        [announcementId],
      );

      const version = await tx.query<{ id: string }>(
        `insert into announcement_versions
           (organization_id, announcement_id, version_number, script_text, locale,
            pronunciation_dictionary, media_asset_id, estimated_duration_ms, content_hash, source, created_by)
         values ($1,$2,$3,$4,'pt-BR',$5::jsonb,$6,$7,$8,$9,$10) returning id`,
        [
          principal.organizationId,
          announcementId,
          next.rows[0]!.n,
          input.scriptText,
          JSON.stringify(dictionary),
          input.mediaAssetId ?? null,
          estimateScriptDurationMs(input.scriptText),
          contentHash({
            scriptText: input.scriptText,
            mediaAssetId: input.mediaAssetId ?? null,
            pronunciationDictionary: dictionary,
          }),
          input.source,
          principal.userId,
        ],
      );

      /*
       * Editar um anuncio ja aprovado o devolve para rascunho: o que foi
       * aprovado nao e mais o que esta la. Deixar "aprovado" apontando para
       * texto novo seria mentira na auditoria.
       */
      const resetStatus = current.status === 'approved' || current.status === 'pending_approval';
      await tx.query(
        `update announcements
            set current_version_id = $2,
                status = case when $3 then 'draft' else status end,
                approved_by = case when $3 then null else approved_by end,
                approved_at = case when $3 then null else approved_at end,
                updated_at = now()
          where id = $1`,
        [announcementId, version.rows[0]!.id, resetStatus],
      );

      return version.rows[0]!.id;
    });

    await audit.write({
      organizationId: principal.organizationId,
      actorType: 'user',
      actorId: principal.userId,
      action: AUDIT_ACTIONS.announcementVersioned,
      resourceType: 'announcement',
      resourceId: announcementId,
      requestId: req.id,
      metadata: { versionId },
      ip: req.ip,
    });

    return created(reply, {
      announcement: await loadAnnouncement(services, principal.organizationId, announcementId),
    });
  });

  /**
   * Transicao de estado.
   *
   * Uma unica rota para todas as acoes. O cliente nunca envia um status: a
   * maquina de estados valida se a transicao e legal e recusa com 400 se nao
   * for -- inclusive quando o frontend tiver um bug.
   */
  server.post('/api/v1/announcements/:id/actions', async (req) => {
    const principal = authorize(req, 'announcements:write');
    const announcementId = idOf(req);
    const input = parseBody(req, zAnnouncementActionInput);
    const action = input.action as AnnouncementAction;

    const current = await loadAnnouncement(services, principal.organizationId, announcementId);

    // Aprovar e rejeitar exigem permissao propria: quem escreve nao aprova.
    if (action === 'approve' || action === 'reject') {
      authorize(req, 'announcements:approve');
    }

    const org = await db.query<{ requires_approval: boolean }>(
      'select requires_approval from organizations where id = $1',
      [principal.organizationId],
    );
    const requiresApproval = org.rows[0]!.requires_approval;

    if (requiresApproval && action === 'approve' && current.status === 'draft') {
      throw new DomainError('approval_required', 'Este anuncio precisa passar por revisao antes de ser aprovado.', {
        action: 'Use "Enviar para aprovacao" primeiro.',
      });
    }

    if (action === 'activate' && !current.currentVersion?.mediaAssetId) {
      // Sem audio nao ha o que tocar. Melhor recusar agora do que o player
      // descobrir no meio da grade.
      throw new DomainError('conflict', 'Este anuncio ainda nao tem audio.', {
        action: 'Envie a locucao na biblioteca e vincule-a ao anuncio.',
      });
    }

    const nextStatus = announcementMachine.apply(current.status, action);
    const approving = action === 'approve';
    const rejecting = action === 'reject';

    await db.query(
      `update announcements
          set status = $2,
              approved_by = case when $3 then $4::uuid else approved_by end,
              approved_at = case when $3 then now() else approved_at end,
              rejection_reason = case when $5 then $6::text else null end,
              updated_at = now()
        where id = $1 and organization_id = $7`,
      [
        announcementId,
        nextStatus,
        approving,
        principal.userId,
        rejecting,
        input.reason ?? null,
        principal.organizationId,
      ],
    );

    await audit.write({
      organizationId: principal.organizationId,
      actorType: 'user',
      actorId: principal.userId,
      action: AUDIT_ACTIONS.announcementTransitioned,
      resourceType: 'announcement',
      resourceId: announcementId,
      requestId: req.id,
      metadata: {
        from: current.status,
        to: nextStatus,
        operation: action,
        contentHash: current.currentVersion?.contentHash ?? null,
      },
      ip: req.ip,
    });

    return { announcement: await loadAnnouncement(services, principal.organizationId, announcementId) };
  });

  /** Estimativa de duracao do roteiro, para o editor avisar antes de gravar. */
  server.post('/api/v1/announcements/estimate', (req) => {
    authorize(req, 'announcements:read');
    const { scriptText } = parseBody(req, z.object({ scriptText: z.string().max(4000) }));
    return {
      estimatedDurationMs: estimateScriptDurationMs(scriptText),
      // A estimativa nunca e apresentada como duracao real.
      basis: 'Estimativa a 160 palavras por minuto em pt-BR. A duracao real vem do audio gravado.',
    };
  });
}
