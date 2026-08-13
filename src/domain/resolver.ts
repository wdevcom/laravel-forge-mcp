import type { ForgeClient } from '../forge/client.js'
import type { JsonApiResource } from './formatter.js'

export interface ServerRef {
  org: string
  serverId: number
  name: string
}

export interface SiteRef {
  org: string
  serverId: number
  siteId: number
  name: string
  serverName: string
}

export class ResolutionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ResolutionError'
  }
}

export class AmbiguousReferenceError extends Error {
  constructor(
    readonly query: string,
    readonly candidates: Array<ServerRef | SiteRef>,
  ) {
    const lines = candidates.map((c) =>
      'siteId' in c
        ? `  site ${c.siteId} (${c.name}) na serwerze ${c.serverId} (${c.serverName})`
        : `  serwer ${c.serverId} (${c.name})`,
    )
    super(
      `Zapytanie "${query}" pasuje do wiecej niz jednego zasobu:\n${lines.join('\n')}\nPodaj identyfikator liczbowy.`,
    )
    this.name = 'AmbiguousReferenceError'
  }
}

interface OrgCache {
  servers: ServerRef[]
  sites: SiteRef[]
  fetchedAt: number
}

export interface ResolverOptions {
  defaultOrg?: string
  ttlMs?: number
  now?: () => number
}

const DEFAULT_TTL_MS = 5 * 60 * 1000

export class Resolver {
  private readonly defaultOrg?: string
  private readonly ttlMs: number
  private readonly now: () => number
  private readonly cache = new Map<string, OrgCache>()
  private orgSlugs?: string[]

  constructor(
    private readonly client: ForgeClient,
    opts: ResolverOptions = {},
  ) {
    this.defaultOrg = opts.defaultOrg
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
    this.now = opts.now ?? (() => Date.now())
  }

  invalidate(): void {
    this.cache.clear()
    this.orgSlugs = undefined
  }

  async resolveOrg(explicit?: string): Promise<string> {
    if (explicit) return explicit
    if (this.defaultOrg) return this.defaultOrg

    this.orgSlugs ??= (await this.client.paginate<JsonApiResource>({ method: 'get', path: '/orgs' })).items.map(
      (org) => String(org.attributes?.slug ?? org.id),
    )

    if (this.orgSlugs.length === 1) return this.orgSlugs[0]!

    if (this.orgSlugs.length === 0) {
      throw new ResolutionError('Token nie daje dostepu do zadnej organizacji Forge.')
    }

    throw new ResolutionError(
      `Masz dostep do kilku organizacji: ${this.orgSlugs.join(', ')}. ` +
        'Wskaz jedna w argumencie org albo ustaw zmienna FORGE_ORG.',
    )
  }

  private async load(org: string): Promise<OrgCache> {
    const cached = this.cache.get(org)
    if (cached && this.now() - cached.fetchedAt < this.ttlMs) return cached

    const [serverPage, sitePage] = await Promise.all([
      this.client.paginate<JsonApiResource>({ method: 'get', path: `/orgs/${org}/servers` }),
      this.client.paginate<JsonApiResource>({
        method: 'get',
        path: `/orgs/${org}/sites`,
        query: { include: 'server' },
      }),
    ])

    const servers: ServerRef[] = serverPage.items.map((s) => ({
      org,
      serverId: Number(s.id),
      name: String(s.attributes?.name ?? s.id),
    }))

    const serverNames = new Map(servers.map((s) => [s.serverId, s.name]))

    const sites: SiteRef[] = sitePage.items.flatMap((s) => {
      const relation = (s.relationships as { server?: { data?: { id?: string } } } | undefined)?.server?.data?.id
      if (!relation) return []

      const serverId = Number(relation)
      return [
        {
          org,
          serverId,
          siteId: Number(s.id),
          name: String(s.attributes?.name ?? s.id),
          serverName: serverNames.get(serverId) ?? String(serverId),
        },
      ]
    })

    const entry: OrgCache = { servers, sites, fetchedAt: this.now() }
    this.cache.set(org, entry)
    return entry
  }

  async resolveServer(query: string | number, org?: string): Promise<ServerRef> {
    const slug = await this.resolveOrg(org)
    const { servers } = await this.load(slug)
    const needle = String(query).trim().toLowerCase()

    const byId = servers.filter((s) => String(s.serverId) === needle)
    if (byId.length === 1) return byId[0]!

    const byName = servers.filter((s) => s.name.toLowerCase() === needle)
    if (byName.length === 1) return byName[0]!
    if (byName.length > 1) throw new AmbiguousReferenceError(String(query), byName)

    throw new ResolutionError(
      `Nie znaleziono serwera "${query}" w organizacji ${slug}. ` +
        `Dostepne: ${servers.map((s) => s.name).join(', ') || 'brak'}.`,
    )
  }

  async resolveSite(query: string | number, org?: string): Promise<SiteRef> {
    const slug = await this.resolveOrg(org)
    const { sites } = await this.load(slug)
    const needle = String(query).trim().toLowerCase()

    const byId = sites.filter((s) => String(s.siteId) === needle)
    if (byId.length === 1) return byId[0]!

    const byName = sites.filter((s) => s.name.toLowerCase() === needle)
    if (byName.length === 1) return byName[0]!
    if (byName.length > 1) throw new AmbiguousReferenceError(String(query), byName)

    throw new ResolutionError(
      `Nie znaleziono site'a "${query}" w organizacji ${slug}. ` +
        'Sprawdz nazwe narzedziem forge_list_sites albo podaj identyfikatory serwera i site jawnie.',
    )
  }
}
