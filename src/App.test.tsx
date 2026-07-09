import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { clearAccessToken } from './admin/session'

const apiProposal = {
  proposalId: 'proposal-1',
  proposalCode: 'PROP-000001',
  contentType: 'festival',
  regionId: 'KR-42-150',
  cityName: '강릉',
  title: '강릉 커피축제 공식 정보 갱신',
  description: '공식 축제 정보를 갱신합니다.',
  officialSourceUrl: 'https://www.gn.go.kr/',
  evidenceText: '공식 홈페이지 공지',
  status: 'submitted',
  submittedAt: '2026-06-23T09:00:00Z',
}

const highRiskRequest = {
  id: 'high-risk-1',
  operationType: 'role_grant',
  targetUserId: 'target-1',
  payload: {
    targetUserId: 'target-1',
    roleCode: 'R-LOCAL-OPERATOR',
  },
  status: 'pending',
  reason: '운영 담당자 권한 부여',
  requestedBy: 'admin-1',
  requestedAt: '2026-06-30T02:00:00Z',
}

// Build an unsigned JWT-shaped token. The console only base64-decodes the payload
// to read roles for UI gating; the signature is never verified in the browser.
function base64url(input: string) {
  return btoa(input).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function makeToken(roles: string[]) {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = base64url(JSON.stringify({ sub: 'dev', roles }))
  return `${header}.${payload}.signature`
}

function useSessionRoles(roles: string[]) {
  vi.stubEnv('VITE_LOVV_ADMIN_ACCESS_TOKEN', makeToken(roles))
}

function useSessionRole(role: string) {
  useSessionRoles([role])
}

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
      ...init,
    }),
  )
}

function requestUrl(input: RequestInfo | URL) {
  return typeof input === 'string' ? input : input.toString()
}

function defaultAdminFetch(input: RequestInfo | URL) {
  const url = requestUrl(input)
  if (url.includes('/api/v1/admin/metrics/destinations')) {
    return jsonResponse({ items: [] })
  }
  if (url.includes('/api/v1/admin/data-proposals')) {
    return jsonResponse({ items: [apiProposal] })
  }
  return jsonResponse({ items: [] })
}

const verifiedMfaStatus = {
  enrolled: true,
  credentialStatus: 'active',
  sessionVerified: true,
  sessionVerifiedAt: '2026-06-30T09:00:00Z',
  sessionExpiresAt: '2026-06-30T21:00:00Z',
  recoveryCodesRemaining: 8,
}

function withVerifiedMfa(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
) {
  return (input: RequestInfo | URL, init?: RequestInit) => {
    if (requestUrl(input).includes('/api/v1/admin/security/mfa/status')) {
      return jsonResponse({ mfa: verifiedMfaStatus })
    }
    return handler(input, init)
  }
}

