# NLO — Stage B (auth): full vhost with nginx Basic auth (STAGE deployments)
#
# TEMPLATE — render before install (see deploy/nginx/README.md):
#   __NLO_DOMAIN__          public domain fronting the Stage NLO
#   __NLO_LOG_DIR__         webserver log directory for this vhost
#   __NLO_ACME_WEBROOT__    certbot --webroot path
#   __NLO_CERT_DIR__        issued certificate dir (certbot: /etc/letsencrypt/live/<domain>)
#   __NLO_UPSTREAM__        Stage NLO loopback upstream (e.g. 127.0.0.1:4871)
#   __NLO_MAX_UPLOAD_MB__   headroom above NLO_MAX_UPLOAD_BYTES for multipart overhead
#   __NLO_AUTH_FILE__       htpasswd file (0640 root:www), e.g. /etc/nginx/htpasswd-nlo2
#
# Differences from nlo-vhost.stageB.conf.tpl (deliberate):
#   - Basic auth (auth_basic) on the ENTIRE 443 server block: the Stage web UI
#     has no API-token model of its own (apps/web/src/lib/api.ts sends no
#     Authorization header; it uses the app-ungated legacy /api surface), so
#     "the public UI must not be reachable without auth" is enforced HERE, at
#     the proxy. The 80 block stays auth-free (LE HTTP-01 + 301 only).
#   - No WebSocket/SSE upgrade headers: the current UI polls plain REST
#     (no EventSource/WebSocket), and the host nginx main config has no
#     $connection_upgrade map — keeping this vhost self-contained means the
#     install touches ONLY this one file (no main-config change, no reload
#     of other vhosts' behavior).
#
# Independent file; must not touch any existing vhost.
# NLO stays loopback-only; no bind/firewall change. App auth (NLO_API_AUTH)
# is untouched and remains the second layer for /api/v1.

# HTTP: ACME challenge + HTTPS redirect (auth-free: LE must reach the challenge)
server {
    listen 80;
    listen [::]:80;
    server_name __NLO_DOMAIN__;

    access_log __NLO_LOG_DIR__/__NLO_DOMAIN__.log;
    error_log  __NLO_LOG_DIR__/__NLO_DOMAIN__.error.log;

    # Let's Encrypt HTTP-01 challenge
    location ^~ /.well-known/acme-challenge/ {
        root __NLO_ACME_WEBROOT__;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

# HTTPS: NLO reverse proxy, behind Basic auth
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name __NLO_DOMAIN__;

    ssl_certificate     __NLO_CERT_DIR__/fullchain.pem;
    ssl_certificate_key __NLO_CERT_DIR__/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;

    # Access control: the whole Stage vhost (UI + legacy /api + /api/v1)
    # requires credentials. Password file rendered at deploy time, 0640 root:www.
    auth_basic           "NLO Stage";
    auth_basic_user_file __NLO_AUTH_FILE__;

    access_log __NLO_LOG_DIR__/__NLO_DOMAIN__.log;
    error_log  __NLO_LOG_DIR__/__NLO_DOMAIN__.error.log;

    # NLO_MAX_UPLOAD_BYTES = 200 MB (default) -> +10 MB headroom for multipart overhead
    client_max_body_size __NLO_MAX_UPLOAD_MB__m;

    # Long API operations (audio->text jobs can take minutes)
    proxy_connect_timeout 30s;
    proxy_read_timeout    600s;
    proxy_send_timeout    600s;
    proxy_http_version    1.1;

    location / {
        proxy_pass http://__NLO_UPSTREAM__;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
    }

    # Clean upstream-error handling (502/504 -> readable 503 body)
    error_page 502 503 504 /nlo-maintenance;
    location = /nlo-maintenance {
        internal;
        default_type text/plain;
        return 503 "NLO upstream is temporarily unavailable (502/504). Please retry in a moment.\n";
    }

    # Security headers
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options DENY always;
    add_header Referrer-Policy strict-origin-when-cross-origin always;
}
