import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'

export const BASE = 'https://forge.laravel.com/api'
export { http, HttpResponse }

export const server = setupServer()

export function withMswLifecycle(hooks: {
  beforeAll: (fn: () => void) => void
  afterEach: (fn: () => void) => void
  afterAll: (fn: () => void) => void
}): void {
  hooks.beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
  hooks.afterEach(() => server.resetHandlers())
  hooks.afterAll(() => server.close())
}
