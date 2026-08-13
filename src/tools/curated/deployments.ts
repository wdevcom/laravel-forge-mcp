import { z } from 'zod'
import type { ToolDefinition, ToolContext } from '../types.js'
import { callOperation, paginateOperation, dataOf, truncationNote, textOf } from './helpers.js'
import { flatten, flattenMany, toTable, toKeyValue, truncateLines, type JsonApiResource } from '../../domain/formatter.js'
import type { SiteRef } from '../../domain/resolver.js'

const SITE_FIELDS = [
  'name',
  'id',
  'status',
  'deployment_status',
  'php_version',
  'url',
  'web_directory',
  'root_directory',
  'repository',
  'quick_deploy',
  'zero_downtime_deployments',
  'https',
  'user',
  'isolated',
  'database',
  'created_at',
]

const DEPLOYMENT_COLUMNS = ['id', 'status', 'type', 'started_at', 'ended_at']

const WAIT_TIMEOUT_MS = 120_000
const WAIT_INTERVAL_MS = 5_000

async function deploymentStatus(ctx: ToolContext, ref: SiteRef): Promise<Record<string, unknown>> {
  const response = await callOperation(ctx, 'organizations.servers.sites.deployments.status.show', {
    organization: ref.org,
    server: ref.serverId,
    site: ref.siteId,
  })

  return flatten(dataOf(response) as JsonApiResource)
}

export const getSiteTool: ToolDefinition = {
  name: 'forge_get_site',
  title: 'Szczegoly site',
  description:
    'Pokazuje pelne dane site: status, wersje PHP, repozytorium, katalogi, HTTPS i status ostatniego wdrozenia. ' +
    'Argument site przyjmuje domene albo identyfikator.',
  inputSchema: {
    site: z.union([z.string(), z.number()]).describe('Domena albo identyfikator site, np. "sklep.pl"'),
    org: z.string().optional().describe('Slug organizacji, domyslnie z konfiguracji serwera'),
  },
  risk: 'read',
  handler: async (args, ctx) => {
    const ref = await ctx.resolver.resolveSite(args.site, args.org)
    const response = await callOperation(ctx, 'organizations.sites.show', {
      organization: ref.org,
      site: ref.siteId,
    })

    const site = flatten(dataOf(response) as JsonApiResource)
    return `serwer: ${ref.serverName} (${ref.serverId})\n${toKeyValue(site, SITE_FIELDS)}`
  },
}

export const deploySiteTool: ToolDefinition = {
  name: 'forge_deploy_site',
  title: 'Uruchom wdrozenie',
  description:
    'Uruchamia wdrozenie site. Domyslnie zwraca potwierdzenie startu bez czekania na koniec - ' +
    'ustaw wait na true, zeby odpytywac status az do zakonczenia (maksymalnie 2 minuty). ' +
    'Postep sprawdzisz tez narzedziem forge_deployment_status.',
  inputSchema: {
    site: z.union([z.string(), z.number()]).describe('Domena albo identyfikator site'),
    wait: z.boolean().optional().describe('Czekaj na zakonczenie wdrozenia (domyslnie false)'),
    org: z.string().optional().describe('Slug organizacji, domyslnie z konfiguracji serwera'),
  },
  risk: 'write',
  handler: async (args, ctx) => {
    const ref = await ctx.resolver.resolveSite(args.site, args.org)

    await callOperation(ctx, 'organizations.servers.sites.deployments.store', {
      organization: ref.org,
      server: ref.serverId,
      site: ref.siteId,
    })

    if (!args.wait) {
      return `Zlecono wdrozenie site ${ref.name} (${ref.siteId}). Postep sprawdzisz narzedziem forge_deployment_status.`
    }

    const deadline = Date.now() + WAIT_TIMEOUT_MS

    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, WAIT_INTERVAL_MS))

      const status = await deploymentStatus(ctx, ref)
      const value = String(status.status ?? '')

      if (value && !['deploying', 'pending', 'queued', 'running'].includes(value)) {
        return `Wdrozenie site ${ref.name} zakonczone ze statusem: ${value}.`
      }
    }

    return `Wdrozenie site ${ref.name} trwa dluzej niz 2 minuty. Sprawdz status narzedziem forge_deployment_status.`
  },
}

export const listDeploymentsTool: ToolDefinition = {
  name: 'forge_list_deployments',
  title: 'Historia wdrozen',
  description: 'Wypisuje ostatnie wdrozenia site wraz ze statusem i czasami rozpoczecia oraz zakonczenia.',
  inputSchema: {
    site: z.union([z.string(), z.number()]).describe('Domena albo identyfikator site'),
    org: z.string().optional().describe('Slug organizacji, domyslnie z konfiguracji serwera'),
  },
  risk: 'read',
  handler: async (args, ctx) => {
    const ref = await ctx.resolver.resolveSite(args.site, args.org)

    const { items, truncated } = await paginateOperation(
      ctx,
      'organizations.servers.sites.deployments.index',
      { organization: ref.org, server: ref.serverId, site: ref.siteId },
      { maxPages: 1 },
    )

    return toTable(flattenMany(items), DEPLOYMENT_COLUMNS) + truncationNote(truncated)
  },
}

