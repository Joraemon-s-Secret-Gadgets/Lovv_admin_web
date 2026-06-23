# RDS DB Search Subtasks

## Source Of Truth

- Full Spec: `docs/specs/RDS_DB_SEARCH_SPEC.md`
- Role UI Spec: `docs/specs/ROLE_BASED_ACCESS_UI_SPEC.md`
- Execution Mode: Sequential Mode for API, database, auth, and permission work.

## User Request Original

일단 검색만 고려하는걸로. RDS야

Follow-up input:

MySQL

## Structured Agent Contract

Implement a search-only RDS inspection feature for the Lovv admin web against a MySQL RDS database. Do not implement database writes, raw SQL execution, schema mutation, direct browser-to-RDS connections, or secret exposure. Use Atomic commits per Subtask.

## Execution Policy

- Use Sequential Mode for API, RDS, auth, permission, and secret-handling work.
- Hybrid Mode may be used only after API contract is stable, for independent UI styling or read-only review.
- Parallel implementation is not allowed for files that share API contracts, permission logic, or environment variables.
- Each completed Subtask should be committed separately with a Conventional Commit message.

### Subtask 1: Spec And Contract

- Purpose: RDS 검색 기능의 범위, 보안 경계, API 계약을 먼저 고정합니다.
- Required Context:
  - 검색만 고려합니다.
  - RDS를 사용합니다.
  - RDS 엔진과 스키마는 아직 확정되지 않았습니다.
- Context Budget:
  - Must read:
    - `docs/specs/RDS_DB_SEARCH_SPEC.md`
  - Do not read:
    - `node_modules`
    - `dist`
    - `.git` internals
  - Optional read:
    - `docs/specs/ROLE_BASED_ACCESS_UI_SPEC.md`
- Source of Truth:
  - Full Spec: `docs/specs/RDS_DB_SEARCH_SPEC.md`
- Target Files:
  - `docs/specs/RDS_DB_SEARCH_SPEC.md`
  - `docs/specs/RDS_DB_SEARCH_SUBTASKS.md`
- Out of Scope:
  - Code implementation.
  - Dependencies.
  - Environment variable files with real values.
- Acceptance Criteria:
  - Spec says search-only.
  - Spec forbids raw SQL input and writes.
  - Spec requires server-side API and server-only RDS credentials.
  - Spec marks RDS engine and table whitelist as pending implementation inputs.
- Verification:
  - Documentation review.

### Subtask 2: API Skeleton And Validation

- Purpose: DB 연결 전에도 검색 요청 검증과 응답 형태를 테스트할 수 있게 합니다.
- Required Context:
  - RDS engine is still pending.
  - API must be server-side only.
  - No real DB connection should be attempted in this Subtask.
- Context Budget:
  - Must read:
    - `docs/specs/RDS_DB_SEARCH_SPEC.md`
    - `package.json`
    - existing test setup files
  - Do not read:
    - `.env`
    - real credential files
    - `dist`
    - `node_modules`
  - Optional read:
    - Vercel function docs only if implementation target needs confirmation.
- Source of Truth:
  - Full Spec: `docs/specs/RDS_DB_SEARCH_SPEC.md`
- Target Files:
  - API route/helper files to be created.
  - Tests for request validation.
  - `.env.example` only if needed, with dummy values.
- Out of Scope:
  - Real RDS connection.
  - Query adapter.
  - UI.
  - Real auth.
- Acceptance Criteria:
  - `q` validation: required, min 2, max 80.
  - `table` validation rejects non-whitelisted values.
  - `page` and `pageSize` validation enforces safe bounds.
  - Error responses do not expose internal stack traces.
  - No server-only variable is referenced from client code.
- Verification:
  - `npm run test`
  - `npm run lint`
  - `npm run build`

### Subtask 3: RDS Engine Adapter

- Purpose: 확정된 RDS 엔진과 whitelist에 맞춰 read-only 검색 adapter를 구현합니다.
- Required Inputs Before Starting:
  - RDS engine: MySQL. Confirmed by user.
  - Allowed table list. Pending for production activation.
  - Allowed searchable columns per table. Pending for production activation.
  - ID/title/summary/date mapping per table. Pending for production activation.
  - Sensitive columns to mask/exclude. Pending for production activation.
  - Deployment connectivity path from Vercel/API runtime to RDS. Pending for production activation.
- Context Budget:
  - Must read:
    - `docs/specs/RDS_DB_SEARCH_SPEC.md`
    - Subtask 2 API files
  - Do not read:
    - Real `.env` values unless explicitly approved by the user.
    - `dist`
    - `node_modules`
- Source of Truth:
  - Full Spec: `docs/specs/RDS_DB_SEARCH_SPEC.md`
- Target Files:
  - Server-side DB adapter files.
  - Adapter tests.
- Out of Scope:
  - UI.
  - Write queries.
  - Raw SQL console.
- Acceptance Criteria:
  - Uses parameterized queries.
  - Uses static table/column whitelist.
  - Uses read-only connection assumptions.
  - Returns normalized paginated results.
  - Masks/excludes sensitive fields.
  - Production search remains disabled until real table whitelist and connectivity path are confirmed.
- Verification:
  - Unit tests with mocked DB client.
  - Integration test only when a safe test RDS is explicitly approved.

### Subtask 4: Admin Search UI

- Purpose: `R-ADMIN`이 관리자 콘솔에서 검색 조건을 입력하고 결과를 확인할 수 있게 합니다.
- Required Context:
  - Existing role-gated tab UI.
  - API contract from Subtask 2.
- Context Budget:
  - Must read:
    - `docs/specs/RDS_DB_SEARCH_SPEC.md`
    - `docs/specs/ROLE_BASED_ACCESS_UI_SPEC.md`
    - `src/admin/AdminDashboard.tsx`
    - `src/admin/types.ts`
    - `src/index.css`
    - `src/App.test.tsx`
  - Do not read:
    - `dist`
    - `node_modules`
    - real environment files
- Source of Truth:
  - Full Spec: `docs/specs/RDS_DB_SEARCH_SPEC.md`
- Target Files:
  - React admin UI files.
  - CSS.
  - component tests.
- Out of Scope:
  - DB adapter implementation.
  - Real auth.
- Acceptance Criteria:
  - `DB 검색` tab is accessible only to `R-ADMIN`.
  - Non-admin roles see it locked.
  - UI supports keyword, table filter, loading, empty, error, success, pagination.
  - UI labels the feature as read-only search.
- Verification:
  - `npm run test`
  - `npm run lint`
  - `npm run build`
  - browser verification.

### Subtask 5: Security Review

- Purpose: DB 검색 기능이 민감 데이터 노출, 권한 우회, SQL injection, secret exposure 위험을 만들지 않는지 검토합니다.
- Required Context:
  - Full diff for implemented subtasks.
  - `docs/agents/security-review-checklist.md`
  - `docs/agents/review-format.md`
- Target Files:
  - Read-only review of changed files.
- Out of Scope:
  - Review Agent must not edit implementation files by default.
- Acceptance Criteria:
  - No Blocker findings remain.
  - Raw SQL and write paths are absent.
  - Server-only secrets are not exposed to client code.
  - Search is bounded, paginated, and parameterized.
- Verification:
  - Security checklist.
  - Existing test/lint/build evidence.
