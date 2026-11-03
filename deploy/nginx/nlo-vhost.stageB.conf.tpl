# NLO — Stage B: full vhost (HTTP ACME/redirect + HTTPS reverse proxy to NLO)
#
# TEMPLATE — render before install (see deploy/nginx/README.md):
#   __NLO_DOMAIN__          public domain fronting NLO
#   __NLO_LOG_DIR__         webserver log directory for this vhost
#   __NLO_ACME_WEBROOT__    certbot --webroot path
#   __NLO_CERT_DIR__        issued certificate dir (certbot: /etc/letsencrypt/live/<domain>)
#   __NLO_UPSTREAM__        NLO loopback upstream (default: 127.0.0.1:4870)
#   __NLO_MAX_UPLOAD_MB__   headroom above NLO_MAX_UPLOAD_BYTES for multipart overhead
#
# Independent file; must not touch any existing vhost. Pattern follows the
# proven s52/s53 vhosts (docs.ai.ismc.ir.conf etc.), adapted:
#   - upload limit matched to NLO_MAX_UPLOAD_BYTES (200 MB default) + 10 MB
#   - long proxy timeouts for audio->text jobs (can take minutes)
#   - WebSocket/SSE upgrade support requires the http-context map in
#     ngx-map-connection.conf (install once in the main nginx.conf http block)
# NLO stays loopback-only; no bind/firewall change. App auth is untouched.

# HTTP: ACME challenge + HTTPS redirect
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

# HTTPS: NLO reverse proxy
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name __NLO_DOMAIN__;

    ssl_certificate     __NLO_CERT_DIR__/fullchain.pem;
    ssl_certificate_key __NLO_CERT_DIR__/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;

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
        # WebSocket / SSE compatibility (requires ngx-map-connection in http context)
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
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
