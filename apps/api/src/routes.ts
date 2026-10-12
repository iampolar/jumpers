import type { FastifyInstance } from 'fastify';
import type { AppServices } from './http/context.js';
import { registerAnnouncementRoutes } from './modules/announcements/routes.js';
import { registerCampaignRoutes } from './modules/campaigns/routes.js';
import { registerDeviceRoutes } from './modules/devices/routes.js';
import { registerMediaRoutes } from './modules/media/routes.js';
import { registerOrganizationRoutes } from './modules/organizations/routes.js';
import { registerPlaybackRoutes } from './modules/playback/routes.js';
import { registerPlaylistRoutes } from './modules/playlists/routes.js';
import { registerScheduleRoutes } from './modules/schedules/routes.js';
import { registerStoreRoutes } from './modules/stores/routes.js';

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
}
