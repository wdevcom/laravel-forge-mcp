import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export type OpenApiDocument = {
  paths: Record<string, Record<string, any>>
  components?: { schemas?: Record<string, any> }
}

const SPEC_RELATIVE_PATH = join('spec', 'forge.openapi.json')

/**
 * Szuka snapshotu idac w gore od katalogu modulu. Dzieki temu ta sama sciezka
 * dziala i przy uruchomieniu ze zrodel (src/openapi/), i po zbudowaniu
 * (dist/src/openapi/), gdzie liczba poziomow do korzenia pakietu jest inna.
 */
export function findSpecPath(startDir = dirname(fileURLToPath(import.meta.url))): string {
  let current = startDir

  for (;;) {
    const candidate = join(current, SPEC_RELATIVE_PATH)
    if (existsSync(candidate)) return candidate

    const parent = resolve(current, '..')
    if (parent === current) {
      throw new Error(
        `Nie znaleziono ${SPEC_RELATIVE_PATH} w zadnym katalogu nadrzednym wzgledem ${startDir}. ` +
          'Uruchom npm run sync:spec, zeby pobrac specyfikacje Forge API.',
      )
    }
    current = parent
  }
}

let cached: OpenApiDocument | undefined

export function loadSpec(): OpenApiDocument {
  cached ??= JSON.parse(readFileSync(findSpecPath(), 'utf8')) as OpenApiDocument
  return cached
}

const MAX_DEPTH = 8

/**
 * Rozwija $ref wzgledem components.schemas. Przy przekroczeniu glebokosci
 * albo cyklu zwraca placeholder zamiast wpasc w nieskonczona rekurencje.
 */
export function resolveRefs(
  node: unknown,
  doc: OpenApiDocument,
  depth = 0,
  seen: Set<string> = new Set(),
): unknown {
  if (node === null || typeof node !== 'object') return node
  if (depth > MAX_DEPTH) return { type: 'object', description: 'schemat obciety - przekroczona glebokosc' }

  if (Array.isArray(node)) {
    return node.map((item) => resolveRefs(item, doc, depth + 1, seen))
  }

  const record = node as Record<string, unknown>
  const ref = record['$ref']

  if (typeof ref === 'string') {
    const name = ref.split('/').pop()!
    if (seen.has(name)) return { type: 'object', description: `cykliczna referencja do ${name}` }

    const target = doc.components?.schemas?.[name]
    if (!target) return { type: 'object', description: `nieznana referencja ${name}` }

    return resolveRefs(target, doc, depth + 1, new Set([...seen, name]))
  }

  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    out[key] = resolveRefs(value, doc, depth + 1, seen)
  }
  return out
}
