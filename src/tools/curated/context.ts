import { z } from 'zod'
import type { ToolDefinition } from '../types.js'
import { callOperation, paginateOperation, dataOf, truncationNote } from './helpers.js'
import { flatten, flattenMany, toTable, toKeyValue, type JsonApiResource } from '../../domain/formatter.js'
import { AmbiguousReferenceError, ResolutionError } from '../../domain/resolver.js'

const SERVER_COLUMNS = ['id', 'name', 'ip_address', 'php_version', 'provider', 'region', 'is_ready']
const SITE_COLUMNS = ['id', 'name', 'status', 'deployment_status', 'php_version']

export const whoamiTool: ToolDefinition = {
  name: 'forge_whoami',
  title: 'Konto i organizacje',
  description:
    'Pokazuje zalogowanego uzytkownika Forge oraz liste jego organizacji wraz z ich slugami. ' +
    'Zacznij od tego narzedzia, gdy nie wiesz, do ktorej organizacji nalezy zasob.',
  inputSchema: {},
  risk: 'read',
  handler: async (_args, ctx) => {
    const [user, orgs] = await Promise.all([
      callOperation(ctx, 'user.show'),
      paginateOperation(ctx, 'organizations.index'),
    ])

    const profile = flatten(dataOf(user) as JsonApiResource)
    const organizations = flattenMany(orgs.items)

    const lines = organizations.map((org) => {
      const slug = String(org.slug ?? org.id)
      const isDefault = ctx.config.defaultOrg === slug
      return `  ${slug}${isDefault ? '  (domyslna)' : ''}`
    })

    return [toKeyValue(profile, ['name', 'email', 'id']), '', `Organizacje (${organizations.length}):`, ...lines].join(
      '\n',
    )
  },
}

export const listServersTool: ToolDefinition = {
  name: 'forge_list_servers',
  title: 'Lista serwerow',
  description:
    'Wypisuje serwery w organizacji: identyfikator, nazwe, adres IP, wersje PHP i gotowosc. ' +
    'Uzyj argumentu search, zeby zawezic liste po nazwie.',
  inputSchema: {
    org: z.string().optional().describe('Slug organizacji, domyslnie z konfiguracji serwera'),
    search: z.string().optional().describe('Fragment nazwy serwera'),
  },
  risk: 'read',
  handler: async (args, ctx) => {
    const org = await ctx.resolver.resolveOrg(args.org)

    const { items, truncated } = await paginateOperation(
      ctx,
      'organizations.servers.index',
      { organization: org },
      { query: args.search ? { 'filter[name]': args.search } : undefined },
    )

    return toTable(flattenMany(items), SERVER_COLUMNS) + truncationNote(truncated)
  },
}

export const listSitesTool: ToolDefinition = {
  name: 'forge_list_sites',
  title: 'Lista site',
  description:
    'Wypisuje site w organizacji albo na wskazanym serwerze: identyfikator, domene, status i status ostatniego wdrozenia. ' +
    'Argument server przyjmuje nazwe serwera albo jego identyfikator.',
  inputSchema: {
    org: z.string().optional().describe('Slug organizacji, domyslnie z konfiguracji serwera'),
    server: z.union([z.string(), z.number()]).optional().describe('Nazwa albo identyfikator serwera'),
    search: z.string().optional().describe('Fragment domeny site'),
  },
  risk: 'read',
  handler: async (args, ctx) => {
    const query = args.search ? { 'filter[name]': args.search } : undefined

    if (args.server !== undefined) {
      const ref = await ctx.resolver.resolveServer(args.server, args.org)
      const { items, truncated } = await paginateOperation(
        ctx,
        'organizations.servers.sites.index',
        { organization: ref.org, server: ref.serverId },
        { query },
      )
      return `Serwer ${ref.name} (${ref.serverId}):\n${toTable(flattenMany(items), SITE_COLUMNS)}${truncationNote(truncated)}`
    }

    const org = await ctx.resolver.resolveOrg(args.org)
    const { items, truncated } = await paginateOperation(
      ctx,
      'organizations.sites.index',
      { organization: org },
      { query },
    )

    return toTable(flattenMany(items), SITE_COLUMNS) + truncationNote(truncated)
  },
}

export const resolveTool: ToolDefinition = {
  name: 'forge_resolve',
  title: 'Znajdz identyfikatory zasobu',
  description:
    'Zamienia domene albo nazwe na komplet identyfikatorow {organization, server, site}. ' +
    'Przydatne, gdy chcesz uzyc forge_call, ktore wymaga surowych identyfikatorow.',
  inputSchema: {
    query: z.string().describe('Domena site albo nazwa serwera, np. "sklep.pl" lub "web-1"'),
    org: z.string().optional().describe('Slug organizacji, domyslnie z konfiguracji serwera'),
  },
  risk: 'read',
  handler: async (args, ctx) => {
    try {
      const site = await ctx.resolver.resolveSite(args.query, args.org)
      return toKeyValue({
        typ: 'site',
        organization: site.org,
        server: site.serverId,
        serverName: site.serverName,
        site: site.siteId,
        domena: site.name,
      })
    } catch (error) {
      if (error instanceof AmbiguousReferenceError) return error.message
      if (!(error instanceof ResolutionError)) throw error
    }

    try {
      const srv = await ctx.resolver.resolveServer(args.query, args.org)
      return toKeyValue({ typ: 'serwer', organization: srv.org, server: srv.serverId, nazwa: srv.name })
    } catch (error) {
      if (error instanceof AmbiguousReferenceError) return error.message
      return `Nie znaleziono zasobu pasujacego do "${args.query}". Sprawdz liste narzedziem forge_list_sites albo forge_list_servers.`
    }
  },
}

export const contextTools: ToolDefinition[] = [whoamiTool, listServersTool, listSitesTool, resolveTool]
