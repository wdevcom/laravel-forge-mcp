export const DEFAULT_MAX_PAGES = 5
export const DEFAULT_PAGE_SIZE = 30

export interface Page<T> {
  data: T[]
  meta?: {
    per_page?: number
    next_cursor?: string | null
    prev_cursor?: string | null
  }
}

export interface PaginatedResult<T> {
  items: T[]
  truncated: boolean
  pages: number
}
