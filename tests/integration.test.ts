import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest'
import { server, http, HttpResponse, BASE, withMswLifecycle } from './helpers/msw.js'
import { testContext, pickTool, srv, site, instantLimiter } from './helpers/context.js'
import { ForgeClient } from '../src/forge/client.js'
import { ForgeApiError } from '../src/forge/errors.js'
import { Resolver, AmbiguousReferenceError, ResolutionError } from '../src/domain/resolver.js'
import { allTools } from '../src/tools/index.js'
import { searchOperationsTool, callTool } from '../src/tools/universal/index.js'

withMswLifecycle({ beforeAll, afterEach, afterAll })

const client = () => new ForgeClient({ token: 'tok', baseUrl: BASE, limiter: instantLimiter() })
const tool = (name: string) => pickTool(allTools, name)

/** Katalog organizacji, z ktorego korzysta Resolver przy kazdym rozpoznawaniu nazwy. */
function catalog(servers = [srv('42', 'web-1')], sites = [site('918', 'sklep.pl', '42')]) {
  return [
    http.get(`${BASE}/orgs/acme/servers`, () => HttpResponse.json({ data: servers, meta: { next_cursor: null } })),
    http.get(`${BASE}/orgs/acme/sites`, () => HttpResponse.json({ data: sites, meta: { next_cursor: null } })),
  ]
}

const resource = (id: string, type: string, attributes: Record<string, unknown>) => ({ id, type, attributes })

describe('ForgeClient', () => {
  it('wysyla token i naglowki', async () => {
    let auth: string | null = null
    let accept: string | null = null
    server.use(
      http.get(`${BASE}/orgs`, ({ request }) => {
        auth = request.headers.get('Authorization')
        accept = request.headers.get('Accept')
        return HttpResponse.json({ data: [] })
      }),
    )

    await client().request({ method: 'get', path: '/orgs' })
    expect(auth).toBe('Bearer tok')
    expect(accept).toBe('application/json')
  })

  it('serializuje query i pomija undefined', async () => {
    let url = ''
    server.use(
      http.get(`${BASE}/orgs/acme/servers`, ({ request }) => {
        url = request.url
        return HttpResponse.json({ data: [] })
      }),
    )

    await client().request({
      method: 'get',
      path: '/orgs/acme/servers',
      query: { 'page[size]': 30, 'filter[name]': 'web', sort: undefined },
    })

    expect(url).toContain('page%5Bsize%5D=30')
    expect(url).toContain('filter%5Bname%5D=web')
    expect(url).not.toContain('sort')
  })

  it('wysyla body jako JSON', async () => {
    let payload: unknown
    server.use(
      http.post(`${BASE}/orgs/acme/servers/1/actions`, async ({ request }) => {
        payload = await request.json()
        return HttpResponse.json({ data: {} }, { status: 201 })
      }),
    )

    await client().request({ method: 'post', path: '/orgs/acme/servers/1/actions', body: { action: 'reboot' } })
    expect(payload).toEqual({ action: 'reboot' })
  })

  it('zwraca null dla odpowiedzi 204', async () => {
    server.use(http.delete(`${BASE}/orgs/acme/servers/1`, () => new HttpResponse(null, { status: 204 })))
    expect(await client().request({ method: 'delete', path: '/orgs/acme/servers/1' })).toBeNull()
  })

  it('rzuca ForgeApiError z czytelnym opisem', async () => {
    server.use(http.get(`${BASE}/orgs`, () => HttpResponse.json({ message: 'brak' }, { status: 404 })))
    await expect(client().request({ method: 'get', path: '/orgs' })).rejects.toThrow(ForgeApiError)
  })

  it('rozbija bledy walidacji 422 na pola', async () => {
    server.use(
      http.post(`${BASE}/orgs/acme/servers/1/sites`, () =>
        HttpResponse.json({ message: 'Bledne dane', errors: { domain: ['Domena jest wymagana'] } }, { status: 422 }),
      ),
    )

    await expect(client().request({ method: 'post', path: '/orgs/acme/servers/1/sites', body: {} })).rejects.toThrow(
      /domain: Domena jest wymagana/,
    )
  })

  it('ponawia zadanie po 429 i zwraca wynik', async () => {
    let calls = 0
    server.use(
      http.get(`${BASE}/orgs`, () => {
        calls += 1
        if (calls === 1) return HttpResponse.json({}, { status: 429, headers: { 'Retry-After': '1' } })
        return HttpResponse.json({ data: [] })
      }),
    )

    await client().request({ method: 'get', path: '/orgs' })
    expect(calls).toBe(2)
  })

  it('nie ponawia bledow innych niz 429', async () => {
    let calls = 0
    server.use(
      http.get(`${BASE}/orgs`, () => {
        calls += 1
        return HttpResponse.json({}, { status: 403 })
      }),
    )

    await expect(client().request({ method: 'get', path: '/orgs' })).rejects.toThrow()
    expect(calls).toBe(1)
  })
})

