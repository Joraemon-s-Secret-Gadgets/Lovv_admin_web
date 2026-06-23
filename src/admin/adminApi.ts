// Thin client for the admin data-proposal API. Attaches the bearer token, maps
// backend payloads to UI-friendly shapes, and surfaces API errors as AdminApiError.
// It deliberately never sends ownership/role fields — the server derives those.
import type {
  AdminProposalHistoryResponse,
  AdminProposalRequest,
  AdminProposalResponse,
  MonthlyDestination,
  MonthlyDestinationAction,
  MonthlyDestinationActionRequest,
  MonthlyDestinationPromoteRequest,
  MonthlyDestinationResponse,
  ProposalHistoryItem,
  ReviewProposal,
} from './types'

export type AdminApiClientOptions = {
  baseUrl?: string
  accessToken?: string
  fetchImpl?: typeof fetch
}

// Shape of GET /api/v1/auth/session. The backend is the source of truth for
// authority fields; the console only reads accessToken (to attach as Bearer) and
// the role/scope arrays for display.
export type AdminAuthSessionResponse = {
  accessToken?: string
  user?: {
    userId?: string
    email?: string | null
    displayName?: string | null
    roles?: string[]
    organizationIds?: string[]
    regionIds?: string[]
    authzVersion?: number
  }
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

type MonthlyDestinationListResponse = {
  items?: MonthlyDestinationResponse[]
}

type MonthlyDestinationMutationResponse = {
  destination?: MonthlyDestinationResponse
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
    // Only Accept / Content-Type / Authorization are set here; request bodies
    // carry content fields only, never authority fields.
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
    async listMonthlyDestinations(filters: { month?: string; regionId?: string; status?: string; limit?: number } = {}) {
      const query = new URLSearchParams()
      if (filters.month) query.set('month', filters.month)
      if (filters.regionId) query.set('regionId', filters.regionId)
      if (filters.status) query.set('status', filters.status)
      if (filters.limit) query.set('limit', String(filters.limit))
      const suffix = query.toString() ? `?${query.toString()}` : ''
      const payload = await request<MonthlyDestinationListResponse>(`/api/v1/admin/monthly-destinations${suffix}`)
      return (payload.items ?? []).map(adaptMonthlyDestination)
    },
    // Promote an approved proposal into a monthly candidate. Only content fields
    // are sent; the server copies city/region from the approved proposal.
    async promoteMonthlyDestination(input: MonthlyDestinationPromoteRequest) {
      const payload = await request<MonthlyDestinationMutationResponse>('/api/v1/admin/monthly-destinations', {
        method: 'POST',
        body: JSON.stringify(input),
      })
      return adaptMonthlyDestination(payload.destination)
    },
    // Move a candidate through its publish state machine (schedule/publish/hide/expire/reject).
    async transitionMonthlyDestination(
      destinationId: string,
      action: MonthlyDestinationAction,
      input: MonthlyDestinationActionRequest = {},
    ) {
      const payload = await request<MonthlyDestinationMutationResponse>(
        `/api/v1/admin/monthly-destinations/${encodeURIComponent(destinationId)}/${action}`,
        {
          method: 'POST',
          body: JSON.stringify(input),
        },
      )
      return adaptMonthlyDestination(payload.destination)
    },
  }
}

// Map a backend proposal to the table/decision-panel shape, with safe fallbacks
// so a partial/!ok payload never crashes the UI.
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

export function adaptMonthlyDestination(destination: MonthlyDestinationResponse | undefined): MonthlyDestination {
  return {
    id: destination?.id ?? '',
    cityName: destination?.cityName || destination?.cityId || destination?.regionId || '미지정',
    regionId: destination?.regionId ?? '',
    curationMonth: destination?.curationMonth ?? '',
    themeCodes: destination?.themeCodes ?? [],
    status: destination?.status ?? 'candidate',
    officialSourceUrl: destination?.officialSourceUrl ?? null,
    publishReason: destination?.publishReason ?? null,
    hiddenReason: destination?.hiddenReason ?? null,
    updatedAt: destination?.updatedAt ?? null,
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

// Auth/session client, separate from the data client because session restore and
// logout do not carry a caller-supplied access token: the browser sends its
// session cookie and the backend returns a freshly minted access token.
export function createAdminAuthClient(options: Omit<AdminApiClientOptions, 'accessToken'> = {}) {
  const baseUrl = options.baseUrl ?? defaultApiBaseUrl
  const fetchImpl = options.fetchImpl ?? fetch

  return {
    // Exchange the session cookie for an access token + role/scope claims.
    async restoreSession(): Promise<AdminAuthSessionResponse> {
      const response = await fetchImpl(`${baseUrl}/api/v1/auth/session`, {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      })
      const payload = await readJson(response)

      if (!response.ok) {
        const error = payload?.error ?? {}
        throw new AdminApiError(
          response.status,
          typeof error.code === 'string' ? error.code : 'AUTH_SESSION_ERROR',
          typeof error.message === 'string' ? error.message : 'Admin session could not be restored.',
        )
      }

      return payload as AdminAuthSessionResponse
    },
    // Revoke the server session. The access token is optional so logout works even
    // if the in-memory token was already cleared.
    async logout(accessToken?: string): Promise<void> {
      const headers = new Headers({ Accept: 'application/json' })
      if (accessToken) {
        headers.set('Authorization', `Bearer ${accessToken}`)
      }
      await fetchImpl(`${baseUrl}/api/v1/auth/logout`, {
        method: 'POST',
        credentials: 'include',
        headers,
      })
    },
  }
}
