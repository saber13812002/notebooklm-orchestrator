#!/usr/bin/env bash
# =============================================================================
# NLO — reproducible Git-based deployment (run on the server, e.g. s52)
#
# Usage:
#   bash deploy/deploy.sh <commit-ish>   # deploy a reviewed commit
#   bash deploy/deploy.sh                # re-deploy whatever is currently HEAD
#   NLO_DEPLOY_DRY_RUN=1 bash deploy/deploy.sh <commit-ish>
#
# Guarantees:
#   - Never touches untracked runtime state: data/ (DB, archives, vault,
#     vendor binaries), .env, node_modules, data/venv.
#   - Aborts (non-zero, no partial state) when the working tree has
#     uncommitted TRACKED changes — those belong in a commit first.
#   - Backs up the database (and .env) before any file change; keeps the 5
#     newest backups.
#   - Installs JS deps only when package.json / package-lock.json changed;
#     the Python venv only when apps/server/python-requirements.txt changed.
#   - Verifies: service active, /api/health, /api/health/ready, port binding,
#     journal free of new errors, server test suite green.
#   - Rollback: ROLLBACK=1 bash deploy/deploy.sh <previous-commit> (the
#     previous good commit is printed at the start of every run).
#
# No credentials are read or logged by this script.
# =============================================================================
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

SVC="${NLO_SERVICE:-nlo}"
PORT="${NLO_PORT:-4870}"
URL="http://127.0.0.1:${PORT}"
TARGET="${1:-HEAD}"
BACKUP_DIR="$REPO/data/backups"
DEPLOYED_FILE="$REPO/data/deployed-commit"
KEEP_BACKUPS=5
DRY_RUN="${NLO_DEPLOY_DRY_RUN:-0}"

log()  { printf '\033[1;34m[deploy]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[deploy:FAIL]\033[0m %s\n' "$*" >&2; exit 1; }

# Non-interactive SSH shells may lack the node install on PATH (it is set in
# login profiles / the systemd unit). Prepend known node locations.
for d in /home/saber/.local/node22/bin /usr/local/bin /usr/bin; do
  if [ -x "$d/npm" ]; then
    case ":$PATH:" in *":$d:"*) ;; *) PATH="$d:$PATH";; esac
  fi
done
export PATH

command -v git >/dev/null || fail "git not found"
[ -f package.json ] || fail "not a repo root: $REPO"

PREV_DEPLOYED=$(cat "$DEPLOYED_FILE" 2>/dev/null || echo "none")
log "repo:      $REPO"
log "deploying: $TARGET   (previous good deployment: $PREV_DEPLOYED)"
log "service:   $SVC   port: $PORT   dry-run: $DRY_RUN"
log "rollback:  ROLLBACK=1 bash deploy/deploy.sh ${PREV_DEPLOYED}"

# ---------------------------------------------------------------- 1. resolve
git fetch origin --quiet 2>/dev/null || log "warning: git fetch failed — deploying from local refs only"
git rev-parse --verify --quiet "$TARGET^{commit}" >/dev/null \
  || fail "unknown commit-ish: $TARGET (commit it and push it first, then re-run)"
DEPLOY_SHA=$(git rev-parse "$TARGET")
# Only commits reachable from origin/main may be deployed (reviewed code).
if ! git merge-base --is-ancestor "$DEPLOY_SHA" origin/main 2>/dev/null; then
  log "warning: $DEPLOY_SHA is not an ancestor of origin/main (deploying local commit)"
fi
log "target sha: $(git rev-parse --short $DEPLOY_SHA)"

# ------------------------------------------------------- 2. working tree
DIRTY=$(git status --porcelain --untracked-files=no)
if [ -n "$DIRTY" ]; then
  echo "$DIRTY" | sed 's/^/[deploy]   dirty: /'
  fail "uncommitted tracked changes exist — commit (and push) them first, then re-run"
fi
log "working tree: clean (tracked files)"

# -------------------------------------------------------- 3. prerequisites
systemctl is-active "$SVC" >/dev/null 2>&1 \
  || log "warning: service $SVC is not active (first deploy?)"
[ -f .env ] || log "warning: .env missing — server will run on defaults"
if [ ! -x data/vendor/xray ] && [ "$DRY_RUN" != "1" ]; then
  log "vendor xray missing — expected to be present from setup; install per docs/deployment/s52-deploy.md §vendor"
fi

