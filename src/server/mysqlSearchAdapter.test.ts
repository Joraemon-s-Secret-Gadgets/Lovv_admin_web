import { describe, expect, it } from 'vitest'
import { createMySqlSearchExecutor, type MySqlQueryRunner } from './mysqlSearchAdapter'
import type { DbSearchTableConfig } from './dbSearch'

const mysqlSearchTables: DbSearchTableConfig[] = [
  {
    key: 'festival_events',
    label: 'Festival Events',
    searchableFields: ['title', 'region', 'summary'],
    displayFields: ['id', 'title', 'summary', 'updatedAt'],
    maskedFields: ['internal_memo'],
    resultFields: {
      id: 'id',
      summary: 'summary',
      title: 'title',
      updatedAt: 'updated_at',
    },
  },
  {
    key: 'content_sources',
    label: 'Content Sources',
    searchableFields: ['title', 'source_name'],
    displayFields: ['id', 'title', 'sourceName', 'updatedAt'],
    resultFields: {
      id: 'id',
      title: 'title',
      updatedAt: 'updated_at',
    },
  },
]

describe('MySQL RDS search adapter', () => {
  it('uses parameterized MySQL queries and normalizes paginated results for one whitelisted table', async () => {
    const calls: Array<{ params: readonly unknown[]; sql: string }> = []
    const query: MySqlQueryRunner = async (sql, params) => {
      calls.push({ params, sql })

      if (sql.includes('COUNT(*)')) {
        return [{ total: 1 }]
      }

      return [
        {
          id: 'evt_123',
          matchedFieldsCsv: 'title,region',
          summary: '강릉 지역 축제 데이터',
          tableKey: 'festival_events',
          title: '강릉 커피 축제',
          updatedAt: new Date('2026-06-09T03:00:00.000Z'),
        },
      ]
    }

    const executor = createMySqlSearchExecutor({ query, tables: mysqlSearchTables })
    const result = await executor({
      page: 2,
      pageSize: 10,
      query: '강릉',
      table: 'festival_events',
    })

    expect(calls).toHaveLength(2)
    expect(calls[0].sql).toContain('COUNT(*)')
    expect(calls[1].sql).toContain('FROM `festival_events`')
    expect(calls[1].sql).toContain('LIMIT ? OFFSET ?')
    expect(calls[1].sql).not.toContain('강릉')
    expect(calls[1].sql).not.toContain('auth_sessions')
    expect(calls[1].params).toEqual(expect.arrayContaining(['%강릉%']))
    expect(calls[1].params.slice(-2)).toEqual([10, 10])
    expect(result).toEqual({
      page: 2,
      pageSize: 10,
      query: '강릉',
      results: [
        {
          id: 'evt_123',
          matchedFields: ['title', 'region'],
          summary: '강릉 지역 축제 데이터',
          table: 'festival_events',
          title: '강릉 커피 축제',
          updatedAt: '2026-06-09T03:00:00.000Z',
        },
      ],
      table: 'festival_events',
      total: 1,
    })
  })

  it('searches all configured tables through a static UNION without selecting masked fields', async () => {
    const calls: Array<{ params: readonly unknown[]; sql: string }> = []
    const query: MySqlQueryRunner = async (sql, params) => {
      calls.push({ params, sql })

      return sql.includes('COUNT(*)') ? [{ total: 0 }] : []
    }

    const executor = createMySqlSearchExecutor({ query, tables: mysqlSearchTables })

    await executor({
      page: 1,
      pageSize: 20,
      query: '축제',
      table: 'all',
    })

    const dataSql = calls[1].sql

    expect(dataSql).toContain('UNION ALL')
    expect(dataSql).toContain('FROM `festival_events`')
    expect(dataSql).toContain('FROM `content_sources`')
    expect(dataSql).not.toContain('internal_memo')
  })

  it('rejects unsafe MySQL identifiers from table configuration', () => {
    expect(() =>
      createMySqlSearchExecutor({
        query: async () => [],
        tables: [
          {
            key: 'festival_events; DROP TABLE users',
            label: 'Unsafe',
            searchableFields: ['title'],
            displayFields: ['id', 'title'],
          },
        ],
      }),
    ).toThrow('Invalid MySQL identifier')
  })

  it('rejects table configuration without safe searchable fields', () => {
    expect(() =>
      createMySqlSearchExecutor({
        query: async () => [],
        tables: [
          {
            key: 'auth_sessions',
            label: 'Auth Sessions',
            searchableFields: ['access_token'],
            displayFields: ['id', 'accessToken'],
          },
        ],
      }),
    ).toThrow('safe searchable field')
  })

  it('excludes sensitive result fields even if they are accidentally listed for display', async () => {
    const calls: Array<{ params: readonly unknown[]; sql: string }> = []
    const query: MySqlQueryRunner = async (sql, params) => {
      calls.push({ params, sql })

      return sql.includes('COUNT(*)') ? [{ total: 0 }] : []
    }

    const executor = createMySqlSearchExecutor({
      query,
      tables: [
        {
          key: 'users',
          label: 'Users',
          searchableFields: ['nickname'],
          displayFields: ['id', 'accessToken'],
          resultFields: {
            id: 'id',
            title: 'accessToken',
          },
        },
      ],
    })

    await executor({
      page: 1,
      pageSize: 20,
      query: 'lovv',
      table: 'users',
    })

    expect(calls[1].sql).not.toContain('accessToken')
  })

  it('escapes MySQL LIKE wildcards so wildcard-only queries stay literal and bounded', async () => {
    const calls: Array<{ params: readonly unknown[]; sql: string }> = []
    const query: MySqlQueryRunner = async (sql, params) => {
      calls.push({ params, sql })

      return sql.includes('COUNT(*)') ? [{ total: 0 }] : []
    }

    const executor = createMySqlSearchExecutor({ query, tables: mysqlSearchTables })

    await executor({
      page: 1,
      pageSize: 20,
      query: '%%',
      table: 'festival_events',
    })

    expect(calls[1].sql).toContain("ESCAPE '\\\\'")
    expect(calls[1].params).toEqual(expect.arrayContaining(['%\\%\\%%']))
  })

  it('escapes underscores and backslashes in MySQL LIKE patterns', async () => {
    const calls: Array<{ params: readonly unknown[]; sql: string }> = []
    const query: MySqlQueryRunner = async (sql, params) => {
      calls.push({ params, sql })

      return sql.includes('COUNT(*)') ? [{ total: 0 }] : []
    }

    const executor = createMySqlSearchExecutor({ query, tables: mysqlSearchTables })

    await executor({
      page: 1,
      pageSize: 20,
      query: '__\\',
      table: 'festival_events',
    })

    expect(calls[1].params).toEqual(expect.arrayContaining(['%\\_\\_\\\\%']))
  })
})
