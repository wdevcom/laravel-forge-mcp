export interface JsonApiResource {
  id: string
  type: string
  attributes?: Record<string, unknown>
  relationships?: Record<string, unknown>
  links?: unknown
}

/**
 * Splaszcza zasob JSON:API. `links` i `relationships` sa odrzucane - to
 * najwiekszy balast w odpowiedziach Forge, a model z nich nie korzysta.
 */
export function flatten(resource: JsonApiResource): Record<string, unknown> {
  return { ...(resource.attributes ?? {}), id: resource.id, type: resource.type }
}

export function flattenMany(resources: JsonApiResource[]): Record<string, unknown>[] {
  return resources.map(flatten)
}

function render(value: unknown): string {
  if (value === null || value === undefined) return '-'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

export function toTable(rows: Record<string, unknown>[], columns: string[]): string {
  if (rows.length === 0) return 'Brak wynikow.'

  const widths = columns.map((column) =>
    Math.max(column.length, ...rows.map((row) => render(row[column]).length)),
  )

  const line = (cells: string[]) => cells.map((cell, i) => cell.padEnd(widths[i]!)).join('  ').trimEnd()

  return [line(columns), ...rows.map((row) => line(columns.map((c) => render(row[c]))))].join('\n')
}

export function toKeyValue(row: Record<string, unknown>, keys?: string[]): string {
  const selected = keys ?? Object.keys(row)

  return selected
    .filter((key) => row[key] !== null && row[key] !== undefined)
    .map((key) => `${key}: ${render(row[key])}`)
    .join('\n')
}

/**
 * Logi i wyjscia komend czyta sie od konca, wiec przycinamy poczatek.
 */
export function truncateLines(text: string, maxLines: number): string {
  const lines = text.split('\n')
  if (lines.length <= maxLines) return text

  const omitted = lines.length - maxLines
  return [`[pominieto ${omitted} wczesniejszych linii]`, ...lines.slice(-maxLines)].join('\n')
}
