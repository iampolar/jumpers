import type { FastifyInstance } from 'fastify';
import type { AppServices } from './http/context';
import { registerAdminRoutes } from './modules/admin/routes';
import { registerAiRoutes } from './modules/ai/routes';
import { registerAnalyticsRoutes } from './modules/analytics/routes';
import { registerAnnouncementRoutes } from './modules/announcements/routes';
import { registerBillingRoutes } from './modules/billing/routes';
import { registerCampaignRoutes } from './modules/campaigns/routes';
import { registerDeviceRoutes } from './modules/devices/routes';
import { registerMediaRoutes } from './modules/media/routes';
import { registerOrganizationRoutes } from './modules/organizations/routes';
import { registerPlaybackRoutes } from './modules/playback/routes';
import { registerPlaylistRoutes } from './modules/playlists/routes';
import { registerScheduleRoutes } from './modules/schedules/routes';
import { registerStoreRoutes } from './modules/stores/routes';

/**
 * Registro central das rotas de dominio.
 *
 * Um unico lugar lista o que a API expoe. Rota nova so existe se aparecer
 * aqui -- nao ha descoberta automatica por diretorio, que esconderia um
 * endpoint acidentalmente publico no meio de uma pasta.
 */
export function registerDomainRoutes(server: FastifyInstance, services: AppServices): void {
  registerOrganizationRoutes(server, services);
  registerStoreRoutes(server, services);
  registerDeviceRoutes(server, services);
  registerMediaRoutes(server, services);
  registerAnnouncementRoutes(server, services);
  registerPlaylistRoutes(server, services);
  registerScheduleRoutes(server, services);
  registerCampaignRoutes(server, services);
  registerPlaybackRoutes(server, services);
  registerAnalyticsRoutes(server, services);
  registerBillingRoutes(server, services);
  registerAiRoutes(server, services);
  registerAdminRoutes(server, services);
}
