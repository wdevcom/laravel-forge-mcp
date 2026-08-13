import type { HttpMethod } from '../openapi/types.js'
import { ForgeApiError } from './errors.js'
import { RateLimiter } from './rate-limiter.js'
import { DEFAULT_BASE_URL } from '../config.js'
import {
  DEFAULT_MAX_PAGES,
  DEFAULT_PAGE_SIZE,
  type Page,
  type PaginatedResult,
} from './pagination.js'

export interface RequestOptions {
  method: HttpMethod
  path: string
  query?: Record<string, string | number | boolean | undefined>
  body?: unknown
}

export interface ForgeClientOptions {
  token: string
  baseUrl?: string
  limiter?: RateLimiter
  fetchImpl?: typeof fetch
  maxRetries?: number
}

export class ForgeClient {
  private readonly token: string
  private readonly baseUrl: string
  private readonly limiter: RateLimiter
  private readonly fetchImpl: typeof fetch
  private readonly maxRetries: number

  constructor(opts: ForgeClientOptions) {
    this.token = opts.token
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL
    this.limiter = opts.limiter ?? new RateLimiter()
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.maxRetries = opts.maxRetries ?? 3
  }

  private buildUrl(path: string, query?: RequestOptions['query']): string {
    const url = new URL(this.baseUrl + path)
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined) continue
      url.searchParams.set(key, String(value))
    }
    return url.toString()
  }

  async request<T = unknown>(options: RequestOptions): Promise<T> {
    const url = this.buildUrl(options.path, options.query)

    for (let attempt = 1; attempt <= this.maxRetries; attempt += 1) {
      await this.limiter.acquire()

      const response = await this.fetchImpl(url, {
        method: options.method.toUpperCase(),
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      })

      this.limiter.observeHeaders(response.headers)

      if (response.status === 429 && attempt < this.maxRetries) {
        await this.limiter.sleep(this.limiter.retryDelayMs(response.headers, attempt))
        continue
      }

      if (!response.ok) {
        throw new ForgeApiError(response.status, await this.safeJson(response))
      }

      if (response.status === 204) return null as T

      return (await this.safeJson(response)) as T
    }

    throw new ForgeApiError(429, null)
  }

  /**
   * Przewija strony kursorowe i skleja wyniki. Twardy limit stron chroni
   * kontekst modelu przed zassaniem tysiaca rekordow jednym wywolaniem.
   */
  async paginate<T = unknown>(
    options: RequestOptions,
    opts: { maxPages?: number; pageSize?: number } = {},
  ): Promise<PaginatedResult<T>> {
    const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES
    const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE

    const items: T[] = []
    let cursor: string | undefined
    let pages = 0

    while (pages < maxPages) {
      const page = await this.request<Page<T>>({
        ...options,
        query: {
          ...options.query,
          'page[size]': pageSize,
          'page[cursor]': cursor,
        },
      })

      pages += 1
      items.push(...(page?.data ?? []))

      const next = page?.meta?.next_cursor
      if (!next) return { items, truncated: false, pages }

      cursor = next
    }

    return { items, truncated: true, pages }
  }

  private async safeJson(response: Response): Promise<unknown> {
    const text = await response.text()
    if (!text) return null
    try {
      return JSON.parse(text)
    } catch {
      return { message: text }
    }
  }
}
