# NLO-P4 — Provider Capability Contracts

Mission: **NLO-P4-0**. Companion to [`NLO_P4_TARGET_ARCHITECTURE.md`](NLO_P4_TARGET_ARCHITECTURE.md) §4 (Provider Management context) and **ADR-001**.
Baseline: `main @ 76cd5f03`. Design document — no code changes.

---

## 1. Why contracts, not interfaces alone

NLO already has a `NotebookLMProvider` interface with honest `CapabilityLevel` values (`implemented_tested | implemented_untested_live | experimental | unsupported | unavailable`) and `ProviderFailure` with 8 `FailureClass` values (`packages/shared/src/types.ts`). The P4 gap is _governance_:

1. **Capabilities are currently declared per-adapter in code** — there is no machine-readable registry a job can query at admission ("can provider X do `infographic` right now?").
2. **No conformance test** proves an adapter's declared capability is real. Today the capability map _is_ the test expectation — P4 makes it a _suite_.
3. **New provider kinds** (external MCP servers, image engines) have no place to declare their limits — risk of _inflated_ capabilities (AGENTS.md §4: "Never report an unsupported operation as successful").

**Contract = (a) a capability declaration (data), (b) an operation interface (code), (c) a conformance suite (tests), (d) an admission check (runtime).** All four are required for a provider to be `active` in the registry.

## 2. Capability model (schema)

```ts
// proposed (packages/shared) — data, serializable, versioned
type ProviderCapability = {
  operation:
    | "notebook.create"
    | "source.add.text"
    | "source.add.file"
    | "source.add.url"
    | "source.add.audio"
    | "source.add.video"
    | "source.add.pdf"
    | "source.add.docx"
    | "source.add.md"
    | "chat.ask" // grounded Q&A with citations
    | "generate.audio.deep_dive"
    | "generate.audio.brief"
    | "generate.audio.critique"
    | "generate.audio.debate"
    | "generate.audio.language.en"
    | "generate.audio.language.fa"
    | "generate.audio.language.other"
    | "generate.video.explainer"
    | "generate.video.cinematic"
    | "generate.video.short"
    | "generate.slide_deck"
    | "generate.infographic"
    | "generate.quiz"
    | "generate.flashcards"
    | "generate.mind_map"
    | "generate.report"
    | "generate.data_table"
    | "artifact.download"
    | "artifact.download.batch"
    | "usage.introspect"
    | "session.verify";
  level: CapabilityLevel; // the 5 existing levels — no new values
  formats?: string[]; // e.g. audio: ["wav","mp3","m4a","ogg","flac"]
  maxInputBytes?: number; // per-source limit
  maxConcurrent?: number; // provider-level concurrency ceiling (default 1)
  asyncPattern?: "blocking" | "task_id_poll" | "webhook";
  egressPolicy: "must-tunnel" | "tunnel-preferred" | "direct-allowed";
  note?: string; // human note, redaction-safe
};

type ProviderDescriptor = {
  id: string; // e.g. "notebooklm.web", "notebooklm.android",
  // "notebooklm.enterprise", "mcp.roomi", "img.<vendor>"
  name: string;
  kind: "native_python" | "native_mcp" | "external_mcp" | "http" | "cli";
  transport: string; // "web-batchexecute" | "android-grpc" | "enterprise-https" | "mcp-stdio"
  capabilities: ProviderCapability[];
  authRequirement: {
    // what the Account Manager must provide
    credentialKinds: ("storage_state" | "master_token" | "enterprise_sso")[];
    hostProfiles: ("consumer" | "enterprise")[];
  };
  egressPolicy: "must-tunnel" | "tunnel-preferred" | "direct-allowed"; // default for all ops
  maxConcurrent: number;
  version: string; // library/server version the descriptor was verified against
  verifiedAt: string; // ISO date of last conformance run
  status: "active" | "candidate" | "disabled";
};
```

Rules:

- **Undeclared = unavailable.** The existing `buildInputMatrix` principle ("A format the provider does not declare is reported 'unavailable' — never guessed") extends from input formats to _all_ operations. (VERIFIED in [`packages/shared/src/input-capabilities.ts`](../../packages/shared/src/input-capabilities.ts).)
- **`level` is the honest label.** An operation at `experimental` may be used but must be flagged in job events and results; at `unavailable` the admission check rejects the job with a clear `E2E_PROVIDER`-class error _before_ anything runs.
- **Capability changes are data changes** — a provider "gains" an operation by a versioned descriptor change + a passing conformance suite, never by an implicit code path.
- **`maxConcurrent` is enforced by the Job Engine**, not by the adapter (the engine knows about the queue; the adapter stays stateless).

## 3. Operation interface (what every adapter implements)

