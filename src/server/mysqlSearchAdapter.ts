import type { DbSearchExecutor, DbSearchQuery, DbSearchResult, DbSearchTableConfig } from './dbSearch'

export type MySqlQueryValue = string | number | null

export type MySqlRow = Record<string, unknown>

export type MySqlQueryRunner = (
  sql: string,
  params: readonly MySqlQueryValue[],
) => Promise<readonly MySqlRow[]>

export type MySqlSearchExecutorOptions = {
  query: MySqlQueryRunner
  tables: readonly DbSearchTableConfig[]
}

type ResultFieldKey = 'id' | 'summary' | 'title' | 'updatedAt'

type NormalizedField = {
  column: string
  sql: string
}

type NormalizedTable = {
  key: string
  resultFields: Partial<Record<ResultFieldKey, NormalizedField>>
  searchFields: NormalizedField[]
  tableSql: string
}

const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/
const likeEscapeSql = " ESCAPE '\\\\'"
const resultFieldKeys: readonly ResultFieldKey[] = ['id', 'title', 'summary', 'updatedAt']
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

function quoteIdentifier(identifier: string) {
  if (!identifierPattern.test(identifier)) {
    throw new Error(`Invalid MySQL identifier: ${identifier}`)
  }

  return `\`${identifier}\``
}

function normalizeField(column: string): NormalizedField {
  return {
    column,
    sql: quoteIdentifier(column),
  }
}

function isBlockedField(table: DbSearchTableConfig, field: string) {
  return sensitiveFieldNames.has(field) || (table.maskedFields?.includes(field) ?? false)
}

function resolveResultField(table: DbSearchTableConfig, key: ResultFieldKey) {
  const explicitColumn = table.resultFields?.[key]

  if (explicitColumn) {
    return isBlockedField(table, explicitColumn) ? undefined : normalizeField(explicitColumn)
  }

  return table.displayFields.includes(key) && !isBlockedField(table, key) ? normalizeField(key) : undefined
}

function normalizeTable(table: DbSearchTableConfig): NormalizedTable {
  const resultFields: Partial<Record<ResultFieldKey, NormalizedField>> = {}
  const searchFields = table.searchableFields.filter((field) => !isBlockedField(table, field)).map(normalizeField)

  if (searchFields.length === 0) {
    throw new Error(`MySQL search table ${table.key} must configure at least one safe searchable field.`)
  }

  for (const key of resultFieldKeys) {
    resultFields[key] = resolveResultField(table, key)
  }

  return {
    key: table.key,
    resultFields,
    searchFields,
    tableSql: quoteIdentifier(table.sourceTable ?? table.key),
  }
}

function normalizeTables(tables: readonly DbSearchTableConfig[]) {
  return tables.map((table) => {
    quoteIdentifier(table.key)

    return normalizeTable(table)
  })
}

function fieldExpression(field?: NormalizedField) {
  return field ? `CAST(${field.sql} AS CHAR)` : 'NULL'
}

function likeExpression(field: NormalizedField) {
  return `LOWER(CAST(${field.sql} AS CHAR)) LIKE ?${likeEscapeSql}`
}

function buildSearchPattern(query: string) {
  return `%${query.toLowerCase().replace(/[\\%_]/g, '\\$&')}%`
}

function buildWhereClause(table: NormalizedTable, pattern: string) {
  return {
    params: table.searchFields.map(() => pattern),
    sql: table.searchFields.map(likeExpression).join(' OR '),
  }
}

function buildMatchedFieldsExpression(table: NormalizedTable, pattern: string) {
  const expressions = table.searchFields.map((field) => `IF(${likeExpression(field)}, ?, NULL)`)

  return {
    params: table.searchFields.flatMap((field) => [pattern, field.column]),
    sql: `CONCAT_WS(',', ${expressions.join(', ')})`,
  }
}

function buildCountSubquery(table: NormalizedTable, pattern: string) {
  const where = buildWhereClause(table, pattern)

  return {
    params: where.params,
    sql: `SELECT COUNT(*) AS total FROM ${table.tableSql} WHERE ${where.sql}`,
  }
}

