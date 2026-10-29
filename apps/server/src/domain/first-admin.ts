import type { Db } from "../db/db.js";
import {
  ALL_TOKEN_SCOPES,
  ApiTokensRepo,
  type ApiTokenRow,
  type TokenScope,
} from "./api-tokens.repo.js";

export class FirstAdminAlreadyBootstrappedError extends Error {
  constructor() {
    super(
      "first-admin bootstrap refused: an active API token already exists. " +
        "Normal token management goes through the admin-scoped API " +
        "(POST /api/v1/tokens). To re-bootstrap (recovery), revoke all " +
        "active tokens first, then run the bootstrap CLI again on the host.",
    );
    this.name = "FirstAdminAlreadyBootstrappedError";
  }
}

export interface FirstAdminResult {
  token: ApiTokenRow;
  /** Plaintext token — returned exactly once; only its hash is stored. */
  plaintext: string;
}

/**
 * First-admin bootstrap (closes the F2 gap: the API cannot create its own
 * first token, because token creation itself requires an `admin` token).
 *
 * Security model:
 *  - **Offline, CLI-only.** This runs directly against the data directory on
 *    the host (see `scripts/bootstrap-first-admin.ts`). There is NO HTTP
 *    endpoint — authenticated or not — that can mint the first admin token.
 *  - **One-shot.** Refuses to run while ANY active token (enabled and not
 *    revoked) exists. After the initial setup the ordinary lifecycle
 *    (create/revoke/rotate) is exclusively the admin-scoped API.
 *  - **Recovery path (documented):** revoke all active tokens, then re-run
 *    the CLI on the host. That is an operator action; it is not reachable
 *    over the network.
 *  - **Secret hygiene.** The plaintext is derived from a 32-byte CSPRNG,
 *    returned exactly once, and never stored or logged; only the SHA-256
 *    hash is persisted (same guarantee as `ApiTokensRepo.create`).
 *  - An audit event `first_admin_bootstrapped` is appended (token id only,
 *    never the plaintext), so the action is attributable.
 */
export function bootstrapFirstAdmin(
  db: Db,
  opts: { name?: string; scopes?: TokenScope[] } = {},
): FirstAdminResult {
  const tokens = new ApiTokensRepo(db);
  const active = tokens.list().filter((t) => t.enabled && !t.revokedAt);
  if (active.length > 0) {
    throw new FirstAdminAlreadyBootstrappedError();
  }
  // Name collision: `api_tokens.name` is UNIQUE across ALL rows, including
  // revoked ones (kept for audit attribution). At this point every existing
  // row is inactive (the gate above passed), so a name collision only ever
  // involves inactive tokens — e.g. re-running the recovery path after
  // revoking the original "first-admin". Pick the next free suffix so the
  // documented "revoke all -> re-run the CLI" procedure works as-is.
  const usedNames = new Set(tokens.list().map((t) => t.name));
  let name = opts.name ?? "first-admin";
  for (let i = 2; usedNames.has(name); i++) {
    name = `${opts.name ?? "first-admin"}-${i}`;
  }
  const scopes = opts.scopes ?? [...ALL_TOKEN_SCOPES];
  const { token, plaintext } = tokens.create({ name, scopes });
  tokens.audit({
    tokenId: token.id,
    tokenName: token.name,
    action: "first_admin_bootstrapped",
    method: "CLI",
    path: "local://bootstrap-first-admin",
    status: 200,
    detail: token.id,
    ip: null,
  });
  return { token, plaintext };
}