```ts
// proposed (packages/shared) — the only interface adapters implement
type ContentProvider = {
  readonly descriptor: ProviderDescriptor;
  verify(creds: CredentialRef, egress: EgressEndpoint): Promise<VerifyResult>;
  createNotebook(input: NotebookInput, ctx: Ctx): Promise<OpHandle>;
  addSource(nb: OpHandle, source: SourceInput, ctx: Ctx): Promise<OpHandle>;
  ask(nb: OpHandle, q: QuestionInput, ctx: Ctx): Promise<OpHandle>;
  generate(nb: OpHandle, kind: GenerateKind, opts: GenerateOpts, ctx: Ctx): Promise<OpHandle>;
  poll(op: OpHandle, ctx: Ctx): Promise<OpState>; // {pending|done|failed, externalId?, error?}
  fetchArtifact(op: OpHandle, dest: ArtifactDest, ctx: Ctx): Promise<ArtifactResult>;
  cancel?(op: OpHandle, ctx: Ctx): Promise<CancelResult>; // optional; absence is fine (NotebookLM: in-flight op may complete server-side)
};

type Ctx = {
  job: JobRef; // correlation id, attempt number
  creds: CredentialRef; // account session (never the raw secret)
  egress: EgressEndpoint; // loopback port + expected egressIp (Egress Gateway, ADR-004)
  signals: AbortSignal; // job cancel
  logger: RedactedLogger; // redaction applied at the boundary
};

type OpHandle = {
  providerId: string;
  externalId?: string; // MUST be returned as soon as the external op exists
  kind: string;
};
```

Non-negotiables (each maps to an existing VERIFIED invariant):

1. **`externalId` as early as possible.** The podcast pipeline's "persist the task id the moment it exists" rule (VERIFIED — `patchOperationIds` in [`jobs.repo.ts`](../../apps/server/src/domain/jobs.repo.ts)) becomes a contract: any adapter that learns an external id must surface it in the first `OpHandle`/`OpState`. This is the resume-never-resubmit anchor.
2. **Failures are classified, not stringly-typed.** Adapters throw `ProviderFailure { failureClass, ambiguous, needsReauth, message }` (existing type). `ambiguous: true` ⇒ never auto-retried (existing `RETRYABLE` map).
3. **No network outside the given `egress` endpoint.** An adapter that opens its own egress (an external MCP server _does_ — it owns its cookies and network) must declare `egressPolicy: "tunnel-preferred"` and the platform records `resultProvenance` with an `egressExternal: true` marker.
4. **Cancellation semantics are declared.** NotebookLM: cancel kills the _local_ worker; the server-side op may still complete (VERIFIED comment in `python-worker-provider.ts`). Adapters state this in `descriptor.note` and in cancel results.
5. **Concurrency is the engine's job.** Adapters are called one in-flight op at a time _unless_ `maxConcurrent > 1` is proven by the conformance suite.

## 4. Conformance suite (what "declared = tested" means)

Per adapter, run in CI (mock/live split as today):

| Suite                     | Level                  | Checks                                                                                                                                                                                                                             |
| ------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **C1 Declaration lint**   | unit                   | descriptor parses; every `operation` is a known id; levels valid; `maxConcurrent ≥ 1`; egress policy in enum; `verifiedAt` not older than X days (warning, not failure)                                                            |
| **C2 Capability honesty** | unit                   | for each declared operation: a test _exists_ exercising it (test-name convention `c2:<provider>:<op>`); for each _undeclared_ operation the adapter rejects with a clean error (no crash, no success)                              |
| **C3 Lifecycle**          | integration            | create→add→generate→poll→fetchArtifact happy path against the adapter's _mock_ (mock provider per AGENTS.md §5); `externalId` appears before first poll; cancel mid-op settles exactly once (mirrors WorkerSupervisor settle-once) |
| **C4 Failure classes**    | integration            | injected faults (mock) produce the declared `failureClass`; `ambiguous` faults are _not_ retried by the engine; `needsReauth` transitions the account state machine                                                                |
| **C5 Concurrency**        | integration (load)     | `maxConcurrent` ops in parallel; no interleaved external ids; queue never wedges (settle-once invariant)                                                                                                                           |
| **C6 Egress**             | integration            | with a mock egress endpoint, all adapter traffic flows through it (no direct socket); with `must-tunnel` policy and a dead endpoint, the adapter fails closed                                                                      |
| **C7 Live**               | manual gate (never CI) | real account + real tunnel: one job per _key_ operation, `resultProvenance: real`, artifact sha256 recorded (the existing live-verification scripts are the template)                                                              |

A provider is `active` only when C1–C6 are green at its `version`; C7 flips `implemented_untested_live` → `implemented_tested`… precisely: **live evidence upgrades the _note_, not the level** — the level taxonomy stays 5 values.

