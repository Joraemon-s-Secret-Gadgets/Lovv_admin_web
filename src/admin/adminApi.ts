import type {
  AdminProposalHistoryResponse,
  AdminProposalRequest,
  AdminProposalResponse,
  ProposalHistoryItem,
  ReviewProposal,
} from './types'

export type AdminApiClientOptions = {
  baseUrl?: string
  accessToken?: string
  fetchImpl?: typeof fetch
}

type AdminProposalListResponse = {
  items?: AdminProposalResponse[]
}

type AdminProposalMutationResponse = {
  proposal?: AdminProposalResponse
}

type AdminProposalHistoryListResponse = {
  items?: AdminProposalHistoryResponse[]
}

const defaultApiBaseUrl = import.meta.env.VITE_LOVV_API_BASE_URL?.trim() ?? ''
const defaultDevAccessToken = import.meta.env.VITE_LOVV_ADMIN_ACCESS_TOKEN?.trim() ?? ''

export class AdminApiError extends Error {
  status: number
  code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'AdminApiError'
    this.status = status
    this.code = code
  }
}

export function createAdminApiClient(options: AdminApiClientOptions = {}) {
  const baseUrl = options.baseUrl ?? defaultApiBaseUrl
  const accessToken = options.accessToken ?? defaultDevAccessToken
  const fetchImpl = options.fetchImpl ?? fetch

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers)
    headers.set('Accept', 'application/json')
    if (init.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json')
    }
    if (accessToken) {
      headers.set('Authorization', `Bearer ${accessToken}`)
    }

    const response = await fetchImpl(`${baseUrl}${path}`, {
      ...init,
      credentials: 'include',
      headers,
    })
    const payload = await readJson(response)

    if (!response.ok) {
      const error = payload?.error ?? {}
      throw new AdminApiError(
        response.status,
        typeof error.code === 'string' ? error.code : 'ADMIN_API_ERROR',
        typeof error.message === 'string' ? error.message : 'Admin API request failed.',
      )
    }

    return payload as T
  }

  return {
    async listProposals() {
      const payload = await request<AdminProposalListResponse>('/api/v1/admin/data-proposals')
      return (payload.items ?? []).map(adaptAdminProposal)
    },
    async createProposal(input: AdminProposalRequest) {
      const payload = await request<AdminProposalMutationResponse>('/api/v1/admin/data-proposals', {
        method: 'POST',
        body: JSON.stringify(input),
      })
      return adaptAdminProposal(payload.proposal)
    },
    async reviewProposal(proposalId: string, reviewNote?: string) {
      const payload = await request<AdminProposalMutationResponse>(
        `/api/v1/admin/data-proposals/${encodeURIComponent(proposalId)}/review`,
        {
          method: 'POST',
          body: JSON.stringify({ reviewNote }),
        },
      )
      return adaptAdminProposal(payload.proposal)
    },
    async approveProposal(proposalId: string, reviewNote?: string) {
      const payload = await request<AdminProposalMutationResponse>(
        `/api/v1/admin/data-proposals/${encodeURIComponent(proposalId)}/approve`,
        {
          method: 'POST',
          body: JSON.stringify({ reviewNote }),
        },
      )
      return adaptAdminProposal(payload.proposal)
    },
    async rejectProposal(proposalId: string, reviewNote: string) {
      const payload = await request<AdminProposalMutationResponse>(
        `/api/v1/admin/data-proposals/${encodeURIComponent(proposalId)}/reject`,
        {
          method: 'POST',
          body: JSON.stringify({ reviewNote }),
        },
      )
      return adaptAdminProposal(payload.proposal)
    },
    async listProposalHistory(proposalId: string) {
      const payload = await request<AdminProposalHistoryListResponse>(
        `/api/v1/admin/data-proposals/${encodeURIComponent(proposalId)}/history`,
      )
      return (payload.items ?? []).map(adaptProposalHistory)
    },
  }
}

export function adaptAdminProposal(proposal: AdminProposalResponse | undefined): ReviewProposal {
  return {
    id: proposal?.proposalId ?? '',
    code: proposal?.proposalCode ?? '',
    title: proposal?.title ?? '제목 없음',
    proposerRole: 'R-DATA-PROVIDER',
    region: proposal?.cityName || proposal?.regionId || '미지정',
    regionId: proposal?.regionId ?? '',
    status: proposal?.status ?? 'submitted',
    submittedAt: proposal?.submittedAt ?? proposal?.createdAt ?? '',
    evidence: proposal?.evidenceText ?? proposal?.officialSourceUrl ?? proposal?.description ?? '근거 자료 없음',
    reviewedBy: proposal?.reviewedBy ?? null,
    reviewedAt: proposal?.reviewedAt ?? null,
    reviewNote: proposal?.reviewNote ?? null,
  }
}

export function adaptProposalHistory(item: AdminProposalHistoryResponse): ProposalHistoryItem {
  return {
    historyId: item.historyId ?? '',
    proposalId: item.proposalId ?? '',
    action: item.action ?? 'updated',
    fromStatus: item.fromStatus ?? null,
    toStatus: item.toStatus ?? null,
    actorUserId: item.actorUserId ?? null,
    note: item.note ?? null,
    createdAt: item.createdAt ?? null,
  }
}

async function readJson(response: Response) {
  const text = await response.text()
  if (!text) {
    return {}
  }
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}
