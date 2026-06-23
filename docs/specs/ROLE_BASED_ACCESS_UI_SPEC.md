# Role-Based Access UI Spec

## User Request Original

그런 식으로 진행 해보게 Spec 작성후, 그 작업에 맞는 FE 에이전트 생성해서 구현 진행해주고, 병렬로 처리 가능하다면 병렬로 처리해

## Structured Agent Contract

Build a frontend-only role-based access UX for the Lovv admin console. Write the Spec first, then use a bounded Frontend Implementation Agent to implement the work. Because the feature touches authorization and permission UI, use Sequential Mode for implementation. Parallel implementation is out of scope unless write scopes are clearly separated and do not affect access-control behavior.

## Summary

The Lovv admin console currently shows all admin tabs to every mock session. This work adds a role-aware UI layer so an operator, data provider, or admin can quickly see which workspace they own, which actions are available, and which pages are locked.

This is not real backend authorization. It is a frontend UX scaffold that makes future route/API guards easier to wire.

## Goals

- Show the current mock role clearly in the top session card.
- Let testers switch mock roles without real login.
- Show only accessible actions as enabled.
- Mark inaccessible tabs with a locked state and a clear reason.
- Prevent disabled tabs from changing the active panel.
- Keep administrator decision actions exclusive to `R-ADMIN`.
- Keep data proposal save action exclusive to `R-DATA-PROVIDER`.
- Keep local operator metrics available to `R-LOCAL-OPERATOR` and `R-ADMIN`.
- Keep publish status available to `R-ADMIN` only.

## Non-Goals

- Real authentication.
- Real backend authorization.
- Token, cookie, SSO, or session storage implementation.
- API request changes.
- Persistence of the selected mock role.
- Server-side route protection.
- New dependencies or routing libraries.

## Actors And Role Permissions

| Role | Allowed Tabs | Locked Tabs | Primary Actions |
| --- | --- | --- | --- |
| `R-LOCAL-OPERATOR` | `운영 지표` | `데이터 제안`, `제안 검토`, `반영 상태` | View assigned regional metrics |
| `R-DATA-PROVIDER` | `데이터 제안` | `운영 지표`, `제안 검토`, `반영 상태` | Save proposal to pending state |
| `R-ADMIN` | `운영 지표`, `제안 검토`, `반영 상태` | `데이터 제안` | Approve, reject, inspect publish status |

## User Flow

1. The console loads with mock role `R-ADMIN`.
2. The session card shows the current role, session type, and a role selector.
3. The tab list renders all known workspaces, but inaccessible tabs are visibly locked and disabled.
4. When the tester changes the mock role, the active tab moves to that role's first allowed tab if the current tab is not allowed.
5. When a tab is locked, it cannot be selected and exposes a concise access reason for screen readers and visible scanning.
6. Role-owned actions remain visible only in their owned panels and are disabled when the role does not own them.

## Requirements

- WHEN the app loads, THE system SHALL default the mock session role to `R-ADMIN`.
- WHEN the current role is `R-ADMIN`, THE system SHALL allow `운영 지표`, `제안 검토`, and `반영 상태`.
- WHEN the current role is `R-DATA-PROVIDER`, THE system SHALL allow only `데이터 제안`.
- WHEN the current role is `R-LOCAL-OPERATOR`, THE system SHALL allow only `운영 지표`.
- WHEN a tab is not allowed for the current role, THE system SHALL render it as disabled with a lock indicator and access reason.
- WHEN a disabled tab is clicked, THE system SHALL keep the current active tab unchanged.
- WHEN the role changes and the current active tab is no longer allowed, THE system SHALL move to the first allowed tab for the new role.
- WHEN the current role is not `R-ADMIN`, THE system SHALL not expose approval or rejection buttons.
- WHEN the current role is not `R-DATA-PROVIDER`, THE system SHALL not expose the proposal save button.
- WHEN the UI shows role restrictions, THE system SHALL use readable text, visible contrast, semantic controls, and keyboard-accessible role selection.

## Design

### State

- Add `currentRole: AdminRole` local React state in `AdminDashboard`.
- Keep `activeTab: AdminTab` local React state.
- Add role-to-tab permission data as static configuration in the dashboard module or admin data module.
- Derive:
  - `allowedTabs`
  - `isTabAllowed(tabId)`
  - `firstAllowedTab`

### UI Changes

- Top session card:
  - Show the active mock role as a compact badge.
  - Add a labeled select for mock role switching.
  - Keep the avatar centered.
- Tab list:
  - Render all tabs for discoverability.
  - Disabled tabs use `aria-disabled="true"`, `disabled`, `data-locked="true"`, and lock copy.
- Panels:
  - `DataProposalPanel` receives `currentRole` and shows the save action only for `R-DATA-PROVIDER`.
  - `ReviewQueuePanel` receives `currentRole` and shows decision actions only for `R-ADMIN`.
  - Publish and metrics visibility is controlled by tab permissions.

### Security Boundary

Frontend tab/action hiding is only a UX boundary. It must not be described as real authorization. Future backend/API work must enforce the same permissions server-side.

## Acceptance Criteria

- The default `R-ADMIN` session shows admin-owned tabs enabled and `데이터 제안` locked.
- Switching to `R-DATA-PROVIDER` enables `데이터 제안`, locks the admin/operator tabs, and moves to the proposal panel.
- Switching to `R-LOCAL-OPERATOR` enables `운영 지표`, locks proposal/review/publish tabs, and moves to the metrics panel.
- Locked tabs cannot be activated by click.
- The admin review panel still contains approval and rejection actions for `R-ADMIN`.
- Non-admin roles cannot access the review tab from the tab list.
- The proposal save action is available to `R-DATA-PROVIDER`.
- Tests cover role switching, locked tabs, and role-owned actions.
- `npm run test`, `npm run lint`, `npm run build`, and browser verification pass.

## Risks And Assumptions

- This implementation is a mock UI scaffold, not a security boundary.
- The app has no router today, so route guards are represented as tab guards.
- Backend permission enforcement must be added in a later API/auth task.
- Vercel deployment remains a static Vite app.

## Task Breakdown

### Task 1: Role Permission Model And Tests

- Purpose: 역할별 접근 가능 탭과 액션 소유권을 명확히 검증합니다.
- Scope: `src/admin/types.ts`, `src/admin/AdminDashboard.tsx`, `src/App.test.tsx`
- Dependencies: None
- Acceptance Criteria:
  - Mock role selection is represented in component state.
  - Role tab permissions are testable from rendered output.
  - Locked tab behavior has regression coverage.
- Verification: `npm run test`

### Task 2: Role-Aware UI Implementation

- Purpose: 관리자가 현재 권한과 잠긴 작업 영역을 한눈에 확인하게 합니다.
- Scope: `src/admin/AdminDashboard.tsx`, `src/index.css`
- Dependencies: Task 1
- Acceptance Criteria:
  - Session card shows active role and selector.
  - Disabled tabs are visually locked and accessible.
  - Role changes redirect the active tab to an allowed panel.
  - Role-owned actions are shown only to the owning role.
- Verification: `npm run test`, browser verification

### Task 3: Verification And Review

- Purpose: 권한 UX 변경이 기존 Lovv UI와 테스트/빌드 품질을 해치지 않았는지 확인합니다.
- Scope: Read-only review of changed files and browser output.
- Dependencies: Task 2
- Acceptance Criteria:
  - Tests, lint, build pass.
  - Browser check confirms role switching and locked tab behavior.
  - Security note remains clear that frontend access control is not backend authorization.
- Verification: `npm run test`, `npm run lint`, `npm run build`, browser verification