describe('Lovv admin console', () => {
  beforeEach(() => {
    useSessionRole('R-ADMIN')
    vi.stubGlobal('fetch', vi.fn(withVerifiedMfa(defaultAdminFetch)))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    clearAccessToken()
  })

  it('renders the admin workflow overview with role-based lanes', async () => {
    render(<App />)

    expect(screen.getByTestId('lovv-admin-shell')).toHaveAttribute('data-theme', 'lovv')
    expect(screen.getByRole('heading', { name: 'Lovv Admin Console' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: '운영 지표' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: '데이터 제안' })).toBeDisabled()
    expect(screen.getByRole('tab', { name: '제안 검토' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: '반영 상태' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: '권한 승인' })).toBeInTheDocument()
    expect(screen.getByTestId('current-role-badge')).toHaveTextContent('R-ADMIN')

    expect(await screen.findByText('R-LOCAL-OPERATOR')).toBeInTheDocument()
    expect(screen.getByText('R-DATA-PROVIDER')).toBeInTheDocument()
    expect(screen.getByText('R-ADMIN')).toBeInTheDocument()
    expect(screen.getByText('R-SUPER-ADMIN')).toBeInTheDocument()
    const adminRoleLane = screen.getByTestId('role-lane-R-ADMIN')
    const superAdminRoleLane = screen.getByTestId('role-lane-R-SUPER-ADMIN')
    expect(adminRoleLane).toHaveAttribute('data-owned', 'true')
    expect(within(adminRoleLane).getByText('보유 중')).toBeInTheDocument()
    expect(superAdminRoleLane).toHaveAttribute('data-owned', 'false')
    expect(within(superAdminRoleLane).queryByText('보유 중')).not.toBeInTheDocument()
    expect(screen.getByText('제출 제안')).toBeInTheDocument()
    expect(screen.getByText('승인 완료')).toBeInTheDocument()
    expect(screen.getByText('반려/수정 요청')).toBeInTheDocument()
  })

  it('shows sample proposals and metrics without a backend token in dev preview mode', async () => {
    vi.stubEnv('VITE_LOVV_ADMIN_ACCESS_TOKEN', '')
    vi.stubEnv('VITE_LOVV_USE_SAMPLE_DATA', 'true')
    vi.stubEnv('DEV', true)
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      void input
      return jsonResponse(
        { error: { code: 'UNAUTHORIZED', message: 'Authentication is required' } },
        { status: 401 },
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)

    expect(screen.getByTestId('current-role-badge')).toHaveTextContent('R-SUPER-ADMIN 외 3개 역할')
    expect(screen.getByText('개발 샘플 모드의 프리뷰 역할을 사용 중입니다.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: '제안 검토' }))
    const proposalTable = await screen.findByRole('table', { name: '데이터 제안 목록' })
    expect(await within(proposalTable).findByText('제주 동백 군락지 겨울 투어')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: '운영 지표' }))
    const metricsTable = await screen.findByRole('table', { name: '담당 지역 운영 지표' })
    expect(await within(metricsTable).findByText('제주')).toBeInTheDocument()
    expect(await within(metricsTable).findByText('12840')).toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([input]) => requestUrl(input).includes('/api/v1/admin/'))).toBe(false)
  })

  it('loads high-risk requests for admins even when MFA is not enrolled', async () => {
    const fetchMock = vi.fn((...args: [RequestInfo | URL, RequestInit?]) => {
      const [input] = args
      const url = requestUrl(input)
      if (url.endsWith('/api/v1/admin/security/mfa/status')) {
        return jsonResponse({
          mfa: {
            enrolled: false,
            credentialStatus: 'not_enrolled',
            sessionVerified: false,
            recoveryCodesRemaining: 0,
          },
        })
      }
      if (url.includes('/api/v1/admin/high-risk-requests')) {
        return jsonResponse({ items: [highRiskRequest], nextCursor: null })
      }
      return defaultAdminFetch(input)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)

    expect(await screen.findByText('R-LOCAL-OPERATOR')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '관리자 추가 인증' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: '권한 승인' }))
    const table = await screen.findByRole('table', { name: '고위험 변경 요청 목록' })
    expect(within(table).getByText('역할 부여')).toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/api/v1/admin/high-risk-requests'))).toBe(true)
  })

  it('locks proposal access for an admin session token', () => {
    render(<App />)

    const proposalTab = screen.getByRole('tab', { name: '데이터 제안' })

    expect(screen.getByTestId('current-role-badge')).toHaveTextContent('R-ADMIN')
    expect(proposalTab).toBeDisabled()
    expect(proposalTab).toHaveAttribute('aria-disabled', 'true')
    expect(proposalTab).toHaveAttribute('data-locked', 'true')
    expect(proposalTab).toHaveAccessibleDescription(
      '역할 접근 제한: R-ADMIN 역할은 데이터 제안 작업 영역을 사용할 수 없습니다.',
    )
  })

  it('gates the console to the proposal panel for a data provider token', () => {
    useSessionRole('R-DATA-PROVIDER')

    render(<App />)

    expect(screen.getByTestId('current-role-badge')).toHaveTextContent('R-DATA-PROVIDER')
    expect(screen.getByRole('tab', { name: '데이터 제안' })).toBeEnabled()
    expect(screen.getByRole('tab', { name: '데이터 제안' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('heading', { name: '관광지/축제/체험 데이터 제안' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '제안 등록' })).toBeEnabled()
    expect(screen.getByRole('tab', { name: '제안 검토' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: '승인' })).not.toBeInTheDocument()
  })

  it('uses the union of tabs for sessions with multiple admin roles', async () => {
    useSessionRoles(['R-ADMIN', 'R-DATA-PROVIDER'])

    render(<App />)

    expect(screen.getByTestId('current-role-badge')).toHaveTextContent('R-ADMIN')
    expect(screen.getByRole('tab', { name: '운영 지표' })).toBeEnabled()
    expect(screen.getByRole('tab', { name: '데이터 제안' })).toBeEnabled()
    expect(screen.getByRole('tab', { name: '제안 검토' })).toBeEnabled()

    fireEvent.click(screen.getByRole('tab', { name: '데이터 제안' }))
    expect(await screen.findByRole('button', { name: '제안 등록' })).toBeEnabled()

    fireEvent.click(screen.getByRole('tab', { name: '제안 검토' }))
    expect(await screen.findByRole('button', { name: '검토 시작' })).toBeEnabled()
  })

  it('marks both admin and super-admin role cards for a combined session', () => {
    useSessionRoles(['R-ADMIN', 'R-SUPER-ADMIN'])

    render(<App />)

    const adminRoleLane = screen.getByTestId('role-lane-R-ADMIN')
    const superAdminRoleLane = screen.getByTestId('role-lane-R-SUPER-ADMIN')
    const dataProviderRoleLane = screen.getByTestId('role-lane-R-DATA-PROVIDER')

    expect(adminRoleLane).toHaveAttribute('data-owned', 'true')
    expect(within(adminRoleLane).getByText('보유 중')).toBeInTheDocument()
    expect(superAdminRoleLane).toHaveAttribute('data-owned', 'true')
    expect(within(superAdminRoleLane).getByText('보유 중')).toBeInTheDocument()
    expect(dataProviderRoleLane).toHaveAttribute('data-owned', 'false')
    expect(within(dataProviderRoleLane).queryByText('보유 중')).not.toBeInTheDocument()
    expect(screen.getByRole('tab', { name: '운영 지표' })).toBeEnabled()
    expect(screen.getByRole('tab', { name: '권한 승인' })).toBeEnabled()
    expect(screen.getByRole('tab', { name: '데이터 제안' })).toBeDisabled()
  })

  it('lists high-risk requests for regular admins but hides super-admin decisions', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = requestUrl(input)
      if (url.includes('/api/v1/admin/high-risk-requests')) {
        return jsonResponse({ items: [highRiskRequest], nextCursor: null })
      }
      return defaultAdminFetch(input)
    })
    vi.stubGlobal('fetch', vi.fn(withVerifiedMfa(fetchMock)))

    render(<App />)
    fireEvent.click(screen.getByRole('tab', { name: '권한 승인' }))

    expect(await screen.findByRole('heading', { name: '권한 승인 요청' })).toBeInTheDocument()
    const table = await screen.findByRole('table', { name: '고위험 변경 요청 목록' })
    expect(within(table).getByText('역할 부여')).toBeInTheDocument()
    expect(within(table).getByText('target-1')).toBeInTheDocument()
    expect(within(table).queryByRole('button', { name: '승인 실행' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '고위험 요청 생성' })).toBeDisabled()
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/api/v1/admin/high-risk-requests'))).toBe(true)
  })

  it('creates high-risk requests without client-owned authority fields', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input)
      if (url.endsWith('/api/v1/admin/high-risk-requests') && init?.method === 'POST') {
        return jsonResponse({ request: highRiskRequest }, { status: 201 })
      }
      if (url.includes('/api/v1/admin/high-risk-requests')) {
        return jsonResponse({ items: [], nextCursor: null })
      }
      return defaultAdminFetch(input)
    })
    vi.stubGlobal('fetch', vi.fn(withVerifiedMfa(fetchMock)))

    render(<App />)
    fireEvent.click(screen.getByRole('tab', { name: '권한 승인' }))
    await screen.findByRole('heading', { name: '권한 승인 요청' })
    fireEvent.change(screen.getByLabelText('대상 사용자 ID'), { target: { value: 'target-1' } })
    fireEvent.change(screen.getByLabelText('요청 사유'), { target: { value: '운영 담당자 권한 부여' } })
    fireEvent.click(screen.getByRole('button', { name: '고위험 요청 생성' }))

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input, init]) =>
          String(input).endsWith('/api/v1/admin/high-risk-requests') &&
          (init as RequestInit | undefined)?.method === 'POST',
        ),
      ).toBe(true),
    )
    const createCall = fetchMock.mock.calls.find(([input, init]) =>
      String(input).endsWith('/api/v1/admin/high-risk-requests') &&
      (init as RequestInit | undefined)?.method === 'POST',
    )
    const body = JSON.parse(String((createCall?.[1] as RequestInit).body))
    expect(body).toEqual({
      operationType: 'role_grant',
      targetUserId: 'target-1',
      roleCode: 'R-LOCAL-OPERATOR',
      reason: '운영 담당자 권한 부여',
    })
    expect(body).not.toHaveProperty('requestedBy')
    expect(body).not.toHaveProperty('decidedBy')
    expect(body).not.toHaveProperty('roles')
  })

  it('lets super admins approve high-risk requests only after TOTP verification', async () => {
    useSessionRole('R-SUPER-ADMIN')
    let approveCalls = 0
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input)
      if (url.endsWith('/api/v1/admin/security/mfa/verify')) {
        return jsonResponse({ mfa: verifiedMfaStatus })
      }
      if (url.endsWith('/api/v1/admin/high-risk-requests/high-risk-1/approve') && init?.method === 'POST') {
        approveCalls += 1
        if (approveCalls === 1) {
          return jsonResponse(
            { error: { code: 'ADMIN_MFA_REQUIRED', message: 'MFA 인증이 필요합니다.' } },
            { status: 403 },
          )
        }
        return jsonResponse({ request: { ...highRiskRequest, status: 'executed', decidedBy: 'super-1' } })
      }
      if (url.includes('/api/v1/admin/high-risk-requests')) {
        return jsonResponse({ items: [highRiskRequest], nextCursor: null })
      }
      return defaultAdminFetch(input)
    })
    vi.stubGlobal('fetch', vi.fn(withVerifiedMfa(fetchMock)))

    render(<App />)

    expect(await screen.findByRole('heading', { name: '권한 승인 요청' })).toBeInTheDocument()
    expect(screen.getByTestId('current-role-badge')).toHaveTextContent('R-SUPER-ADMIN')
    const superAdminRoleLane = screen.getByTestId('role-lane-R-SUPER-ADMIN')
    const adminRoleLane = screen.getByTestId('role-lane-R-ADMIN')
    expect(superAdminRoleLane).toHaveAttribute('data-owned', 'true')
    expect(within(superAdminRoleLane).getByText('보유 중')).toBeInTheDocument()
    expect(adminRoleLane).toHaveAttribute('data-owned', 'false')
    expect(within(adminRoleLane).queryByText('보유 중')).not.toBeInTheDocument()
    const table = await screen.findByRole('table', { name: '고위험 변경 요청 목록' })
    expect(within(table).getByRole('button', { name: '승인 실행' })).toBeEnabled()
    fireEvent.click(within(table).getByRole('button', { name: '승인 실행' }))
    const dialog = await screen.findByRole('dialog', { name: '승인 추가 인증' })
    fireEvent.change(within(dialog).getByLabelText('인증 코드'), { target: { value: '123456' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '인증' }))

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([input, init]) =>
          String(input).endsWith('/api/v1/admin/high-risk-requests/high-risk-1/approve') &&
          (init as RequestInit | undefined)?.method === 'POST',
        ),
      ).toHaveLength(2),
    )
    const verifyIndex = fetchMock.mock.calls.findIndex(([input]) =>
      String(input).endsWith('/api/v1/admin/security/mfa/verify'),
    )
    const approveIndex = fetchMock.mock.calls
      .map(([input], index) => ({ input, index }))
      .filter(({ input }) => String(input).endsWith('/api/v1/admin/high-risk-requests/high-risk-1/approve'))
      .at(-1)?.index ?? -1
    expect(verifyIndex).toBeGreaterThanOrEqual(0)
    expect(approveIndex).toBeGreaterThan(verifyIndex)
    expect(JSON.parse(String((fetchMock.mock.calls[approveIndex][1] as RequestInit).body))).toEqual({})
  })

  it('locks every workspace when the token carries no known admin role', () => {
    useSessionRole('R-USER')

    render(<App />)

    expect(screen.getByTestId('current-role-badge')).toHaveTextContent('역할 없음')
    expect(screen.getByRole('tab', { name: '운영 지표' })).toBeDisabled()
    expect(screen.getByRole('tab', { name: '데이터 제안' })).toBeDisabled()
    expect(screen.getByRole('tab', { name: '제안 검토' })).toBeDisabled()
    expect(screen.getByRole('tab', { name: '반영 상태' })).toBeDisabled()
    expect(screen.getByRole('heading', { name: '유효한 세션 역할이 없습니다' })).toBeInTheDocument()
  })

  it('summarizes local operator metrics from the admin API', async () => {
    useSessionRole('R-LOCAL-OPERATOR')
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = requestUrl(input)
      if (url.includes('/api/v1/admin/metrics/destinations')) {
        return jsonResponse({
          items: [
            {
              monthlyCuratedDestinationId: 'monthly-1',
              cityId: 'gangneung',
              regionId: 'KR-42-150',
              startDate: '2026-10-01',
              endDate: '2026-10-31',
              destinationImpressions: 100,
              destinationDetailOpens: 40,
              itineraryGenerated: 25,
              itinerarySaved: 10,
              officialLinkClicks: 12,
              partnerLinkClicks: 8,
              visitIntentSubmitted: 6,
              visitConfirmed: 2,
              distinctUserCount: 9,
              minGroupSizeMet: true,
            },
          ],
        })
      }
      return jsonResponse({ items: [] })
    })
    vi.stubGlobal('fetch', vi.fn(withVerifiedMfa(fetchMock)))

    render(<App />)

    const dashboard = await screen.findByRole('region', { name: '지역 운영자 집계 대시보드' })
    expect(within(dashboard).getByText('총 노출')).toBeInTheDocument()
    expect(within(dashboard).getByText('100')).toBeInTheDocument()
    expect(within(dashboard).getByText('저장 전환율')).toBeInTheDocument()
    expect(within(dashboard).getByText('25%')).toBeInTheDocument()
    expect(within(dashboard).getByText('공식 12 / 제휴 8')).toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/api/v1/admin/metrics/destinations'))).toBe(true)
  })

  it('creates a data proposal through the admin API without client-owned authority fields', async () => {
    useSessionRole('R-DATA-PROVIDER')
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input)
      if (url.includes('/api/v1/admin/metrics/destinations')) {
        return jsonResponse({ items: [] })
      }
      if (url.endsWith('/api/v1/admin/data-proposals') && init?.method === 'POST') {
        return jsonResponse({ proposal: apiProposal }, { status: 201 })
      }
      if (url.includes('/api/v1/admin/data-proposals')) {
        return jsonResponse({ items: [] })
      }
      return jsonResponse({ items: [] })
    })
    vi.stubGlobal('fetch', vi.fn(withVerifiedMfa(fetchMock)))

    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: '제안 등록' }))

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input, init]) =>
          String(input).endsWith('/api/v1/admin/data-proposals') &&
          (init as RequestInit | undefined)?.method === 'POST',
        ),
      ).toBe(true),
    )
    const createCall = fetchMock.mock.calls.find(([input, init]) =>
      String(input).endsWith('/api/v1/admin/data-proposals') &&
      (init as RequestInit | undefined)?.method === 'POST',
    )
    expect(createCall).toBeDefined()
    const [, createInit] = createCall as [RequestInfo | URL, RequestInit]
    const body = JSON.parse(String(createInit.body))

    expect(createCall?.[0]).toBe('/api/v1/admin/data-proposals')
    expect(createInit.method).toBe('POST')
    expect(body).toMatchObject({
      contentType: 'festival',
      regionId: 'KR-42-150',
      title: '강릉 커피축제 공식 정보 갱신',
    })
    expect(body).not.toHaveProperty('organizationId')
    expect(body).not.toHaveProperty('createdBy')
    expect(body).not.toHaveProperty('reviewedBy')
    expect(body).not.toHaveProperty('roles')
  })

  it('loads review proposals from the admin API and exposes review actions to admins', async () => {
    render(<App />)

    fireEvent.click(screen.getByRole('tab', { name: '제안 검토' }))

    const queue = await screen.findByRole('table', { name: '데이터 제안 목록' })
    expect(await within(queue).findByText('강릉 커피축제 공식 정보 갱신')).toBeInTheDocument()
    expect(within(queue).getByText('submitted')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '승인 여부' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '검토 시작' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '승인' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '반려' })).toBeDisabled()
    expect(screen.getByText('제안자에게 사유 표시')).toBeInTheDocument()
  })

  it('sends review action requests to the backend API', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input)
      if (url.includes('/api/v1/admin/metrics/destinations')) {
        return jsonResponse({ items: [] })
      }
      if (url.endsWith('/api/v1/admin/data-proposals/proposal-1/review') && init?.method === 'POST') {
        return jsonResponse({ proposal: { ...apiProposal, status: 'in_review' } })
      }
      if (url.includes('/api/v1/admin/data-proposals')) {
        return jsonResponse({ items: [apiProposal] })
      }
      return jsonResponse({ items: [] })
    })
    vi.stubGlobal('fetch', vi.fn(withVerifiedMfa(fetchMock)))

    render(<App />)
    fireEvent.click(screen.getByRole('tab', { name: '제안 검토' }))
    const queue = await screen.findByRole('table', { name: '데이터 제안 목록' })
    expect(await within(queue).findByText('강릉 커피축제 공식 정보 갱신')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '검토 시작' }))

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input, init]) =>
          String(input).endsWith('/api/v1/admin/data-proposals/proposal-1/review') &&
          (init as RequestInit | undefined)?.method === 'POST',
        ),
      ).toBe(true),
    )
    const reviewCall = fetchMock.mock.calls.find(([input]) =>
      String(input).endsWith('/api/v1/admin/data-proposals/proposal-1/review'),
    )
    expect(reviewCall?.[0]).toBe('/api/v1/admin/data-proposals/proposal-1/review')
    expect((reviewCall?.[1] as RequestInit).method).toBe('POST')
    const body = JSON.parse(String((reviewCall?.[1] as RequestInit).body))
    expect(body).not.toHaveProperty('reviewedBy')
    expect(body).not.toHaveProperty('roles')
  })

  it('loads proposal history through the admin API', async () => {
    const historyResponse = {
        items: [
          {
            historyId: 'history-1',
            proposalId: 'proposal-1',
            action: 'submitted',
            fromStatus: null,
            toStatus: 'submitted',
            actorUserId: 'provider-1',
            note: 'created',
            createdAt: '2026-06-23T09:00:00Z',
          },
        ],
      }
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = requestUrl(input)
      if (url.includes('/api/v1/admin/metrics/destinations')) {
        return jsonResponse({ items: [] })
      }
      if (url.endsWith('/api/v1/admin/data-proposals/proposal-1/history')) {
        return jsonResponse(historyResponse)
      }
      if (url.includes('/api/v1/admin/data-proposals')) {
        return jsonResponse({ items: [apiProposal] })
      }
      return jsonResponse({ items: [] })
    })
    vi.stubGlobal('fetch', vi.fn(withVerifiedMfa(fetchMock)))

    render(<App />)
    fireEvent.click(screen.getByRole('tab', { name: '제안 검토' }))
    const queue = await screen.findByRole('table', { name: '데이터 제안 목록' })
    await within(queue).findByText('강릉 커피축제 공식 정보 갱신')
    fireEvent.click(screen.getByRole('button', { name: '이력 조회' }))

    expect(await screen.findByLabelText('제안 변경 이력')).toHaveTextContent('submitted')
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).endsWith('/api/v1/admin/data-proposals/proposal-1/history'),
      ),
    ).toBe(true)
  })

  it('shows API errors instead of falling back to mock proposal rows', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = requestUrl(input)
        if (url.includes('/api/v1/admin/security/mfa/status')) {
          return jsonResponse({ mfa: verifiedMfaStatus })
        }
        if (url.includes('/api/v1/admin/metrics/destinations')) {
          return jsonResponse({ items: [] })
        }
        return jsonResponse(
          { error: { code: 'UNAUTHORIZED', message: 'Authentication is required' } },
          { status: 401 },
        )
      }),
    )

    render(<App />)
    fireEvent.click(screen.getByRole('tab', { name: '제안 검토' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Authentication is required')
    expect(screen.getByText('표시할 제안이 없습니다.')).toBeInTheDocument()
  })

  it('lists monthly curated destinations from the admin API in the 반영 상태 tab', async () => {
    const monthly = {
      id: 'monthly-1',
      cityName: '강릉',
      regionId: 'KR-42-150',
      curationMonth: '2026-10',
      themeCodes: ['coffee', 'festival'],
      status: 'candidate',
    }
    const fetchMock = vi.fn((...args: [RequestInfo | URL, RequestInit?]) => {
      const [input] = args
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/api/v1/admin/monthly-destinations')) {
        return jsonResponse({ items: [monthly] })
      }
      return jsonResponse({ items: [] })
    })
    vi.stubGlobal('fetch', vi.fn(withVerifiedMfa(fetchMock)))

    render(<App />)
    fireEvent.click(screen.getByRole('tab', { name: '반영 상태' }))

    expect(
      await screen.findByRole('heading', { name: '월간 여행지 후보·게시 상태' }),
    ).toBeInTheDocument()
    const table = await screen.findByRole('table', { name: '월간 여행지 후보 목록' })
    expect(within(table).getByText('강릉')).toBeInTheDocument()
    expect(within(table).getByText('2026-10')).toBeInTheDocument()
    expect(within(table).getByText('후보')).toBeInTheDocument()
    // R-ADMIN can manage, so candidate-stage transition buttons are offered.
    expect(within(table).getByRole('button', { name: '게시' })).toBeInTheDocument()
    expect(
      fetchMock.mock.calls.some(([input]) => String(input).includes('/api/v1/admin/monthly-destinations')),
    ).toBe(true)
  })

  it('sends a monthly destination transition to the backend API', async () => {
    const candidate = {
      id: 'monthly-1',
      cityName: '강릉',
      regionId: 'KR-42-150',
      curationMonth: '2026-10',
      themeCodes: ['coffee'],
      status: 'candidate',
    }
    const fetchMock = vi.fn((...args: [RequestInfo | URL, RequestInit?]) => {
      const [input] = args
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/monthly-destinations/monthly-1/publish')) {
        return jsonResponse({ destination: { ...candidate, status: 'published' } })
      }
      if (url.includes('/api/v1/admin/monthly-destinations')) {
        return jsonResponse({ items: [candidate] })
      }
      return jsonResponse({ items: [] })
    })
    vi.stubGlobal('fetch', vi.fn(withVerifiedMfa(fetchMock)))

    render(<App />)
    fireEvent.click(screen.getByRole('tab', { name: '반영 상태' }))
    const table = await screen.findByRole('table', { name: '월간 여행지 후보 목록' })
    fireEvent.click(within(table).getByRole('button', { name: '게시' }))

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input, init]) =>
          String(input).includes('/monthly-destinations/monthly-1/publish') &&
          (init as RequestInit | undefined)?.method === 'POST',
        ),
      ).toBe(true),
    )
  })
  it('restores the session token from /api/v1/auth/session when no local token exists', async () => {
    vi.stubEnv('VITE_LOVV_ADMIN_ACCESS_TOKEN', '')
    clearAccessToken()
    const adminToken = makeToken(['R-ADMIN'])
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/api/v1/auth/session')) {
        return jsonResponse({ accessToken: adminToken, user: { userId: 'admin-1', roles: ['R-ADMIN'] } })
      }
      return jsonResponse({ items: [] })
    })
    vi.stubGlobal('fetch', vi.fn(withVerifiedMfa(fetchMock)))

    render(<App />)

    await waitFor(() =>
      expect(screen.getByTestId('current-role-badge')).toHaveTextContent('R-ADMIN'),
    )
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/api/v1/auth/session'))).toBe(true)
  })

  it('loads reflection job history for a published destination', async () => {
    const candidate = {
      id: 'monthly-1',
      cityName: '강릉',
      regionId: 'KR-42-150',
      curationMonth: '2026-10',
      themeCodes: ['coffee'],
      status: 'published',
    }
    const job = {
      id: 'job-1',
      monthlyCuratedDestinationId: 'monthly-1',
      jobType: 'catalog_sync',
      status: 'queued',
      attemptCount: 0,
    }
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/monthly-destinations/monthly-1/publish-jobs')) {
        return jsonResponse({ items: [job] })
      }
      if (url.includes('/api/v1/admin/monthly-destinations')) {
        return jsonResponse({ items: [candidate] })
      }
      return jsonResponse({ items: [] })
    })
    vi.stubGlobal('fetch', vi.fn(withVerifiedMfa(fetchMock)))

    render(<App />)
    fireEvent.click(screen.getByRole('tab', { name: '반영 상태' }))
    const table = await screen.findByRole('table', { name: '월간 여행지 후보 목록' })
    fireEvent.click(within(table).getByRole('button', { name: '반영 이력' }))

    const jobsTable = await screen.findByRole('table', { name: '데이터 반영 작업' })
    expect(within(jobsTable).getByText('카탈로그 동기화')).toBeInTheDocument()
    expect(within(jobsTable).getByText('대기')).toBeInTheDocument()
    // R-ADMIN can manage, so the queued job offers the start action.
    expect(within(jobsTable).getByRole('button', { name: '시작' })).toBeInTheDocument()
    expect(
      fetchMock.mock.calls.some(([input]) => String(input).includes('/monthly-destinations/monthly-1/publish-jobs')),
    ).toBe(true)
  })

  it('lists notices and recommendation policies in the operations tab', async () => {
    const notice = {
      id: 'notice-1',
      title: '추천 반영 일정 안내',
      body: '월간 후보가 추천 캐시에 반영되는 일정을 공지합니다.',
      audience: 'admin',
      severity: 'info',
      status: 'draft',
    }
    const policy = {
      id: 'policy-1',
      policyKey: 'small_city_balance',
      title: '소도시 노출 균형 정책',
      description: '과소 노출 소도시를 우선 고려합니다.',
      priority: 80,
      status: 'draft',
    }
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/api/v1/admin/notices')) {
        return jsonResponse({ items: [notice] })
      }
      if (url.includes('/api/v1/admin/recommendation-policies')) {
        return jsonResponse({ items: [policy] })
      }
      return jsonResponse({ items: [] })
    })
    vi.stubGlobal('fetch', vi.fn(withVerifiedMfa(fetchMock)))

    render(<App />)
    fireEvent.click(screen.getByRole('tab', { name: '공지·정책' }))

    expect(
      await screen.findByRole('heading', { name: '공지·추천 정책 관리' }),
    ).toBeInTheDocument()
    expect(await screen.findByText('추천 반영 일정 안내')).toBeInTheDocument()
    expect(await screen.findByText('소도시 노출 균형 정책')).toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/api/v1/admin/notices'))).toBe(true)
    expect(
      fetchMock.mock.calls.some(([input]) => String(input).includes('/api/v1/admin/recommendation-policies')),
    ).toBe(true)
  })

  it('lists audit log entries in the audit tab', async () => {
    const entry = {
      id: 'audit-1',
      occurredAt: '2026-06-24T00:00:00Z',
      actorUserId: 'admin-1',
      action: 'data_proposal.approve',
      resourceType: 'data_proposal',
      resourceId: 'proposal-1',
      result: 'succeeded',
    }
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/api/v1/admin/audit-logs')) {
        return jsonResponse({ items: [entry] })
      }
      return jsonResponse({ items: [] })
    })
    vi.stubGlobal('fetch', vi.fn(withVerifiedMfa(fetchMock)))

    render(<App />)
    fireEvent.click(screen.getByRole('tab', { name: '감사 로그' }))

    expect(await screen.findByRole('heading', { name: '감사 로그' })).toBeInTheDocument()
    const table = await screen.findByRole('table', { name: '감사 로그 목록' })
    expect(within(table).getByText('data_proposal.approve')).toBeInTheDocument()
    expect(within(table).getByText('성공')).toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/api/v1/admin/audit-logs'))).toBe(true)
  })

})
