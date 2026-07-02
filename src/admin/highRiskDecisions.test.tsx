import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { clearAccessToken } from './session'

// Fixtures mirror the shared ones in App.test.tsx so this spec is self-contained.
const highRiskRequest = {
  id: 'high-risk-1',
  operationType: 'role_grant',
  targetUserId: 'target-1',
  payload: { targetUserId: 'target-1', roleCode: 'R-LOCAL-OPERATOR' },
  status: 'pending',
  reason: '운영 담당자 권한 부여',
  requestedBy: 'admin-1',
  requestedAt: '2026-06-30T02:00:00Z',
}

const verifiedMfaStatus = {
  enrolled: true,
  credentialStatus: 'active',
  sessionVerified: true,
  sessionVerifiedAt: '2026-06-30T09:00:00Z',
  sessionExpiresAt: '2026-06-30T21:00:00Z',
  recoveryCodesRemaining: 8,
}

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

describe('high-risk decision flows (super admin)', () => {
  beforeEach(() => {
    useSessionRoles(['R-SUPER-ADMIN'])
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    clearAccessToken()
  })

  async function openDecisionPanel() {
    expect(await screen.findByRole('heading', { name: '권한 승인 요청' })).toBeInTheDocument()
    return screen.findByRole('table', { name: '고위험 변경 요청 목록' })
  }

  it('retries reject after decision-time TOTP verification', async () => {
    let rejectCalls = 0
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input)
      if (url.endsWith('/api/v1/admin/security/mfa/verify')) {
        return jsonResponse({ mfa: verifiedMfaStatus })
      }
      if (url.endsWith('/api/v1/admin/high-risk-requests/high-risk-1/reject') && init?.method === 'POST') {
        rejectCalls += 1
        if (rejectCalls === 1) {
          return jsonResponse(
            { error: { code: 'ADMIN_MFA_REQUIRED', message: 'MFA 인증이 필요합니다.' } },
            { status: 403 },
          )
        }
        return jsonResponse({ request: { ...highRiskRequest, status: 'rejected' } })
      }
      if (url.includes('/api/v1/admin/high-risk-requests')) {
        return jsonResponse({ items: [highRiskRequest], nextCursor: null })
      }
      return jsonResponse({ items: [] })
    })
    vi.stubGlobal('fetch', vi.fn(withVerifiedMfa(fetchMock)))

    render(<App />)
    const table = await openDecisionPanel()

    const rejectButton = within(table).getByRole('button', { name: '거절 실행' })
    expect(rejectButton).toBeDisabled()
    fireEvent.change(screen.getByLabelText('결정 사유'), { target: { value: '정책 위반으로 거절' } })
    expect(rejectButton).toBeEnabled()

    fireEvent.click(rejectButton)
    const dialog = await screen.findByRole('dialog', { name: '승인 추가 인증' })
    fireEvent.change(within(dialog).getByLabelText('인증 코드'), { target: { value: '123456' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '인증' }))

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([input, init]) =>
          String(input).endsWith('/api/v1/admin/high-risk-requests/high-risk-1/reject') &&
          (init as RequestInit | undefined)?.method === 'POST',
        ),
      ).toHaveLength(2),
    )
    const verifyIndex = fetchMock.mock.calls.findIndex(([input]) =>
      String(input).endsWith('/api/v1/admin/security/mfa/verify'),
    )
    const rejectIndex = fetchMock.mock.calls
      .map(([input], index) => ({ input, index }))
      .filter(({ input }) => String(input).endsWith('/api/v1/admin/high-risk-requests/high-risk-1/reject'))
      .at(-1)?.index ?? -1
    expect(verifyIndex).toBeGreaterThanOrEqual(0)
    expect(rejectIndex).toBeGreaterThan(verifyIndex)
    expect(JSON.parse(String((fetchMock.mock.calls[rejectIndex][1] as RequestInit).body))).toEqual({
      decisionReason: '정책 위반으로 거절',
    })
  })

  it('keeps the decision blocked when TOTP verification fails', async () => {
    let approveCalls = 0
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input)
      if (url.endsWith('/api/v1/admin/security/mfa/verify')) {
        return jsonResponse(
          { error: { code: 'MFA_REAUTH_REQUIRED', message: 'MFA 재인증이 만료되었습니다.' } },
          { status: 401 },
        )
      }
      if (url.endsWith('/api/v1/admin/high-risk-requests/high-risk-1/approve') && init?.method === 'POST') {
        approveCalls += 1
        return jsonResponse(
          { error: { code: 'ADMIN_MFA_REQUIRED', message: 'MFA 인증이 필요합니다.' } },
          { status: 403 },
        )
      }
      if (url.includes('/api/v1/admin/high-risk-requests')) {
        return jsonResponse({ items: [highRiskRequest], nextCursor: null })
      }
      return jsonResponse({ items: [] })
    })
    vi.stubGlobal('fetch', vi.fn(withVerifiedMfa(fetchMock)))

    render(<App />)
    const table = await openDecisionPanel()

    fireEvent.click(within(table).getByRole('button', { name: '승인 실행' }))
    const dialog = await screen.findByRole('dialog', { name: '승인 추가 인증' })
    fireEvent.change(within(dialog).getByLabelText('인증 코드'), { target: { value: '000000' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '인증' }))

    expect(await screen.findByText('MFA 재인증이 만료되었습니다.')).toBeInTheDocument()
    expect(approveCalls).toBe(1)
  })

  it('surfaces the backend self-approval rejection after MFA retry', async () => {
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
        return jsonResponse(
          { error: { code: 'SELF_APPROVAL_FORBIDDEN', message: '본인이 요청한 고위험 변경은 승인할 수 없습니다.' } },
          { status: 403 },
        )
      }
      if (url.includes('/api/v1/admin/high-risk-requests')) {
        return jsonResponse({ items: [highRiskRequest], nextCursor: null })
      }
      return jsonResponse({ items: [] })
    })
    vi.stubGlobal('fetch', vi.fn(withVerifiedMfa(fetchMock)))

    render(<App />)
    const table = await openDecisionPanel()

    fireEvent.click(within(table).getByRole('button', { name: '승인 실행' }))
    const dialog = await screen.findByRole('dialog', { name: '승인 추가 인증' })
    fireEvent.change(within(dialog).getByLabelText('인증 코드'), { target: { value: '123456' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '인증' }))

    expect(await screen.findByText('본인이 요청한 고위험 변경은 승인할 수 없습니다.')).toBeInTheDocument()
    expect(approveCalls).toBe(2)
  })

  it('requires an authenticator app code when the backend rejects a recovery-code MFA session', async () => {
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
            { error: { code: 'ADMIN_MFA_TOTP_REQUIRED', message: '인증 앱 코드가 필요합니다.' } },
            { status: 403 },
          )
        }
        return jsonResponse({ request: { ...highRiskRequest, status: 'executed' } })
      }
      if (url.includes('/api/v1/admin/high-risk-requests')) {
        return jsonResponse({ items: [highRiskRequest], nextCursor: null })
      }
      return jsonResponse({ items: [] })
    })
    vi.stubGlobal('fetch', vi.fn(withVerifiedMfa(fetchMock)))

    render(<App />)
    const table = await openDecisionPanel()

    fireEvent.click(within(table).getByRole('button', { name: '승인 실행' }))
    const dialog = await screen.findByRole('dialog', { name: '승인 추가 인증' })
    expect(within(dialog).getByText('복구 코드로는 승인/거절할 수 없습니다. 인증 앱의 TOTP 코드를 입력하세요.')).toBeInTheDocument()
    expect(within(dialog).queryByLabelText('복구 코드')).not.toBeInTheDocument()
    fireEvent.change(within(dialog).getByLabelText('인증 코드'), { target: { value: '123456' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '인증' }))

    await waitFor(() => expect(approveCalls).toBe(2))
  })

  it('does not treat an MFA status lookup failure as an unenrolled credential', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input)
      if (url.endsWith('/api/v1/admin/security/mfa/status')) {
        return jsonResponse(
          { error: { code: 'MFA_STATUS_UNAVAILABLE', message: 'MFA 상태 조회에 실패했습니다.' } },
          { status: 503 },
        )
      }
      if (url.endsWith('/api/v1/admin/high-risk-requests/high-risk-1/approve') && init?.method === 'POST') {
        return jsonResponse(
          { error: { code: 'ADMIN_MFA_REQUIRED', message: 'MFA 인증이 필요합니다.' } },
          { status: 403 },
        )
      }
      if (url.includes('/api/v1/admin/high-risk-requests')) {
        return jsonResponse({ items: [highRiskRequest], nextCursor: null })
      }
      return jsonResponse({ items: [] })
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)
    const table = await openDecisionPanel()
    fireEvent.click(within(table).getByRole('button', { name: '승인 실행' }))

    const dialog = await screen.findByRole('dialog', { name: '승인 추가 인증' })
    expect(await within(dialog).findByText('MFA 상태 조회에 실패했습니다.')).toBeInTheDocument()
    expect(within(dialog).getByText('MFA 상태를 확인할 수 없습니다. 모달을 닫고 다시 시도하세요.')).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'MFA 등록 시작' })).not.toBeInTheDocument()
  })

  it('shows a pending-count badge on the 권한 승인 tab (loaded eagerly, before opening it)', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = requestUrl(input)
      if (url.includes('/api/v1/admin/high-risk-requests')) {
        return jsonResponse({
          items: [highRiskRequest, { ...highRiskRequest, id: 'high-risk-2' }],
          nextCursor: null,
        })
      }
      return jsonResponse({ items: [] })
    })
    vi.stubGlobal('fetch', vi.fn(withVerifiedMfa(fetchMock)))

    render(<App />)

    const tab = await screen.findByRole('tab', { name: '권한 승인' })
    await waitFor(() => expect(tab).toHaveTextContent('2'))
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes('/api/v1/admin/high-risk-requests?status=pending'),
      ),
    ).toBe(true)
  })

  it('caps the pending badge at 50+ when the server returns a full page', async () => {
    const items = Array.from({ length: 50 }, (_, i) => ({ ...highRiskRequest, id: `high-risk-${i + 1}` }))
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = requestUrl(input)
      if (url.includes('/api/v1/admin/high-risk-requests')) {
        return jsonResponse({ items, nextCursor: null })
      }
      return jsonResponse({ items: [] })
    })
    vi.stubGlobal('fetch', vi.fn(withVerifiedMfa(fetchMock)))

    render(<App />)

    const tab = await screen.findByRole('tab', { name: '권한 승인' })
    await waitFor(() => expect(tab).toHaveTextContent('50+'))
  })
})
