import { z } from 'zod'
import type { ToolDefinition } from '../types.js'
import type { OperationMeta } from '../../openapi/types.js'

function describeBody(schema: Record<string, unknown> | undefined): string {
  if (!schema) return ''

  const properties = (schema as { properties?: Record<string, { type?: unknown }> }).properties
  if (!properties) return '  body: (schemat nieustrukturyzowany)'

  const required = new Set(((schema as { required?: string[] }).required ?? []) as string[])
  const fields = Object.entries(properties).map(([name, prop]) => {
    const type = Array.isArray(prop?.type) ? prop.type.join('|') : (prop?.type ?? 'unknown')
    return `${name}${required.has(name) ? '*' : ''}: ${String(type)}`
  })

  return `  body: { ${fields.join(', ')} }`
}

function describeOperation(op: OperationMeta): string {
  const lines = [`${op.operationId}  [${op.risk}]`, `  ${op.method.toUpperCase()} ${op.path}`, `  ${op.summary}`]

  if (op.pathParams.length > 0) lines.push(`  path: ${op.pathParams.join(', ')}`)
  if (op.queryParams.length > 0) {
    lines.push(`  query: ${op.queryParams.map((p) => `${p.name}${p.required ? '*' : ''}`).join(', ')}`)
  }

  const body = describeBody(op.bodySchema)
  if (body) lines.push(body)
  if (op.enumValues.length > 0) lines.push(`  dozwolone wartosci: ${op.enumValues.join(', ')}`)

  return lines.join('\n')
}

export const searchOperationsTool: ToolDefinition = {
  name: 'forge_search_operations',
  title: 'Wyszukaj operacje Forge API',
  description:
    'Przeszukuje wszystkie 273 operacje Laravel Forge API i zwraca dopasowania wraz ze schematem parametrow. ' +
    'Uzyj tego, gdy potrzebna operacja nie ma wlasnego narzedzia forge_*, a potem wywolaj ja przez forge_call. ' +
    'Przyklady zapytan: "certificate", "firewall", "recipe", "backup".',
  inputSchema: {
    query: z.string().describe('Fragment nazwy operacji, opisu albo sciezki, np. "certificate"'),
    tag: z.string().optional().describe('Zawezenie do grupy, np. "Sites", "Servers", "Databases"'),
    limit: z.number().int().min(1).max(50).optional().describe('Maksymalna liczba wynikow (domyslnie 15)'),
  },
  risk: 'read',
  handler: async (args, ctx) => {
    const results = ctx.index.search(args.query, { tag: args.tag, limit: args.limit ?? 15 })

    if (results.length === 0) {
      return `Nie znaleziono operacji pasujacych do "${args.query}". Sprobuj ogolniejszego slowa albo innego tagu.`
    }

    return results.map(describeOperation).join('\n\n')
  },
}
