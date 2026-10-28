/**
 * NLO API client example — Phase C6.
 *
 * Self-contained (Node 18+ global fetch, zero dependencies). Run against a
 * REAL running instance — mock or live provider; there are no mocks here:
 *
 *   npx tsx docs/api/examples/client.ts [baseUrl]
 *   NLO_API_TOKEN=nlo_... npx tsx docs/api/examples/client.ts http://127.0.0.1:4870
 *
 * The token is optional in the default (loopback, optional-auth) mode and
 * required when the server runs with NLO_API_AUTH=true.
 */

const BASE_URL = process.argv[2] ?? "http://127.0.0.1:4870";
const V1 = `${BASE_URL}/api/v1`;
const TOKEN = process.env.NLO_API_TOKEN ?? null;

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return TOKEN ? { Authorization: `Bearer ${TOKEN}`, ...extra } : extra;
}

async function api(method: string, path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${V1}${path}`, {
    ...init,
    headers: headers(init.headers as Record<string, string>),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${method} ${path} -> ${res.status}: ${body}`);
  }
  return res;
}

async function buildCreateForm(): Promise<FormData> {
  const form = new FormData();
  // `prompt` is the only required field; `audio` is optional (extension
  // whitelist + non-empty). Provide a REAL file via NLO_AUDIO_FILE for a
  // full audio+prompt flow.
  form.append(
    "prompt",
    process.env.NLO_AUDIO_FILE
      ? "List the numbers spoken in the audio, in order."
      : "Answer in one sentence: what is this service for?",
  );
  form.append("title", "client-example");
  const audioFile = process.env.NLO_AUDIO_FILE;
  if (audioFile) {
    const bytes = new Uint8Array(await (await import("node:fs/promises")).readFile(audioFile));
    const name = (await import("node:path")).basename(audioFile);
    form.append("audio", new File([bytes], name));
  }
  return form;
}

async function main(): Promise<void> {
  // 1) Health (auth-exempt)
  const health = await (await fetch(`${BASE_URL}/api/health`)).json();
  console.log("health:", JSON.stringify(health));

  // 2) Create a job (idempotent; replay-safe with a token)
  const form = await buildCreateForm();
  const createRes = await api("POST", "/jobs", {
    method: "POST",
    headers: { "Idempotency-Key": `client-example-${Date.now()}` },
    body: form,
  });
  const { id, status } = (await createRes.json()) as { id: string; status: string };
  const replay = createRes.headers.get("x-idempotent-replay");
  console.log(`created job ${id} (${status})${replay ? " [idempotent replay]" : ""}`);

  // 3) Poll to a terminal state
  const terminal = new Set(["SUCCEEDED", "FAILED", "CANCELLED", "NEEDS_ATTENTION"]);
  let job: Record<string, unknown> = {};
  for (let i = 0; i < 120; i++) {
    job = await (await api("GET", `/jobs/${id}`)).json();
    const cur = job.status as string;
    if (terminal.has(cur)) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  console.log(`final status: ${job.status} (provenance: ${String(job.resultProvenance)})`);

  // 4) List artifacts and download each one
  const artifacts = (await (await api("GET", `/jobs/${id}/artifacts`)).json()) as Array<{
    id: string;
    filename: string;
  }>;
  for (const art of artifacts) {
    const res = await api("GET", `/jobs/${id}/artifacts/${art.id}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const dest = `./downloaded-${art.filename}`;
    await (await import("node:fs/promises")).writeFile(dest, buf);
    console.log(`downloaded ${art.filename} (${buf.byteLength} bytes) -> ${dest}`);
  }

  // 5) Token management (admin scope) + audit — only when a token was supplied
  if (TOKEN) {
    const audit = (await (await api("GET", "/audit?limit=5")).json()) as { total: number };
    console.log(`audit trail: ${audit.total} events for this token's server (limit 5 shown)`);
  } else {
    console.log("no NLO_API_TOKEN set — skipping token/audit introspection");
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
