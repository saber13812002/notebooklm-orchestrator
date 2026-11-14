import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ApiError, ApiCodes } from "@nlo/shared";
import type { AppContext } from "../../app-context.js";
import type { WebhookEndpointRow } from "../../domain/webhooks.repo.js";
import "../request-augment.js";

/**
 * NLO-P2 (webhooks): webhook endpoint management + delivery log.
 *
 * Surface: `${base}/webhooks` (registered on BOTH /api and /api/v1; the v1
 * group maps every route to `admin` scope). Secrets are written to the vault
 * under `webhook:<endpointId>`; the plaintext is returned EXACTLY ONCE (on
 * create or rotate) and never again. Views expose `hasSecret`, not the value.
 * Deliveries log never exposes payloads or signatures.
 */

/** The event types the platform can emit (job lifecycle + manual test). */
export const WEBHOOK_EVENTS = [
  "job.created",
  "job.running",
  "job.succeeded",
  "job.failed",
  "job.cancelled",
  "job.needs_attention",
] as const;

const eventArray = z.array(z.enum(WEBHOOK_EVENTS)).max(WEBHOOK_EVENTS.length);

const createBody = z.object({
  name: z.string().min(1).max(64),
  url: z.string().url(),
  /** HMAC-SHA256 signing secret; generated when omitted (returned once). */
  secret: z.string().min(16).max(128).optional().nullable(),
  /** Event filter; empty/omitted = all events. */
  events: eventArray.optional().nullable(),
});

const patchBody = z.object({
  name: z.string().min(1).max(64).optional().nullable(),
  url: z.string().url().optional().nullable(),
  secret: z.string().min(16).max(128).optional().nullable(),
  events: eventArray.optional().nullable(),
  enabled: z.boolean().optional().nullable(),
});

function view(e: WebhookEndpointRow): Record<string, unknown> {
  return {
    id: e.id,
    name: e.name,
    url: e.url,
    hasSecret: e.secretRef !== null,
    events: e.events,
    enabled: e.enabled,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
}

function requireUrl(v: string | undefined | null): string | null {
  if (v === undefined || v === null) return null;
  if (!/^https?:\/\//i.test(v)) {
    throw new ApiError(ApiCodes.validation, "url must be an http(s) URL", 400);
  }
  return v;
}

export function registerWebhookRoutes(app: FastifyInstance, ctx: AppContext, base = "/api"): void {
  const { endpoints, deliveries } = ctx.webhooks;
  const vault = ctx.vault;

  // Create an endpoint. The signing secret (generated or supplied) is
  // stored in the vault and returned exactly once.
  app.post(`${base}/webhooks`, async (req, reply) => {
    const body = createBody.parse(req.body);
    const url = requireUrl(body.url);
    if (url === null) throw new ApiError(ApiCodes.validation, "url must be an http(s) URL", 400);
    if (endpoints.list().some((e) => e.name === body.name)) {
      throw new ApiError(ApiCodes.conflict, "a webhook endpoint with this name exists", 409);
    }
    const id = endpoints.newId();
    const secretRef = `webhook:${id}`;
    const secret = body.secret ?? randomBytes(32).toString("hex");
    vault.put(secretRef, secret, "webhook_secret");
    endpoints.create({ id, name: body.name, url, secretRef, events: body.events ?? [] });
    const row = endpoints.get(id);
    if (!row) throw new ApiError(ApiCodes.notFound, "endpoint disappeared after create", 404);
    return reply.code(201).send({ ...view(row), secret });
  });

  app.get(`${base}/webhooks`, async () => {
    const items = endpoints.list().map(view);
    return { items, total: items.length };
  });

  app.get<{ Params: { id: string } }>(`${base}/webhooks/:id`, async (req) => {
    const e = endpoints.get(req.params.id);
    if (!e) throw new ApiError(ApiCodes.notFound, "webhook endpoint not found", 404);
    return view(e);
  });

  app.patch<{ Params: { id: string } }>(`${base}/webhooks/:id`, async (req) => {
    const e = endpoints.get(req.params.id);
    if (!e) throw new ApiError(ApiCodes.notFound, "webhook endpoint not found", 404);
    const body = patchBody.parse(req.body);
    const url = requireUrl(body.url);
    if (body.url !== undefined && body.url !== null && url === null) {
      throw new ApiError(ApiCodes.validation, "url must be an http(s) URL", 400);
    }
    const patch: {
      name?: string;
      url?: string;
      secretRef?: string | null;
      events?: string[];
      enabled?: boolean;
    } = {};
    if (body.name !== undefined && body.name !== null) patch.name = body.name;
    if (url !== null) patch.url = url;
    if (body.events !== undefined && body.events !== null) patch.events = body.events;
    if (body.enabled !== undefined && body.enabled !== null) patch.enabled = body.enabled;
    let rotatedSecret: string | null = null;
    if (body.secret !== undefined && body.secret !== null) {
      const ref = e.secretRef ?? `webhook:${e.id}`;
      vault.put(ref, body.secret, "webhook_secret");
      if (!e.secretRef) patch.secretRef = ref;
      rotatedSecret = body.secret;
    }
    if (Object.keys(patch).length > 0) endpoints.update(e.id, patch);
    const updated = endpoints.get(e.id);
    if (!updated) throw new ApiError(ApiCodes.notFound, "webhook endpoint not found", 404);
    return { ...view(updated), ...(rotatedSecret ? { secret: rotatedSecret } : {}) };
  });

  app.delete<{ Params: { id: string } }>(`${base}/webhooks/:id`, async (req, reply) => {
    const e = endpoints.get(req.params.id);
    if (!e) throw new ApiError(ApiCodes.notFound, "webhook endpoint not found", 404);
    endpoints.delete(e.id);
    if (e.secretRef) vault.delete(e.secretRef);
    return reply.code(204).send();
  });

  // Delivery log: attempts, statuses, errors — but never payloads or secrets.
  app.get<{ Params: { id: string } }>(`${base}/webhooks/:id/deliveries`, async (req) => {
    const e = endpoints.get(req.params.id);
    if (!e) throw new ApiError(ApiCodes.notFound, "webhook endpoint not found", 404);
    const { items, total } = deliveries.list({ endpointId: e.id, limit: 100 });
    return {
      items: items.map((d) => ({
        id: d.id,
        jobId: d.jobId,
        eventType: d.eventType,
        status: d.status,
        attempts: d.attempts,
        lastStatus: d.lastStatus,
        lastError: d.lastError,
        createdAt: d.createdAt,
        lastAttemptAt: d.lastAttemptAt,
        deliveredAt: d.deliveredAt,
        deadAt: d.deadAt,
      })),
      total,
    };
  });

  // Manual test: enqueue a synthetic delivery so the log shows end-to-end
  // behavior without waiting for a real job event.
  app.post<{ Params: { id: string } }>(`${base}/webhooks/:id/test`, async (req, reply) => {
    const e = endpoints.get(req.params.id);
    if (!e) throw new ApiError(ApiCodes.notFound, "webhook endpoint not found", 404);
    const deliveryId = deliveries.enqueue({
      endpointId: e.id,
      jobId: null,
      eventType: "webhook.test",
      payload: {
        event: "webhook.test",
        endpointId: e.id,
        occurredAt: new Date().toISOString(),
        note: "manual test delivery",
      },
    });
    return reply.code(202).send({ ok: true, deliveryId });
  });
}