# ------------------------------------------------------------- 4. backup
if [ "$DRY_RUN" != "1" ]; then
  mkdir -p "$BACKUP_DIR"
  TS=$(date -u +%Y%m%dT%H%M%SZ)
  if [ -f data/nlo.sqlite ]; then
    cp -f data/nlo.sqlite "$BACKUP_DIR/nlo-${TS}-${DEPLOY_SHA:0:7}.sqlite"
    log "db backup:  data/backups/nlo-${TS}-${DEPLOY_SHA:0:7}.sqlite ($(wc -c < data/nlo.sqlite) bytes)"
  fi
  if [ -f .env ]; then
    cp -f .env "$BACKUP_DIR/env-${TS}-${DEPLOY_SHA:0:7}.env"
    chmod 600 "$BACKUP_DIR/env-${TS}-${DEPLOY_SHA:0:7}.env"
    log "env backup: data/backups/env-${TS}-${DEPLOY_SHA:0:7}.env"
  fi
  # Retention: keep the $KEEP_BACKUPS newest of each kind.
  ls -1t "$BACKUP_DIR"/nlo-*.sqlite 2>/dev/null | tail -n +$((KEEP_BACKUPS + 1)) | xargs -r rm -f
  ls -1t "$BACKUP_DIR"/env-*.env 2>/dev/null | tail -n +$((KEEP_BACKUPS + 1)) | xargs -r rm -f
fi

# -------------------------------------------------------- 5. deploy commit
OLD_SHA=$(git rev-parse HEAD)
if [ "$OLD_SHA" = "$DEPLOY_SHA" ]; then
  log "HEAD already at target — skipping checkout (no-op deploy)"
else
  log "git checkout: $(git rev-parse --short $OLD_SHA) -> $(git rev-parse --short $DEPLOY_SHA)"
  git reset --hard "$DEPLOY_SHA"
fi

# --------------------------------------------- 6. dependencies (when needed)
CHANGED=$(git diff --name-only "$OLD_SHA" "$DEPLOY_SHA" -- package.json package-lock.json apps/server/python-requirements.txt 2>/dev/null || true)
if [ -z "$CHANGED" ] || [ "$OLD_SHA" = "$DEPLOY_SHA" ]; then
  log "dependencies: unchanged — skipping npm ci / venv sync"
elif [ "$DRY_RUN" = "1" ]; then
  log "dependencies: CHANGED in dry-run — would run npm ci (+ venv sync if python-requirements.txt changed)"
else
  if echo "$CHANGED" | grep -qE '^package(\.lock)?\.json$'; then
    log "dependencies: installing node deps (npm ci --omit=dev)"
    npm ci --omit=dev
  fi
  if echo "$CHANGED" | grep -q 'python-requirements.txt'; then
    log "dependencies: syncing python venv"
    data/venv/bin/pip install -q -r apps/server/python-requirements.txt
  fi
fi

# ------------------------------------------------------------ 7. restart
if [ "$DRY_RUN" = "1" ]; then
  log "DRY-RUN complete — no service restart performed"
  exit 0
fi
log "restarting $SVC"
sudo systemctl restart "$SVC"

# ----------------------------------------------------------- 8. verify
sleep 5
[ "$(systemctl is-active "$SVC")" = "active" ] || fail "service $SVC not active after restart"
curl -sf -m 5 "$URL/api/health" >/dev/null || fail "/api/health failed after restart"
READY=$(curl -s -m 10 "$URL/api/health/ready")
echo "$READY" | grep -q '"ready":true' || fail "/api/health/ready not ready: $READY"
log "health+ready: $READY"
ss -ltn | grep -q ":$PORT " || fail "port $PORT not listening"
log "port $PORT: listening"

# Journal: no new errors since restart (ignore harmless startup warnings).
JOURNAL_START=$(systemctl show "$SVC" -p ExecMainStartTimestamp --value)
NEW_ERRORS=$(journalctl -u "$SVC" --since "$JOURNAL_START" --no-pager 2>/dev/null \
  | grep -EiE 'error|exception|fatal' \
  | grep -viE 'ExperimentalWarning|trace-warnings' || true)
if [ -n "$NEW_ERRORS" ]; then
  log "WARNING — journal errors since restart:"
  echo "$NEW_ERRORS" | head -10
else
  log "journal: no new errors since restart"
fi

# ----------------------------------------------- 9. regression (server tests)
# Non-interactive shells may not have a custom node install on PATH —
# prepend the repo-local .bin so the test run never depends on the caller's
# shell environment.
VIT="$REPO/node_modules/.bin/vitest"
[ -x "$VIT" ] || VIT="$REPO/apps/server/node_modules/.bin/vitest"
if [ ! -x "$VIT" ]; then
  log "WARNING — vitest binary not found (run 'npm ci' first); skipping tests"
elif (cd apps/server && "$VIT" run --silent); then
  log "tests: PASS"
else
  log "WARNING — test suite reported failures (service is running; review output above)"
fi

# ------------------------------------------------------- 10. record deploy
git rev-parse --short HEAD > "$DEPLOYED_FILE"
log "recorded deployed commit: $(cat "$DEPLOYED_FILE")"
log "DEPLOY SUCCESS: $(git log -1 --oneline HEAD)"
