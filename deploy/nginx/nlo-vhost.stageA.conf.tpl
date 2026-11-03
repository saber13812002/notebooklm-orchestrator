# NLO — Stage A: HTTP only (ACME HTTP-01 challenge + HTTPS redirect)
#
# TEMPLATE — render before install (see deploy/nginx/README.md):
#   __NLO_DOMAIN__      public domain fronting NLO (e.g. the service FQDN)
#   __NLO_LOG_DIR__     webserver log directory for this vhost
#   __NLO_ACME_WEBROOT__  certbot --webroot path
#
# Independent file; must not touch any existing vhost.
# Stage B (443 ssl block) is added only after Let's Encrypt issuance.
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
