# Laravel Forge MCP

An [MCP](https://modelcontextprotocol.io) server exposing the full **Laravel Forge API v2** (273 operations)
to Claude Code and other MCP clients.

## Why not 273 tools

One tool per operation would burn roughly **43,000 tokens** of context before you say anything. This server
uses two layers instead:

| Layer | Contents | Purpose |
|---|---|---|
| Curated (26 tools) | deploys, logs, `.env`, service restarts | one call per common task |
| Universal (2 tools) | `forge_search_operations` + `forge_call` | reaches all 273 operations |

Total: **~5,500 tokens**, with no loss of API coverage.

## Install

```bash
claude mcp add forge --env FORGE_API_TOKEN=your_token -- npx -y @wdevcom/laravel-forge-mcp
```

Generate a token at <https://forge.laravel.com/profile/api>.

| Variable | Meaning |
|---|---|
| `FORGE_API_TOKEN` | required |
| `FORGE_ORG` | optional default organization slug; without it the server uses your only organization or asks |

The token is read **only** from the environment. Passing it as an argument is rejected, because process
arguments are visible in `ps`.

## Safety modes

Forge has no trash can - a deleted server does not come back. Operations are classified into three levels:

```bash
laravel-forge-mcp                      # read + write (default), no destructive operations
laravel-forge-mcp --allow-destructive  # everything, including DELETE and reboot
laravel-forge-mcp --read-only          # read only, 19 tools
```

| Level | Rule | Operations |
|---|---|---|
| `read` | GET | 133 |
| `write` | POST, PUT, PATCH | 93 |
| `destructive` | DELETE plus `action: reboot` / `action: stop` | 47 |

Classification depends on the **request body**, not just the HTTP method - restarting a service passes,
stopping the same service is blocked. Tools also carry MCP annotations (`readOnlyHint`, `destructiveHint`)
so the client can ask for confirmation.

## Tools

`site` and `server` arguments accept a **domain, name, or ID** - you never need numeric IDs.

- **Context:** `forge_whoami`, `forge_list_servers`, `forge_list_sites`, `forge_resolve`
- **Server:** `forge_get_server`, `forge_server_events`, `forge_restart_service`, `forge_server_action`, `forge_get_server_log`
- **Deploy:** `forge_get_site`, `forge_deploy_site`, `forge_list_deployments`, `forge_get_deployment_log`, `forge_deployment_status`, `forge_get_deployment_script`, `forge_update_deployment_script`
- **Config:** `forge_get_env`, `forge_update_env`, `forge_get_nginx_config`, `forge_update_nginx_config`
- **Diagnostics:** `forge_get_site_logs`, `forge_run_command`
- **Processes:** `forge_list_background_processes`, `forge_background_process_action`, `forge_list_scheduled_jobs`, `forge_list_databases`

Everything else - certificates, firewall, VPC, roles, recipes, backups - goes through the universal layer:

```
forge_search_operations("certificate")   → matching operations with parameter schemas
forge_call("organizations.servers.sites.domains.certificates.store", { ... })
```

A missing `{organization}` parameter is filled in automatically.

## How it works

**OpenAPI is the source of truth.** The `spec/forge.openapi.json` snapshot ships with the package and loads
locally, so the server starts without network calls. New Forge endpoints become reachable through the
universal layer as soon as the file is refreshed (`npm run sync:spec`).

The **resolver** caches domain → `{organization, server, site}` mappings for five minutes; Forge allows only
60 requests per minute. On ambiguity (same domain on two servers) it returns candidates instead of guessing.
The **formatter** flattens JSON:API, dropping the `links` and `relationships` that dominate raw responses.
**Pagination** follows at most 5 pages and marks the result as truncated.

## Development

```bash
npm install
npm test           # 130 tests
npm run typecheck
npm run dev        # run without building
```

A contract test asserts that **every `operationId` used in the code exists in the spec**, catching Forge-side
changes before they blow up mid-conversation.

## Notes

- Transport is **stdio**; HTTP and SSE are not supported.
- API v2 has **no site-level workers**, despite the PHP SDK exposing them (`$forge->workers(...)`). Use
  `forge_list_background_processes` at server level.
- `forge_get_env` returns secrets in plain text.

## License

Apache-2.0. [Forge API reference](https://laravel.com/forge/docs/api-reference/introduction).
