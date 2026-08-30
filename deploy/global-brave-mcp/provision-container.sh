#!/bin/sh
set -eu

INSTANCE=${INSTANCE:-global-brave-mcp}
IMAGE=${IMAGE:-images:alpine/3.24}
# This NIC exists only while Alpine installs Node and CA certificates. pen-cloud
# provides DHCP/NAT on this host; the NIC is removed before the service starts.
NETWORK=${NETWORK:-pen-cloud}
REPO_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
APP_DIR="$REPO_DIR/apps/brave-search-mcp"
DEPLOY_DIR="$REPO_DIR/deploy/global-brave-mcp"

if [ ! -f "$APP_DIR/dist/index.js" ]; then
  echo "missing $APP_DIR/dist/index.js; run pnpm -C apps/brave-search-mcp build" >&2
  exit 1
fi
if [ -z "${BRAVE_API_KEY_FILE:-}" ] || [ ! -f "$BRAVE_API_KEY_FILE" ]; then
  echo "set BRAVE_API_KEY_FILE to a readable host file" >&2
  exit 1
fi
if incus info "$INSTANCE" >/dev/null 2>&1; then
  echo "instance already exists: $INSTANCE" >&2
  exit 1
fi

incus launch "$IMAGE" "$INSTANCE" --network "$NETWORK"
incus config set "$INSTANCE" security.nesting=false limits.cpu=2 limits.memory=1GiB limits.processes=128 boot.autostart=true

# Incus returns as soon as the container starts, which can be before DHCP has
# installed its address/default route. Avoid racing apk on fresh instances.
attempt=0
until incus exec "$INSTANCE" -- ip -4 route show default | grep -q '^default '; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo "temporary bootstrap network did not acquire a default route" >&2
    exit 1
  fi
  sleep 1
done
incus exec "$INSTANCE" -- apk add --no-cache nodejs ca-certificates
incus exec "$INSTANCE" -- addgroup -S brave-mcp
incus exec "$INSTANCE" -- adduser -S -D -H -s /sbin/nologin -G brave-mcp brave-mcp
incus exec "$INSTANCE" -- install -d -m 0755 -o brave-mcp -g brave-mcp /srv/global-brave-mcp/bin
incus exec "$INSTANCE" -- install -d -m 0750 -o root -g brave-mcp /srv/global-brave-mcp/etc
incus exec "$INSTANCE" -- install -m 0640 -o brave-mcp -g brave-mcp /dev/null /var/log/global-brave-mcp.log
incus file push "$APP_DIR/dist/index.js" "$INSTANCE/srv/global-brave-mcp/bin/index.js" --mode 0755 --uid 0 --gid 0
incus file push "$DEPLOY_DIR/config.toml" "$INSTANCE/srv/global-brave-mcp/etc/config.toml" --mode 0640 --uid 0 --gid 0
incus file push "$BRAVE_API_KEY_FILE" "$INSTANCE/srv/global-brave-mcp/etc/brave-api-key" --mode 0400 --uid 0 --gid 0
incus exec "$INSTANCE" -- chown root:brave-mcp /srv/global-brave-mcp/etc/config.toml
incus exec "$INSTANCE" -- chown brave-mcp:brave-mcp /srv/global-brave-mcp/etc/brave-api-key
incus exec "$INSTANCE" -- chmod 0640 /srv/global-brave-mcp/etc/config.toml
incus exec "$INSTANCE" -- chmod 0400 /srv/global-brave-mcp/etc/brave-api-key
incus file push "$DEPLOY_DIR/global-brave-mcp.initd" "$INSTANCE/etc/init.d/global-brave-mcp" --mode 0755 --uid 0 --gid 0
incus exec "$INSTANCE" -- rc-update add global-brave-mcp default

# Remove general network access before the service ever receives its key in a process.
incus stop "$INSTANCE"
incus config device remove "$INSTANCE" eth0
incus config device add "$INSTANCE" eth0 none
incus config device add "$INSTANCE" mcp-in proxy bind=host listen=tcp:127.0.0.1:3001 connect=tcp:127.0.0.1:3001
incus config device add "$INSTANCE" brave-egress proxy bind=instance listen=tcp:127.0.0.1:8888 connect=tcp:127.0.0.1:18888
incus config device add "$INSTANCE" audit-out proxy bind=instance listen=tcp:127.0.0.1:1515 connect=unix:/run/global-brave-mcp/log.sock
incus start "$INSTANCE"

echo "global Brave MCP is available at http://127.0.0.1:3001/mcp"