describe('paginacja', () => {
  function paged(totalPages: number) {
    return http.get(`${BASE}/orgs/acme/servers`, ({ request }) => {
      const cursor = new URL(request.url).searchParams.get('page[cursor]')
      const page = cursor ? Number(cursor) : 1
      return HttpResponse.json({
        data: [{ id: String(page), type: 'servers', attributes: { name: `web-${page}` } }],
        meta: { next_cursor: page >= totalPages ? null : String(page + 1) },
      })
    })
  }

  it('zbiera elementy ze wszystkich stron', async () => {
    server.use(paged(3))
    const result = await client().paginate<{ id: string }>({ method: 'get', path: '/orgs/acme/servers' })
    expect(result.items.map((i) => i.id)).toEqual(['1', '2', '3'])
    expect(result.truncated).toBe(false)
  })

  it('przerywa po limicie stron i oznacza wynik jako uciety', async () => {
    server.use(paged(50))
    const result = await client().paginate({ method: 'get', path: '/orgs/acme/servers' })
    expect(result.pages).toBe(5)
    expect(result.truncated).toBe(true)
  })

  it('respektuje wlasny limit stron', async () => {
    server.use(paged(50))
    expect((await client().paginate({ method: 'get', path: '/orgs/acme/servers' }, { maxPages: 2 })).items).toHaveLength(2)
  })

  it('radzi sobie z odpowiedzia bez meta', async () => {
    server.use(http.get(`${BASE}/orgs/acme/servers`, () => HttpResponse.json({ data: [{ id: '1' }] })))
    expect((await client().paginate({ method: 'get', path: '/orgs/acme/servers' })).truncated).toBe(false)
  })
})

describe('Resolver', () => {
  it('zwraca organizacje podana jawnie bez odpytywania API', async () => {
    expect(await new Resolver(client(), {}).resolveOrg('podana')).toBe('podana')
  })

  it('uzywa jedynej organizacji uzytkownika gdy nie ma domyslnej', async () => {
    server.use(
      http.get(`${BASE}/orgs`, () =>
        HttpResponse.json({ data: [resource('1', 'organizations', { slug: 'acme' })], meta: { next_cursor: null } }),
      ),
    )
    expect(await new Resolver(client(), {}).resolveOrg()).toBe('acme')
  })

  it('rzuca blad z lista gdy organizacji jest wiecej', async () => {
    server.use(
      http.get(`${BASE}/orgs`, () =>
        HttpResponse.json({
          data: [resource('1', 'organizations', { slug: 'acme' }), resource('2', 'organizations', { slug: 'beta' })],
          meta: { next_cursor: null },
        }),
      ),
    )
    await expect(new Resolver(client(), {}).resolveOrg()).rejects.toThrow(/acme, beta/)
  })

  it('rozpoznaje site po domenie', async () => {
    server.use(...catalog())
    expect(await new Resolver(client(), { defaultOrg: 'acme' }).resolveSite('sklep.pl')).toEqual({
      org: 'acme',
      serverId: 42,
      siteId: 918,
      name: 'sklep.pl',
      serverName: 'web-1',
    })
  })

  it('rozpoznaje site po identyfikatorze i bez wzgledu na wielkosc liter', async () => {
    server.use(...catalog())
    const resolver = new Resolver(client(), { defaultOrg: 'acme' })
    expect((await resolver.resolveSite(918)).name).toBe('sklep.pl')
    expect((await resolver.resolveSite('SKLEP.PL')).siteId).toBe(918)
  })

  it('rzuca AmbiguousReferenceError gdy domena jest na dwoch serwerach', async () => {
    server.use(...catalog([srv('42', 'web-1'), srv('43', 'web-2')], [site('918', 'sklep.pl', '42'), site('920', 'sklep.pl', '43')]))

    const error = await new Resolver(client(), { defaultOrg: 'acme' }).resolveSite('sklep.pl').catch((e) => e)
    expect(error).toBeInstanceOf(AmbiguousReferenceError)
    expect((error as AmbiguousReferenceError).candidates).toHaveLength(2)
    expect((error as Error).message).toContain('web-2')
  })

  it('pomija site bez relacji do serwera', async () => {
    server.use(...catalog([srv('42', 'web-1')], [{ id: '918', type: 'sites', attributes: { name: 'sklep.pl' } }]))
    await expect(new Resolver(client(), { defaultOrg: 'acme' }).resolveSite('sklep.pl')).rejects.toThrow(ResolutionError)
  })

  it('korzysta z cache i nie odpytuje API drugi raz', async () => {
    let calls = 0
    server.use(
      http.get(`${BASE}/orgs/acme/servers`, () => HttpResponse.json({ data: [srv('42', 'web-1')], meta: { next_cursor: null } })),
      http.get(`${BASE}/orgs/acme/sites`, () => {
        calls += 1
        return HttpResponse.json({ data: [site('918', 'sklep.pl', '42')], meta: { next_cursor: null } })
      }),
    )

    const resolver = new Resolver(client(), { defaultOrg: 'acme' })
    await resolver.resolveSite('sklep.pl')
    await resolver.resolveSite('sklep.pl')
    expect(calls).toBe(1)

    resolver.invalidate()
    await resolver.resolveSite('sklep.pl')
    expect(calls).toBe(2)
  })

  it('rozpoznaje serwer po nazwie i identyfikatorze', async () => {
    server.use(...catalog([srv('42', 'web-1'), srv('43', 'web-2')], []))
    const resolver = new Resolver(client(), { defaultOrg: 'acme' })
    expect((await resolver.resolveServer('web-2')).serverId).toBe(43)
    expect((await resolver.resolveServer(42)).name).toBe('web-1')
  })

  it('rzuca ResolutionError z lista dostepnych serwerow', async () => {
    server.use(...catalog([srv('42', 'web-1')], []))
    await expect(new Resolver(client(), { defaultOrg: 'acme' }).resolveServer('nieznany')).rejects.toThrow(/web-1/)
  })
})

