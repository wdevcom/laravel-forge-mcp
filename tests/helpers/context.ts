import { ForgeClient } from '../../src/forge/client.js'
import { RateLimiter } from '../../src/forge/rate-limiter.js'
import { SpecIndex } from '../../src/openapi/index.js'
import { Resolver } from '../../src/domain/resolver.js'
import type { ToolContext, ToolDefinition } from '../../src/tools/types.js'
import type { PolicyMode } from '../../src/domain/policy.js'
import { BASE } from './msw.js'

const sharedIndex = SpecIndex.build()

/** Limiter bez realnego czekania - testy maja byc natychmiastowe. */
export function instantLimiter(): RateLimiter {
  return new RateLimiter({ now: () => 0, sleep: async () => {} })
}

export function testContext(mode: PolicyMode = 'default'): ToolContext {
  const client = new ForgeClient({ token: 'tok', baseUrl: BASE, limiter: instantLimiter() })

  return {
    client,
    index: sharedIndex,
    resolver: new Resolver(client, { defaultOrg: 'acme' }),
    config: { token: 'tok', defaultOrg: 'acme', mode, baseUrl: BASE },
  }
}

export function pickTool(tools: ToolDefinition[], name: string): ToolDefinition {
  const found = tools.find((t) => t.name === name)
  if (!found) throw new Error(`brak narzedzia ${name}`)
  return found
}

export const srv = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: 'servers',
  attributes: { id: Number(id), name, ip_address: `10.0.0.${id}`, php_version: 'php84', is_ready: true, ...extra },
})

export const site = (id: string, name: string, serverId: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: 'sites',
  attributes: { name, status: 'installed', deployment_status: 'finished', ...extra },
  relationships: { server: { data: { type: 'servers', id: serverId } } },
})
