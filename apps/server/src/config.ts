import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface AppConfig {
  host: string;
  port: number;
  dataDir: string;
  vaultKey: string | null;
  provider: "mock" | "python-worker";
  proxyRuntime: "mock" | "xray";
  maxUploadBytes: number;
  allowedAudioExtensions: string[];
  liveTestsEnabled: boolean;
  /** SSRF allowlist for health checks (host[:port] entries). */
  healthAllowlist: string[];
  /** Python interpreter for the notebooklm worker (default "python3"). */
  pythonBin: string;
  /**
   * Browser channel for interactive login: "chromium" (bundled Playwright
   * build) or "chrome"/"msedge" (system-installed browser, used when the
   * bundled download is unavailable). Default "chromium".
   */
  loginBrowser: string;
  /** Hard timeout for a live job (ms). */
  jobTimeoutMs: number;
  /** Development only: allow live jobs without a proxy tunnel. */
  allowDirectEgress: boolean;
  /**
   * When true, the versioned API surface (/api/v1) REQUIRES a valid API
   * token (Authorization: Bearer nlo_...). Loopback UI traffic to the
   * legacy /api routes is unaffected. Default false: tokens are optional
   * (used for audit attribution + idempotency) until the operator
   * enables enforcement.
   */
  apiAuthEnforced: boolean;
  /** Rate limit window (requests per window) for token-authenticated /api/v1 traffic. */
  apiRateLimitMax: number;
  /** Rate limit window duration. */
  apiRateLimitWindowMs: number;
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..", "..");

/** Env getter honoring `loadConfig` overrides over process.env. */
type EnvGetter = (name: string) => string | undefined;

function intEnv(env: EnvGetter, name: string, def: number): number {
  const raw = env(name);
  if (!raw) return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`env ${name} must be a non-negative integer`);
  return n;
}

function boolEnv(env: EnvGetter, name: string, def: boolean): boolean {
  const raw = env(name);
  if (raw === undefined || raw === "") return def;
  if (["1", "true", "yes", "on"].includes(raw.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(raw.toLowerCase())) return false;
  throw new Error(`env ${name} must be a boolean`);
}

/**
 * Minimal .env loader (no dependency): reads <repo>/.env if present and sets
 * variables that are not already set in the environment (real env always
 * wins). Called explicitly by the server entrypoint and the live scripts;
 * tests never call it, so test isolation is unaffected.
 */
export function loadDotEnv(): void {
  const p = path.join(REPO_ROOT, ".env");
  if (!existsSync(p)) return;
  let text: string;
  try {
    text = readFileSync(p, "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

/**
 * Load and validate configuration. Fails fast on invalid values.
 * Secrets are NOT logged. `dataDir` is created if missing.
 */
export function loadConfig(overrides: Partial<Record<string, string>> = {}): AppConfig {
  const env = (name: string): string | undefined =>
    overrides[name] !== undefined ? overrides[name] : process.env[name];

  const host = env("NLO_HOST") ?? "127.0.0.1";
  if (!/^[a-fA-F0-9:.]+$/.test(host) && host !== "localhost") {
    throw new Error(`invalid NLO_HOST: ${host}`);
  }

  const dataDir = path.resolve(env("NLO_DATA_DIR") ?? path.join(REPO_ROOT, "data"));
  mkdirSync(dataDir, { recursive: true });

  const vaultKey = env("NLO_VAULT_KEY");
  if (vaultKey !== undefined && !/^[0-9a-fA-F]{64}$/.test(vaultKey)) {
    throw new Error("NLO_VAULT_KEY must be 64 hex chars (32 bytes)");
  }

  const provider = env("NLO_PROVIDER") ?? "mock";
  if (!["mock", "python-worker"].includes(provider)) {
    throw new Error("NLO_PROVIDER must be 'mock' or 'python-worker'");
  }
  const proxyRuntime = env("NLO_PROXY_RUNTIME") ?? "mock";
  if (!["mock", "xray"].includes(proxyRuntime)) {
    throw new Error("NLO_PROXY_RUNTIME must be 'mock' or 'xray'");
  }

  const maxUploadBytes = intEnv(env, "NLO_MAX_UPLOAD_BYTES", 200 * 1024 * 1024);
  if (maxUploadBytes > 5 * 1024 * 1024 * 1024) {
    throw new Error("NLO_MAX_UPLOAD_BYTES is unreasonably large");
  }

  const allowedAudioExtensions = (env("NLO_ALLOWED_AUDIO_EXTENSIONS") ?? "wav,mp3,m4a,ogg,flac")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const healthAllowlist = (
    env("NLO_HEALTH_ALLOWLIST") ?? "api.ipify.org:443,notebooklm.google.com:443"
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    host,
    port: intEnv(env, "NLO_PORT", 4870),
    dataDir,
    vaultKey: vaultKey ?? null,
    provider: provider as AppConfig["provider"],
    proxyRuntime: proxyRuntime as AppConfig["proxyRuntime"],
    maxUploadBytes,
    allowedAudioExtensions,
    liveTestsEnabled: boolEnv(env, "NLO_LIVE_TESTS", false),
    healthAllowlist,
    pythonBin: env("NLO_PYTHON_BIN") ?? "python3",
    loginBrowser: env("NLO_LOGIN_BROWSER") ?? "chromium",
    jobTimeoutMs: intEnv(env, "NLO_JOB_TIMEOUT_MS", 30 * 60_000),
    allowDirectEgress: boolEnv(env, "NLO_ALLOW_DIRECT_EGRESS", false),
    apiAuthEnforced: boolEnv(env, "NLO_API_AUTH", false),
    apiRateLimitMax: intEnv(env, "NLO_API_RATE_LIMIT_MAX", 120),
    apiRateLimitWindowMs: intEnv(env, "NLO_API_RATE_LIMIT_WINDOW_MS", 60_000),
  };
}

export function dataPaths(dataDir: string) {
  return {
    dbFile: path.join(dataDir, "nlo.sqlite"),
    jobsDir: path.join(dataDir, "jobs"),
    vaultDir: path.join(dataDir, "vault"),
    vaultKeyFile: path.join(dataDir, "vault.key"),
    tempDir: path.join(dataDir, "tmp"),
    sessionsDir: path.join(dataDir, "sessions"),
    vendorDir: path.join(dataDir, "vendor"),
  };
}
