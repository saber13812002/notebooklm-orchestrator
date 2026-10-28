import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Db } from "../db/db.js";

/**
 * API tokens for external consumers (Phase C).
 *
 * Security model:
 *  - Token format: `nlo_<name-slug>_<32-byte random hex>` (64+ chars).
 *  - ONLY the SHA-256 hash is persisted (`token_hash`). The plaintext is
 *    returned exactly once at creation; it can never be read back.
 *  - `lastUsedAt` is refreshed on a THROTTLED interval (30s) so high-rate
 *    consumers do not hammer the DB on every request.
 *  - Revocation is a flag (`revoked_at`); rows are kept for the audit log
 *    (FK ON DELETE SET NULL keeps history attributable).
 */

export interface ApiTokenRow {
  id: string;
  name: string;
  scopes: string[];
  enabled: boolean;
  lastUsedAt: string | null;
  createdAt: string;
  revokedAt: string | null;
}

export type TokenScope =
  "jobs:read" | "jobs:write" | "jobs:cancel" | "jobs:download" | "meta:read" | "admin";

/**
 * The full scope set. Kept as a literal tuple (no widened annotation) so it
 * can be used directly in `z.enum(...)` for token-creation validation.
 *  - jobs:*    — the job lifecycle (create/read/cancel/download)
 *  - meta:read — provider/health/settings read-only introspection
 *  - admin     — operational surface (accounts, proxies, sessions,
 *                settings writes, token management, audit); implies all
 */
export const ALL_TOKEN_SCOPES = [
  "jobs:read",
  "jobs:write",
  "jobs:cancel",
  "jobs:download",
  "meta:read",
  "admin",
] as const;

const LAST_USED_THROTTLE_MS = 30_000;

export class ApiTokensRepo {
  constructor(private readonly db: Db) {}

  newId(): string {
    return `tok_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  }

  /**
   * Create a token. Returns the row + the PLAINTEXT token (one-time
   * disclosure). The plaintext is derived from a 32-byte CSPRNG and is
   * NEVER stored or logged.
   */
  create(input: { name: string; scopes?: TokenScope[] }): {
    token: ApiTokenRow;
    plaintext: string;
  } {
    const scopes = input.scopes ?? ["jobs:read", "jobs:write", "jobs:download"];
    const now = this.db.now();
    const id = this.newId();
    const random = randomBytes(32).toString("hex");
    const plaintext = `nlo_${slug(input.name)}_${random}`;
    const tokenHash = sha256(plaintext);
    this.db.raw
      .prepare(
        `INSERT INTO api_tokens (id, name, token_hash, scopes, enabled, last_used_at, created_at, revoked_at)
         VALUES (?, ?, ?, ?, 1, NULL, ?, NULL)`,
      )
      .run(id, input.name, tokenHash, scopes.join(","), now);
    return { token: this.getOrThrow(id)!, plaintext };
  }

  get(id: string): ApiTokenRow | null {
    const row = this.db.raw.prepare("SELECT * FROM api_tokens WHERE id = ?").get(id) as
      Record<string, unknown> | undefined;
    return row ? this.map(row) : null;
  }

  getOrThrow(id: string): ApiTokenRow {
    const t = this.get(id);
    if (!t) throw new Error(`api token not found: ${id}`);
    return t;
  }

  list(): ApiTokenRow[] {
    const rows = this.db.raw
      .prepare("SELECT * FROM api_tokens ORDER BY created_at")
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.map(r));
  }

  /** Look up a token by its presented plaintext (hash comparison). */
  findByPlaintext(plaintext: string): ApiTokenRow | null {
    const row = this.db.raw
      .prepare("SELECT * FROM api_tokens WHERE token_hash = ?")
      .get(sha256(plaintext)) as Record<string, unknown> | undefined;
    return row ? this.map(row) : null;
  }

  /**
   * Resolve a presented token for authorization. Returns null when the
   * token is unknown, revoked, or disabled. Touches `last_used_at` at
   * most once per 30s per token.
   */
  resolve(plaintext: string): ApiTokenRow | null {
    const t = this.findByPlaintext(plaintext);
    if (!t || !t.enabled || t.revokedAt) return null;
    const stale = !t.lastUsedAt || Date.now() - Date.parse(t.lastUsedAt) > LAST_USED_THROTTLE_MS;
    if (stale) this.touchLastUsed(t.id);
    return t;
  }

  setEnabled(id: string, enabled: boolean): ApiTokenRow {
    this.getOrThrow(id);
    this.db.raw.prepare("UPDATE api_tokens SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
    return this.getOrThrow(id);
  }

  /** Revoke (disable permanently; the row stays for audit attribution). */
  revoke(id: string): ApiTokenRow {
    this.db.raw
      .prepare("UPDATE api_tokens SET enabled = 0, revoked_at = ? WHERE id = ?")
      .run(this.db.now(), id);
    return this.getOrThrow(id);
  }

  /** Append an audit event. Never called with secrets; caller redacts. */
  audit(input: {
    tokenId: string | null;
    tokenName: string | null;
    action: string;
    method: string;
    path: string;
    status: number;
    detail?: string | null;
    ip?: string | null;
  }): void {
    this.db.raw
      .prepare(
        `INSERT INTO api_audit_log (at, token_id, token_name, action, method, path, status, detail, ip)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.db.now(),
        input.tokenId,
        input.tokenName,
        input.action,
        input.method,
        input.path,
        input.status,
        input.detail ?? null,
        input.ip ?? null,
      );
  }

  /** Query the audit trail (newest first). */
  auditList(filter: { tokenId?: string; limit?: number; offset?: number }): {
    items: {
      id: number;
      at: string;
      tokenId: string | null;
      tokenName: string | null;
      action: string;
      method: string;
      path: string;
      status: number;
      detail: string | null;
      ip: string | null;
    }[];
    total: number;
  } {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.tokenId) {
      where.push("token_id = ?");
      params.push(filter.tokenId);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = Number(
      (
        this.db.raw
          .prepare(`SELECT COUNT(*) AS c FROM api_audit_log ${whereSql}`)
          .get(...params) as { c: number }
      ).c,
    );
    const limit = Math.min(filter.limit ?? 100, 500);
    const offset = filter.offset ?? 0;
    const rows = this.db.raw
      .prepare(`SELECT * FROM api_audit_log ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as Record<string, unknown>[];
    return {
      total,
      items: rows.map((r) => ({
        id: Number(r.id),
        at: r.at as string,
        tokenId: (r.token_id as string) ?? null,
        tokenName: (r.token_name as string) ?? null,
        action: r.action as string,
        method: r.method as string,
        path: r.path as string,
        status: Number(r.status),
        detail: (r.detail as string) ?? null,
        ip: (r.ip as string) ?? null,
      })),
    };
  }

  private touchLastUsed(id: string): void {
    try {
      this.db.raw
        .prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?")
        .run(this.db.now(), id);
    } catch {
      // best-effort housekeeping
    }
  }

  private map(row: Record<string, unknown>): ApiTokenRow {
    return {
      id: row.id as string,
      name: row.name as string,
      scopes: String(row.scopes).split(",").filter(Boolean),
      enabled: Number(row.enabled) === 1,
      lastUsedAt: (row.last_used_at as string) ?? null,
      createdAt: row.created_at as string,
      revokedAt: (row.revoked_at as string) ?? null,
    };
  }
}

/** SHA-256 hex of a token value. */
export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Lowercase [a-z0-9-] slug, max 24 chars — keeps token names path-safe. */
function slug(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return s.slice(0, 24) || "token";
}
