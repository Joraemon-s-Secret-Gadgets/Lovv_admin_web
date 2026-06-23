# Lovv Admin Console UI Scope

## User Request Original

관리자 페이지는 이런 흐름이면 되기는 해

이건 JJonyeok2/Lovv_admin_web.git 여기 비우고나서, 관리자 페이지로 따로 두고 이것도 버셀로 따로 배포할게

그래 승인할게

## Structured Agent Contract

Replace the existing `JJonyeok2/Lovv_admin_web` contents with a standalone Vite React TypeScript admin UI mock. Keep the current Git history, remove the old Lovv user-facing app files, and implement a Vercel-ready admin console with mock data only.

## Functional Scope

- Show a mock operator/admin session.
- Show role lanes for `R-LOCAL-OPERATOR`, `R-DATA-PROVIDER`, and `R-ADMIN`.
- Show local operator metrics.
- Show a mock data proposal form for tourism, festival, and activity data.
- Show a review queue for pending, approved, and change-requested proposals.
- Show approval and rejection action UI.
- Show publish, RAG index refresh, cache/search update, and user recommendation reflection states.

## Non-Goals

- Real authentication.
- Real authorization.
- Real API requests.
- Real persistence.
- Real RAG index updates.
- Client-side secrets or server environment variables.

## Verification

- `npm run test`
- `npm run lint`
- `npm run build`
- Browser verification for the Vite app.
