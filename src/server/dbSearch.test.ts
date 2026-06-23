import { describe, expect, it } from 'vitest'
import {
  buildDbSearchError,
  handleDbSearchRequest,
  maskSearchResult,
  parseDbSearchRequest,
  type DbSearchTableConfig,
} from './dbSearch'

const searchableTables: DbSearchTableConfig[] = [
  {
    key: 'festival_events',
    label: 'Festival Events',
    searchableFields: ['title', 'region', 'summary'],
    displayFields: ['id', 'title', 'region', 'summary', 'updatedAt'],
    maskedFields: ['internalMemo'],
  },
  {
    key: 'content_sources',
    label: 'Content Sources',
    searchableFields: ['title', 'sourceName'],
    displayFields: ['id', 'title', 'sourceName', 'updatedAt'],
  },
]

describe('RDS DB search validation', () => {
  it('normalizes valid search parameters with safe defaults', () => {
    const parsed = parseDbSearchRequest('https://admin.lovv.test/api/admin/db-search?q=%20강릉%20', searchableTables)

    expect(parsed.ok).toBe(true)
    expect(parsed.ok && parsed.value).toEqual({
      page: 1,
      pageSize: 20,
      query: '강릉',
      table: 'all',
    })
  })

  it('rejects missing and too-short keywords before any DB work', () => {
    const missing = parseDbSearchRequest('https://admin.lovv.test/api/admin/db-search', searchableTables)
    const tooShort = parseDbSearchRequest('https://admin.lovv.test/api/admin/db-search?q=a', searchableTables)

    expect(missing.ok).toBe(false)
    expect(!missing.ok && missing.error.status).toBe(400)
    expect(tooShort.ok).toBe(false)
    expect(!tooShort.ok && tooShort.error.code).toBe('INVALID_QUERY')
  })

  it('rejects invalid table and unsafe pagination parameters', () => {
    const invalidTable = parseDbSearchRequest(
      'https://admin.lovv.test/api/admin/db-search?q=강릉&table=auth_sessions',
      searchableTables,
    )
    const invalidPageSize = parseDbSearchRequest(
      'https://admin.lovv.test/api/admin/db-search?q=강릉&page=0&pageSize=200',
      searchableTables,
    )

    expect(invalidTable.ok).toBe(false)
    expect(!invalidTable.ok && invalidTable.error.code).toBe('INVALID_TABLE')
    expect(invalidPageSize.ok).toBe(false)
    expect(!invalidPageSize.ok && invalidPageSize.error.code).toBe('INVALID_PAGINATION')
  })

  it('rejects unsafe page values before converting them into DB pagination input', () => {
    const unsafeInteger = parseDbSearchRequest(
      'https://admin.lovv.test/api/admin/db-search?q=강릉&page=9007199254740993',
      searchableTables,
    )
    const overLimit = parseDbSearchRequest(
      'https://admin.lovv.test/api/admin/db-search?q=강릉&page=10001',
      searchableTables,
    )

    expect(unsafeInteger.ok).toBe(false)
    expect(!unsafeInteger.ok && unsafeInteger.error.code).toBe('INVALID_PAGINATION')
    expect(overLimit.ok).toBe(false)
    expect(!overLimit.ok && overLimit.error.code).toBe('INVALID_PAGINATION')
  })

  it('keeps sensitive fields out of normalized result payloads', () => {
    const masked = maskSearchResult(
      {
        accessToken: 'secret-token',
        id: 'evt_123',
        internalMemo: 'operator-only',
        region: '강릉',
        title: '강릉 커피 축제',
      },
      searchableTables[0],
    )

    expect(masked).toEqual({
      id: 'evt_123',
      matchedFields: [],
      region: '강릉',
      table: 'festival_events',
      title: '강릉 커피 축제',
    })
    expect(masked).not.toHaveProperty('accessToken')
    expect(masked).not.toHaveProperty('internalMemo')
  })

  it('returns sanitized API errors without exposing stack traces', async () => {
    const response = buildDbSearchError({
      code: 'INVALID_QUERY',
      message: 'Search keyword must be between 2 and 80 characters.',
      status: 400,
    })
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body).toEqual({
      error: {
        code: 'INVALID_QUERY',
        message: 'Search keyword must be between 2 and 80 characters.',
      },
    })
    expect(JSON.stringify(body)).not.toContain('stack')
  })

  it('handles valid requests through an injected read-only search executor', async () => {
    const response = await handleDbSearchRequest(
      new Request('https://admin.lovv.test/api/admin/db-search?q=강릉&table=festival_events&page=2&pageSize=10'),
      {
        currentRole: 'R-ADMIN',
        executeSearch: async (query) => ({
          page: query.page,
          pageSize: query.pageSize,
          query: query.query,
          results: [
            {
              id: 'evt_123',
              matchedFields: ['title'],
              table: 'festival_events',
              title: '강릉 커피 축제',
            },
          ],
          table: query.table,
          total: 1,
        }),
        featureEnabled: true,
        tables: searchableTables,
      },
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({
      page: 2,
      pageSize: 10,
      query: '강릉',
      results: [
        {
          id: 'evt_123',
          matchedFields: ['title'],
          table: 'festival_events',
          title: '강릉 커피 축제',
        },
      ],
      table: 'festival_events',
      total: 1,
    })
  })

  it('blocks non-admin requests before executing a search', async () => {
    let executed = false
    const response = await handleDbSearchRequest(new Request('https://admin.lovv.test/api/admin/db-search?q=강릉'), {
      currentRole: 'R-DATA-PROVIDER',
      executeSearch: async () => {
        executed = true
        throw new Error('should not execute')
      },
      featureEnabled: true,
      tables: searchableTables,
    })
    const body = await response.json()

    expect(response.status).toBe(403)
    expect(body.error.code).toBe('FORBIDDEN')
    expect(executed).toBe(false)
  })
})
