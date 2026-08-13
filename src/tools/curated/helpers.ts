import type { ToolContext } from '../types.js'
import { buildPath } from '../universal/call.js'
import { classify, denialMessage, isAllowed } from '../../domain/policy.js'
import type { JsonApiResource } from '../../domain/formatter.js'

export type Params = Record<string, string | number>
export type Query = Record<string, string | number | boolean | undefined>

/**
 * Wspolna sciezka wykonania dla narzedzi kurowanych: operacja jest
 * identyfikowana przez operationId ze specu, wiec test kontraktowy wychwyci
 * kazde odwolanie do endpointu, ktory zniknal z API.
 */
export async function callOperation(
  ctx: ToolContext,
  operationId: string,
  params: Params = {},
  opts: { query?: Query; body?: unknown } = {},
): Promise<unknown> {
  const op = ctx.index.get(operationId)
  if (!op) throw new Error(`Operacja ${operationId} nie istnieje w specyfikacji API.`)

  const risk = classify(op, opts.body)
  if (!isAllowed(risk, ctx.config.mode)) {
    throw new Error(denialMessage(operationId, risk, ctx.config.mode))
  }

  return ctx.client.request({
    method: op.method,
    path: buildPath(op.path, params),
    query: opts.query,
    body: opts.body,
  })
}

export async function paginateOperation(
  ctx: ToolContext,
  operationId: string,
  params: Params = {},
  opts: { query?: Query; maxPages?: number } = {},
): Promise<{ items: JsonApiResource[]; truncated: boolean }> {
  const op = ctx.index.get(operationId)
  if (!op) throw new Error(`Operacja ${operationId} nie istnieje w specyfikacji API.`)

  const result = await ctx.client.paginate<JsonApiResource>(
    { method: op.method, path: buildPath(op.path, params), query: opts.query },
    { maxPages: opts.maxPages },
  )

  return { items: result.items, truncated: result.truncated }
}

export function dataOf(response: unknown): unknown {
  if (response && typeof response === 'object' && 'data' in (response as object)) {
    return (response as { data: unknown }).data
  }
  return response
}

export function truncationNote(truncated: boolean): string {
  return truncated ? '\n\n[wynik uciety - jest wiecej rekordow, zawez wyszukiwanie]' : ''
}

/**
 * Wyciaga tresc tekstowa z zasobu, ktory moze ja trzymac pod roznymi kluczami
 * (content, output, script) w zaleznosci od endpointu.
 */
export function textOf(resource: Record<string, unknown>, keys: string[] = ['content', 'output', 'script']): string {
  for (const key of keys) {
    const value = resource[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return ''
}
