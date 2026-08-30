# global-brave-mcp deployment

This deploys one shared, stateless HTTP MCP server in an unprivileged Alpine Incus system container. The container has no NIC. Its only outbound path is a loopback proxy that permits `api.search.brave.com:443`; its audit path can only submit records to the host writer.

The API key is copied to `/srv/global-brave-mcp/etc/brave-api-key` with mode `0400`. The app and config live in `/srv/global-brave-mcp/bin` and `/srv/global-brave-mcp/etc`. Search audit records land at `/logs/Brave_MCP/searches/<cwd-with-slashes-replaced>/<session-id>/<UTC-timestamp>.jsonl`.

Build and install:

```sh
pnpm -C apps/brave-search-mcp build
sudo deploy/global-brave-mcp/install-host.sh
sudo env BRAVE_API_KEY_FILE=/path/to/brave-api-key deploy/global-brave-mcp/provision-container.sh
```

Clients connect to `http://127.0.0.1:3001/mcp` and supply these fixed headers from environment variables:

- `X-Brave-Client`: `codex` or `claude`
- `X-Brave-Cwd`: the session `$CWD`
- `X-Brave-Session`: `$CODEX_SESSION_ID` or `$CLAUDE_SESSION_ID`

Codex config:

```toml
[mcp_servers.brave-search]
url = "http://127.0.0.1:3001/mcp"
http_headers = { X-Brave-Client = "codex" }
env_http_headers = { X-Brave-Cwd = "PWD", X-Brave-Session = "CODEX_SESSION_ID" }
```

Claude user-scoped `~/.claude.json` entry (using its environment interpolation):

```json
{
  "mcpServers": {
    "brave-search": {
      "type": "http",
      "url": "http://127.0.0.1:3001/mcp",
      "headers": {
        "X-Brave-Client": "claude",
        "X-Brave-Cwd": "${PWD}",
        "X-Brave-Session": "${CLAUDE_SESSION_ID}"
      }
    }
  }
}
```

These examples are documentation only. The deployment scripts do not modify any Claude or Codex configuration.

There is deliberately no bearer authentication because the listener is host-loopback only. CORS is off. Host-header validation remains enabled automatically for loopback binds.

Logging is fail-open from the MCP caller's perspective. The app opens the audit connection without awaiting it. Invalid metadata, an unavailable writer, or a disk error is reported to journald and never changes the search result.

Useful checks:

```sh
incus config show global-brave-mcp --expanded
incus exec global-brave-mcp -- rc-service global-brave-mcp status
curl -fsS http://127.0.0.1:3001/mcp
journalctl -u global-brave-mcp-log@'*' -u global-brave-mcp-tinyproxy.service
```
