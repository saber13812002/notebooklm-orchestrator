import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  {
    // tmp/ is scratch space (probes, repro scripts, evidence dumps) and must
    // never be committed; it is excluded from lint the same way data/ is.
    ignores: ["**/dist/**", "**/node_modules/**", "data/**", "**/vendor/**", "tmp/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.es2022 },
    },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-console": "off",
    },
  },
  // ── P4-1D: context boundary rules (audit map §4.4) ─────────────────────────
  // The two rules P4-1 actually creates: provider←orchestration, and
  // orchestration←proxy-seam-only. The remaining boundaries from the
  // architecture doc are added incrementally — a 9-rule set on day one is a
  // lint-churn risk (AGENT-C-P4-1-IMPLEMENTATION-MAP.md §4.4).
  //
  // Context map:  Provider Mgmt   = apps/server/src/providers/**
  //               Job Orchestration = apps/server/src/queue/** +
  //                                   domain/jobs*.ts + domain/stages.repo.ts
  //               Egress & Proxy  = apps/server/src/proxy/** + domain/proxies*.ts
  //
  // Pattern syntax (ESLint 9 no-restricted-imports): `group` entries are
  // GLOBs; real regexes go in the `regex` field of each pattern object
  // (matched against the raw import source, flags "iu").
  {
    files: ["apps/server/src/providers/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "^\\.\\./domain/jobs[\\w.-]*\\.js$",
              message: "Provider Management must not import Job Orchestration (jobs repo/lock).",
            },
            {
              regex: "^\\.\\./queue/[\\w-]+\\.js$",
              message: "Provider Management must not import the queue engine.",
            },
            {
              regex: "^\\.\\./domain/stages\\.repo\\.js$",
              message: "Provider Management must not import the stage repository.",
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      "apps/server/src/queue/**/*.ts",
      "apps/server/src/domain/jobs*.ts",
      "apps/server/src/domain/stages.repo.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "^\\.\\./proxy/(?!gateway\\.js$|egress\\.js$)[\\w-]+\\.js$",
              message:
                "Job Orchestration may only touch the proxy context via proxy/gateway.js and proxy/egress.js.",
            },
          ],
        },
      ],
    },
  },
);
