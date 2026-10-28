import type { ApiTokenRow } from "../domain/api-tokens.repo.js";

/**
 * Fastify request augmentation for the versioned API (single source of
 * truth, imported for its side effect by v1.ts and the shared job handler).
 */
declare module "fastify" {
  interface FastifyRequest {
    /** Resolved API token (null when absent or unresolvable). */
    apiToken?: ApiTokenRow | null;
    /** True when the request was authorized by a valid token. */
    apiTokenAuthorized?: boolean;
    /** Correlation id for this request (always present on v1). */
    correlationId?: string;
    /** Set when a failure audit row was already recorded synchronously. */
    apiAuditRecorded?: boolean;
  }
}

export {};
