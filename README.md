# Lovv Admin Web

Lovv 관리자 콘솔입니다. 본 서비스 사용자 프론트와 분리된 Vite React 앱이며, 지자체·데이터 제공자·서비스 관리자의 운영 PoC 흐름을 검증합니다.

## 현재 범위

- 역할별 콘솔 UI
  - `R-ADMIN`
  - `R-DATA-PROVIDER`
  - `R-LOCAL-OPERATOR`
- 데이터 제안 등록
- 제안 목록 조회
- 검토 시작, 승인, 반려
- 제안 변경 이력 조회
- 승인 이후 반영 상태 타임라인 표시

## Backend API 연동

관리자 콘솔은 Lovv Backend의 다음 API를 사용합니다.

```text
GET  /api/v1/admin/data-proposals
POST /api/v1/admin/data-proposals
POST /api/v1/admin/data-proposals/{proposalId}/review
POST /api/v1/admin/data-proposals/{proposalId}/approve
POST /api/v1/admin/data-proposals/{proposalId}/reject
GET  /api/v1/admin/data-proposals/{proposalId}/history
```

프론트는 `organizationId`, `createdBy`, `reviewedBy`, `roles` 같은 권한 필드를 요청 body로 보내지 않습니다. 소유권과 검토자는 백엔드가 access token과 DB 권한 할당 기준으로 결정합니다.

## Environment

`.env.example`을 참고해 로컬 또는 Vercel 환경변수를 설정합니다.

```bash
VITE_LOVV_API_BASE_URL=https://your-api.example.com
```

개발 확인용 토큰이 필요할 때만 아래 값을 사용할 수 있습니다. 운영에서는 실제 로그인/session 흐름으로 교체해야 합니다.

```bash
VITE_LOVV_ADMIN_ACCESS_TOKEN=replace-with-development-token
```

RDS 검색용 환경변수는 브라우저에 노출되지 않아야 하므로 `VITE_` prefix를 붙이지 않습니다.

## Commands

```bash
npm install
npm run dev
npm run lint
npm test
npm run build
```

## Vercel

이 저장소를 별도 Vercel Project로 import합니다.

- Build Command: `npm run build`
- Output Directory: `dist`
- Framework Preset: Vite

## Notes

- 현재 역할 선택 UI는 운영 인증이 연결되기 전까지의 preview UX입니다.
- 실제 권한 검증은 백엔드 `/api/v1/admin/*` API에서 수행합니다.
- 승인된 제안이 실제 추천 데이터로 반영되는 작업은 후속 단계에서 연결합니다.
