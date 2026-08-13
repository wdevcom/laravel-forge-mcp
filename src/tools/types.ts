import type { z } from 'zod'
import type { ForgeClient } from '../forge/client.js'
import type { SpecIndex } from '../openapi/index.js'
import type { Resolver } from '../domain/resolver.js'
import type { Config } from '../config.js'
import type { RiskLevel } from '../openapi/types.js'

export interface ToolContext {
  client: ForgeClient
  index: SpecIndex
  resolver: Resolver
  config: Config
}

export interface ToolDefinition {
  name: string
  title: string
  description: string
  inputSchema: z.ZodRawShape
  risk: RiskLevel
  handler: (args: Record<string, any>, ctx: ToolContext) => Promise<string>
}
