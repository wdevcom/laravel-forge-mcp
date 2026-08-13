#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { loadConfig, ConfigError, type Config } from './config.js'
import { SpecIndex } from './openapi/index.js'
import { ForgeClient } from './forge/client.js'
import { Resolver } from './domain/resolver.js'
import { registerTools, visibleTools } from './tools/registry.js'
import { allTools } from './tools/index.js'
import type { ToolContext } from './tools/types.js'
import { SERVER_NAME, SERVER_VERSION } from './version.js'

export function buildContext(config: Config): ToolContext {
  const client = new ForgeClient({ token: config.token, baseUrl: config.baseUrl })
  const resolver = new Resolver(client, { defaultOrg: config.defaultOrg })

  return { client, index: SpecIndex.build(), resolver, config }
}

export function createServer(config: Config): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION })
  const ctx = buildContext(config)

  registerTools(server, visibleTools(allTools, config.mode), ctx)

  return server
}

async function main(): Promise<void> {
  const config = loadConfig(process.env, process.argv.slice(2))
  const server = createServer(config)

  // Logi diagnostyczne wylacznie na stderr - stdout to kanal protokolu MCP.
  console.error(`${SERVER_NAME} ${SERVER_VERSION}, tryb: ${config.mode}`)

  await server.connect(new StdioServerTransport())
}

// Uruchamiamy main tylko wtedy, gdy plik jest punktem wejscia procesu,
// zeby import w testach nie startowal transportu stdio.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    if (error instanceof ConfigError) {
      console.error(error.message)
      process.exit(1)
    }
    console.error(error instanceof Error ? error.stack : String(error))
    process.exit(1)
  })
}
