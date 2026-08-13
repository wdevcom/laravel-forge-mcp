import { z } from 'zod'
import type { ToolDefinition } from '../types.js'
import { callOperation, paginateOperation, dataOf, truncationNote, textOf } from './helpers.js'
import { flatten, flattenMany, toTable, truncateLines, type JsonApiResource } from '../../domain/formatter.js'

const PROCESS_COLUMNS = ['id', 'command', 'user', 'directory', 'processes', 'status']
const JOB_COLUMNS = ['id', 'command', 'frequency', 'user', 'status', 'next_run_at']
const DATABASE_COLUMNS = ['id', 'name', 'type', 'status', 'created_at']

export const listBackgroundProcessesTool: ToolDefinition = {
  name: 'forge_list_background_processes',
  title: 'Procesy w tle serwera',
  description:
    'Wypisuje procesy w tle uruchomione na serwerze - to sa workery kolejek i inne dlugotrwale komendy ' +
    '(w starym Forge nazywane demonami). Podaj argument process, zeby zobaczyc jego log. ' +
    'Uwaga: w API v2 procesy w tle naleza do serwera, nie do pojedynczego site.',
  inputSchema: {
    server: z.union([z.string(), z.number()]).describe('Nazwa albo identyfikator serwera'),
    process: z.union([z.string(), z.number()]).optional().describe('Identyfikator procesu - zwraca jego log'),
    lines: z.number().int().min(1).max(2000).optional().describe('Ile ostatnich linii logu pokazac (domyslnie 200)'),
    org: z.string().optional().describe('Slug organizacji, domyslnie z konfiguracji serwera'),
  },
  risk: 'read',
  handler: async (args, ctx) => {
    const ref = await ctx.resolver.resolveServer(args.server, args.org)
    const params = { organization: ref.org, server: ref.serverId }

    if (args.process !== undefined) {
      const response = await callOperation(ctx, 'organizations.servers.background-processes.log.show', {
        ...params,
        backgroundProcess: args.process,
      })

      const content = textOf(flatten(dataOf(response) as JsonApiResource))
      if (!content) return `Proces ${args.process} nie ma zapisanego logu.`

      return `Log procesu ${args.process}:\n${truncateLines(content, args.lines ?? 200)}`
    }

    const { items, truncated } = await paginateOperation(ctx, 'organizations.servers.background-processes.index', params)

    return toTable(flattenMany(items), PROCESS_COLUMNS) + truncationNote(truncated)
  },
}

export const backgroundProcessActionTool: ToolDefinition = {
  name: 'forge_background_process_action',
  title: 'Akcja na procesie w tle',
  description:
    'Restartuje, uruchamia albo zatrzymuje proces w tle na serwerze - tak restartuje sie workery kolejek. ' +
    'Zatrzymanie jest operacja destrukcyjna i wymaga flagi --allow-destructive.',
  inputSchema: {
    server: z.union([z.string(), z.number()]).describe('Nazwa albo identyfikator serwera'),
    process: z.union([z.string(), z.number()]).describe('Identyfikator procesu w tle'),
    action: z.enum(['restart', 'start', 'stop']).optional().describe('Akcja, domyslnie restart'),
    org: z.string().optional().describe('Slug organizacji, domyslnie z konfiguracji serwera'),
  },
  risk: 'write',
  handler: async (args, ctx) => {
    const ref = await ctx.resolver.resolveServer(args.server, args.org)
    const action = args.action ?? 'restart'

    await callOperation(
      ctx,
      'organizations.servers.background-processes.actions.store',
      { organization: ref.org, server: ref.serverId, backgroundProcess: args.process },
      { body: { action } },
    )

    return `Zlecono akcje ${action} dla procesu ${args.process} na serwerze ${ref.name} (${ref.serverId}).`
  },
}

export const listScheduledJobsTool: ToolDefinition = {
  name: 'forge_list_scheduled_jobs',
  title: 'Zadania cykliczne',
  description:
    'Wypisuje zadania cykliczne (cron) serwera albo konkretnego site. ' +
    'Podaj argument job razem z site, zeby zobaczyc wyjscie ostatniego uruchomienia.',
  inputSchema: {
    server: z.union([z.string(), z.number()]).describe('Nazwa albo identyfikator serwera'),
    site: z.union([z.string(), z.number()]).optional().describe('Domena albo identyfikator site - zaweza do zadan site'),
    job: z.union([z.string(), z.number()]).optional().describe('Identyfikator zadania - zwraca jego wyjscie'),
    org: z.string().optional().describe('Slug organizacji, domyslnie z konfiguracji serwera'),
  },
  risk: 'read',
  handler: async (args, ctx) => {
    if (args.site !== undefined) {
      const ref = await ctx.resolver.resolveSite(args.site, args.org)
      const params = { organization: ref.org, server: ref.serverId, site: ref.siteId }

      if (args.job !== undefined) {
        const response = await callOperation(ctx, 'organizations.servers.sites.scheduled-jobs.outputs.show', {
          ...params,
          job: args.job,
        })

        const output = textOf(flatten(dataOf(response) as JsonApiResource))
        return output ? truncateLines(output, 200) : `Zadanie ${args.job} nie ma zapisanego wyjscia.`
      }

      const { items, truncated } = await paginateOperation(ctx, 'organizations.servers.sites.scheduled-jobs.index', params)
      return toTable(flattenMany(items), JOB_COLUMNS) + truncationNote(truncated)
    }

    const ref = await ctx.resolver.resolveServer(args.server, args.org)
    const params = { organization: ref.org, server: ref.serverId }

    if (args.job !== undefined) {
      const response = await callOperation(ctx, 'organizations.servers.scheduled-jobs.outputs.show', {
        ...params,
        job: args.job,
      })

      const output = textOf(flatten(dataOf(response) as JsonApiResource))
      return output ? truncateLines(output, 200) : `Zadanie ${args.job} nie ma zapisanego wyjscia.`
    }

    const { items, truncated } = await paginateOperation(ctx, 'organizations.servers.scheduled-jobs.index', params)
    return toTable(flattenMany(items), JOB_COLUMNS) + truncationNote(truncated)
  },
}

export const listDatabasesTool: ToolDefinition = {
  name: 'forge_list_databases',
  title: 'Bazy danych serwera',
  description: 'Wypisuje bazy danych i uzytkownikow bazy na serwerze.',
  inputSchema: {
    server: z.union([z.string(), z.number()]).describe('Nazwa albo identyfikator serwera'),
    org: z.string().optional().describe('Slug organizacji, domyslnie z konfiguracji serwera'),
  },
  risk: 'read',
  handler: async (args, ctx) => {
    const ref = await ctx.resolver.resolveServer(args.server, args.org)
    const params = { organization: ref.org, server: ref.serverId }

    const [schemas, users] = await Promise.all([
      paginateOperation(ctx, 'organizations.servers.database.schemas.index', params),
      paginateOperation(ctx, 'organizations.servers.database.users.index', params),
    ])

    return [
      `Bazy danych na serwerze ${ref.name} (${ref.serverId}):`,
      toTable(flattenMany(schemas.items), DATABASE_COLUMNS) + truncationNote(schemas.truncated),
      '',
      'Uzytkownicy bazy:',
      toTable(flattenMany(users.items), ['id', 'name', 'status', 'created_at']) + truncationNote(users.truncated),
    ].join('\n')
  },
}

export const processTools: ToolDefinition[] = [
  listBackgroundProcessesTool,
  backgroundProcessActionTool,
  listScheduledJobsTool,
  listDatabasesTool,
]
