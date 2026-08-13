import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { PolicyMode } from '../domain/policy.js'
import { annotationsFor, isAllowed } from '../domain/policy.js'
import type { ToolContext, ToolDefinition } from './types.js'

/**
 * Narzedzia poza dozwolonym poziomem ryzyka nie sa w ogole rejestrowane -
 * model ich nie widzi, wiec nie probuje ich wywolac.
 */
export function visibleTools(tools: ToolDefinition[], mode: PolicyMode): ToolDefinition[] {
  return tools.filter((tool) => isAllowed(tool.risk, mode))
}

export function registerTools(server: McpServer, tools: ToolDefinition[], ctx: ToolContext): void {
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: annotationsFor(tool.risk),
      },
      async (args: Record<string, any>) => {
        try {
          return { content: [{ type: 'text' as const, text: await tool.handler(args ?? {}, ctx) }] }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return { content: [{ type: 'text' as const, text: message }], isError: true }
        }
      },
    )
  }
}
