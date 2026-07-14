import { describe, expect, it, vi } from 'vitest'
import {
  adaptAdminProposal,
  adaptAuditLog,
  adaptDestinationMetricsSummary,
  adaptHighRiskRequest,
  createAdminApiClient,
} from './adminApi'

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
      ...init,
    }),
  )
}

describe('adminApi', () => {
  it('uses admin security endpoints for MFA enrollment and verification', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ enrollment: { secret: 'SECRET', provisioningUri: 'otpauth://totp/Lovv' } }))
      .mockResolvedValueOnce(jsonResponse({ mfa: { enrolled: true, credentialStatus: 'active', sessionVerified: true, recoveryCodesRemaining: 8 } }))
    const client = createAdminApiClient({ accessToken: 'access-token', fetchImpl })

    await client.enrollMfa()
    await client.verifyMfa('123456')

    expect(fetchImpl.mock.calls[0][0]).toBe('/api/v1/admin/security/mfa/enroll')
    expect(JSON.parse(String(fetchImpl.mock.calls[1][1].body))).toEqual({ code: '123456' })
    expect((fetchImpl.mock.calls[1][1].headers as Headers).get('Authorization')).toBe('Bearer access-token')
  })

  it('lists admin proposals with bearer authorization and adapter shape', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        items: [
          {
            proposalId: 'proposal-1',
            proposalCode: 'PROP-000001',
            regionId: 'KR-42-150',
            cityName: '강릉',
            title: '강릉 커피축제 공식 정보 갱신',
            evidenceText: '공식 홈페이지 공지',
            status: 'submitted',
            submittedAt: '2026-06-23T09:00:00Z',
          },
        ],
      }),
    )
    const client = createAdminApiClient({
      baseUrl: 'https://api.lovv.example',
      accessToken: 'access-token',
      fetchImpl,
    })

    const proposals = await client.listProposals()

    expect(fetchImpl).toHaveBeenCalledWith('https://api.lovv.example/api/v1/admin/data-proposals', {
      credentials: 'include',
      headers: expect.any(Headers),
    })
    const headers = fetchImpl.mock.calls[0][1].headers as Headers
    expect(headers.get('Authorization')).toBe('Bearer access-token')
    expect(proposals[0]).toMatchObject({
      id: 'proposal-1',
      code: 'PROP-000001',
      region: '강릉',
      title: '강릉 커피축제 공식 정보 갱신',
      status: 'submitted',
    })
  })

  it('creates proposals without sending authority fields', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        proposal: {
          proposalId: 'proposal-1',
          title: '강릉 커피축제 공식 정보 갱신',
          status: 'submitted',
        },
      }),
    )
    const client = createAdminApiClient({ fetchImpl })

    await client.createProposal({
      contentType: 'festival',
      regionId: 'KR-42-150',
      title: '강릉 커피축제 공식 정보 갱신',
      evidenceText: '공식 홈페이지 공지',
    })

    const body = JSON.parse(String(fetchImpl.mock.calls[0][1].body))

    expect(fetchImpl.mock.calls[0][0]).toBe('/api/v1/admin/data-proposals')
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: 'POST' })
    expect(body).toEqual({
      contentType: 'festival',
      regionId: 'KR-42-150',
      title: '강릉 커피축제 공식 정보 갱신',
      evidenceText: '공식 홈페이지 공지',
    })
  })

  it('maps backend API errors into AdminApiError', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: 'ROLE_FORBIDDEN',
            message: 'This role cannot perform the requested operation.',
          },
        },
        { status: 403 },
      ),
    )
    const client = createAdminApiClient({ fetchImpl })

    await expect(client.listProposals()).rejects.toMatchObject({
      name: 'AdminApiError',
      status: 403,
      code: 'ROLE_FORBIDDEN',
      message: 'This role cannot perform the requested operation.',
    })
  })

  it.each([
    [401, { error: { code: 'UNAUTHORIZED', message: 'Authentication is required' } }],
    [403, { message: 'Unauthorized' }],
    [403, { message: 'Forbidden' }],
  ])('refreshes once after a Gateway authentication failure (%s, %j)', async (status, body) => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(await jsonResponse(body, { status }))
      .mockResolvedValueOnce(await jsonResponse({ items: [] }))
    const refreshAccessToken = vi.fn().mockResolvedValue('fresh-token')
    const client = createAdminApiClient({
      accessToken: 'expired-token',
      fetchImpl,
      refreshAccessToken,
    })

    await client.listProposals()

    expect(refreshAccessToken).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect((fetchImpl.mock.calls[0][1].headers as Headers).get('Authorization')).toBe('Bearer expired-token')
    expect((fetchImpl.mock.calls[1][1].headers as Headers).get('Authorization')).toBe('Bearer fresh-token')
  })

  it('preserves a POST method and JSON body when retrying once', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(await jsonResponse({ message: 'Unauthorized' }, { status: 403 }))
      .mockResolvedValueOnce(await jsonResponse({ proposal: { proposalId: 'proposal-1' } }))
    const client = createAdminApiClient({
      accessToken: 'expired-token',
      fetchImpl,
      refreshAccessToken: vi.fn().mockResolvedValue('fresh-token'),
    })

    await client.createProposal({
      contentType: 'festival',
      regionId: 'KR-42-150',
      title: '강릉 축제',
      evidenceText: '공식 공지',
    })

    const firstInit = fetchImpl.mock.calls[0][1] as RequestInit
    const retryInit = fetchImpl.mock.calls[1][1] as RequestInit
    expect(retryInit.method).toBe('POST')
    expect(retryInit.body).toBe(firstInit.body)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('does not retry again when the refreshed request is still unauthorized', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(await jsonResponse({ message: 'Unauthorized' }, { status: 403 }))
      .mockResolvedValueOnce(await jsonResponse({ message: 'Unauthorized' }, { status: 403 }))
    const onSessionExpired = vi.fn()
    const client = createAdminApiClient({
      fetchImpl,
      refreshAccessToken: vi.fn().mockResolvedValue('fresh-token'),
      onSessionExpired,
    })

    await expect(client.listProposals()).rejects.toMatchObject({
      status: 403,
      code: 'GATEWAY_UNAUTHORIZED',
    })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(onSessionExpired).toHaveBeenCalledTimes(1)
  })

  it.each([500, 502, 504])('does not refresh server errors (%s)', async (status) => {
    const refreshAccessToken = vi.fn().mockResolvedValue('fresh-token')
    const client = createAdminApiClient({
      fetchImpl: vi.fn().mockResolvedValue(await jsonResponse({}, { status })),
      refreshAccessToken,
    })

    await expect(client.listProposals()).rejects.toMatchObject({ status })
    expect(refreshAccessToken).not.toHaveBeenCalled()
  })

  it('does not refresh business authorization failures or network errors', async () => {
    const refreshAccessToken = vi.fn().mockResolvedValue('fresh-token')
    const businessClient = createAdminApiClient({
      fetchImpl: vi.fn().mockResolvedValue(await jsonResponse({
        error: { code: 'SUPER_ADMIN_REQUIRED', message: 'Super admin role is required' },
      }, { status: 403 })),
      refreshAccessToken,
    })

    await expect(businessClient.listProposals()).rejects.toMatchObject({
      status: 403,
      code: 'SUPER_ADMIN_REQUIRED',
      message: 'Super admin role is required',
    })
    expect(refreshAccessToken).not.toHaveBeenCalled()

    const networkClient = createAdminApiClient({
      fetchImpl: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
      refreshAccessToken,
    })
    await expect(networkClient.listProposals()).rejects.toThrow('Failed to fetch')
    expect(refreshAccessToken).not.toHaveBeenCalled()
  })

  it('does not treat a non-exact Forbidden payload as a Gateway authentication failure', async () => {
    const refreshAccessToken = vi.fn().mockResolvedValue('fresh-token')
    const client = createAdminApiClient({
      fetchImpl: vi.fn().mockResolvedValue(await jsonResponse({
        message: 'Forbidden',
        reason: 'role policy',
      }, { status: 403 })),
      refreshAccessToken,
    })

    await expect(client.listProposals()).rejects.toMatchObject({
      status: 403,
      code: 'ADMIN_API_ERROR',
    })
    expect(refreshAccessToken).not.toHaveBeenCalled()
  })

  it('surfaces self-review authorization failures without remapping the code', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: 'SELF_REVIEW_FORBIDDEN',
            message: 'The proposal author cannot review this proposal.',
          },
        },
        { status: 403 },
      ),
    )
    const client = createAdminApiClient({ fetchImpl })

    await expect(client.approveProposal('proposal-1', '승인합니다.')).rejects.toMatchObject({
      name: 'AdminApiError',
      status: 403,
      code: 'SELF_REVIEW_FORBIDDEN',
      message: 'The proposal author cannot review this proposal.',
    })
  })

  it('sends review mutations without client-owned authority fields', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        proposal: {
          proposalId: 'proposal-1',
          title: '강릉 커피축제 공식 정보 갱신',
          status: 'in_review',
        },
      }),
    )
    const client = createAdminApiClient({ fetchImpl })

    await client.reviewProposal('proposal-1', '검토를 시작합니다.')

    const body = JSON.parse(String(fetchImpl.mock.calls[0][1].body))
    expect(fetchImpl.mock.calls[0][0]).toBe('/api/v1/admin/data-proposals/proposal-1/review')
    expect(body).toEqual({ reviewNote: '검토를 시작합니다.' })
    expect(body).not.toHaveProperty('reviewedBy')
    expect(body).not.toHaveProperty('roles')
    expect(body).not.toHaveProperty('organizationId')
    expect(body).not.toHaveProperty('regionIds')
  })

  it('lists proposal history records', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        items: [
          {
            historyId: 'history-1',
            proposalId: 'proposal-1',
            action: 'approved',
            fromStatus: 'in_review',
            toStatus: 'approved',
            note: 'approved',
            createdAt: '2026-06-23T09:30:00Z',
          },
        ],
      }),
    )
    const client = createAdminApiClient({ fetchImpl })

    const history = await client.listProposalHistory('proposal-1')

    expect(fetchImpl.mock.calls[0][0]).toBe('/api/v1/admin/data-proposals/proposal-1/history')
    expect(history[0]).toMatchObject({
      historyId: 'history-1',
      action: 'approved',
      fromStatus: 'in_review',
      toStatus: 'approved',
      note: 'approved',
    })
  })

  it('falls back missing proposal fields to safe UI values', () => {
    expect(adaptAdminProposal(undefined)).toMatchObject({
      id: '',
      title: '제목 없음',
      proposerRole: 'R-DATA-PROVIDER',
      region: '미지정',
      status: 'submitted',
      evidence: '근거 자료 없음',
    })
  })
  it('keeps official and partner link metrics separated while exposing a total', () => {
    expect(
      adaptDestinationMetricsSummary({
        monthlyCuratedDestinationId: 'monthly-1',
        cityId: 'gangneung',
        regionId: 'KR-42-150',
        startDate: '2026-10-01',
        endDate: '2026-10-31',
        officialLinkClicks: 7,
        partnerLinkClicks: 3,
      }),
    ).toMatchObject({
      destinationId: 'monthly-1',
      officialLinkClicks: 7,
      partnerLinkClicks: 3,
      linkClicks: 10,
      dateRange: '2026-10-01 ~ 2026-10-31',
    })
  })
  it('preserves optional audit display fields and null fallbacks', () => {
    expect(
      adaptAuditLog({
        id: 'audit-1',
        actorUserId: 'admin-1',
        actorDisplayName: '탈퇴/삭제 사용자',
        actorEmail: null,
        action: 'admin_mfa.verify',
        resourceType: 'admin_mfa',
        resourceId: 'admin-1',
        resourceDisplayName: '관리자 추가 인증',
        result: 'succeeded',
      }),
    ).toMatchObject({
      actorUserId: 'admin-1',
      actorDisplayName: '탈퇴/삭제 사용자',
      actorEmail: null,
      resourceDisplayName: '관리자 추가 인증',
      result: 'succeeded',
    })

    expect(
      adaptAuditLog({
        actorUserId: 'admin-1',
        actorDisplayName: null,
        actorEmail: null,
        resourceType: 'data_proposal',
        resourceId: 'proposal-1',
        resourceDisplayName: null,
      }),
    ).toMatchObject({
      actorDisplayName: null,
      actorEmail: null,
      resourceDisplayName: null,
    })
  })
  it('sends an explicit default page-size limit on list endpoints', async () => {
    // Fresh Response per call (not mockResolvedValue, which reuses one Response
    // and would fail the second read with "Body already read").
    const fetchImpl = vi.fn((...args: [RequestInfo | URL, RequestInit?]) => {
      void args
      return jsonResponse({ items: [] })
    })
    const client = createAdminApiClient({ baseUrl: 'https://api.lovv.example', fetchImpl })

    await client.listMonthlyDestinations()
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://api.lovv.example/api/v1/admin/monthly-destinations?limit=50',
    )

    await client.listAuditLogs({ limit: 10 })
    expect(String(fetchImpl.mock.calls[1][0])).toContain('limit=10')

    await client.listAuditLogs({
      action: 'admin_mfa.verify',
      resourceType: 'admin_mfa',
      result: 'denied',
      actorUserId: 'actor-42',
      limit: 50,
    })
    expect(String(fetchImpl.mock.calls[2][0])).toContain('action=admin_mfa.verify')
    expect(String(fetchImpl.mock.calls[2][0])).toContain('resourceType=admin_mfa')
    expect(String(fetchImpl.mock.calls[2][0])).toContain('result=denied')
    expect(String(fetchImpl.mock.calls[2][0])).toContain('actorUserId=actor-42')
    expect(String(fetchImpl.mock.calls[2][0])).toContain('limit=50')
  })

  it('uses the BE high-risk request contract without MFA codes in decision bodies', async () => {
    const fetchImpl = vi.fn((...args: [RequestInfo | URL, RequestInit?]) => {
      void args
      return jsonResponse({
        request: {
          id: 'high-risk-1',
          operationType: 'role_grant',
          targetUserId: 'target-1',
          payload: { targetUserId: 'target-1', roleCode: 'R-LOCAL-OPERATOR' },
          status: 'pending',
          reason: '운영 권한 부여',
          requestedBy: 'admin-1',
          requestedAt: '2026-06-30T02:00:00Z',
        },
      })
    })
    const client = createAdminApiClient({ accessToken: 'access-token', fetchImpl })

    await client.createHighRiskRequest({
      operationType: 'role_grant',
      targetUserId: 'target-1',
      roleCode: 'R-LOCAL-OPERATOR',
      reason: '운영 권한 부여',
    })
    await client.approveHighRiskRequest('high-risk-1', { decisionReason: '승인' })
    await client.rejectHighRiskRequest('high-risk-1', { decisionReason: '근거 부족' })

    const createCall = fetchImpl.mock.calls[0] as [RequestInfo | URL, RequestInit]
    const approveCall = fetchImpl.mock.calls[1] as [RequestInfo | URL, RequestInit]
    const rejectCall = fetchImpl.mock.calls[2] as [RequestInfo | URL, RequestInit]

    expect(createCall[0]).toBe('/api/v1/admin/high-risk-requests')
    expect(JSON.parse(String(createCall[1].body))).toEqual({
      operationType: 'role_grant',
      targetUserId: 'target-1',
      roleCode: 'R-LOCAL-OPERATOR',
      reason: '운영 권한 부여',
    })
    expect(approveCall[0]).toBe('/api/v1/admin/high-risk-requests/high-risk-1/approve')
    expect(JSON.parse(String(approveCall[1].body))).toEqual({ decisionReason: '승인' })
    expect(JSON.parse(String(approveCall[1].body))).not.toHaveProperty('totpCode')
    expect(rejectCall[0]).toBe('/api/v1/admin/high-risk-requests/high-risk-1/reject')
    expect(JSON.parse(String(rejectCall[1].body))).toEqual({ decisionReason: '근거 부족' })
    expect((rejectCall[1].headers as Headers).get('Authorization')).toBe('Bearer access-token')
  })

  it('lists high-risk requests with BE-supported filters and adapts missing fields', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        items: [
          {
            id: 'high-risk-1',
            operationType: 'bulk_publish',
            payload: { destinationIds: ['monthly-1', 'monthly-2'] },
            status: 'pending',
            reason: '월간 후보 일괄 게시',
          },
        ],
        nextCursor: null,
      }),
    )
    const client = createAdminApiClient({ baseUrl: 'https://api.lovv.example', fetchImpl })

    const items = await client.listHighRiskRequests({ status: 'pending', operationType: 'bulk_publish', limit: 10 })

    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://api.lovv.example/api/v1/admin/high-risk-requests?status=pending&operationType=bulk_publish&limit=10',
    )
    expect(items[0]).toMatchObject({
      id: 'high-risk-1',
      operationType: 'bulk_publish',
      status: 'pending',
      reason: '월간 후보 일괄 게시',
    })
    expect(adaptHighRiskRequest(undefined)).toMatchObject({
      id: '',
      operationType: 'role_grant',
      status: 'pending',
      payload: {},
    })
  })

})
