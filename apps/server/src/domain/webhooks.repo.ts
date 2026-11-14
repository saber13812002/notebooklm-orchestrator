import { randomUUID } from "node:crypto";
import type { Db } from "../db/db.js";

/**
 * NLO-P2 (webhooks): durable, outbox-style webhook delivery.
 *
 * `webhook_endpoints`  — configured targets (name, URL, events filter, enabled).
 *                        The signing secret lives in the VAULT (secret_ref),
 *                        never in this table.
 * `webhook_deliveries` — the outbox. A publish() writes one row per matching
 *                        endpoint; the dispatcher drains due rows, settles
 *                        each exactly once (status guards), and dead-letters
 *                        what permanently fails. Rows survive restarts.
 *
 * Schema: migrations/0006 (webhook_endpoints + webhook_deliveries).
 */

export interface WebhookEndpointRow {
  id: string;
  name: string;
  url: string;
  /** Vault ref of the signing secret, or null when the endpoint has none. */
  secretRef: string | null;
  /** Event types to deliver; empty = all events. */
  events: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookDeliveryRow {
  id: string;
  endpointId: string;
  jobId: string | null;
  eventType: string;
  /** The exact bytes POSTed to the endpoint (payload snapshot at publish). */
  payloadJson: string;
  status: "pending" | "delivered" | "dead";
  attempts: number;
  lastStatus: number | null;
  lastError: string | null;
  /** Replay protection: a random nonce included in delivery headers. */
  hmacNonce: string;
  nextAttemptAt: string | null;
  createdAt: string;
  lastAttemptAt: string | null;
  deliveredAt: string | null;
  deadAt: string | null;
}

export class WebhookEndpointsRepo {
  constructor(private readonly db: Db) {}

  newId(): string {
    return `whk_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  }

  /** Insert an endpoint. Returns the (caller-provided or generated) id. */
  create(input: {
    id?: string;
    name: string;
    url: string;
    secretRef?: string | null;
    events?: string[];
  }): string {
    const id = input.id ?? this.newId();
    const now = this.db.now();
    this.db.raw
      .prepare(
        `INSERT INTO webhook_endpoints (id, name, url, secret_ref, events, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.url,
        input.secretRef ?? null,
        JSON.stringify(input.events ?? []),
        now,
        now,
      );
    return id;
  }

  get(id: string): WebhookEndpointRow | null {
    const row = this.db.raw.prepare(`SELECT * FROM webhook_endpoints WHERE id = ?`).get(id);
    return row ? this.map(row as Record<string, unknown>) : null;
  }

  list(): WebhookEndpointRow[] {
    return this.db.raw
      .prepare(`SELECT * FROM webhook_endpoints ORDER BY created_at, rowid`)
      .all()
      .map((r) => this.map(r as Record<string, unknown>));
  }

  update(
    id: string,
    patch: {
      name?: string;
      url?: string;
      secretRef?: string | null;
      events?: string[];
      enabled?: boolean;
    },
  ): number {
    const sets: string[] = [];
    const args: (string | number | null)[] = [];
    if (patch.name !== undefined) {
      sets.push("name = ?");
      args.push(patch.name);
    }
    if (patch.url !== undefined) {
      sets.push("url = ?");
      args.push(patch.url);
    }
    if (patch.secretRef !== undefined) {
      sets.push("secret_ref = ?");
      args.push(patch.secretRef);
    }
    if (patch.events !== undefined) {
      sets.push("events = ?");
      args.push(JSON.stringify(patch.events));
    }
    if (patch.enabled !== undefined) {
      sets.push("enabled = ?");
      args.push(patch.enabled ? 1 : 0);
    }
    if (sets.length === 0) return 0;
    sets.push("updated_at = ?");
    args.push(this.db.now(), id);
    const res = this.db.raw
      .prepare(`UPDATE webhook_endpoints SET ${sets.join(", ")} WHERE id = ?`)
      .run(...args);
    return Number(res.changes);
  }

  delete(id: string): number {
    const res = this.db.raw.prepare(`DELETE FROM webhook_endpoints WHERE id = ?`).run(id);
    return Number(res.changes);
  }

  private map(row: Record<string, unknown>): WebhookEndpointRow {
    let events: string[] = [];
    try {
      const parsed: unknown = JSON.parse(String(row.events ?? "[]"));
      if (Array.isArray(parsed)) events = parsed.map(String);
    } catch {
      events = [];
    }
    return {
      id: String(row.id),
      name: String(row.name),
      url: String(row.url),
      secretRef: row.secret_ref == null ? null : String(row.secret_ref),
      events,
      enabled: Number(row.enabled) === 1,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }
}

export class WebhookDeliveriesRepo {
  constructor(private readonly db: Db) {}

