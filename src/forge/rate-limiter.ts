export interface RateLimiterOptions {
  capacity?: number
  refillPerMinute?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

const LOW_WATERMARK = 0.1

/**
 * Token bucket chroniacy przed dobiciem do limitu Forge (60 zadan/min).
 * Zegar i usypianie sa wstrzykiwane, zeby testy byly deterministyczne.
 */
export class RateLimiter {
  private readonly capacity: number
  private readonly refillPerMs: number
  private readonly now: () => number
  private readonly sleepFn: (ms: number) => Promise<void>

  private tokens: number
  private lastRefill: number
  private throttleUntil = 0

  constructor(opts: RateLimiterOptions = {}) {
    this.capacity = opts.capacity ?? 60
    this.refillPerMs = (opts.refillPerMinute ?? 60) / 60_000
    this.now = opts.now ?? (() => Date.now())
    this.sleepFn = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.tokens = this.capacity
    this.lastRefill = this.now()
  }

  async sleep(ms: number): Promise<void> {
    if (ms > 0) await this.sleepFn(ms)
  }

  private refill(): void {
    const current = this.now()
    const elapsed = current - this.lastRefill
    if (elapsed <= 0) return

    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs)
    this.lastRefill = current
  }

  async acquire(): Promise<void> {
    const throttleDelay = this.throttleUntil - this.now()
    if (throttleDelay > 0) {
      this.throttleUntil = 0
      await this.sleepFn(throttleDelay)
    }

    this.refill()

    if (this.tokens < 1) {
      const deficit = 1 - this.tokens
      await this.sleepFn(Math.ceil(deficit / this.refillPerMs))
      this.refill()
    }

    this.tokens -= 1
  }

  /**
   * Gdy Forge zglasza maly zapas zadan, wprowadzamy dodatkowa przerwe,
   * zeby nie dobic do limitu i nie zbierac odpowiedzi 429.
   */
  observeHeaders(headers: Headers): void {
    const remaining = Number(headers.get('X-RateLimit-Remaining'))
    const limit = Number(headers.get('X-RateLimit-Limit'))
    if (!Number.isFinite(remaining) || !Number.isFinite(limit) || limit <= 0) return

    if (remaining / limit <= LOW_WATERMARK) {
      this.throttleUntil = this.now() + 2000
    }
  }

  retryDelayMs(headers: Headers, attempt: number): number {
    const retryAfter = Number(headers.get('Retry-After'))
    if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000

    return Math.min(30_000, 1000 * 2 ** attempt)
  }
}
