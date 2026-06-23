# Role-Based Access UI Subtasks

## Source Of Truth

- Full Spec: `docs/specs/ROLE_BASED_ACCESS_UI_SPEC.md`
- Existing Scope: `docs/specs/ADMIN_CONSOLE_UI_SCOPE.md`
- Execution Mode: Sequential Mode, because this task touches authorization and permission UI.

## User Request Original

그런 식으로 진행 해보게 Spec 작성후, 그 작업에 맞는 FE 에이전트 생성해서 구현 진행해주고, 병렬로 처리 가능하다면 병렬로 처리해

## Structured Agent Contract

Implement the frontend-only role-based access UX described in `ROLE_BASED_ACCESS_UI_SPEC.md`. Keep the implementation scoped to the existing Vite React admin mock. Do not implement real auth, backend authorization, routing libraries, persistence, API calls, or new dependencies.

### Subtask 1: Role Permission Model And Regression Tests

- Purpose: 역할별 접근 가능 탭과 액션 소유권을 테스트로 먼저 고정합니다.
- Required Context:
  - The app currently has one `AdminDashboard` component with local tab state and mock data.
  - Role-based restrictions must be frontend UX only, not real authorization.
- Context Budget:
  - Must read:
    - `docs/specs/ROLE_BASED_ACCESS_UI_SPEC.md`
    - `src/admin/AdminDashboard.tsx`
    - `src/admin/types.ts`
    - `src/App.test.tsx`
  - Do not read:
    - `dist`
    - `node_modules`
    - `.git` internals
  - Optional read:
    - `src/admin/adminData.ts`
    - `src/index.css`
- Source of Truth:
  - Full Spec: `docs/specs/ROLE_BASED_ACCESS_UI_SPEC.md`
- Required Sections:
  - `## Requirements`
  - `## Acceptance Criteria`
  - `## Design`
- Must Read Before Implementation:
  - `## Requirements`
  - `## Acceptance Criteria`
  - `## Design`
- Target Files:
  - `src/App.test.tsx`
  - `src/admin/types.ts`
  - `src/admin/AdminDashboard.tsx`
- Out of Scope:
  - Styling polish beyond what is required to expose state in tests.
  - Real auth, API calls, persistence, route libraries, dependency changes.
- Acceptance Criteria:
  - Tests assert the default role is `R-ADMIN`.
  - Tests assert `데이터 제안` is locked for `R-ADMIN`.
  - Tests assert switching to `R-DATA-PROVIDER` enables `데이터 제안` and moves to that panel.
  - Tests assert switching to `R-LOCAL-OPERATOR` enables `운영 지표` and locks review/publish/proposal tabs.
  - Tests assert locked tabs do not activate when clicked.
- Verification:
  - Run `npm run test` and confirm the new tests fail before implementation, then pass after implementation.

### Subtask 2: Role-Aware UI And Action Gating

- Purpose: 관리자가 현재 권한, 잠긴 작업 영역, 가능한 액션을 즉시 파악하도록 화면을 구현합니다.
- Required Context:
  - `Subtask 1` tests define expected role behavior.
  - Lovv palette and existing admin layout must be preserved.
- Context Budget:
  - Must read:
    - `docs/specs/ROLE_BASED_ACCESS_UI_SPEC.md`
    - `src/admin/AdminDashboard.tsx`
    - `src/index.css`
  - Do not read:
    - `dist`
    - `node_modules`
    - `.git` internals
  - Optional read:
    - `src/admin/adminData.ts`
    - `src/admin/types.ts`
- Source of Truth:
  - Full Spec: `docs/specs/ROLE_BASED_ACCESS_UI_SPEC.md`
- Required Sections:
  - `## User Flow`
  - `## UI Changes`
  - `## Acceptance Criteria`
- Must Read Before Implementation:
  - `## User Flow`
  - `## UI Changes`
  - `## Acceptance Criteria`
- Target Files:
  - `src/admin/AdminDashboard.tsx`
  - `src/index.css`
- Out of Scope:
  - Real authentication or backend authorization.
  - Data fetching or persistence.
  - New packages.
- Acceptance Criteria:
  - Session card shows active role and role selector.
  - Locked tabs are disabled, visibly marked, and have readable access copy.
  - Role switching automatically selects the first allowed tab when needed.
  - Admin review decision buttons are only available for `R-ADMIN`.
  - Provider proposal save button is only available for `R-DATA-PROVIDER`.
  - Text remains readable on desktop and mobile widths.
- Verification:
  - `npm run test`
  - Browser verification of role switching and locked tabs.

### Subtask 3: Final Verification And Read-Only Review

- Purpose: 변경 사항이 Spec, 보안 경계, UI 품질을 만족하는지 확인합니다.
- Required Context:
  - Completed implementation diff.
  - Full Spec acceptance criteria.
- Context Budget:
  - Must read:
    - `docs/specs/ROLE_BASED_ACCESS_UI_SPEC.md`
    - Changed files only.
    - `docs/agents/review-format.md`
    - `docs/agents/security-review-checklist.md`
  - Do not read:
    - Unchanged large files or build artifacts.
- Source of Truth:
  - Full Spec: `docs/specs/ROLE_BASED_ACCESS_UI_SPEC.md`
- Target Files:
  - Read-only review of changed files.
- Out of Scope:
  - Review Agent must not edit implementation files.
- Acceptance Criteria:
  - No Blocker findings remain.
  - Frontend-only access control is not misrepresented as real backend authorization.
  - Tests, lint, build, and browser verification are reported.
- Verification:
  - `npm run test`
  - `npm run lint`
  - `npm run build`
  - Browser verification
