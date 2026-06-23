import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'

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

function useSessionRole(role: string) {
  vi.stubEnv('VITE_LOVV_ADMIN_ACCESS_TOKEN', makeToken([role]))
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

describe('Lovv admin console', () => {
  beforeEach(() => {
    useSessionRole('R-ADMIN')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ items: [apiProposal] })))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    window.localStorage.clear()
  })

  it('renders the admin workflow overview with role-based lanes', () => {
    render(<App />)

    expect(screen.getByTestId('lovv-admin-shell')).toHaveAttribute('data-theme', 'lovv')
    expect(screen.getByRole('heading', { name: 'Lovv Admin Console' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: '운영 지표' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: '데이터 제안' })).toBeDisabled()
    expect(screen.getByRole('tab', { name: '제안 검토' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: '반영 상태' })).toBeInTheDocument()
    expect(screen.getByTestId('current-role-badge')).toHaveTextContent('R-ADMIN')

    expect(screen.getByText('R-LOCAL-OPERATOR')).toBeInTheDocument()
    expect(screen.getByText('R-DATA-PROVIDER')).toBeInTheDocument()
    expect(screen.getByText('R-ADMIN')).toBeInTheDocument()
    expect(screen.getByText('제출 제안')).toBeInTheDocument()
    expect(screen.getByText('승인 완료')).toBeInTheDocument()
    expect(screen.getByText('반려/수정 요청')).toBeInTheDocument()
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

  it('creates a data proposal through the admin API without client-owned authority fields', async () => {
    useSessionRole('R-DATA-PROVIDER')
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ items: [] }))
      .mockResolvedValueOnce(jsonResponse({ proposal: apiProposal }, { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: '제안 등록' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    const [, createInit] = fetchMock.mock.calls[1]
    const body = JSON.parse(String(createInit.body))

    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/admin/data-proposals')
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
    expect(within(queue).getByText('강릉 커피축제 공식 정보 갱신')).toBeInTheDocument()
    expect(within(queue).getByText('submitted')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '승인 여부' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '검토 시작' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '승인' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '반려' })).toBeEnabled()
    expect(screen.getByText('제안자에게 사유 표시')).toBeInTheDocument()
  })

  it('sends review action requests to the backend API', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ items: [apiProposal] }))
      .mockResolvedValueOnce(jsonResponse({ proposal: { ...apiProposal, status: 'in_review' } }))
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)
    fireEvent.click(screen.getByRole('tab', { name: '제안 검토' }))
    const queue = await screen.findByRole('table', { name: '데이터 제안 목록' })
    expect(within(queue).getByText('강릉 커피축제 공식 정보 갱신')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '검토 시작' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/admin/data-proposals/proposal-1/review')
    expect(fetchMock.mock.calls[1][1].method).toBe('POST')
  })

  it('loads proposal history through the admin API', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ items: [apiProposal] }))
      .mockResolvedValueOnce(jsonResponse({
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
      }))
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)
    fireEvent.click(screen.getByRole('tab', { name: '제안 검토' }))
    await screen.findByRole('table', { name: '데이터 제안 목록' })
    fireEvent.click(screen.getByRole('button', { name: '이력 조회' }))

    expect(await screen.findByLabelText('제안 변경 이력')).toHaveTextContent('submitted')
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/admin/data-proposals/proposal-1/history')
  })

  it('shows API errors instead of falling back to mock proposal rows', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(
          { error: { code: 'UNAUTHORIZED', message: 'Authentication is required' } },
          { status: 401 },
        ),
      ),
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
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/api/v1/admin/monthly-destinations')) {
        return jsonResponse({ items: [monthly] })
      }
      return jsonResponse({ items: [] })
    })
    vi.stubGlobal('fetch', fetchMock)

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
    const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/monthly-destinations/monthly-1/publish')) {
        return jsonResponse({ destination: { ...candidate, status: 'published' } })
      }
      if (url.includes('/api/v1/admin/monthly-destinations')) {
        return jsonResponse({ items: [candidate] })
      }
      return jsonResponse({ items: [] })
    })
    vi.stubGlobal('fetch', fetchMock)

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
    window.localStorage.clear()
    const adminToken = makeToken(['R-ADMIN'])
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/api/v1/auth/session')) {
        return jsonResponse({ accessToken: adminToken, user: { userId: 'admin-1', roles: ['R-ADMIN'] } })
      }
      return jsonResponse({ items: [] })
    })
    vi.stubGlobal('fetch', fetchMock)

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
    vi.stubGlobal('fetch', fetchMock)

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

})