  newId(): string {
    return `dlv_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  }

  /**
   * Enqueue one delivery (outbox write). The payload is snapshotted as JSON
   * at publish time; the dispatcher POSTs these exact bytes (the HMAC is
   * computed over them), so late delivery is byte-identical to on-time.
   */
  enqueue(input: {
    endpointId: string;
    jobId?: string | null;
    eventType: string;
    payload: unknown;
  }): string {
    const id = this.newId();
    const now = this.db.now();
    this.db.raw
      .prepare(
        `INSERT INTO webhook_deliveries (
           id, endpoint_id, job_id, event_type, payload_json, status,
           attempts, hmac_nonce, next_attempt_at, created_at
         ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
      )
      .run(
        id,
        input.endpointId,
        input.jobId ?? null,
        input.eventType,
        JSON.stringify(input.payload),
        randomUUID().replace(/-/g, "").slice(0, 16),
        now,
        now,
      );
    return id;
  }

  /** Pending rows whose retry time has come (oldest first). */
  due(nowIso: string, limit = 20): WebhookDeliveryRow[] {
    return this.db.raw
      .prepare(
        `SELECT * FROM webhook_deliveries
         WHERE status = 'pending' AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?
         ORDER BY next_attempt_at ASC, rowid ASC
         LIMIT ?`,
      )
      .all(nowIso, limit)
      .map((r) => this.map(r as Record<string, unknown>));
  }

  get(id: string): WebhookDeliveryRow | null {
    const row = this.db.raw.prepare(`SELECT * FROM webhook_deliveries WHERE id = ?`).get(id);
    return row ? this.map(row as Record<string, unknown>) : null;
  }

  /** Exactly-once settlement: only flips a PENDING row. */
  markDelivered(id: string, lastStatus: number): void {
    const now = this.db.now();
    this.db.raw
      .prepare(
        `UPDATE webhook_deliveries
         SET status = 'delivered', last_status = ?, last_attempt_at = ?, delivered_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(lastStatus, now, now, id);
  }

  /** Pending -> pending with backoff (attempt count bumped). */
  markFailed(
    id: string,
    p: { attempts: number; lastStatus: number | null; lastError: string; nextAttemptAt: string },
  ): void {
    this.db.raw
      .prepare(
        `UPDATE webhook_deliveries
         SET attempts = ?, last_status = ?, last_error = ?, next_attempt_at = ?, last_attempt_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(p.attempts, p.lastStatus, p.lastError, p.nextAttemptAt, this.db.now(), id);
  }

  /** Pending -> dead (permanent failure or attempts exhausted). */
  markDead(id: string, lastError: string, lastStatus: number | null = null): void {
    const now = this.db.now();
    this.db.raw
      .prepare(
        `UPDATE webhook_deliveries
         SET status = 'dead', last_status = ?, last_error = ?, last_attempt_at = ?, dead_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(lastStatus, lastError, now, now, id);
  }

  /** Delivery log (newest first). NO payload, NO secrets. */
  list(filter: { endpointId?: string; jobId?: string; status?: string; limit?: number }): {
    items: WebhookDeliveryRow[];
    total: number;
  } {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter.endpointId) {
      where.push("endpoint_id = ?");
      args.push(filter.endpointId);
    }
    if (filter.jobId) {
      where.push("job_id = ?");
      args.push(filter.jobId);
    }
    if (filter.status) {
      where.push("status = ?");
      args.push(filter.status);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
    const countRow = this.db.raw
      .prepare(`SELECT COUNT(*) AS n FROM webhook_deliveries ${whereSql}`)
      .get(...args) as { n: number };
    const items = this.db.raw
      .prepare(
        `SELECT * FROM webhook_deliveries ${whereSql} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(...args, limit)
      .map((r) => this.map(r as Record<string, unknown>));
    return { items, total: Number(countRow.n) };
  }

  private map(row: Record<string, unknown>): WebhookDeliveryRow {
    const n = (v: unknown): number | null => (v == null ? null : Number(v));
    return {
      id: String(row.id),
      endpointId: String(row.endpoint_id),
      jobId: row.job_id == null ? null : String(row.job_id),
      eventType: String(row.event_type),
      payloadJson: String(row.payload_json),
      status: String(row.status) as WebhookDeliveryRow["status"],
      attempts: Number(row.attempts),
      lastStatus: n(row.last_status),
      lastError: row.last_error == null ? null : String(row.last_error),
      hmacNonce: String(row.hmac_nonce),
      nextAttemptAt: row.next_attempt_at == null ? null : String(row.next_attempt_at),
      createdAt: String(row.created_at),
      lastAttemptAt: row.last_attempt_at == null ? null : String(row.last_attempt_at),
      deliveredAt: row.delivered_at == null ? null : String(row.delivered_at),
      deadAt: row.dead_at == null ? null : String(row.dead_at),
    };
  }
}
