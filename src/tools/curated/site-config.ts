import { z } from 'zod'
import type { ToolDefinition } from '../types.js'
import { callOperation, dataOf, textOf } from './helpers.js'
import { flatten, type JsonApiResource } from '../../domain/formatter.js'

export const getEnvTool: ToolDefinition = {
  name: 'forge_get_env',
  title: 'Plik .env site',
  description:
    'Pobiera zawartosc pliku .env site. Uwaga: zwraca sekrety w czystej postaci, ' +
    'wiec nie wklejaj wyniku do publicznych miejsc.',
  inputSchema: {
    site: z.union([z.string(), z.number()]).describe('Domena albo identyfikator site'),
    org: z.string().optional().describe('Slug organizacji, domyslnie z konfiguracji serwera'),
  },
  risk: 'read',
  handler: async (args, ctx) => {
    const ref = await ctx.resolver.resolveSite(args.site, args.org)
    const response = await callOperation(ctx, 'organizations.servers.sites.environment.show', {
      organization: ref.org,
      server: ref.serverId,
      site: ref.siteId,
    })

    const content = textOf(flatten(dataOf(response) as JsonApiResource))
    return content || 'Plik .env jest pusty.'
  },
}

export const updateEnvTool: ToolDefinition = {
  name: 'forge_update_env',
  title: 'Zapisz plik .env site',
  description:
    'Nadpisuje caly plik .env site. To operacja nadpisujaca, nie scalajaca - ' +
    'najpierw pobierz obecna tresc narzedziem forge_get_env i zmodyfikuj ja, ' +
    'inaczej skasujesz wszystkie pozostale zmienne.',
  inputSchema: {
    site: z.union([z.string(), z.number()]).describe('Domena albo identyfikator site'),
    content: z.string().describe('Pelna nowa tresc pliku .env'),
    org: z.string().optional().describe('Slug organizacji, domyslnie z konfiguracji serwera'),
  },
  risk: 'write',
  handler: async (args, ctx) => {
    const ref = await ctx.resolver.resolveSite(args.site, args.org)

    await callOperation(
      ctx,
      'organizations.servers.sites.environment.update',
      { organization: ref.org, server: ref.serverId, site: ref.siteId },
      { body: { environment: args.content } },
    )

    return `Zapisano plik .env site ${ref.name} (${args.content.split('\n').length} linii).`
  },
}

export const getNginxConfigTool: ToolDefinition = {
  name: 'forge_get_nginx_config',
  title: 'Konfiguracja Nginx site',
  description: 'Pobiera konfiguracje Nginx dla site - przydatne przy diagnozowaniu przekierowan i naglowkow.',
  inputSchema: {
    site: z.union([z.string(), z.number()]).describe('Domena albo identyfikator site'),
    org: z.string().optional().describe('Slug organizacji, domyslnie z konfiguracji serwera'),
  },
  risk: 'read',
  handler: async (args, ctx) => {
    const ref = await ctx.resolver.resolveSite(args.site, args.org)
    const response = await callOperation(ctx, 'organizations.servers.sites.nginx.show', {
      organization: ref.org,
      server: ref.serverId,
      site: ref.siteId,
    })

    const content = textOf(flatten(dataOf(response) as JsonApiResource))
    return content || 'Konfiguracja Nginx jest pusta.'
  },
}

export const updateNginxConfigTool: ToolDefinition = {
  name: 'forge_update_nginx_config',
  title: 'Zapisz konfiguracje Nginx site',
  description:
    'Nadpisuje cala konfiguracje Nginx site. Bledna konfiguracja moze wylaczyc strone - ' +
    'najpierw pobierz obecna tresc narzedziem forge_get_nginx_config.',
  inputSchema: {
    site: z.union([z.string(), z.number()]).describe('Domena albo identyfikator site'),
    content: z.string().describe('Pelna nowa tresc konfiguracji Nginx'),
    org: z.string().optional().describe('Slug organizacji, domyslnie z konfiguracji serwera'),
  },
  risk: 'write',
  handler: async (args, ctx) => {
    const ref = await ctx.resolver.resolveSite(args.site, args.org)

    await callOperation(
      ctx,
      'organizations.servers.sites.nginx.update',
      { organization: ref.org, server: ref.serverId, site: ref.siteId },
      { body: { config: args.content } },
    )

    return `Zapisano konfiguracje Nginx site ${ref.name}.`
  },
}

export const siteConfigTools: ToolDefinition[] = [getEnvTool, updateEnvTool, getNginxConfigTool, updateNginxConfigTool]
