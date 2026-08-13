import type { PolicyMode } from './domain/policy.js'

export const DEFAULT_BASE_URL = 'https://forge.laravel.com/api'

export interface Config {
  token: string
  defaultOrg?: string
  mode: PolicyMode
  baseUrl: string
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

export function loadConfig(env: NodeJS.ProcessEnv, argv: string[]): Config {
  if (argv.some((arg) => arg.startsWith('--token'))) {
    throw new ConfigError(
      'Tokenu nie wolno podawac w argumencie wiersza polecen - argumenty sa widoczne w ps. ' +
        'Ustaw zmienna srodowiskowa FORGE_API_TOKEN.',
    )
  }

  const token = env.FORGE_API_TOKEN?.trim()
  if (!token) {
    throw new ConfigError(
      'Brak tokenu API. Ustaw zmienna FORGE_API_TOKEN - token wygenerujesz na https://forge.laravel.com/profile/api',
    )
  }

  const readOnly = argv.includes('--read-only')
  const allowDestructive = argv.includes('--allow-destructive')

  if (readOnly && allowDestructive) {
    throw new ConfigError('Flag --read-only i --allow-destructive nie mozna uzyc jednoczesnie.')
  }

  const mode: PolicyMode = readOnly ? 'read-only' : allowDestructive ? 'allow-destructive' : 'default'
  const defaultOrg = env.FORGE_ORG?.trim() || undefined

  return { token, defaultOrg, mode, baseUrl: DEFAULT_BASE_URL }
}
