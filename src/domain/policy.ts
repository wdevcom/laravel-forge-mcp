import type { OperationMeta, RiskLevel } from '../openapi/types.js'

export type PolicyMode = 'read-only' | 'default' | 'allow-destructive'

/**
 * Operacje, ktorych ryzyko zalezy od tresci body, a nie od metody HTTP.
 */
const CONDITIONAL_DESTRUCTIVE: Array<{ pattern: RegExp; actions: string[] }> = [
  { pattern: /^organizations\.servers\.actions\.store$/, actions: ['reboot'] },
  { pattern: /^organizations\.servers\.services\.\w+\.actions\.store$/, actions: ['stop'] },
  { pattern: /^organizations\.servers\.background-processes\.actions\.store$/, actions: ['stop'] },
]

const ORDER: Record<RiskLevel, number> = { read: 0, write: 1, destructive: 2 }

const MODE_CEILING: Record<PolicyMode, RiskLevel> = {
  'read-only': 'read',
  default: 'write',
  'allow-destructive': 'destructive',
}

export function classify(op: OperationMeta, body?: unknown): RiskLevel {
  if (op.risk === 'destructive') return 'destructive'

  const action = (body as { action?: unknown } | undefined)?.action
  if (typeof action === 'string') {
    for (const rule of CONDITIONAL_DESTRUCTIVE) {
      if (rule.pattern.test(op.operationId) && rule.actions.includes(action)) {
        return 'destructive'
      }
    }
  }

  return op.risk
}

export function isAllowed(risk: RiskLevel, mode: PolicyMode): boolean {
  return ORDER[risk] <= ORDER[MODE_CEILING[mode]]
}

export function denialMessage(operationId: string, risk: RiskLevel, mode: PolicyMode): string {
  if (mode === 'read-only') {
    return (
      `Operacja ${operationId} modyfikuje dane (poziom: ${risk}), a serwer dziala w trybie --read-only. ` +
      'Uruchom serwer bez flagi --read-only, aby ja wykonac.'
    )
  }

  return (
    `Operacja ${operationId} jest destrukcyjna i moze skasowac zasoby bez mozliwosci cofniecia. ` +
    'Uruchom serwer z flaga --allow-destructive, aby ja wykonac.'
  )
}

export function annotationsFor(risk: RiskLevel): {
  readOnlyHint: boolean
  destructiveHint: boolean
  idempotentHint: boolean
} {
  if (risk === 'read') return { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  if (risk === 'write') return { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  return { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
}
