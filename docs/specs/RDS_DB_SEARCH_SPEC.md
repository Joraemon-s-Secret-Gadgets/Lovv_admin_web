# RDS DB Search Spec

## User Request Original

일단 검색만 고려하는걸로. RDS야

## Structured Agent Contract

Add a search-only database inspection capability to the Lovv admin web deliverable. The database is AWS RDS. The feature must be scoped to read-only search and must not allow create, update, delete, raw SQL execution, schema mutation, or direct database access from the browser.

## Summary

The admin deliverable needs a web-based way to search database contents. This work adds a secure RDS search feature plan for the Lovv admin console. The admin UI will expose a `DB 검색` workspace for `R-ADMIN` only. The browser will call a server-side API, and the API will query RDS with a read-only database user and a strict table/column whitelist.

## Goals

- Provide an `R-ADMIN` only DB search workspace in the admin console.
- Search RDS content through a server-side API.
- Keep the browser disconnected from direct RDS credentials.
- Support keyword search, table filter, pagination, and basic result preview.
- Return only allowed tables and allowed columns.
- Mask sensitive fields before data reaches the browser.
- Keep the feature search-only.
- Keep implementation deployable as a Vercel-hosted admin project.

## Non-Goals

- Raw SQL console.
- Database writes.
- Create, update, delete, import, export, or migration actions.
- Schema editor or table designer.
- Full database backup or dump viewer.
- Direct RDS connection from client-side React code.
- Storing RDS credentials in source code.
- Implementing real SSO in this task.
- Searching non-whitelisted sensitive system tables by default.

## Actors And Permissions

| Role | DB Search Access | Behavior |
| --- | --- | --- |
| `R-ADMIN` | Allowed | Can open `DB 검색`, choose allowed table scope, submit search, inspect paginated results |
| `R-LOCAL-OPERATOR` | Locked | Sees locked tab/access reason only if the tab is shown |
| `R-DATA-PROVIDER` | Locked | Sees locked tab/access reason only if the tab is shown |

Frontend tab locks are UX only. The API must enforce the same role check before querying RDS.

## Architecture

```text
Lovv Admin Web
  -> GET /api/admin/db-search
  -> server-side role check
  -> search input validation
  -> allowed table/column map
  -> read-only RDS connection
  -> masked paginated result response
```

## RDS Assumptions To Confirm

- RDS engine is confirmed as MySQL.
- Connection values must be provided through Vercel environment variables.
- RDS network access must allow the deployed API runtime to connect.
- A dedicated read-only DB user must exist before production use.
- Table and column whitelist must be confirmed before searching real data.

## Required Environment Variables

Names may be finalized during implementation, but the values must remain server-only:

```text
RDS_ENGINE=mysql
RDS_HOST=example.rds.amazonaws.com
RDS_PORT=3306
RDS_DATABASE=lovv
RDS_READONLY_USER=lovv_admin_readonly
RDS_READONLY_PASSWORD=replace-with-vercel-secret
ADMIN_DB_SEARCH_ENABLED=false
```

These variables must not be exposed with a `VITE_` prefix.

## API Contract

### `GET /api/admin/db-search`

Query parameters:

| Name | Required | Description |
| --- | --- | --- |
| `q` | Yes | Search keyword. Trimmed. Minimum 2 characters. Maximum 80 characters. |
| `table` | No | Allowed table key. If omitted, search all allowed tables. |
| `page` | No | 1-based page number. Default `1`. |
| `pageSize` | No | Default `20`. Maximum `50`. |

Success response:

```json
{
  "query": "강릉",
  "table": "all",
  "page": 1,
  "pageSize": 20,
  "total": 3,
  "results": [
    {
      "table": "festival_events",
      "id": "evt_123",
      "title": "강릉 커피 축제",
      "summary": "강릉 지역 축제 데이터",
      "matchedFields": ["title", "region"],
      "updatedAt": "2026-06-09T03:00:00.000Z"
    }
  ]
}
```

Error responses:

- `400`: invalid query, invalid table, invalid pagination.
- `401`: missing login/session when real auth is later connected.
- `403`: non-admin role.
- `503`: feature disabled or DB unavailable.

## Search Rules

