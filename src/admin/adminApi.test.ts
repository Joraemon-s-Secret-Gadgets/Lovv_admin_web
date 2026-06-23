import { describe, expect, it, vi } from 'vitest'
import { adaptAdminProposal, createAdminApiClient } from './adminApi'

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
})
