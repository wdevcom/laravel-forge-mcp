import { describe, it, expect } from 'vitest'
import { SpecIndex } from '../src/openapi/index.js'
import { classify, isAllowed, denialMessage, annotationsFor } from '../src/domain/policy.js'
import { flatten, flattenMany, toTable, toKeyValue, truncateLines } from '../src/domain/formatter.js'
import { loadConfig, ConfigError } from '../src/config.js'
import { describeError, ForgeApiError } from '../src/forge/errors.js'
import { RateLimiter } from '../src/forge/rate-limiter.js'
import { buildPath } from '../src/tools/universal/index.js'

const index = SpecIndex.build()
const op = (id: string) => {
  const found = index.get(id)
  if (!found) throw new Error(`brak operacji ${id}`)
  return found
}

describe('SpecIndex', () => {
  it('zwraca metadane operacji po operationId', () => {
    const meta = op('organizations.servers.index')
    expect(meta.method).toBe('get')
    expect(meta.path).toBe('/orgs/{organization}/servers')
    expect(meta.pathParams).toEqual(['organization'])
    expect(meta.tag).toBe('Servers')
  })

  it('zwraca undefined dla nieznanego operationId', () => {
    expect(index.get('nie.ma.takiej.operacji')).toBeUndefined()
  })

  it('wykrywa parametry sciezki w zagniezdzonych zasobach', () => {
    expect(op('organizations.servers.sites.deployments.log.show').pathParams).toEqual([
      'organization',
      'server',
      'site',
      'deployment',
    ])
  })

  it('rozwija $ref w schemacie body', () => {
    const schema = op('organizations.servers.sites.environment.update').bodySchema
    expect(schema).toBeDefined()
    expect(JSON.stringify(schema)).not.toContain('$ref')
  })

  it('wyszukuje operacje po fragmencie nazwy', () => {
    expect(index.search('deployment').length).toBeGreaterThan(5)
  })

  it('wyszukuje operacje po tresci summary', () => {
    expect(index.search('reboot').map((r) => r.operationId)).toContain('organizations.servers.actions.store')
  })

  it('zaweza wyszukiwanie do tagu', () => {
    expect(index.search('list', { tag: 'Databases' }).every((r) => r.tag === 'Databases')).toBe(true)
  })

  it('respektuje limit wynikow', () => {
    expect(index.search('list', { limit: 3 })).toHaveLength(3)
  })

  it('preferuje trafienie w operationId nad trafieniem w summary', () => {
    expect(index.search('environment')[0]!.operationId).toContain('environment')
  })
})

describe('classify', () => {
  it('klasyfikuje GET jako read', () => {
    expect(classify(op('organizations.servers.index'))).toBe('read')
  })

  it('klasyfikuje POST jako write', () => {
    expect(classify(op('organizations.servers.sites.deployments.store'))).toBe('write')
  })

  it('klasyfikuje DELETE jako destructive', () => {
    expect(classify(op('organizations.servers.destroy'))).toBe('destructive')
  })

  it('podnosi reboot do destructive na podstawie body', () => {
    expect(classify(op('organizations.servers.actions.store'), { action: 'reboot' })).toBe('destructive')
  })

  it('zostawia inna akcje serwera jako write', () => {
    expect(classify(op('organizations.servers.actions.store'), { action: 'ping' })).toBe('write')
  })

  it('podnosi zatrzymanie uslugi do destructive', () => {
    expect(classify(op('organizations.servers.services.nginx.actions.store'), { action: 'stop' })).toBe('destructive')
  })

  it('zostawia restart uslugi jako write', () => {
    expect(classify(op('organizations.servers.services.nginx.actions.store'), { action: 'restart' })).toBe('write')
  })

  it('podnosi zatrzymanie procesu w tle do destructive', () => {
    expect(classify(op('organizations.servers.background-processes.actions.store'), { action: 'stop' })).toBe(
      'destructive',
    )
  })

  it('traktuje brak body przy operacji warunkowej jako write', () => {
    expect(classify(op('organizations.servers.actions.store'))).toBe('write')
  })
})

describe('isAllowed', () => {
  it('w trybie read-only przepuszcza tylko odczyt', () => {
    expect([isAllowed('read', 'read-only'), isAllowed('write', 'read-only'), isAllowed('destructive', 'read-only')]).toEqual([
      true,
      false,
      false,
    ])
  })

  it('w trybie domyslnym blokuje destrukcje', () => {
    expect([isAllowed('read', 'default'), isAllowed('write', 'default'), isAllowed('destructive', 'default')]).toEqual([
      true,
      true,
      false,
    ])
  })

  it('w trybie allow-destructive przepuszcza wszystko', () => {
    expect(isAllowed('destructive', 'allow-destructive')).toBe(true)
  })
})

