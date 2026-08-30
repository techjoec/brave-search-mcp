#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "run as root" >&2
  exit 1
fi

SOURCE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/host" && pwd)

getent passwd global-brave-mcp-log >/dev/null 2>&1 \
  || useradd --system --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin global-brave-mcp-log
install -d -m 0700 -o global-brave-mcp-log -g global-brave-mcp-log /logs/Brave_MCP/searches
install -d -m 0755 /usr/local/libexec
install -m 0755 "$SOURCE_DIR/global-brave-mcp-log-writer.py" /usr/local/libexec/global-brave-mcp-log-writer.py
if [ -e /usr/local/libexec/global-brave-mcp-log-writer.mjs ]; then
  unlink /usr/local/libexec/global-brave-mcp-log-writer.mjs
fi
install -m 0644 "$SOURCE_DIR/global-brave-mcp-log.socket" /etc/systemd/system/global-brave-mcp-log.socket
install -m 0644 "$SOURCE_DIR/global-brave-mcp-log@.service" /etc/systemd/system/global-brave-mcp-log@.service
install -m 0644 "$SOURCE_DIR/global-brave-mcp-tinyproxy.conf" /etc/tinyproxy/global-brave-mcp.conf
install -m 0644 "$SOURCE_DIR/global-brave-mcp.filter" /etc/tinyproxy/global-brave-mcp.filter
install -m 0644 "$SOURCE_DIR/global-brave-mcp-tinyproxy.service" /etc/systemd/system/global-brave-mcp-tinyproxy.service

systemd-analyze verify /etc/systemd/system/global-brave-mcp-log.socket \
  /etc/systemd/system/global-brave-mcp-log@.service \
  /etc/systemd/system/global-brave-mcp-tinyproxy.service
systemctl daemon-reload
systemctl enable --now global-brave-mcp-log.socket global-brave-mcp-tinyproxy.service
