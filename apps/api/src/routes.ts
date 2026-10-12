import type { FastifyInstance } from 'fastify';
import type { AppServices } from './http/context.js';
import { registerDeviceRoutes } from './modules/devices/routes.js';
import { registerOrganizationRoutes } from './modules/organizations/routes.js';
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
}
