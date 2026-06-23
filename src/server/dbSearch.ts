export type DbSearchErrorCode =
  | 'DB_SEARCH_DISABLED'
  | 'FORBIDDEN'
  | 'INVALID_METHOD'
  | 'INVALID_PAGINATION'
  | 'INVALID_QUERY'
  | 'INVALID_TABLE'
  | 'NOT_AUTHENTICATED'
  | 'SEARCH_NOT_CONFIGURED'
  | 'SEARCH_UNAVAILABLE'

export type DbSearchError = {
  code: DbSearchErrorCode
  message: string
  status: number
}

export type DbSearchTableConfig = {
  key: string
  label: string
  searchableFields: readonly string[]
  displayFields: readonly string[]
  maskedFields?: readonly string[]
  resultFields?: {
    id?: string
    summary?: string
    title?: string
    updatedAt?: string
  }
  sourceTable?: string
}

export type DbSearchQuery = {
  page: number
  pageSize: number
  query: string
  table: 'all' | string
}

export type DbSearchResult = {
  id?: string
  matchedFields: string[]
  table: string
  title?: string
  summary?: string
  updatedAt?: string
  [key: string]: string | string[] | undefined
}

export type DbSearchResponse = {
  page: number
  pageSize: number
  query: string
  results: DbSearchResult[]
  table: 'all' | string
  total: number
}

export type DbSearchExecutor = (query: DbSearchQuery) => Promise<DbSearchResponse>

export type DbSearchHandlerOptions = {
  currentRole?: string
  executeSearch?: DbSearchExecutor
  featureEnabled?: boolean
  tables?: readonly DbSearchTableConfig[]
}

type ParseResult = { ok: true; value: DbSearchQuery } | { ok: false; error: DbSearchError }

const DEFAULT_PAGE = 1
const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE = 10_000
const MAX_PAGE_SIZE = 50
const MAX_QUERY_LENGTH = 80
const MIN_QUERY_LENGTH = 2

const sensitiveFieldNames = new Set([
  'accessToken',
  'access_token',
  'authSecret',
  'auth_secret',
  'password',
  'refreshToken',
  'refresh_token',
  'secret',
  'token',
])

export const emptyDbSearchTables: readonly DbSearchTableConfig[] = []

function jsonResponse(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store',
    },
  })
}

function parsePositiveInteger(value: string | null, fallback: number) {
  if (value === null || value === '') {
    return fallback
  }

  if (!/^\d+$/.test(value)) {
    return undefined
  }

  const parsed = Number(value)

  if (!Number.isSafeInteger(parsed)) {
    return undefined
  }

  return parsed
}

function invalidRequest(code: DbSearchErrorCode, message: string): DbSearchError {
  return {
    code,
    message,
    status: 400,
  }
}

export function parseDbSearchRequest(input: string | URL, tables: readonly DbSearchTableConfig[]): ParseResult {
  const url = typeof input === 'string' ? new URL(input) : input
  const query = (url.searchParams.get('q') ?? '').trim()
  const table = (url.searchParams.get('table') ?? 'all').trim() || 'all'
  const page = parsePositiveInteger(url.searchParams.get('page'), DEFAULT_PAGE)
  const pageSize = parsePositiveInteger(url.searchParams.get('pageSize'), DEFAULT_PAGE_SIZE)

  if (query.length < MIN_QUERY_LENGTH || query.length > MAX_QUERY_LENGTH) {
    return {
      error: invalidRequest('INVALID_QUERY', 'Search keyword must be between 2 and 80 characters.'),
      ok: false,
    }
  }

  if (table !== 'all' && !tables.some((allowedTable) => allowedTable.key === table)) {
    return {
      error: invalidRequest('INVALID_TABLE', 'Requested table is not allowed for DB search.'),
      ok: false,
    }
  }

  if (
    page === undefined ||
    page < 1 ||
    page > MAX_PAGE ||
    pageSize === undefined ||
    pageSize < 1 ||
    pageSize > MAX_PAGE_SIZE
  ) {
    return {
      error: invalidRequest(
        'INVALID_PAGINATION',
        'Pagination must use page between 1 and 10000 and pageSize between 1 and 50.',
      ),
      ok: false,
    }
  }

  return {
    ok: true,
    value: {
      page,
      pageSize,
      query,
      table,
    },
  }
}

export function buildDbSearchError(error: DbSearchError) {
  return jsonResponse(
    {
      error: {
        code: error.code,
        message: error.message,
      },
    },
    error.status,
  )
}

export function maskSearchResult(row: Record<string, unknown>, table: DbSearchTableConfig): DbSearchResult {
  const blockedFields = new Set([...(table.maskedFields ?? []), ...sensitiveFieldNames])
  const result: DbSearchResult = {
    matchedFields: [],
    table: table.key,
  }

  for (const field of table.displayFields) {
    if (blockedFields.has(field)) {
      continue
    }

    const value = row[field]

    if (typeof value === 'string') {
      result[field] = value
    }
  }

  return result
}

export async function handleDbSearchRequest(request: Request, options: DbSearchHandlerOptions = {}) {
  if (request.method !== 'GET') {
    return buildDbSearchError({
      code: 'INVALID_METHOD',
      message: 'DB search only supports GET requests.',
      status: 405,
    })
  }

  if (!options.featureEnabled) {
    return buildDbSearchError({
      code: 'DB_SEARCH_DISABLED',
      message: 'DB search is not enabled.',
      status: 503,
    })
  }

  if (!options.currentRole) {
    return buildDbSearchError({
      code: 'NOT_AUTHENTICATED',
      message: 'Admin session is required before DB search.',
      status: 401,
    })
  }

  if (options.currentRole !== 'R-ADMIN') {
    return buildDbSearchError({
      code: 'FORBIDDEN',
      message: 'Only R-ADMIN can search database contents.',
      status: 403,
    })
  }

  const tables = options.tables ?? emptyDbSearchTables
  const parsed = parseDbSearchRequest(request.url, tables)

  if (!parsed.ok) {
    return buildDbSearchError(parsed.error)
  }

  if (tables.length === 0 || !options.executeSearch) {
    return buildDbSearchError({
      code: 'SEARCH_NOT_CONFIGURED',
      message: 'DB search tables or engine adapter are not configured.',
      status: 503,
    })
  }

  try {
    return jsonResponse(await options.executeSearch(parsed.value))
  } catch {
    return buildDbSearchError({
      code: 'SEARCH_UNAVAILABLE',
      message: 'DB search is temporarily unavailable.',
      status: 503,
    })
  }
}
