import { randomUUID } from "node:crypto";
import type { Db } from "../db/db.js";

export interface ArtifactRow {
  id: string;
  jobId: string;
  filename: string;
  mediaType: string;
  size: number;
  /** "provider" (the external service produced it) or "application"
   *  (NLO produced it, e.g. an MP3 transcode — see sourceArtifactId). */
  source: string;
  /** Job-relative storage key (server-generated; never a user path). */
  storageKey: string;
  durationSeconds: number | null;
  codec: string | null;
  sampleRate: number | null;
  channels: number | null;
  bitrate: number | null;
  /** For application-produced artifacts: the artifact they were derived from. */
  sourceArtifactId: string | null;
  /** SHA-256 of the stored file (verified at write time, when available). */
  sha256: string | null;
  /** "mock" | "real" | "unknown" — from the provider's own report, never assumed. */
  provenance: string | null;
  createdAt: string;
  /** Owning job's token_id (null for jobs created by the UI/admin). Used by
   *  the download API for token-scoped ownership checks. */
  tokenId: string | null;
  /** Owning job's current status (read-side guard; not authoritative). */
  jobStatus: string | null;
}

export interface ArtifactCreate {
  jobId: string;
  filename: string;
  mediaType: string;
  size: number;
  source: string;
  storageKey: string;
  durationSeconds?: number | null;
  codec?: string | null;
  sampleRate?: number | null;
  channels?: number | null;
  bitrate?: number | null;
  sourceArtifactId?: string | null;
  sha256?: string | null;
  provenance?: string | null;
}

/**
 * ArtifactRepo (NLO-P2): the single writer/reader for the artifacts table.
 *
 * Invariants:
 *  - ids are server-generated (`art_<hex16>`); no user-supplied names reach
 *    the key columns (the filename is display-only and already safe-named).
 *  - metadata columns are only written when the producer actually verified
 *    them; NULL is an honest "not reported", never a guess.
 *  - reads join the owning job so ownership (token_id, status) can be
 *    enforced at the API boundary without a second lookup.
 */
export class ArtifactRepo {
  constructor(private readonly db: Db) {}

  newId(): string {
    return `art_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  }

  /** Register a stored artifact. Returns the generated id. */
  create(input: ArtifactCreate): string {
    const id = this.newId();
    this.db.raw
      .prepare(
        `INSERT INTO artifacts (
           id, job_id, filename, media_type, size, source, storage_key,
           duration_seconds, codec, sample_rate, channels, bitrate,
           source_artifact_id, sha256, provenance, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.jobId,
        input.filename,
        input.mediaType,
        input.size,
        input.source,
        input.storageKey,
        input.durationSeconds ?? null,
        input.codec ?? null,
        input.sampleRate ?? null,
        input.channels ?? null,
        input.bitrate ?? null,
        input.sourceArtifactId ?? null,
        input.sha256 ?? null,
        input.provenance ?? null,
        this.db.now(),
      );
    return id;
  }

  /** An artifact joined with its owning job (ownership checks). */
  getById(id: string): ArtifactRow | null {
    const rows = this.db.raw
      .prepare(
        `SELECT a.*, j.token_id AS job_token_id, j.status AS job_status
         FROM artifacts a JOIN jobs j ON j.id = a.job_id
         WHERE a.id = ?`,
      )
      .all(id);
    const row = rows[0];
    return row ? this.map(row as Record<string, unknown>) : null;
  }

  listByJob(jobId: string): ArtifactRow[] {
    return this.db.raw
      .prepare(
        `SELECT a.*, j.token_id AS job_token_id, j.status AS job_status
         FROM artifacts a JOIN jobs j ON j.id = a.job_id
         WHERE a.job_id = ? ORDER BY a.rowid`,
      )
      .all(jobId)
      .map((r) => this.map(r as Record<string, unknown>));
  }

  /**
   * Update the stored metadata of an artifact (used by the MP3 transcode
   * step: new media_type/size/sha256/codec + source_artifact_id +
   * provenance). Only the provided fields change. Returns the row count.
   */
  updateMeta(
    id: string,
    patch: {
      mediaType?: string;
      size?: number;
      sha256?: string;
      codec?: string;
      sampleRate?: number | null;
      channels?: number | null;
      bitrate?: number | null;
      durationSeconds?: number | null;
      sourceArtifactId?: string;
      provenance?: string;
      storageKey?: string;
    },
  ): number {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    const set = (col: string, v: string | number | null): void => {
      sets.push(`${col} = ?`);
      params.push(v);
    };
    if (patch.mediaType !== undefined) set("media_type", patch.mediaType);
    if (patch.size !== undefined) set("size", patch.size);
    if (patch.sha256 !== undefined) set("sha256", patch.sha256);
    if (patch.codec !== undefined) set("codec", patch.codec);
    if (patch.sampleRate !== undefined) set("sample_rate", patch.sampleRate);
    if (patch.channels !== undefined) set("channels", patch.channels);
    if (patch.bitrate !== undefined) set("bitrate", patch.bitrate);
    if (patch.durationSeconds !== undefined) set("duration_seconds", patch.durationSeconds);
    if (patch.sourceArtifactId !== undefined) set("source_artifact_id", patch.sourceArtifactId);
    if (patch.provenance !== undefined) set("provenance", patch.provenance);
    if (patch.storageKey !== undefined) set("storage_key", patch.storageKey);
    if (sets.length === 0) return 0;
    params.push(id);
    return Number(
      this.db.raw.prepare(`UPDATE artifacts SET ${sets.join(", ")} WHERE id = ?`).run(...params)
        .changes,
    );
  }

  private map(row: Record<string, unknown>): ArtifactRow {
    return {
      id: String(row.id),
      jobId: String(row.job_id),
      filename: String(row.filename),
      mediaType: String(row.media_type),
      size: Number(row.size),
      source: String(row.source),
      storageKey: String(row.storage_key),
      durationSeconds: row.duration_seconds == null ? null : Number(row.duration_seconds),
      codec: row.codec == null ? null : String(row.codec),
      sampleRate: row.sample_rate == null ? null : Number(row.sample_rate),
      channels: row.channels == null ? null : Number(row.channels),
      bitrate: row.bitrate == null ? null : Number(row.bitrate),
      sourceArtifactId: row.source_artifact_id == null ? null : String(row.source_artifact_id),
      sha256: row.sha256 == null ? null : String(row.sha256),
      provenance: row.provenance == null ? null : String(row.provenance),
      createdAt: String(row.created_at),
      tokenId: row.job_token_id == null ? null : String(row.job_token_id),
      jobStatus: row.job_status == null ? null : String(row.job_status),
    };
  }
}