describe('forge_search_operations', () => {
  it('znajduje operacje po fragmencie nazwy', async () => {
    expect(await searchOperationsTool.handler({ query: 'deployment' }, testContext())).toContain(
      'organizations.servers.sites.deployments.store',
    )
  })

  it('znajduje operacje po wartosci enum w body', async () => {
    const text = await searchOperationsTool.handler({ query: 'reboot' }, testContext())
    expect(text).toContain('organizations.servers.actions.store')
    expect(text).toContain('dozwolone wartosci: reboot, power-cycle')
  })

  it('podaje metode, sciezke i poziom ryzyka', async () => {
    const text = await searchOperationsTool.handler({ query: 'organizations.servers.destroy' }, testContext())
    expect(text).toContain('DELETE')
    expect(text).toContain('destructive')
  })

  it('informuje gdy nic nie znaleziono', async () => {
    expect(await searchOperationsTool.handler({ query: 'zzzznieistnieje' }, testContext())).toContain('Nie znaleziono')
  })
})

describe('forge_call', () => {
  it('wykonuje operacje i splaszcza odpowiedz', async () => {
    server.use(
      http.get(`${BASE}/orgs/acme/servers/42`, () =>
        HttpResponse.json({ data: { ...resource('42', 'servers', { name: 'web-1' }), links: { self: '/x' } } }),
      ),
    )

    const text = await callTool.handler(
      { operationId: 'organizations.servers.show', path: { organization: 'acme', server: 42 } },
      testContext(),
    )
    expect(text).toContain('web-1')
    expect(text).not.toContain('links')
  })

  it('zwraca surowa odpowiedz przy raw', async () => {
    server.use(
      http.get(`${BASE}/orgs/acme/servers/42`, () =>
        HttpResponse.json({ data: { ...resource('42', 'servers', { name: 'web-1' }), links: { self: '/x' } } }),
      ),
    )

    const text = await callTool.handler(
      { operationId: 'organizations.servers.show', path: { organization: 'acme', server: 42 }, raw: true },
      testContext(),
    )
    expect(text).toContain('links')
  })

  it('uzupelnia brakujaca organizacje z konfiguracji', async () => {
    let url = ''
    server.use(
      http.get(`${BASE}/orgs/acme/servers`, ({ request }) => {
        url = request.url
        return HttpResponse.json({ data: [] })
      }),
    )

    await callTool.handler({ operationId: 'organizations.servers.index' }, testContext())
    expect(url).toContain('/orgs/acme/servers')
  })

  it('odrzuca nieznany operationId i podpowiada podobne', async () => {
    const text = await callTool.handler({ operationId: 'organizations.servers.deploy' }, testContext())
    expect(text).toContain('Nieznana operacja')
  })

  it('blokuje operacje destrukcyjna w trybie domyslnym', async () => {
    const text = await callTool.handler(
      { operationId: 'organizations.servers.destroy', path: { organization: 'acme', server: 42 } },
      testContext('default'),
    )
    expect(text).toContain('--allow-destructive')
  })

  it('przepuszcza destrukcje gdy flaga jest wlaczona', async () => {
    server.use(http.delete(`${BASE}/orgs/acme/servers/42`, () => new HttpResponse(null, { status: 204 })))

    const text = await callTool.handler(
      { operationId: 'organizations.servers.destroy', path: { organization: 'acme', server: 42 } },
      testContext('allow-destructive'),
    )
    expect(text).toContain('Wykonano')
  })

  it('blokuje reboot na podstawie tresci body', async () => {
    const text = await callTool.handler(
      {
        operationId: 'organizations.servers.actions.store',
        path: { organization: 'acme', server: 42 },
        body: { action: 'reboot' },
      },
      testContext('default'),
    )
    expect(text).toContain('--allow-destructive')
  })

  it('blokuje zapis w trybie read-only', async () => {
    const text = await callTool.handler(
      { operationId: 'organizations.servers.sites.deployments.store', path: { organization: 'acme', server: 42, site: 918 } },
      testContext('read-only'),
    )
    expect(text).toContain('--read-only')
  })

  it('zglasza brakujacy parametr sciezki zamiast wysylac bledne zadanie', async () => {
    await expect(
      callTool.handler({ operationId: 'organizations.servers.show', path: { organization: 'acme' } }, testContext()),
    ).rejects.toThrow(/server/)
  })
})

