import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app-context.js";

/**
 * NLO-P4-1A: `GET /api/v1/capabilities` — the registry-backed, honest
 * capability endpoint.
 *
 * Returns the descriptors registered in `ctx.registry` (derived from the
 * live provider's capability matrix at boot — levels are never inflated).
 * Auth: `providers:read` scope when tokens are used (admin implies it);
 * anonymous loopback traffic is allowed, mirroring `/provider`.
 */
export function registerCapabilitiesRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  base: string = "/api/v1",
): void {
  app.get(`${base}/capabilities`, async () => ctx.registry.capabilitiesResponse());
}
