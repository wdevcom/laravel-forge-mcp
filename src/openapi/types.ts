export type RiskLevel = 'read' | 'write' | 'destructive'

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete'

export const HTTP_METHODS: HttpMethod[] = ['get', 'post', 'put', 'patch', 'delete']

export interface ParamMeta {
  name: string
  in: 'query' | 'path'
  required: boolean
  type: string
  description?: string
}

export interface OperationMeta {
  operationId: string
  method: HttpMethod
  path: string
  tag: string
  summary: string
  /** Opis operacji ze specu, oczyszczony z markdownowych tabelek. */
  description: string
  /** Dopuszczalne wartosci pol enum w body, np. reboot, restart, stop. */
  enumValues: string[]
  pathParams: string[]
  queryParams: ParamMeta[]
  bodySchema?: Record<string, unknown>
  risk: RiskLevel
}