export const getDeploymentLogTool: ToolDefinition = {
  name: 'forge_get_deployment_log',
  title: 'Log wdrozenia',
  description:
    'Pobiera pelne wyjscie wdrozenia. Bez argumentu deployment bierze ostatnie wdrozenie - ' +
    'to najczestszy przypadek przy diagnozowaniu nieudanego deploya.',
  inputSchema: {
    site: z.union([z.string(), z.number()]).describe('Domena albo identyfikator site'),
    deployment: z.union([z.string(), z.number()]).optional().describe('Identyfikator wdrozenia, domyslnie ostatnie'),
    lines: z.number().int().min(1).max(2000).optional().describe('Ile ostatnich linii pokazac (domyslnie 300)'),
    org: z.string().optional().describe('Slug organizacji, domyslnie z konfiguracji serwera'),
  },
  risk: 'read',
  handler: async (args, ctx) => {
    const ref = await ctx.resolver.resolveSite(args.site, args.org)
    const params = { organization: ref.org, server: ref.serverId, site: ref.siteId }

    let deployment = args.deployment

    if (deployment === undefined) {
      const { items } = await paginateOperation(
        ctx,
        'organizations.servers.sites.deployments.index',
        params,
        { maxPages: 1 },
      )

      const latest = items[0]
      if (!latest) return `Site ${ref.name} nie ma jeszcze zadnego wdrozenia.`
      deployment = latest.id
    }

    const response = await callOperation(ctx, 'organizations.servers.sites.deployments.log.show', {
      ...params,
      deployment: deployment as string | number,
    })

    const output = textOf(flatten(dataOf(response) as JsonApiResource))
    if (!output) return `Wdrozenie ${deployment} nie ma zapisanego wyjscia.`

    return `Wdrozenie ${deployment} site ${ref.name}:\n${truncateLines(output, args.lines ?? 300)}`
  },
}

export const deploymentStatusTool: ToolDefinition = {
  name: 'forge_deployment_status',
  title: 'Status wdrozenia',
  description: 'Pokazuje biezacy status wdrozenia site - czy trwa, czy sie zakonczylo i kiedy sie zaczelo.',
  inputSchema: {
    site: z.union([z.string(), z.number()]).describe('Domena albo identyfikator site'),
    org: z.string().optional().describe('Slug organizacji, domyslnie z konfiguracji serwera'),
  },
  risk: 'read',
  handler: async (args, ctx) => {
    const ref = await ctx.resolver.resolveSite(args.site, args.org)
    const status = await deploymentStatus(ctx, ref)

    return toKeyValue({ site: ref.name, ...status }, ['site', 'status', 'started_at'])
  },
}

export const getDeploymentScriptTool: ToolDefinition = {
  name: 'forge_get_deployment_script',
  title: 'Skrypt wdrozeniowy',
  description: 'Pobiera tresc skryptu wdrozeniowego site - komendy uruchamiane przy kazdym deployu.',
  inputSchema: {
    site: z.union([z.string(), z.number()]).describe('Domena albo identyfikator site'),
    org: z.string().optional().describe('Slug organizacji, domyslnie z konfiguracji serwera'),
  },
  risk: 'read',
  handler: async (args, ctx) => {
    const ref = await ctx.resolver.resolveSite(args.site, args.org)
    const response = await callOperation(ctx, 'organizations.servers.sites.deployments.script.show', {
      organization: ref.org,
      server: ref.serverId,
      site: ref.siteId,
    })

    const content = textOf(flatten(dataOf(response) as JsonApiResource))
    return content || 'Skrypt wdrozeniowy jest pusty.'
  },
}

export const updateDeploymentScriptTool: ToolDefinition = {
  name: 'forge_update_deployment_script',
  title: 'Zapisz skrypt wdrozeniowy',
  description:
    'Nadpisuje caly skrypt wdrozeniowy site. Najpierw pobierz obecna tresc narzedziem ' +
    'forge_get_deployment_script, zeby nie skasowac istniejacych komend.',
  inputSchema: {
    site: z.union([z.string(), z.number()]).describe('Domena albo identyfikator site'),
    content: z.string().describe('Pelna nowa tresc skryptu wdrozeniowego'),
    org: z.string().optional().describe('Slug organizacji, domyslnie z konfiguracji serwera'),
  },
  risk: 'write',
  handler: async (args, ctx) => {
    const ref = await ctx.resolver.resolveSite(args.site, args.org)

    await callOperation(
      ctx,
      'organizations.servers.sites.deployments.script.update',
      { organization: ref.org, server: ref.serverId, site: ref.siteId },
      { body: { content: args.content } },
    )

    return `Zapisano skrypt wdrozeniowy site ${ref.name} (${args.content.split('\n').length} linii).`
  },
}

export const deploymentTools: ToolDefinition[] = [
  getSiteTool,
  deploySiteTool,
  listDeploymentsTool,
  getDeploymentLogTool,
  deploymentStatusTool,
  getDeploymentScriptTool,
  updateDeploymentScriptTool,
]
