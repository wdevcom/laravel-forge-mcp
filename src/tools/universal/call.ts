import { z } from 'zod'
import type { ToolDefinition } from '../types.js'
import { classify, denialMessage, isAllowed } from '../../domain/policy.js'
import { flatten, flattenMany, type JsonApiResource } from '../../domain/formatter.js'

export function buildPath(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = params[name]
    if (value === undefined || value === null || value === '') {
      throw new Error(`Brak wymaganego parametru sciezki: ${name}`)
    }
    return encodeURIComponent(String(value))
  })
}

function present(payload: unknown, raw: boolean): string {
  if (payload === null || payload === undefined) return 'Wykonano. Serwer nie zwrocil tresci.'
  if (raw) return JSON.stringify(payload, null, 2)

  const isEnvelope = typeof payload === 'object' && payload !== null && 'data' in (payload as object)
  const data = isEnvelope ? (payload as { data: unknown }).data : payload

  if (Array.isArray(data)) {
    return JSON.stringify(flattenMany(data as JsonApiResource[]), null, 2)
  }

  if (data && typeof data === 'object' && 'attributes' in (data as object)) {
    return JSON.stringify(flatten(data as JsonApiResource), null, 2)
  }

  return JSON.stringify(data ?? payload, null, 2)
}

export const callTool: ToolDefinition = {
  name: 'forge_call',
  title: 'Wywolaj dowolna operacje Forge API',
  description:
    'Wykonuje dowolna z 273 operacji Laravel Forge API po jej operationId. ' +
    'Operacje znajdziesz narzedziem forge_search_operations. ' +
    'Brakujacy parametr {organization} jest uzupelniany z konfiguracji serwera.',
  inputSchema: {
    operationId: z.string().describe('Identyfikator operacji, np. "organizations.servers.sites.domains.index"'),
    path: z
      .record(z.string(), z.union([z.string(), z.number()]))
      .optional()
      .describe('Parametry sciezki, np. { organization: "acme", server: 42 }'),
    query: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .optional()
      .describe('Parametry zapytania, np. { sort: "-created_at" }'),
    body: z.record(z.string(), z.any()).optional().describe('Tresc zadania dla POST, PUT i PATCH'),
    raw: z.boolean().optional().describe('Zwroc surowa odpowiedz JSON:API zamiast splaszczonej'),
  },
  risk: 'write',
  handler: async (args, ctx) => {
    const op = ctx.index.get(args.operationId)

    if (!op) {
      const hints = ctx.index.search(args.operationId.split('.').pop() ?? args.operationId, { limit: 5 })
      const suggestion =
        hints.length > 0 ? `\nMoze chodzilo o:\n${hints.map((h) => `  ${h.operationId}`).join('\n')}` : ''
      return `Nieznana operacja: ${args.operationId}${suggestion}`
    }

    const risk = classify(op, args.body)
    if (!isAllowed(risk, ctx.config.mode)) {
      return denialMessage(op.operationId, risk, ctx.config.mode)
    }

    const params: Record<string, string | number> = { ...(args.path ?? {}) }

    if (op.pathParams.includes('organization') && !params.organization) {
      params.organization = await ctx.resolver.resolveOrg()
    }

    const path = buildPath(op.path, params)

    const response = await ctx.client.request({
      method: op.method,
      path,
      query: args.query,
      body: args.body,
    })

    return present(response, Boolean(args.raw))
  },
}
