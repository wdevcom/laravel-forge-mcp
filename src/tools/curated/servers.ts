import { z } from 'zod'
import type { ToolDefinition } from '../types.js'
import { callOperation, paginateOperation, dataOf, truncationNote, textOf } from './helpers.js'
import { flatten, flattenMany, toTable, toKeyValue, truncateLines, type JsonApiResource } from '../../domain/formatter.js'

const SERVICES = ['nginx', 'php', 'mysql', 'postgres', 'redis', 'supervisor'] as const

const SERVER_FIELDS = [
  'name',
  'id',
  'ip_address',
  'private_ip_address',
  'provider',
  'region',
  'size',
  'php_version',
  'php_cli_version',
  'database_type',
  'ubuntu_version',
  'is_ready',
  'connection_status',
  'db_status',
  'redis_status',
  'created_at',
]

export const getServerTool: ToolDefinition = {
  name: 'forge_get_server',
  title: 'Szczegoly serwera',
  description:
    'Pokazuje pelne dane serwera: adresy IP, dostawce, region, wersje PHP, typ bazy i status uslug. ' +
    'Argument server przyjmuje nazwe serwera albo jego identyfikator.',
  inputSchema: {
    server: z.union([z.string(), z.number()]).describe('Nazwa albo identyfikator serwera'),
    org: z.string().optional().describe('Slug organizacji, domyslnie z konfiguracji serwera'),
  },
  risk: 'read',
  handler: async (args, ctx) => {
    const ref = await ctx.resolver.resolveServer(args.server, args.org)
    const response = await callOperation(ctx, 'organizations.servers.show', {
      organization: ref.org,
      server: ref.serverId,
    })

    return toKeyValue(flatten(dataOf(response) as JsonApiResource), SERVER_FIELDS)
  },
}

export const serverEventsTool: ToolDefinition = {
  name: 'forge_server_events',
  title: 'Zdarzenia serwera',
  description:
    'Pokazuje ostatnie zdarzenia serwera - to odpowiedz na pytanie "co sie teraz dzieje z serwerem". ' +
    'Podaj argument event, zeby zobaczyc pelne wyjscie konkretnego zdarzenia.',
  inputSchema: {
    server: z.union([z.string(), z.number()]).describe('Nazwa albo identyfikator serwera'),
    event: z.union([z.string(), z.number()]).optional().describe('Identyfikator zdarzenia - zwraca jego pelne wyjscie'),
    org: z.string().optional().describe('Slug organizacji, domyslnie z konfiguracji serwera'),
  },
  risk: 'read',
  handler: async (args, ctx) => {
    const ref = await ctx.resolver.resolveServer(args.server, args.org)

    if (args.event !== undefined) {
      const response = await callOperation(ctx, 'organizations.servers.events.output.show', {
        organization: ref.org,
        server: ref.serverId,
        event: args.event,
      })

      const output = textOf(flatten(dataOf(response) as JsonApiResource))
      return output ? truncateLines(output, 200) : 'Zdarzenie nie ma zapisanego wyjscia.'
    }

    const { items, truncated } = await paginateOperation(
      ctx,
      'organizations.servers.events.index',
      { organization: ref.org, server: ref.serverId },
      { maxPages: 1 },
    )

    return toTable(flattenMany(items), ['id', 'name', 'status', 'created_at']) + truncationNote(truncated)
  },
}

export const restartServiceTool: ToolDefinition = {
  name: 'forge_restart_service',
  title: 'Akcja na usludze serwera',
  description:
    'Restartuje, uruchamia albo zatrzymuje usluge na serwerze: nginx, php, mysql, postgres, redis lub supervisor. ' +
    'Zatrzymanie uslugi jest operacja destrukcyjna i wymaga flagi --allow-destructive.',
  inputSchema: {
    server: z.union([z.string(), z.number()]).describe('Nazwa albo identyfikator serwera'),
    service: z.enum(SERVICES).describe('Usluga do zrestartowania'),
    action: z.enum(['restart', 'start', 'stop']).optional().describe('Akcja, domyslnie restart'),
    org: z.string().optional().describe('Slug organizacji, domyslnie z konfiguracji serwera'),
  },
  risk: 'write',
  handler: async (args, ctx) => {
    const ref = await ctx.resolver.resolveServer(args.server, args.org)
    const action = args.action ?? 'restart'

    await callOperation(
      ctx,
      `organizations.servers.services.${args.service}.actions.store`,
      { organization: ref.org, server: ref.serverId },
      { body: { action } },
    )

    return `Zlecono akcje ${action} dla uslugi ${args.service} na serwerze ${ref.name} (${ref.serverId}).`
  },
}

export const serverActionTool: ToolDefinition = {
  name: 'forge_server_action',
  title: 'Akcja na serwerze',
  description:
    'Wykonuje akcje na samym serwerze, na przyklad reboot. ' +
    'Reboot jest operacja destrukcyjna i wymaga flagi --allow-destructive.',
  inputSchema: {
    server: z.union([z.string(), z.number()]).describe('Nazwa albo identyfikator serwera'),
    action: z.string().describe('Nazwa akcji, np. "reboot"'),
    org: z.string().optional().describe('Slug organizacji, domyslnie z konfiguracji serwera'),
  },
  risk: 'write',
  handler: async (args, ctx) => {
    const ref = await ctx.resolver.resolveServer(args.server, args.org)

    await callOperation(
      ctx,
      'organizations.servers.actions.store',
      { organization: ref.org, server: ref.serverId },
      { body: { action: args.action } },
    )

    return `Zlecono akcje ${args.action} na serwerze ${ref.name} (${ref.serverId}).`
  },
}

export const getServerLogTool: ToolDefinition = {
  name: 'forge_get_server_log',
  title: 'Log serwera',
  description:
    'Pobiera zawartosc logu systemowego serwera po jego kluczu, np. "nginx-error". ' +
    'Logi konkretnego site pobierzesz narzedziem forge_get_site_logs.',
  inputSchema: {
    server: z.union([z.string(), z.number()]).describe('Nazwa albo identyfikator serwera'),
    key: z.string().describe('Klucz logu, np. "nginx-error"'),
    lines: z.number().int().min(1).max(1000).optional().describe('Ile ostatnich linii pokazac (domyslnie 200)'),
    org: z.string().optional().describe('Slug organizacji, domyslnie z konfiguracji serwera'),
  },
  risk: 'read',
  handler: async (args, ctx) => {
    const ref = await ctx.resolver.resolveServer(args.server, args.org)
    const response = await callOperation(ctx, 'organizations.servers.logs.show', {
      organization: ref.org,
      server: ref.serverId,
      key: args.key,
    })

    const content = textOf(flatten(dataOf(response) as JsonApiResource))
    return content ? truncateLines(content, args.lines ?? 200) : 'Log jest pusty.'
  },
}

export const serverTools: ToolDefinition[] = [
  getServerTool,
  serverEventsTool,
  restartServiceTool,
  serverActionTool,
  getServerLogTool,
]
