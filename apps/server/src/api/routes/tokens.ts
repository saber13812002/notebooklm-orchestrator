import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { ApiError, ApiCodes } from "@nlo/shared";
import type { AppContext } from "../../app-context.js";
import { ALL_TOKEN_SCOPES } from "../../domain/api-tokens.repo.js";
import "../request-augment.js";

/**
 * API-token management + audit query routes (Phase C4).
 *
 * Security:
 *  - These routes ALWAYS require a valid token, even when auth enforcement
 *    is globally off (the `admin` scope must be present; the v1 hook
 *    enforces the scope, the handlers re-check presence as defense in depth).
 *  - The plaintext token is returned exactly ONCE, at creation.
 *  - List/revoke responses expose only non-secret metadata.
 *  - Every create/revoke is additionally recorded as a specific audit event.
 */

const createTokenBody = z.object({
  name: z.string().min(1).max(80),
  scopes: z.array(z.enum(ALL_TOKEN_SCOPES)).min(1).max(6).optional(),
});

const updateTokenBody = z.object({
  enabled: z.boolean(),
});

const auditQuery = z.object({
  tokenId: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

function requireActor(req: FastifyRequest): void {
  if (!req.apiToken) {
    throw new ApiError(ApiCodes.unauthorized, "API token required", 401);
  }
}

function actor(req: FastifyRequest): { id: string; name: string } {
  return { id: req.apiToken!.id, name: req.apiToken!.name };
}

export function registerTokenRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  base: string = "/api/v1",
): void {
  app.post(`${base}/tokens`, async (req, reply) => {
    requireActor(req);
    const a = actor(req);
    const body = createTokenBody.parse(req.body);
    const { token, plaintext } = ctx.apiTokens.create({
      name: body.name,
      scopes: body.scopes,
    });
    ctx.apiTokens.audit({
      tokenId: a.id,
      tokenName: a.name,
      action: "token_created",
      method: req.method,
      path: req.url.split("?")[0] ?? base + "/tokens",
      status: 201,
      detail: token.id,
      ip: null,
    });
    return reply.code(201).send({
      token,
      plaintext,
      note: "Store the plaintext now: it is shown only once and cannot be read back.",
    });
  });

  app.get(`${base}/tokens`, async (req) => {
    requireActor(req);
    return { items: ctx.apiTokens.list() };
  });

  app.patch<{ Params: { id: string } }>(`${base}/tokens/:id`, async (req) => {
    requireActor(req);
    const body = updateTokenBody.parse(req.body);
    const token = ctx.apiTokens.setEnabled(req.params.id, body.enabled);
    return { token };
  });

  app.delete<{ Params: { id: string } }>(`${base}/tokens/:id`, async (req) => {
    requireActor(req);
    const a = actor(req);
    const token = ctx.apiTokens.revoke(req.params.id);
    ctx.apiTokens.audit({
      tokenId: a.id,
      tokenName: a.name,
      action: "token_revoked",
      method: req.method,
      path: req.url.split("?")[0] ?? `${base}/tokens/${req.params.id}`,
      status: 200,
      detail: token.id,
      ip: null,
    });
    return { ok: true, id: token.id, revokedAt: token.revokedAt };
  });
}

export function registerAuditRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  base: string = "/api/v1",
): void {
  app.get(`${base}/audit`, async (req) => {
    requireActor(req);
    const q = auditQuery.parse(req.query);
    const { items, total } = ctx.apiTokens.auditList({
      tokenId: q.tokenId,
      limit: q.limit,
      offset: q.offset,
    });
    return { items, total };
  });
}