- Search must use parameterized queries only.
- Table names and column names must come from static server-side whitelist configuration, not user input.
- Search must be case-insensitive when the selected engine supports it.
- Search must limit scanned columns to searchable text columns.
- Result payload must use a normalized shape instead of returning arbitrary row objects.
- Pagination is mandatory.
- Empty query must not search the DB.
- Very broad query must be rejected or bounded.

## Sensitive Data Rules

Default excluded or masked categories:

- access tokens
- refresh tokens
- auth session secrets
- OAuth provider IDs when unnecessary
- passwords or password-like fields
- internal logs with stack traces
- private user identifiers not needed for admin inspection
- raw embedding vectors

If a table is required for search but contains sensitive fields, only safe display fields should be returned.

## UI Requirements

- Add `DB 검색` tab/workspace.
- `R-ADMIN` can access the tab.
- `R-LOCAL-OPERATOR` and `R-DATA-PROVIDER` see it locked.
- The panel contains:
  - keyword input
  - table filter
  - search button
  - loading state
  - empty state
  - error state
  - paginated result list/table
  - masked-field indication when relevant
- The UI must clearly communicate that it is read-only search.

## Acceptance Criteria

- `DB 검색` is visible in the admin navigation.
- `R-ADMIN` can open `DB 검색`.
- Non-admin roles cannot open `DB 검색`.
- Search submission validates keyword length before calling API.
- API contract rejects invalid table and pagination parameters.
- API uses server-only environment variables.
- API does not expose raw DB errors to the client.
- API uses parameterized queries.
- Results are normalized and paginated.
- Sensitive fields are excluded or masked.
- Tests cover role access, input validation, API parameter validation, and masked output behavior.
- `npm run test`, `npm run lint`, `npm run build`, and browser verification pass for UI work.

## Risks

- Vercel serverless functions may need RDS network access through public RDS endpoint, VPC integration, proxy, or another backend depending on deployment setup.
- RDS schema and table whitelist are not confirmed, so production search must remain disabled until the whitelist is configured.
- Full cross-table search can be expensive; whitelist and pagination are mandatory.
- Frontend role state is mock-only until real auth is connected.

## Task Breakdown

### Task 1: Spec And Contract

- Purpose: 검색 전용 RDS 기능의 보안 경계와 API 계약을 고정합니다.
- Scope: `docs/specs/RDS_DB_SEARCH_SPEC.md`, `docs/specs/RDS_DB_SEARCH_SUBTASKS.md`
- Dependencies: RDS requirement from user.
- Acceptance Criteria: 검색만 포함하고 쓰기/삭제/raw SQL은 제외합니다.
- Verification: Documentation review.

### Task 2: API Skeleton And Validation

- Purpose: RDS 연결 전에도 검증 가능한 검색 API 껍데기와 입력 검증을 만듭니다.
- Scope: server-side API files, tests, environment example if added.
- Dependencies: Task 1.
- Acceptance Criteria: DB 연결 없이도 invalid query/table/page tests가 통과합니다.
- Verification: `npm run test`, `npm run lint`, `npm run build`.

### Task 3: RDS Engine Adapter

- Purpose: 확정된 RDS 엔진에 맞는 read-only 검색 adapter를 구현합니다.
- Scope: server-side DB adapter only.
- Dependencies: MySQL, connection env names, table whitelist.
- Acceptance Criteria: parameterized query, whitelist table/column mapping, masked normalized result.
- Verification: unit tests with mocked adapter or integration test against approved test DB.

### Task 4: Admin Search UI

- Purpose: `R-ADMIN`이 검색어와 테이블 필터로 DB 내용을 조회할 수 있게 합니다.
- Scope: React admin UI, CSS, component tests.
- Dependencies: API contract from Task 2.
- Acceptance Criteria: role-gated DB search tab, loading/empty/error/success states.
- Verification: `npm run test`, browser verification.

### Task 5: Security Review

- Purpose: DB 검색이 민감 데이터 노출이나 권한 우회를 만들지 않는지 확인합니다.
- Scope: changed API/UI/env docs.
- Dependencies: Tasks 2-4.
- Acceptance Criteria: no Blocker findings.
- Verification: security checklist plus tests.
