import type { FastifyReply, FastifyRequest } from "fastify";

import { assertGeoAllowed, GeoBlockedError } from "./geo";
import { errBody } from "./reply";

/**
 * Fastify preHandler enforcing jurisdiction on PLAYER-facing routes.
 *
 * Applied to the money and gameplay surface (spin, cashier) rather than
 * globally, for two reasons:
 *
 *   - /api/health must answer for load balancers regardless of origin.
 *   - Provider and PSP webhooks are SERVER-to-server. Geolocating an
 *     aggregator's datacenter tells us nothing about a player and would
 *     reject legitimate settlement traffic. Those routes are protected by
 *     HMAC instead.
 *
 * Every rejection returns the same opaque 403 body; the specific reason goes
 * to logs only, so the endpoint cannot be used to probe which check failed.
 */
export async function requirePermittedJurisdiction(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    assertGeoAllowed({
      socketIp: req.socket.remoteAddress ?? undefined,
      header: (name) => {
        const v = req.headers[name];
        return Array.isArray(v) ? v[0] : v;
      },
    });
  } catch (err) {
    if (err instanceof GeoBlockedError) {
      req.log.warn({ geo_reason: err.reason, route: req.url }, "request rejected by jurisdiction fence");
      await reply.code(err.status).send(errBody(err.code, err.message));
      return;
    }
    throw err;
  }
}
