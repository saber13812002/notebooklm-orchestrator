# Internal GitLab (`git.ai.ismc.ir`) — Mirror Setup & Sync Procedure

Status: **documented, blocked on a token.** The GitLab instance exists and is
reachable, but no NLO project has been created and no credential was found on
either host (verified in Phase A, see
[`docs/reports/PHASE_A_AUDIT.md`](../reports/PHASE_A_AUDIT.md)). Nothing in this
document has been executed against GitLab except read-only probes.

## 1. Role (dual-repository policy)

| Repo                                                 | Role                                                               |
| ---------------------------------------------------- | ------------------------------------------------------------------ |
| GitHub `saber13812002/notebooklm-orchestrator`       | **Source of truth** (public)                                       |
| GitLab `git.ai.ismc.ir` (internal, container on s52) | **One-way mirror** (internal CI/CD, organizational access control) |

Rules (also binding in [`AGENTS.md`](../../AGENTS.md)):

- Commits are **never** created first on GitLab. GitLab is a push target only.
- GitHub → GitLab mirror. No automatic push back to GitHub.
- The existing `origin` remote is never changed without verification and user
  approval.
- **No secrets ever** in any repo or on either CI (`.env`, cookies, tokens,
  VLESS UUIDs, vault keys). A CI secret scan is a hard gate when added.

## 2. What was verified (evidence)

| Fact                                                      | Evidence                                                                                         |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| GitLab CE 16.3.9 runs in a container **on s52**           | `docker ps -a` on s52                                                                            |
| `external_url` = `https://git.ai.ismc.ir` (→ 172.20.1.52) | container env                                                                                    |
| Sign-in page reachable                                    | `curl -o /dev/null -w '%{http_code}' https://git.ai.ismc.ir/users/sign_in` → `200` (from s52)    |
| API requires auth                                         | `GET /api/v4/projects?search=nlo` without token → `401`                                          |
| **No NLO project exists**                                 | anonymous project search for `notebooklm` / `nlo` → 0 results                                    |
| No `saber` user visible anonymously                       | user search returned nothing usable                                                              |
| Anonymous git access denied                               | `git ls-remote https://git.ai.ismc.ir/<any>/nlo.git` → "could not read Username" (auth required) |
| No GitLab credentials found on s52 or workstation         | shell history, env, ssh-agent, `/home/saber/.gitlab*` — none present                             |

## 3. What is needed (minimum-scope request)

One **Personal Access Token** for the maintainer account on `git.ai.ismc.ir`:

- Scope: **`api`** (needed to create the project and set up protected mirror
  settings). `read_repository` alone is **not enough** — project creation and
  project-settings writes require `api`.
- Expiry: shortest reasonable (e.g. 30–90 days), renewable.
- The token is used **only** to: create the project, enable mirror settings,
  and (for CI) authenticate the pipeline. It is stored as a GitLab CI/CD
  variable / locally in an **untracked** file — never in git, never in logs.

## 4. One-time setup (run on s52, after the token is provided)

> Replace `$GITLAB_TOKEN` with the value from an untracked env file
> (e.g. `export GITLAB_TOKEN=…` in a shell session). Never paste it into a
> command that gets recorded, and never commit it.

### 4.1 Create the project

```bash
curl -fsS --request POST "https://git.ai.ismc.ir/api/v4/projects" \
  --header "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  --header "Content-Type: application/json" \
  --data '{
    "path": "notebooklm-orchestrator",
    "name": "notebooklm-orchestrator",
    "visibility": "private",
    "description": "One-way mirror of github.com/saber13812002/notebooklm-orchestrator (source of truth: GitHub)",
    "default_branch": "main"
  }'
```

Expected: `201 Created` with the new project JSON (id, `web_url`,
`ssh_url_to_repo`). Record the id and URLs **in this file** (no secrets).

### 4.2 Add the remote and push the first mirror

```bash
cd /home/saber/saberprojects/notebooklm-orchestrator
git remote add gitlab https://git.ai.ismc.ir/<group-or-namespace>/notebooklm-orchestrator.git
git fetch gitlab --prune        # expect: empty/new remote, nothing to fetch
git push gitlab main
```

(Use the actual namespace from the `web_url` of step 4.1. If the GitLab
instance uses HTTPS with a self-signed or internal CA, verify the cert first —
do **not** blanket-disable verification; configure `http.<url>.extraHeader` or
the CA bundle instead.)

### 4.3 Ongoing mirror (manual, one-way)

After each push to GitHub:

```bash
git push gitlab main
```

Automation (optional, later): a cron on s52 that runs `git fetch origin &&
git push gitlab main` when `origin/main` is ahead of `gitlab/main`. Do **not**
add force-push automation in Phase B; mirror policy is append-only pushes.

### 4.4 CI on GitLab

- `.gitlab-ci.yml` is committed and mirrors `.github/workflows/ci.yml`
  (quality stage: lint → format:check → typecheck → test → build on node 22;
  docker stage gated behind `BUILD_DOCKER=1`).
- **No runner has been created.** Provisioning a runner (tag, registration
  token, Docker access) requires explicit maintainer approval — it is
  infrastructure, and per the mission no infrastructure changes happen in
  Phase B without permission.
- Once a runner exists: set the `BUILD_DOCKER=1` CI/CD variable if the docker
  stage should run; the quality stage works on any runner with Node 22.
- Token for CI: store `$GITLAB_TOKEN` (or a dedicated deploy-token with
  `read_repository`/`write_repository`) as a **masked, protected** CI/CD
  variable — never in the repo.

## 5. Verification checklist (after setup)

- [ ] Project exists, `visibility=private`, description states mirror role
- [ ] `git ls-remote gitlab main` shows the same SHA as `origin/main`
- [ ] `gitlab` remote present locally on s52; `origin` unchanged
- [ ] Token used only interactively / as CI variable; `git status` clean of
      secret files; token not in any log
- [ ] First internal pipeline (once a runner exists): quality stage green

## 6. Out of scope for Phase B

- No runner installation, no Docker-in-Docker, no GitLab runners on any host
  (infrastructure change → separate approval).
- No Webhook from GitHub → GitLab mirror (would require GitHub-side secrets;
  manual push is the Phase B mechanism).
- No changes to the GitLab container itself (version, external_url, ports).