describe('narzedzia kurowane', () => {
  it('forge_whoami wypisuje uzytkownika i organizacje', async () => {
    server.use(
      http.get(`${BASE}/user`, () => HttpResponse.json({ data: resource('7', 'users', { name: 'Robert', email: 'r@example.com' }) })),
      http.get(`${BASE}/orgs`, () =>
        HttpResponse.json({ data: [resource('1', 'organizations', { slug: 'acme' })], meta: { next_cursor: null } }),
      ),
    )

    const text = await tool('forge_whoami').handler({}, testContext())
    expect(text).toContain('Robert')
    expect(text).toContain('acme  (domyslna)')
  })

  it('forge_list_servers wypisuje tabele i przekazuje filtr', async () => {
    let url = ''
    server.use(
      http.get(`${BASE}/orgs/acme/servers`, ({ request }) => {
        url = request.url
        return HttpResponse.json({ data: [srv('42', 'web-1')], meta: { next_cursor: null } })
      }),
    )

    const text = await tool('forge_list_servers').handler({ search: 'web' }, testContext())
    expect(text).toContain('web-1')
    expect(text).toContain('10.0.0.42')
    expect(url).toContain('filter%5Bname%5D=web')
  })

  it('forge_list_sites zawezone do serwera trafia w endpoint serwera', async () => {
    server.use(
      ...catalog(),
      http.get(`${BASE}/orgs/acme/servers/42/sites`, () =>
        HttpResponse.json({ data: [site('918', 'sklep.pl', '42')], meta: { next_cursor: null } }),
      ),
    )

    expect(await tool('forge_list_sites').handler({ server: 'web-1' }, testContext())).toContain('sklep.pl')
  })

  it('forge_resolve podaje komplet identyfikatorow', async () => {
    server.use(...catalog())
    const text = await tool('forge_resolve').handler({ query: 'sklep.pl' }, testContext())
    expect(text).toContain('site: 918')
    expect(text).toContain('server: 42')
  })

  it('forge_get_server wypisuje szczegoly', async () => {
    server.use(
      ...catalog(),
      http.get(`${BASE}/orgs/acme/servers/42`, () =>
        HttpResponse.json({ data: resource('42', 'servers', { name: 'web-1', ip_address: '10.0.0.1' }) }),
      ),
    )

    expect(await tool('forge_get_server').handler({ server: 'web-1' }, testContext())).toContain('10.0.0.1')
  })

  it('forge_restart_service wysyla akcje restart', async () => {
    let payload: unknown
    server.use(
      ...catalog(),
      http.post(`${BASE}/orgs/acme/servers/42/services/nginx/actions`, async ({ request }) => {
        payload = await request.json()
        return HttpResponse.json({ data: resource('1', 'events', {}) })
      }),
    )

    await tool('forge_restart_service').handler({ server: 42, service: 'nginx' }, testContext())
    expect(payload).toEqual({ action: 'restart' })
  })

  it('forge_restart_service blokuje zatrzymanie w trybie domyslnym', async () => {
    server.use(...catalog())
    await expect(
      tool('forge_restart_service').handler({ server: 42, service: 'nginx', action: 'stop' }, testContext('default')),
    ).rejects.toThrow(/--allow-destructive/)
  })

  it('forge_server_action blokuje reboot w trybie domyslnym', async () => {
    server.use(...catalog())
    await expect(tool('forge_server_action').handler({ server: 42, action: 'reboot' }, testContext())).rejects.toThrow(
      /--allow-destructive/,
    )
  })

  it('forge_deploy_site zleca wdrozenie bez czekania', async () => {
    let called = false
    server.use(
      ...catalog(),
      http.post(`${BASE}/orgs/acme/servers/42/sites/918/deployments`, () => {
        called = true
        return HttpResponse.json({ data: resource('1', 'deployments', { status: 'deploying' }) })
      }),
    )

    const text = await tool('forge_deploy_site').handler({ site: 'sklep.pl' }, testContext())
    expect(called).toBe(true)
    expect(text).toContain('Zlecono wdrozenie')
  })

  it('forge_get_deployment_log bierze ostatnie wdrozenie gdy nie podano identyfikatora', async () => {
    server.use(
      ...catalog(),
      http.get(`${BASE}/orgs/acme/servers/42/sites/918/deployments`, () =>
        HttpResponse.json({ data: [resource('77', 'deployments', { status: 'failed' })], meta: { next_cursor: null } }),
      ),
      http.get(`${BASE}/orgs/acme/servers/42/sites/918/deployments/77/log`, () =>
        HttpResponse.json({ data: resource('77', 'deployment-outputs', { output: 'composer install failed' }) }),
      ),
    )

    const text = await tool('forge_get_deployment_log').handler({ site: 'sklep.pl' }, testContext())
    expect(text).toContain('composer install failed')
    expect(text).toContain('77')
  })

  it('forge_get_deployment_log informuje gdy nie ma wdrozen', async () => {
    server.use(
      ...catalog(),
      http.get(`${BASE}/orgs/acme/servers/42/sites/918/deployments`, () =>
        HttpResponse.json({ data: [], meta: { next_cursor: null } }),
      ),
    )

    expect(await tool('forge_get_deployment_log').handler({ site: 'sklep.pl' }, testContext())).toContain(
      'nie ma jeszcze zadnego wdrozenia',
    )
  })

  it('forge_get_env zwraca tresc pliku', async () => {
    server.use(
      ...catalog(),
      http.get(`${BASE}/orgs/acme/servers/42/sites/918/environment`, () =>
        HttpResponse.json({ data: resource('1', 'environments', { content: 'APP_ENV=production' }) }),
      ),
    )

    expect(await tool('forge_get_env').handler({ site: 'sklep.pl' }, testContext())).toBe('APP_ENV=production')
  })

  it('forge_update_env wysyla tresc pod kluczem environment', async () => {
    let payload: unknown
    server.use(
      ...catalog(),
      http.put(`${BASE}/orgs/acme/servers/42/sites/918/environment`, async ({ request }) => {
        payload = await request.json()
        return HttpResponse.json({ data: resource('1', 'environments', { content: 'APP_ENV=staging' }) })
      }),
    )

    await tool('forge_update_env').handler({ site: 'sklep.pl', content: 'APP_ENV=staging' }, testContext())
    expect(payload).toEqual({ environment: 'APP_ENV=staging' })
  })

  it('forge_update_nginx_config wysyla tresc pod kluczem config', async () => {
    let payload: unknown
    server.use(
      ...catalog(),
      http.put(`${BASE}/orgs/acme/servers/42/sites/918/nginx`, async ({ request }) => {
        payload = await request.json()
        return HttpResponse.json({ data: resource('1', 'nginx', { content: 'server {}' }) })
      }),
    )

    await tool('forge_update_nginx_config').handler({ site: 'sklep.pl', content: 'server {}' }, testContext())
    expect(payload).toEqual({ config: 'server {}' })
  })

  it('forge_update_deployment_script wysyla tresc pod kluczem content', async () => {
    let payload: unknown
    server.use(
      ...catalog(),
      http.put(`${BASE}/orgs/acme/servers/42/sites/918/deployments/script`, async ({ request }) => {
        payload = await request.json()
        return HttpResponse.json({ data: resource('1', 'scripts', { content: 'git pull' }) })
      }),
    )

    await tool('forge_update_deployment_script').handler({ site: 'sklep.pl', content: 'git pull' }, testContext())
    expect(payload).toEqual({ content: 'git pull' })
  })

  it('forge_get_site_logs pobiera log aplikacji i przycina do ostatnich linii', async () => {
    const long = Array.from({ length: 500 }, (_, i) => `linia ${i + 1}`).join('\n')
    server.use(
      ...catalog(),
      http.get(`${BASE}/orgs/acme/servers/42/sites/918/logs/application`, () =>
        HttpResponse.json({ data: resource('1', 'logs', { content: long }) }),
      ),
    )

    const text = await tool('forge_get_site_logs').handler({ site: 'sklep.pl', lines: 10 }, testContext())
    expect(text).toContain('linia 500')
    expect(text).toContain('pominieto 490')
  })

  it('forge_get_site_logs obsluguje log bledow Nginx', async () => {
    server.use(
      ...catalog(),
      http.get(`${BASE}/orgs/acme/servers/42/sites/918/logs/nginx-error`, () =>
        HttpResponse.json({ data: resource('1', 'logs', { content: 'upstream timed out' }) }),
      ),
    )

    expect(await tool('forge_get_site_logs').handler({ site: 'sklep.pl', type: 'nginx-error' }, testContext())).toContain(
      'upstream timed out',
    )
  })

  it('forge_run_command bez czekania zwraca identyfikator', async () => {
    server.use(
      ...catalog(),
      http.post(`${BASE}/orgs/acme/servers/42/sites/918/commands`, () =>
        HttpResponse.json({ data: resource('5', 'commands', { command: 'php artisan migrate', status: 'running' }) }),
      ),
    )

    const text = await tool('forge_run_command').handler(
      { site: 'sklep.pl', command: 'php artisan migrate', wait: false },
      testContext(),
    )
    expect(text).toContain('5')
  })

  it('forge_list_background_processes wypisuje procesy serwera', async () => {
    server.use(
      ...catalog(),
      http.get(`${BASE}/orgs/acme/servers/42/background-processes`, () =>
        HttpResponse.json({
          data: [resource('3', 'background-processes', { command: 'php artisan queue:work', status: 'running' })],
          meta: { next_cursor: null },
        }),
      ),
    )

    expect(await tool('forge_list_background_processes').handler({ server: 42 }, testContext())).toContain(
      'queue:work',
    )
  })

  it('forge_background_process_action restartuje worker', async () => {
    let payload: unknown
    server.use(
      ...catalog(),
      http.post(`${BASE}/orgs/acme/servers/42/background-processes/3/actions`, async ({ request }) => {
        payload = await request.json()
        return HttpResponse.json({ data: resource('1', 'events', {}) })
      }),
    )

    await tool('forge_background_process_action').handler({ server: 42, process: 3 }, testContext())
    expect(payload).toEqual({ action: 'restart' })
  })

  it('forge_list_databases laczy bazy i uzytkownikow', async () => {
    server.use(
      ...catalog(),
      http.get(`${BASE}/orgs/acme/servers/42/database/schemas`, () =>
        HttpResponse.json({ data: [resource('1', 'databases', { name: 'forge' })], meta: { next_cursor: null } }),
      ),
      http.get(`${BASE}/orgs/acme/servers/42/database/users`, () =>
        HttpResponse.json({ data: [resource('2', 'database-users', { name: 'forge_user' })], meta: { next_cursor: null } }),
      ),
    )

    const text = await tool('forge_list_databases').handler({ server: 42 }, testContext())
    expect(text).toContain('forge')
    expect(text).toContain('forge_user')
  })

  it('forge_list_scheduled_jobs zawezone do site trafia w endpoint site', async () => {
    server.use(
      ...catalog(),
      http.get(`${BASE}/orgs/acme/servers/42/sites/918/scheduled-jobs`, () =>
        HttpResponse.json({ data: [resource('4', 'jobs', { command: 'schedule:run', frequency: 'minutely' })], meta: { next_cursor: null } }),
      ),
    )

    expect(await tool('forge_list_scheduled_jobs').handler({ server: 42, site: 'sklep.pl' }, testContext())).toContain(
      'schedule:run',
    )
  })
})
