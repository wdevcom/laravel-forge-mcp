import { z } from 'zod'
import type { ToolDefinition } from '../types.js'
import { callOperation, dataOf, textOf } from './helpers.js'
import { flatten, toKeyValue, truncateLines, type JsonApiResource } from '../../domain/formatter.js'

const LOG_TYPES = ['application', 'nginx-error', 'nginx-access'] as const

const COMMAND_TIMEOUT_MS = 60_000
const COMMAND_INTERVAL_MS = 3_000

export const getSiteLogsTool: ToolDefinition = {
  name: 'forge_get_site_logs',
  title: 'Logi site',
  description:
    'Pobiera logi site: application (log aplikacji Laravel), nginx-error (bledy serwera WWW) ' +
    'albo nginx-access (ruch). Zwraca ostatnie linie, bo logi czyta sie od konca.',
  inputSchema: {
    site: z.union([z.string(), z.number()]).describe('Domena albo identyfikator site'),
    type: z.enum(LOG_TYPES).optional().describe('Rodzaj logu, domyslnie application'),
    lines: z.number().int().min(1).max(2000).optional().describe('Ile ostatnich linii pokazac (domyslnie 200)'),
    org: z.string().optional().describe('Slug organizacji, domyslnie z konfiguracji serwera'),
  },
  risk: 'read',
  handler: async (args, ctx) => {
    const ref = await ctx.resolver.resolveSite(args.site, args.org)
    const type = args.type ?? 'application'

    const response = await callOperation(ctx, `organizations.servers.sites.logs.${type}.show`, {
      organization: ref.org,
      server: ref.serverId,
      site: ref.siteId,
    })

    const content = textOf(flatten(dataOf(response) as JsonApiResource))
    if (!content) return `Log ${type} site ${ref.name} jest pusty.`

    return `Log ${type} site ${ref.name}:\n${truncateLines(content, args.lines ?? 200)}`
  },
}

export const runCommandTool: ToolDefinition = {
  name: 'forge_run_command',
  title: 'Uruchom komende w katalogu site',
  description:
    'Uruchamia komende powloki w katalogu site, np. "php artisan migrate --force" albo "php artisan cache:clear". ' +
    'Domyslnie czeka na zakonczenie i zwraca wyjscie (maksymalnie minute). ' +
    'Komenda wykonuje sie na produkcyjnym serwerze - sprawdz ja przed uruchomieniem.',
  inputSchema: {
    site: z.union([z.string(), z.number()]).describe('Domena albo identyfikator site'),
    command: z.string().describe('Komenda do uruchomienia, np. "php artisan migrate --force"'),
    wait: z.boolean().optional().describe('Czekaj na wyjscie komendy (domyslnie true)'),
    org: z.string().optional().describe('Slug organizacji, domyslnie z konfiguracji serwera'),
  },
  risk: 'write',
  handler: async (args, ctx) => {
    const ref = await ctx.resolver.resolveSite(args.site, args.org)
    const params = { organization: ref.org, server: ref.serverId, site: ref.siteId }

    const created = await callOperation(ctx, 'organizations.servers.sites.commands.store', params, {
      body: { command: args.command },
    })

    const command = flatten(dataOf(created) as JsonApiResource)
    const commandId = String(command.id)

    if (args.wait === false) {
      return `Zlecono komende na site ${ref.name}, identyfikator ${commandId}.`
    }

    const deadline = Date.now() + COMMAND_TIMEOUT_MS

    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, COMMAND_INTERVAL_MS))

      const detail = await callOperation(ctx, 'organizations.servers.sites.commands.show', {
        ...params,
        command: commandId,
      })

      const state = flatten(dataOf(detail) as JsonApiResource)
      const status = String(state.status ?? '')

      if (['running', 'pending', 'queued'].includes(status)) continue

      const outputResponse = await callOperation(ctx, 'organizations.servers.sites.commands.output.show', {
        ...params,
        command: commandId,
      })

      const output = textOf(flatten(dataOf(outputResponse) as JsonApiResource))

      return [
        toKeyValue({ komenda: args.command, status, exit_code: state.exit_code, duration: state.duration }),
        '',
        output ? truncateLines(output, 300) : '(brak wyjscia)',
      ].join('\n')
    }

    return `Komenda ${commandId} na site ${ref.name} trwa dluzej niz minute. Wyjscie pobierzesz przez forge_call z operationId organizations.servers.sites.commands.output.show.`
  },
}

export const diagnosticTools: ToolDefinition[] = [getSiteLogsTool, runCommandTool]