describe('denialMessage', () => {
  it('wskazuje flage odblokowujaca destrukcje', () => {
    expect(denialMessage('organizations.servers.destroy', 'destructive', 'default')).toContain('--allow-destructive')
  })

  it('wyjasnia blokade zapisu w trybie read-only', () => {
    expect(denialMessage('x.store', 'write', 'read-only')).toContain('--read-only')
  })
})

describe('annotationsFor', () => {
  it('oznacza odczyt jako bezpieczny', () => {
    expect(annotationsFor('read')).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true })
  })

  it('oznacza destrukcje odpowiednimi podpowiedziami', () => {
    expect(annotationsFor('destructive')).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    })
  })
})

describe('formatter', () => {
  const resource = {
    id: '42',
    type: 'servers',
    attributes: { name: 'web-1', ip_address: '10.0.0.1', is_ready: true },
    relationships: { tags: { data: [] } },
    links: { self: '/api/orgs/acme/servers/42' },
  }

  it('wciaga attributes na poziom obiektu', () => {
    expect(flatten(resource)).toMatchObject({ name: 'web-1', ip_address: '10.0.0.1', is_ready: true })
  })

  it('odrzuca links i relationships', () => {
    const result = flatten(resource)
    expect(result).not.toHaveProperty('links')
    expect(result).not.toHaveProperty('relationships')
  })

  it('nie pozwala atrybutowi id nadpisac identyfikatora zasobu', () => {
    expect(flatten({ id: '42', type: 'servers', attributes: { id: 999 } }).id).toBe('42')
  })

  it('splaszcza liste zasobow', () => {
    expect(flattenMany([resource, resource])).toHaveLength(2)
  })

  it('wyrownuje kolumny tabeli', () => {
    const rows = [
      { id: '1', name: 'web-1' },
      { id: '2', name: 'db-1' },
    ]
    const lines = toTable(rows, ['id', 'name']).split('\n')
    expect(lines[0]!.indexOf('name')).toBe(lines[1]!.indexOf('web-1'))
  })

  it('zastepuje brakujace wartosci myslnikiem', () => {
    expect(toTable([{ id: '1' }], ['id', 'name'])).toContain('-')
  })

  it('informuje o braku wynikow', () => {
    expect(toTable([], ['id'])).toBe('Brak wynikow.')
  })

  it('zaweza pary klucz-wartosc do wskazanych kluczy z kolejnoscia', () => {
    expect(toKeyValue({ b: 2, a: 1, c: 3 }, ['a', 'b']).split('\n')).toEqual(['a: 1', 'b: 2'])
  })

  it('pomija wartosci null', () => {
    expect(toKeyValue({ name: 'web', database: null })).toBe('name: web')
  })

  it('przycina poczatek dlugiego tekstu i informuje ile pominieto', () => {
    const text = Array.from({ length: 200 }, (_, i) => `linia ${i + 1}`).join('\n')
    const result = truncateLines(text, 10)
    expect(result).toContain('linia 200')
    expect(result).toContain('190')
  })

  it('zwraca krotki tekst bez zmian', () => {
    expect(truncateLines('a\nb', 10)).toBe('a\nb')
  })
})

describe('loadConfig', () => {
  const withToken = { FORGE_API_TOKEN: 'tok_123' }

  it('czyta token ze zmiennej srodowiskowej', () => {
    expect(loadConfig(withToken, []).token).toBe('tok_123')
  })

  it('rzuca czytelny blad gdy brakuje tokenu', () => {
    expect(() => loadConfig({}, [])).toThrow(ConfigError)
    expect(() => loadConfig({}, [])).toThrow(/FORGE_API_TOKEN/)
  })

  it('odrzuca token zlozony z samych spacji', () => {
    expect(() => loadConfig({ FORGE_API_TOKEN: '   ' }, [])).toThrow(ConfigError)
  })

  it('domyslnie dziala w trybie default', () => {
    expect(loadConfig(withToken, []).mode).toBe('default')
  })

  it('ustawia tryby na podstawie flag', () => {
    expect(loadConfig(withToken, ['--read-only']).mode).toBe('read-only')
    expect(loadConfig(withToken, ['--allow-destructive']).mode).toBe('allow-destructive')
  })

  it('odrzuca jednoczesne uzycie obu flag trybu', () => {
    expect(() => loadConfig(withToken, ['--read-only', '--allow-destructive'])).toThrow(/jednoczesnie/)
  })

  it('czyta domyslna organizacje', () => {
    expect(loadConfig({ ...withToken, FORGE_ORG: 'acme' }, []).defaultOrg).toBe('acme')
  })

  it('odrzuca probe podania tokenu w argumencie', () => {
    expect(() => loadConfig(withToken, ['--token=tok_456'])).toThrow(/widoczne w ps/)
  })
})

