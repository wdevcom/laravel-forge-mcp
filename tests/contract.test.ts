import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { SpecIndex } from '../src/openapi/index.js'
import { findSpecPath } from '../src/openapi/spec.js'
import { allTools, curatedTools } from '../src/tools/index.js'
import { universalTools } from '../src/tools/universal/index.js'

const index = SpecIndex.build()

/** Operacje sklejane w kodzie z fragmentu dynamicznego - rozwijamy je recznie. */
const DYNAMIC_OPERATIONS = [
  ...['application', 'nginx-error', 'nginx-access'].map((t) => `organizations.servers.sites.logs.${t}.show`),
  ...['nginx', 'php', 'mysql', 'postgres', 'redis', 'supervisor'].map(
    (s) => `organizations.servers.services.${s}.actions.store`,
  ),
]

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return path.endsWith('.ts') ? [path] : []
  })
}

function operationIdsInSource(): string[] {
  const pattern = /['"`]((?:organizations|providers|permissions|forge-recipes|predefined-roles|user|me)[a-z0-9.-]*)['"`]/gi

  const found = new Set<string>()
  for (const file of sourceFiles('src')) {
    for (const match of readFileSync(file, 'utf8').matchAll(pattern)) {
      const id = match[1]!
      if (id.includes('.')) found.add(id)
    }
  }
  return [...found]
}

describe('lokalizacja snapshotu specu', () => {
  it('znajduje spec przy uruchomieniu ze zrodel', () => {
    expect(findSpecPath(join(process.cwd(), 'src', 'openapi'))).toContain('spec/forge.openapi.json')
  })

  it('znajduje spec po zbudowaniu, gdy modul lezy glebiej w dist', () => {
    // dist/src/openapi/ ma inna liczbe poziomow do korzenia niz src/openapi/,
    // wiec stala sciezka '../../spec' dziala tylko w jednym z tych przypadkow.
    expect(findSpecPath(join(process.cwd(), 'dist', 'src', 'openapi'))).toContain('spec/forge.openapi.json')
  })

  it('zglasza czytelny blad gdy specu nigdzie nie ma', () => {
    expect(() => findSpecPath('/')).toThrow(/npm run sync:spec/)
  })
})

describe('kontrakt ze specyfikacja API', () => {
  it('kazdy operationId uzyty w kodzie istnieje w specyfikacji', () => {
    const missing = operationIdsInSource().filter((id) => !index.get(id))
    expect(missing, 'kod odwoluje sie do nieistniejacych endpointow').toEqual([])
  })

  it('kazda operacja sklejana dynamicznie istnieje w specyfikacji', () => {
    const missing = DYNAMIC_OPERATIONS.filter((id) => !index.get(id))
    expect(missing).toEqual([])
  })

  it('kod nie odwoluje sie do nieistniejacych workerow na poziomie site', () => {
    // API v2 nie ma workerow site-level, mimo ze wystawia je PHP SDK.
    expect(index.get('organizations.servers.sites.workers.index')).toBeUndefined()
  })

  it('specyfikacja zawiera komplet operacji', () => {
    expect(index.size()).toBeGreaterThanOrEqual(273)
  })
})

describe('zestaw narzedzi', () => {
  it('wystawia 26 narzedzi kurowanych', () => {
    expect(curatedTools).toHaveLength(26)
  })

  it('wystawia 2 narzedzia uniwersalne', () => {
    expect(universalTools.map((t) => t.name)).toEqual(['forge_search_operations', 'forge_call'])
  })

  it('nadaje kazdemu narzedziu prefiks forge_', () => {
    expect(allTools.filter((t) => !t.name.startsWith('forge_'))).toEqual([])
  })

  it('nie ma zduplikowanych nazw', () => {
    const names = allTools.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('kazde narzedzie ma opis wystarczajaco dlugi, zeby model je rozroznil', () => {
    expect(allTools.filter((t) => t.description.length < 40).map((t) => t.name)).toEqual([])
  })

  it('kazde narzedzie ma tytul', () => {
    expect(allTools.filter((t) => !t.title).map((t) => t.name)).toEqual([])
  })

  it('narzedzia odczytujace nie maja poziomu wyzszego niz read', () => {
    const readers = ['forge_whoami', 'forge_list_servers', 'forge_get_site', 'forge_get_env', 'forge_get_site_logs']
    for (const name of readers) {
      expect(allTools.find((t) => t.name === name)!.risk).toBe('read')
    }
  })

  it('narzedzia modyfikujace maja poziom write', () => {
    const writers = ['forge_deploy_site', 'forge_update_env', 'forge_run_command', 'forge_restart_service']
    for (const name of writers) {
      expect(allTools.find((t) => t.name === name)!.risk).toBe('write')
    }
  })
})
