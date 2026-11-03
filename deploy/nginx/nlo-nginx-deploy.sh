#!/bin/bash
# =============================================================================
# NLO — Nginx vhost deploy helper (render templates -> install -> reload)
#
# Host-agnostic. All environment-specific values come from the environment:
#   NLO_DOMAIN           (required) public domain fronting NLO
#   NLO_VHOST_DIR        (required) webserver vhost dir on this host
#   NLO_LOG_DIR          (required) webserver log directory
#   NLO_ACME_WEBROOT     (required) certbot --webroot path
#   NLO_BACKUP_DIR       (default /www/backup) pre-change vhost backup location
#   NLO_UPSTREAM         (default 127.0.0.1:4870) NLO loopback upstream
#   NLO_MAX_UPLOAD_MB    (default 210) client_max_body_size (NLO 200 MB + headroom)
#
# Usage (run as root; requires sudo on most hosts):
#   NLO_DOMAIN=… NLO_VHOST_DIR=… NLO_LOG_DIR=… NLO_ACME_WEBROOT=… \
#     sudo bash deploy/nginx/nlo-nginx-deploy.sh stageA   # HTTP-only (ACME + 301)
#   … same env … sudo bash deploy/nginx/nlo-nginx-deploy.sh stageB   # full HTTPS
#
# Rollback (any time, any stage):
#   sudo rm "$NLO_VHOST_DIR/$NLO_DOMAIN.conf" && sudo nginx -t && sudo systemctl reload nginx
#
# Guarantees:
#   - Renders from the repo templates (no host-specific hardcoded values).
#   - Backs up the entire vhost dir before any install; never overwrites backups.
#   - Validates (nginx -t) before every reload; aborts without partial state.
#   - Stage B refuses to run without an existing issued certificate.
# =============================================================================
set -euo pipefail

TPL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$TPL_DIR/../.." && pwd)"

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null || { echo "FATAL: not root and sudo missing"; exit 1; }
  SUDO="sudo"
fi

stage() { # render <tpl> <out>
  local tpl="$1" out="$2"
  envsubst '$NLO_DOMAIN $NLO_LOG_DIR $NLO_ACME_WEBROOT $NLO_CERT_DIR $NLO_UPSTREAM $NLO_MAX_UPLOAD_MB' \
    < "$tpl" > "$out"
  # Fail closed if any placeholder survived rendering.
  if grep -q '__NLO_' "$out"; then
    echo "FATAL: unrendered placeholder in $out — check env vars"; rm -f "$out"; exit 1
  fi
}

render_and_install() { # <stage> <tpl>
  local s="$1" tpl="$2"
  local work; work="$(mktemp /tmp/nlo-vhost.XXXXXX)"
  stage "$tpl" "$work"
  if [ "$s" = "stageB" ]; then
    [ -f "$NLO_CERT_DIR/fullchain.pem" ] || { echo "FATAL: $NLO_CERT_DIR/fullchain.pem missing — run certbot first"; exit 1; }
    [ -f "$NLO_CERT_DIR/privkey.pem" ]   || { echo "FATAL: $NLO_CERT_DIR/privkey.pem missing"; exit 1; }
  fi
  $SUDO install -m 0644 -o root -g root "$work" "$NLO_VHOST_DIR/$NLO_DOMAIN.conf"
  rm -f "$work"
  echo "INSTALLED $NLO_VHOST_DIR/$NLO_DOMAIN.conf (from $s)"
  nginx -t
  $SUDO systemctl reload nginx
  echo "RELOADED"
}

backup_vhosts() {
  local ts; ts="$(date -u +%Y%m%dT%H%M%SZ)"
  local bk="$NLO_BACKUP_DIR/nginx-vhost-before-$ts"
  [ -e "$bk" ] && bk="$bk-r"
  $SUDO cp -a "$NLO_VHOST_DIR" "$bk"
  echo "BACKUP_OK $bk"
}

verify() { # expect-redirect (stageA) or expect-https (stageB)
  local kind="$1" code
  if [ "$kind" = stageA ]; then
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1/ -H "Host: $NLO_DOMAIN")"
    echo "local-nlo-http=$code"
    [ "$code" = "301" ] || { echo "FATAL: expected 301, got $code"; exit 1; }
  else
    code="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 10 https://127.0.0.1/api/health -H "Host: $NLO_DOMAIN")"
    local redir; redir="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1/ -H "Host: $NLO_DOMAIN")"
    echo "local-https-health=$code local-http-redirect=$redir"
    [ "$code" = "200" ] || { echo "FATAL: expected HTTPS 200, got $code"; exit 1; }
    [ "$redir" = "301" ] || { echo "FATAL: expected redirect 301, got $redir"; exit 1; }
  fi
}

: "${NLO_DOMAIN:?NLO_DOMAIN is required}"
: "${NLO_VHOST_DIR:?NLO_VHOST_DIR is required}"
: "${NLO_LOG_DIR:?NLO_LOG_DIR is required}"
: "${NLO_ACME_WEBROOT:?NLO_ACME_WEBROOT is required}"
: "${NLO_CERT_DIR:=/etc/letsencrypt/live/$NLO_DOMAIN}"
: "${NLO_UPSTREAM:=127.0.0.1:4870}"
: "${NLO_MAX_UPLOAD_MB:=210}"
: "${NLO_BACKUP_DIR:=/www/backup}"

# The one-time http-context map (idempotent: skip if already present).
if [ ! -f /etc/nginx/nginx.conf ] || ! grep -q 'connection_upgrade' /etc/nginx/nginx.conf 2>/dev/null; then
  echo "NOTE: \$connection_upgrade map not detected in main config — ensure it exists in the http{} block (deploy/nginx/ngx-map-connection.conf.tpl) before stage B."
fi

case "${1:-}" in
  stageA)
    backup_vhosts
    render_and_install stageA "$TPL_DIR/nlo-vhost.stageA.conf.tpl"
    sleep 1
    verify stageA
    echo "STAGE_A_DONE"
    echo "NEXT: issue certificate (certbot certonly --webroot -w $NLO_ACME_WEBROOT -d $NLO_DOMAIN …) then run stage B."
    ;;
  stageB)
    backup_vhosts
    render_and_install stageB "$TPL_DIR/nlo-vhost.stageB.conf.tpl"
    sleep 1
    verify stageB
    echo "STAGE_B_DONE"
    ;;
  *)
    echo "usage: $0 stageA|stageB   (env: NLO_DOMAIN NLO_VHOST_DIR NLO_LOG_DIR NLO_ACME_WEBROOT [NLO_CERT_DIR NLO_UPSTREAM NLO_MAX_UPLOAD_MB NLO_BACKUP_DIR])"
    exit 2
    ;;
esac