describe('describeError', () => {
  it('tlumaczy kody na komunikaty po polsku', () => {
    expect(describeError(401, null)).toContain('FORGE_API_TOKEN')
    expect(describeError(403, null)).toContain('uprawnien')
    expect(describeError(404, null)).toContain('nie istnieje')
    expect(describeError(429, null)).toContain('limit')
    expect(describeError(503, null)).toContain('konserwacji')
  })

  it('wypisuje bledy walidacji per pole', () => {
    const msg = describeError(422, { message: 'Bledne dane', errors: { domain: ['Domena jest wymagana'] } })
    expect(msg).toContain('domain: Domena jest wymagana')
  })

  it('dla nieznanego kodu podaje sam kod', () => {
    expect(describeError(418, null)).toContain('418')
  })

  it('ForgeApiError zachowuje status i tresc', () => {
    const error = new ForgeApiError(404, { message: 'brak' })
    expect(error.status).toBe(404)
    expect(error.name).toBe('ForgeApiError')
  })
})

describe('RateLimiter', () => {
  function fakeClock(start = 0) {
    let now = start
    const slept: number[] = []
    return {
      now: () => now,
      sleep: async (ms: number) => {
        slept.push(ms)
        now += ms
      },
      slept,
      advance: (ms: number) => {
        now += ms
      },
    }
  }

  it('przepuszcza zadania do wyczerpania pojemnosci bez czekania', async () => {
    const clock = fakeClock()
    const limiter = new RateLimiter({ capacity: 3, refillPerMinute: 60, now: clock.now, sleep: clock.sleep })
    await limiter.acquire()
    await limiter.acquire()
    await limiter.acquire()
    expect(clock.slept).toEqual([])
  })

  it('usypia gdy pojemnosc sie wyczerpie', async () => {
    const clock = fakeClock()
    const limiter = new RateLimiter({ capacity: 1, refillPerMinute: 60, now: clock.now, sleep: clock.sleep })
    await limiter.acquire()
    await limiter.acquire()
    expect(clock.slept.length).toBe(1)
    expect(clock.slept[0]).toBeGreaterThan(0)
  })

  it('uzupelnia tokeny z uplywem czasu', async () => {
    const clock = fakeClock()
    const limiter = new RateLimiter({ capacity: 2, refillPerMinute: 60, now: clock.now, sleep: clock.sleep })
    await limiter.acquire()
    await limiter.acquire()
    clock.advance(60_000)
    await limiter.acquire()
    expect(clock.slept).toEqual([])
  })

  it('zwalnia tempo gdy naglowek zglasza maly zapas', async () => {
    const clock = fakeClock()
    const limiter = new RateLimiter({ capacity: 60, refillPerMinute: 60, now: clock.now, sleep: clock.sleep })
    limiter.observeHeaders(new Headers({ 'X-RateLimit-Remaining': '1', 'X-RateLimit-Limit': '60' }))
    await limiter.acquire()
    expect(clock.slept.length).toBeGreaterThan(0)
  })

  it('nie zwalnia gdy zapas jest duzy', async () => {
    const clock = fakeClock()
    const limiter = new RateLimiter({ capacity: 60, refillPerMinute: 60, now: clock.now, sleep: clock.sleep })
    limiter.observeHeaders(new Headers({ 'X-RateLimit-Remaining': '55', 'X-RateLimit-Limit': '60' }))
    await limiter.acquire()
    expect(clock.slept).toEqual([])
  })

  it('respektuje naglowek Retry-After', () => {
    const limiter = new RateLimiter({ now: () => 0, sleep: async () => {} })
    expect(limiter.retryDelayMs(new Headers({ 'Retry-After': '5' }), 1)).toBe(5000)
  })

  it('stosuje wykladniczy backoff gdy brak Retry-After', () => {
    const limiter = new RateLimiter({ now: () => 0, sleep: async () => {} })
    expect(limiter.retryDelayMs(new Headers(), 2)).toBeGreaterThan(limiter.retryDelayMs(new Headers(), 1))
  })
})

describe('buildPath', () => {
  it('podstawia parametry sciezki', () => {
    expect(buildPath('/orgs/{organization}/servers/{server}', { organization: 'acme', server: 42 })).toBe(
      '/orgs/acme/servers/42',
    )
  })

  it('koduje wartosci wymagajace ucieczki', () => {
    expect(buildPath('/orgs/{organization}/sites/{site}', { organization: 'a b', site: 1 })).toBe('/orgs/a%20b/sites/1')
  })

  it('rzuca blad gdy brakuje parametru', () => {
    expect(() => buildPath('/orgs/{organization}/servers/{server}', { organization: 'acme' })).toThrow(/server/)
  })
})