## 5. Baseline mapping: what the existing adapter declares

`notebooklm-py` 0.8.5 in the Python worker (VERIFIED audit of `python-worker-provider.ts`, 894 lines):

| Operation                                                                                                                                                                | Level (honest)                                                                                                                                                       | Evidence                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `notebook.create`, `source.add.text`, `source.add.file` (audio formats wav/mp3/m4a/ogg/flac; doc txt/docx/srt)                                                           | `implemented_tested`                                                                                                                                                 | unit+integration tests (provider-audio.test.ts, e2e-text-to-podcast.test.ts) |
| `chat.ask`                                                                                                                                                               | `implemented_tested` + `LIVE_VERIFIED` (2026-11-06)                                                                                                                  | CHANGELOG NLO-P2                                                             |
| `generate.audio.*` (formats deep_dive/brief/critique/debate; lengths short/default/long; languages en/fa)                                                                | `implemented_tested` + `LIVE_VERIFIED`                                                                                                                               | resume-never-resubmit pipeline; FI-01…FI-19 fault matrix                     |
| `artifact.download` (audio MP3/M4A + transcode)                                                                                                                          | `implemented_tested`                                                                                                                                                 | artifact-download.test.ts                                                    |
| `session.verify`                                                                                                                                                         | `implemented_tested`                                                                                                                                                 | auth_sessions verification path                                              |
| `generate.video.*`, `generate.infographic`, `generate.slide_deck`, `generate.quiz`, `generate.flashcards`, `generate.mind_map`, `generate.report`, `generate.data_table` | `not_implemented` **for NLO** (upstream library _supports_ them — `implemented_untested_live` at the library level, `NOT_IMPLEMENTED` in NLO's worker surface today) | python-worker-provider.ts exposes only job/job_text/audio ops                |
| `source.add.pdf` / `.md` / `.url` / `.video`                                                                                                                             | `NOT_IMPLEMENTED` in NLO worker (library supports)                                                                                                                   | same                                                                         |
| `usage.introspect`                                                                                                                                                       | `NOT_IMPLEMENTED` in NLO                                                                                                                                             | library has `notebooklm usage`                                               |

**Key consequence for P4-2 (templates T1–T4):** T1/T2 (podcasts) run on _implemented_ capabilities today. T3/T4 (vertical infographic / reels-shorts video) require the worker surface to be _extended_ to `generate.infographic` / `generate.video.*` — the upstream library already supports them (notebooklm-py README feature table, VERIFIED 2026-11-15), so the delta is NLO worker ops + artifact delivery, not a new library.

## 6. External MCP providers (contract fit)

An external MCP server (e.g. roomi-fields) is wrapped in a `ContentProvider` adapter whose `kind: "external_mcp"`:

- **Descriptor** is _derived_: the adapter parses the server's `tools/list` at startup and maps tool names → operations via a **per-server mapping file** (data, versioned). A tool with no mapping is _not_ a capability (undeclared = unavailable).
- **`externalId`**: MCP servers that support "retry without losing id" (roomi-fields v4.6.0, VERIFIED) expose the task id; the adapter records it in `OpHandle.externalId`. Servers without it are capped: `asyncPattern: "blocking"`, and the engine treats mid-op death as `ambiguous` (no blind resubmit).
- **Concurrency**: default `maxConcurrent: 1` for external MCP (desktop-grade evidence: `MAX_SESSIONS=10` browser sessions at the _server_, but tool-level concurrency undocumented → conservative).
- **Egress**: `egressPolicy: "tunnel-preferred"` + `egressExternal: true` provenance marker (the server's own network is outside NLO's tunnel — honest accounting).

## 7. Provider health & admission (runtime behavior)

The registry exposes `providerStatus(id) → { descriptor, lastConformance, activeAccounts, activeNodes }` (composes Account + Egress context state — no new stores needed; the job table already records `node_id`/account per attempt).

Admission (Job Engine, per job):

1. Resolve requested/eligible **provider** (job input may name one; default = best capability match for the requested operations).
2. Check **capabilities** for every operation the job needs → any `unavailable` ⇒ reject with `E2E_PROVIDER` (pre-run, cheap, honest).
3. Acquire **account** (Account Manager routing: priority → quota → affinity → rotation; ADR-003) ⇒ `WAITING_FOR_ACCOUNT` if none verified.
4. Acquire **egress** (Egress Gateway, ADR-004) ⇒ `WAITING_FOR_PROXY` if no healthy node (fail-closed).
5. `RUNNING` with the full `Ctx`.

This is the _existing_ admission order (account→proxy→run) with provider selection added at step 1 — the state machine gains no new statuses for P4 (provider selection happens inside `VALIDATING`/`QUEUED`).
