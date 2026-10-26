#!/usr/bin/env sh
# Mint the one-time first-admin invite for a Paperclip instance running from
# deploy/hostinger/docker-compose.yml.
#
# The deployment is internet-facing (PAPERCLIP_DEPLOYMENT_EXPOSURE=public), so
# Paperclip disables the browser "claim this instance" button and expects the
# operator to create the first admin through a bootstrap invite instead. This
# runs `paperclipai auth bootstrap-ceo` inside the server container against the
# container's own DATABASE_URL and PAPERCLIP_PUBLIC_URL.
#
# The CLI insists on a config file, and the image is configured purely through
# environment variables, so a throwaway config describing this deployment is
# written to /tmp inside the container. The server never reads it.
#
# Usage (from the compose directory on the host, e.g. /docker/paperclip):
#   sh bootstrap-admin.sh
# Then open the printed https://<hostname>/invite/pcp_bootstrap_... URL, create
# your account (sign-up must still be enabled) and accept the invite. That
# account becomes the instance admin. Re-running revokes the previous invite and
# issues a new one (--force once an admin exists).
set -eu
SERVICE="${PAPERCLIP_SERVICE:-paperclip}"
docker compose exec -T "$SERVICE" bash -c '
  set -eu
  : "${PAPERCLIP_PUBLIC_URL:?PAPERCLIP_PUBLIC_URL is not set in the container}"
  : "${DATABASE_URL:?DATABASE_URL is not set in the container}"
  cfg=$(mktemp /tmp/paperclip-bootstrap-XXXXXX.json)
  trap "rm -f $cfg" EXIT
  cat > "$cfg" <<EOF
{
  "\$meta": { "version": 1, "updatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)", "source": "configure" },
  "database": { "mode": "postgres" },
  "logging": { "mode": "file" },
  "server": { "deploymentMode": "authenticated", "exposure": "public", "host": "0.0.0.0", "port": ${PORT:-3100} },
  "auth": { "baseUrlMode": "explicit", "publicBaseUrl": "$PAPERCLIP_PUBLIC_URL" },
  "telemetry": { "enabled": false }
}
EOF
  cd /app
  # The image ships the CLI source and its runner; no network download needed.
  exec node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts auth bootstrap-ceo \
    --config "$cfg" --base-url "$PAPERCLIP_PUBLIC_URL" "$@"
' bootstrap-admin "$@"