function buildDataSubquery(table: NormalizedTable, pattern: string) {
  const matchedFields = buildMatchedFieldsExpression(table, pattern)
  const where = buildWhereClause(table, pattern)

  return {
    params: [table.key, ...matchedFields.params, ...where.params],
    sql: [
      'SELECT',
      '? AS tableKey,',
      `${fieldExpression(table.resultFields.id)} AS id,`,
      `${fieldExpression(table.resultFields.title)} AS title,`,
      `${fieldExpression(table.resultFields.summary)} AS summary,`,
      `${fieldExpression(table.resultFields.updatedAt)} AS updatedAt,`,
      `${matchedFields.sql} AS matchedFieldsCsv`,
      `FROM ${table.tableSql}`,
      `WHERE ${where.sql}`,
    ].join(' '),
  }
}

function selectTables(tables: readonly NormalizedTable[], query: DbSearchQuery) {
  if (query.table === 'all') {
    return tables
  }

  const selectedTable = tables.find((table) => table.key === query.table)

  if (!selectedTable) {
    throw new Error(`DB search table is not configured: ${query.table}`)
  }

  return [selectedTable]
}

function buildCountQuery(tables: readonly NormalizedTable[], pattern: string) {
  const subqueries = tables.map((table) => buildCountSubquery(table, pattern))

  return {
    params: subqueries.flatMap((subquery) => subquery.params),
    sql: `SELECT SUM(total) AS total FROM (${subqueries.map((subquery) => subquery.sql).join(' UNION ALL ')}) AS search_counts`,
  }
}

function buildDataQuery(tables: readonly NormalizedTable[], query: DbSearchQuery, pattern: string) {
  const offset = (query.page - 1) * query.pageSize
  const subqueries = tables.map((table) => buildDataSubquery(table, pattern))

  return {
    params: [...subqueries.flatMap((subquery) => subquery.params), query.pageSize, offset],
    sql: [
      'SELECT * FROM',
      `(${subqueries.map((subquery) => subquery.sql).join(' UNION ALL ')}) AS search_results`,
      'ORDER BY updatedAt DESC',
      'LIMIT ? OFFSET ?',
    ].join(' '),
  }
}

function readTotal(rows: readonly MySqlRow[]) {
  const total = rows[0]?.total

  if (typeof total === 'bigint') {
    return Number(total)
  }

  if (typeof total === 'number') {
    return total
  }

  if (typeof total === 'string') {
    const parsed = Number(total)

    return Number.isFinite(parsed) ? parsed : 0
  }

  return 0
}

function toResultString(value: unknown) {
  if (value instanceof Date) {
    return value.toISOString()
  }

  if (typeof value === 'bigint' || typeof value === 'boolean' || typeof value === 'number') {
    return String(value)
  }

  return typeof value === 'string' ? value : undefined
}

function parseMatchedFields(row: MySqlRow, table: NormalizedTable) {
  const matchedFieldsCsv = toResultString(row.matchedFieldsCsv)

  if (!matchedFieldsCsv) {
    return []
  }

  const allowedFields = new Set(table.searchFields.map((field) => field.column))

  return matchedFieldsCsv.split(',').filter((field) => allowedFields.has(field))
}

function normalizeSearchRow(row: MySqlRow, tablesByKey: ReadonlyMap<string, NormalizedTable>): DbSearchResult {
  const tableKey = toResultString(row.tableKey) ?? ''
  const table = tablesByKey.get(tableKey)
  const result: DbSearchResult = {
    matchedFields: table ? parseMatchedFields(row, table) : [],
    table: tableKey,
  }

  for (const key of resultFieldKeys) {
    const value = toResultString(row[key])

    if (value !== undefined) {
      result[key] = value
    }
  }

  return result
}

export function createMySqlSearchExecutor(options: MySqlSearchExecutorOptions): DbSearchExecutor {
  const normalizedTables = normalizeTables(options.tables)
  const tablesByKey = new Map(normalizedTables.map((table) => [table.key, table]))

  return async (query) => {
    const selectedTables = selectTables(normalizedTables, query)
    const pattern = buildSearchPattern(query.query)
    const countQuery = buildCountQuery(selectedTables, pattern)
    const dataQuery = buildDataQuery(selectedTables, query, pattern)
    const countRows = await options.query(countQuery.sql, countQuery.params)
    const resultRows = await options.query(dataQuery.sql, dataQuery.params)

    return {
      page: query.page,
      pageSize: query.pageSize,
      query: query.query,
      results: resultRows.map((row) => normalizeSearchRow(row, tablesByKey)),
      table: query.table,
      total: readTotal(countRows),
    }
  }
}
