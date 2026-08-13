export function describeError(status: number, body: unknown): string {
  const record = (body ?? {}) as { message?: string; errors?: Record<string, string[]> }

  switch (status) {
    case 401:
      return 'Token API jest nieprawidlowy albo wygasl. Sprawdz zmienna FORGE_API_TOKEN.'
    case 403:
      return 'Token nie ma uprawnien do tej operacji w tej organizacji.'
    case 404:
      return (
        'Zasob nie istnieje. Sprawdz, czy identyfikatory sa poprawne i czy naleza do wskazanej organizacji ' +
        '(ten sam zasob moze wystepowac w kilku organizacjach).'
      )
    case 422: {
      const fields = Object.entries(record.errors ?? {})
        .map(([field, messages]) => `  ${field}: ${messages.join('; ')}`)
        .join('\n')
      const head = record.message ?? 'Dane nie przeszly walidacji.'
      return fields ? `${head}\n${fields}` : head
    }
    case 429:
      return 'Przekroczony limit zadan API (60/min). Sprobuj ponownie za chwile.'
    case 503:
      return 'Forge jest w trybie konserwacji. Sprobuj ponownie pozniej.'
    default:
      return record.message ? `Blad API Forge (HTTP ${status}): ${record.message}` : `Blad API Forge (HTTP ${status}).`
  }
}

export class ForgeApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(describeError(status, body))
    this.name = 'ForgeApiError'
  }
}
