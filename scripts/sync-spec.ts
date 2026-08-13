#!/usr/bin/env tsx
import { writeFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SPEC_URL = 'https://forge.laravel.com/api/docs.openapi'
const TARGET = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'spec', 'forge.openapi.json')

const response = await fetch(SPEC_URL, { headers: { Accept: 'application/json' } })

if (!response.ok) {
  console.error(`Nie udalo sie pobrac specu: HTTP ${response.status}`)
  process.exit(1)
}

const spec = (await response.json()) as { paths: Record<string, Record<string, unknown>> }

const operations = Object.values(spec.paths)
  .flatMap((item) => Object.keys(item))
  .filter((method) => ['get', 'post', 'put', 'patch', 'delete'].includes(method)).length

await writeFile(TARGET, `${JSON.stringify(spec, null, 2)}\n`, 'utf8')

console.error(`Zapisano spec: ${Object.keys(spec.paths).length} sciezek, ${operations} operacji`)
