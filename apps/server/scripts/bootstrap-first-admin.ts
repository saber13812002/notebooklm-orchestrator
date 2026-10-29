/**
 * First-admin bootstrap — OFFLINE CLI (Phase 2, closes the F2 gap).
 *
 * Run (on the host that owns the data directory, service NOT running):
 *   npm run bootstrap:admin --workspace @nlo/server
 *   npm run bootstrap:admin --workspace @nlo/server -- --name my-admin
 *
 *   With a non-default data dir (e.g. on s52):
 *   NLO_DATA_DIR=/home/saber/saberprojects/notebooklm-orchestrator/data \
 *     npm run bootstrap:admin --workspace @nlo/server
 *
 * What it does:
 *   - Opens the app SQLite DB (NLO_DATA_DIR, default ./data) read-write.
 *   - Refuses to run if ANY active (enabled, not-revoked) token exists.
 *   - Creates a full-scope admin token (all scopes by default).
 *   - Prints the plaintext token EXACTLY ONCE. Only its SHA-256 hash is
 *     stored; it can never be read back.
 *
 * Safety:
 *   - No HTTP endpoint is involved (this is not a public/admin route).
 *   - Run with the service stopped so both processes do not hold the DB.
 *   - Re-running after setup is impossible unless all tokens are revoked
 *     first (documented recovery path).
 *   - Never prints secrets other than the one-time token disclosure.
 */
import { loadConfig, loadDotEnv, dataPaths } from "../src/config.js";
import { Db } from "../src/db/db.js";
import {
  FirstAdminAlreadyBootstrappedError,
  bootstrapFirstAdmin,
} from "../src/domain/first-admin.js";

function main(): void {
  loadDotEnv();
  const config = loadConfig();
  const paths = dataPaths(config.dataDir);

  // Parse --name <name> (the only supported option).
  let name: string | undefined;
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === "--name") name = process.argv[i + 1];
    i++;
  }

  const db = Db.open(paths.dbFile);
  try {
    const { token, plaintext } = bootstrapFirstAdmin(db, name ? { name } : {});
    console.log("first-admin bootstrap OK");
    console.log(`  data dir : ${config.dataDir}`);
    console.log(`  token id : ${token.id}`);
    console.log(`  name     : ${token.name}`);
    console.log(`  scopes   : ${token.scopes.join(", ")}`);
    console.log("");
    console.log("  TOKEN (shown only once — copy it now, it cannot be read back):");
    console.log(`  ${plaintext}`);
    console.log("");
    console.log("Next steps:");
    console.log("  1. Store the token securely (secret manager / 0600 file, never git).");
    console.log("  2. To enforce auth on /api/v1, set NLO_API_AUTH=1 in the service env");
    console.log("     and restart (deployment procedure). Rollback: NLO_API_AUTH=0.");
    console.log("  3. Rotate this token later via the admin-scoped API");
    console.log("     (create a new token, then DELETE /api/v1/tokens/<id>).");
  } catch (err) {
    if (err instanceof FirstAdminAlreadyBootstrappedError) {
      console.error(err.message);
      process.exitCode = 1;
    } else {
      throw err;
    }
  } finally {
    db.close();
  }
}

main();
