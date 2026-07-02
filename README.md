# Lovv Admin Web

Lovv 관리자 콘솔입니다. 본 서비스 사용자 프론트와 분리된 Vite React 앱이며, 지자체·데이터 제공자·서비스 관리자·슈퍼관리자의 운영 PoC 흐름을 검증합니다.

## 현재 범위

- 역할별 콘솔 UI
  - `R-LOCAL-OPERATOR`: 운영 지표 조회
  - `R-DATA-PROVIDER`: 데이터 제안 생성
  - `R-ADMIN`: 지표, 제안 검토, 월간 반영, 공지·정책, 권한 승인 요청 목록, 감사 로그
  - `R-SUPER-ADMIN`: 고위험 변경 승인/거절
- 데이터 제안 등록
- 제안 목록 조회
- 검토 시작, 승인, 반려
- 제안 변경 이력 조회
- 승인 이후 반영 상태 타임라인 표시
- 권한 승인 탭
  - pending high-risk 목록 조회
  - pending count badge 표시
  - 고위험 요청 생성
  - `R-SUPER-ADMIN` 승인/거절

## 역할과 접근 모델

세션 역할은 access token에서 해석합니다. 한 사용자가 여러 역할을 가질 수 있으며, 탭과 액션 접근은 가진 역할들의 합집합으로 열립니다.

| 역할 | 접근/액션 |
| --- | --- |
| `R-LOCAL-OPERATOR` | 운영 지표 조회 |
| `R-DATA-PROVIDER` | 데이터 제안 생성 |
| `R-ADMIN` | 지표·검토·반영·공지·권한 승인 목록·감사 로그, 고위험 요청 생성 |
| `R-SUPER-ADMIN` | 권한 승인 탭, 고위험 요청 생성, 승인/거절 |

`R-ADMIN`은 고위험 요청 목록 조회와 요청 생성은 가능하지만 승인/거절 버튼은 노출되지 않습니다. `R-SUPER-ADMIN`만 고위험 요청을 승인하거나 거절할 수 있습니다.

## 고위험 승인과 MFA

관리자 콘솔은 전역 MFA 게이트를 사용하지 않습니다. 로그인 직후 MFA 세션이 없어도 `R-ADMIN` 또는 `R-SUPER-ADMIN` 세션이면 pending high-risk 목록과 뱃지를 로딩합니다.

고위험 승인/거절에서만 backend 403 응답을 기준으로 MFA 모달을 표시합니다.

1. `R-SUPER-ADMIN`이 승인 또는 거절을 클릭합니다.
2. admin_web이 먼저 approve/reject API를 호출합니다.
3. backend가 `ADMIN_MFA_REQUIRED` 또는 `ADMIN_MFA_TOTP_REQUIRED`를 반환하면 TOTP 입력 모달을 표시합니다.
4. 사용자가 인증 앱의 6자리 TOTP 코드를 입력합니다.
5. admin_web이 `/api/v1/admin/security/mfa/verify`로 MFA 세션을 생성합니다.
6. verify 성공 후 원래 approve/reject 요청을 재시도합니다.

처리하는 주요 오류 코드는 다음과 같습니다.

- `ADMIN_MFA_REQUIRED`: TOTP 입력 모달 표시
- `ADMIN_MFA_TOTP_REQUIRED`: recovery code로는 승인/거절할 수 없고 인증 앱 코드가 필요하다고 안내
- `ADMIN_MFA_ENROLLMENT_REQUIRED`: MFA 등록 필요 안내
- `ADMIN_MFA_LOCKED`: MFA 잠금 안내
- `SUPER_ADMIN_REQUIRED`: 슈퍼관리자 전용 작업 안내

Recovery code 인증 세션은 고위험 승인/거절에 사용할 수 없습니다. approve/reject 요청 body에도 TOTP code를 넣지 않으며, TOTP 세션은 `/security/mfa/verify`에서 별도로 생성합니다.

Pending 목록은 backend의 `limit=50` 상한과 총계 미제공 제약을 따릅니다. 목록이 50건이면 뱃지는 정확한 총계처럼 `50`으로 표시하지 않고 `50+`로 표시합니다.

## Backend API 연동

관리자 콘솔은 Lovv Backend의 다음 API를 사용합니다.

```text
GET  /api/v1/admin/data-proposals
POST /api/v1/admin/data-proposals
POST /api/v1/admin/data-proposals/{proposalId}/review
POST /api/v1/admin/data-proposals/{proposalId}/approve
POST /api/v1/admin/data-proposals/{proposalId}/reject
GET  /api/v1/admin/data-proposals/{proposalId}/history

GET  /api/v1/admin/security/mfa/status
POST /api/v1/admin/security/mfa/enroll
POST /api/v1/admin/security/mfa/confirm
POST /api/v1/admin/security/mfa/verify
POST /api/v1/admin/security/mfa/recover

GET  /api/v1/admin/high-risk-requests?status=pending&limit=50
POST /api/v1/admin/high-risk-requests
POST /api/v1/admin/high-risk-requests/{requestId}/approve
POST /api/v1/admin/high-risk-requests/{requestId}/reject
```

프론트는 `organizationId`, `createdBy`, `reviewedBy`, `requestedBy`, `decidedBy`, `roles` 같은 권한 필드를 임의로 요청 body에 넣지 않습니다. 소유권, 검토자, 요청자, 결정자는 백엔드가 access token과 DB 권한 할당 기준으로 결정합니다.

## Environment

`.env.example`을 참고해 로컬 또는 Vercel 환경변수를 설정합니다.

```bash
VITE_LOVV_API_BASE_URL=https://your-api.example.com
```

개발 확인용 토큰이 필요할 때만 아래 값을 사용할 수 있습니다. 이 값은 Vite dev mode에서만 세션 역할 fallback으로 사용되며, 운영 빌드에서는 실제 로그인/session 흐름을 사용해야 합니다.

```bash
VITE_LOVV_ADMIN_ACCESS_TOKEN=replace-with-development-token
```

backend 없이 관리자 콘솔의 샘플 제안/지표 데이터를 미리 보려면 개발 환경에서만 아래 값을 사용할 수 있습니다.

```bash
VITE_LOVV_USE_SAMPLE_DATA=true
```

샘플 모드에서 access token이 없으면 네 역할을 모두 가진 개발 전용 프리뷰 세션으로 표시합니다. 이 fallback은 Vite dev mode에서만 활성화되며 운영 빌드에는 적용되지 않습니다.

RDS 검색용 환경변수는 브라우저에 노출되지 않아야 하므로 `VITE_` prefix를 붙이지 않습니다.

## Commands

```bash
npm install
npm run dev
npm run lint
npm test
npm run build
```

Windows PowerShell 실행 정책 때문에 `npm.ps1`이 막히는 환경에서는 `npm.cmd`를 사용합니다.

```powershell
npm.cmd run lint
npm.cmd test
npm.cmd run build
```

## Vercel

이 저장소를 별도 Vercel Project로 import합니다.

- Build Command: `npm run build`
- Output Directory: `dist`
- Framework Preset: Vite

## Notes

- 실제 권한 검증은 백엔드 `/api/v1/admin/*` API에서 수행합니다. 프론트의 역할/액션 제한은 UX 방어선입니다.
- 일반 admin 읽기/목록 경로는 MFA 세션을 요구하지 않습니다.
- MFA는 고위험 approve/reject 시점에만 필요합니다.
- 승인된 제안이 실제 추천 데이터로 반영되는 작업은 후속 단계에서 연결합니다.
