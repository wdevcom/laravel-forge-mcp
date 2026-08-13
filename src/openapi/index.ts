import { loadSpec, resolveRefs, type OpenApiDocument } from './spec.js'
import { HTTP_METHODS, type HttpMethod, type OperationMeta, type ParamMeta, type RiskLevel } from './types.js'

function riskFromMethod(method: HttpMethod): RiskLevel {
  if (method === 'get') return 'read'
  if (method === 'delete') return 'destructive'
  return 'write'
}

function schemaType(schema: any): string {
  if (!schema) return 'unknown'
  if (typeof schema.type === 'string') return schema.type
  if (Array.isArray(schema.type)) return schema.type.filter((t: string) => t !== 'null').join('|') || 'null'
  if (schema.anyOf || schema.oneOf) return 'anyOf'
  return 'unknown'
}

/**
 * Zbiera wartosci enum z calego schematu body. Bez tego wyszukiwanie frazy
 * "reboot" nie znajduje organizations.servers.actions.store, bo slowo wystepuje
 * wylacznie jako dopuszczalna wartosc pola action, nie w summary.
 */
function collectEnums(node: unknown, out: Set<string> = new Set()): Set<string> {
  if (!node || typeof node !== 'object') return out

  if (Array.isArray(node)) {
    for (const item of node) collectEnums(item, out)
    return out
  }

  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === 'enum' && Array.isArray(value)) {
      for (const entry of value) if (typeof entry === 'string') out.add(entry)
      continue
    }
    collectEnums(value, out)
  }

  return out
}

/** Opisy w spec Forge zawieraja markdownowe tabelki - do wyszukiwania biora sie same slowa. */
function cleanDescription(text: unknown): string {
  if (typeof text !== 'string') return ''
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/[|`#*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export class SpecIndex {
  private constructor(private readonly operations: Map<string, OperationMeta>) {}

  static build(doc: OpenApiDocument = loadSpec()): SpecIndex {
    const operations = new Map<string, OperationMeta>()

    for (const [path, item] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(item)) {
        if (!HTTP_METHODS.includes(method as HttpMethod)) continue
        if (!op?.operationId) continue

        const params = (op.parameters ?? []) as any[]
        const pathParams = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!)

        const queryParams: ParamMeta[] = params
          .filter((p) => p.in === 'query')
          .map((p) => ({
            name: p.name,
            in: 'query' as const,
            required: Boolean(p.required),
            type: schemaType(p.schema),
            description: p.description,
          }))

        const rawBody = op.requestBody?.content?.['application/json']?.schema
        const bodySchema = rawBody ? (resolveRefs(rawBody, doc) as Record<string, unknown>) : undefined

        operations.set(op.operationId, {
          operationId: op.operationId,
          method: method as HttpMethod,
          path,
          tag: (op.tags?.[0] as string) ?? 'Inne',
          summary: ((op.summary as string) ?? '').trim(),
          description: cleanDescription(op.description),
          enumValues: [...collectEnums(bodySchema)],
          pathParams,
          queryParams,
          bodySchema,
          risk: riskFromMethod(method as HttpMethod),
        })
      }
    }

    return new SpecIndex(operations)
  }

  get(operationId: string): OperationMeta | undefined {
    return this.operations.get(operationId)
  }

  all(): OperationMeta[] {
    return [...this.operations.values()]
  }

  size(): number {
    return this.operations.size
  }

  /**
   * Wyszukiwanie z prostym rankingiem: trafienie w operationId wazy wiecej
   * niz trafienie w summary, a to wiecej niz trafienie w sciezke.
   */
  search(query: string, opts: { tag?: string; limit?: number } = {}): OperationMeta[] {
    const needle = query.trim().toLowerCase()
    const limit = opts.limit ?? 20

    const scored: Array<{ op: OperationMeta; score: number }> = []

    for (const op of this.operations.values()) {
      if (opts.tag && op.tag !== opts.tag) continue

      let score = 0
      if (op.operationId.toLowerCase().includes(needle)) score += 10
      if (op.summary.toLowerCase().includes(needle)) score += 5
      if (op.enumValues.some((value) => value.toLowerCase() === needle)) score += 4
      if (op.description.toLowerCase().includes(needle)) score += 3
      if (op.path.toLowerCase().includes(needle)) score += 2

      if (score > 0) scored.push({ op, score })
    }

    return scored
      .sort((a, b) => b.score - a.score || a.op.operationId.localeCompare(b.op.operationId))
      .slice(0, limit)
      .map((s) => s.op)
  }
}
