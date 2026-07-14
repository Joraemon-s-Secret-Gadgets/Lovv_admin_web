// Thin client for the admin data-proposal API. Attaches the bearer token, maps
// backend payloads to UI-friendly shapes, and surfaces API errors as AdminApiError.
// It deliberately never sends ownership/role fields — the server derives those.
import type {
  AdminProposalHistoryResponse,
  AdminNotice,
  AdminMfaEnrollment,
  AdminMfaStatus,
  AdminNoticeAction,
  AdminNoticeRequest,
  AdminNoticeResponse,
  AdminProposalRequest,
  AdminProposalResponse,
  DestinationMetricsSummary,
  DestinationMetricsSummaryResponse,
  HighRiskChangeRequest,
  HighRiskChangeRequestInput,
  HighRiskChangeRequestResponse,
  HighRiskDecisionRequest,
  HighRiskOperationType,
  HighRiskRequestStatus,
  MonthlyDestination,
  MonthlyDestinationAction,
  MonthlyDestinationActionRequest,
  MonthlyDestinationPromoteRequest,
  MonthlyDestinationResponse,
  AuditLogEntry,
  AuditLogResponse,
  ProposalHistoryItem,
  PublishJob,
  PublishJobAction,
  PublishJobActionRequest,
  PublishJobResponse,
  RecommendationPolicy,
  RecommendationPolicyAction,
  RecommendationPolicyRequest,
  RecommendationPolicyResponse,
  ReviewProposal,
} from './types'

export type AdminApiClientOptions = {
  baseUrl?: string
  accessToken?: string
  fetchImpl?: typeof fetch
  refreshAccessToken?: () => Promise<string>
  onSessionExpired?: () => void
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

type AdminMfaStatusResponse = {
  mfa: AdminMfaStatus
}

type AdminMfaEnrollmentResponse = {
  enrollment: AdminMfaEnrollment
}

type AdminMfaConfirmationResponse = {
  recoveryCodes: string[]
  status: AdminMfaStatus
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

type PublishJobListResponse = {
  items?: PublishJobResponse[]
}

type PublishJobMutationResponse = {
  job?: PublishJobResponse
}

type AuditLogListResponse = {
  items?: AuditLogResponse[]
}

type DestinationMetricsSummaryListResponse = {
  items?: DestinationMetricsSummaryResponse[]
}

type HighRiskRequestListResponse = {
  items?: HighRiskChangeRequestResponse[]
  nextCursor?: string | null
}

type HighRiskRequestMutationResponse = {
  request?: HighRiskChangeRequestResponse
}

type AdminNoticeListResponse = {
  items?: AdminNoticeResponse[]
}

type AdminNoticeMutationResponse = {
  notice?: AdminNoticeResponse
}

type RecommendationPolicyListResponse = {
  items?: RecommendationPolicyResponse[]
}

type RecommendationPolicyMutationResponse = {
  policy?: RecommendationPolicyResponse
}

const defaultApiBaseUrl = import.meta.env.VITE_LOVV_API_BASE_URL?.trim() ?? ''
// Default page size for list endpoints. Sent explicitly (not relying on the
// backend default) so the client controls how many rows a tab renders.
const DEFAULT_LIMIT = 50

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
  const accessToken = options.accessToken ?? ''
  const fetchImpl = options.fetchImpl ?? fetch

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const send = async (token: string) => {
      // Rebuild headers for every attempt so a refreshed token replaces the
      // expired Authorization value while preserving the original request.
      const headers = new Headers(init.headers)
      headers.set('Accept', 'application/json')
      if (init.body && !headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/json')
      }
      if (token) {
        headers.set('Authorization', `Bearer ${token}`)
      }

      const response = await fetchImpl(`${baseUrl}${path}`, {
        ...init,
        credentials: 'include',
        headers,
      })
      return { response, payload: await readJson(response) }
    }

    let result = await send(accessToken)
    if (isGatewayAuthenticationFailure(result.response, result.payload) && options.refreshAccessToken) {
      const refreshedToken = await options.refreshAccessToken()
      result = await send(refreshedToken)
      if (isGatewayAuthenticationFailure(result.response, result.payload)) {
        options.onSessionExpired?.()
      }
    }

    if (!result.response.ok) {
      throw toAdminApiError(result.response, result.payload)
    }

    return result.payload as T
  }

  return {
    async getMfaStatus() {
      const payload = await request<AdminMfaStatusResponse>('/api/v1/admin/security/mfa/status')
      return payload.mfa
    },
    async enrollMfa() {
      const payload = await request<AdminMfaEnrollmentResponse>('/api/v1/admin/security/mfa/enroll', {
        method: 'POST',
        body: JSON.stringify({}),
      })
      return payload.enrollment
    },
    async confirmMfa(code: string) {
      return request<AdminMfaConfirmationResponse>('/api/v1/admin/security/mfa/confirm', {
        method: 'POST',
        body: JSON.stringify({ code }),
      })
    },
    async verifyMfa(code: string) {
      const payload = await request<AdminMfaStatusResponse>('/api/v1/admin/security/mfa/verify', {
        method: 'POST',
        body: JSON.stringify({ code }),
      })
      return payload.mfa
    },
    async recoverMfa(recoveryCode: string) {
      const payload = await request<AdminMfaStatusResponse>('/api/v1/admin/security/mfa/recover', {
        method: 'POST',
        body: JSON.stringify({ recoveryCode }),
      })
      return payload.mfa
    },
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
      query.set('limit', String(filters.limit ?? DEFAULT_LIMIT))
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
    // Reflection history for a published destination (the publish jobs trail).
    async listDestinationPublishJobs(destinationId: string, filters: { limit?: number } = {}) {
      const query = new URLSearchParams({ limit: String(filters.limit ?? DEFAULT_LIMIT) })
      const payload = await request<PublishJobListResponse>(
        `/api/v1/admin/monthly-destinations/${encodeURIComponent(destinationId)}/publish-jobs?${query.toString()}`,
      )
      return (payload.items ?? []).map(adaptPublishJob)
    },
    // Drive a reflection job through its status machine (start/succeed/fail/retry/cancel).
    async transitionPublishJob(
      jobId: string,
      action: PublishJobAction,
      input: PublishJobActionRequest = {},
    ) {
      const payload = await request<PublishJobMutationResponse>(
        `/api/v1/admin/publish-jobs/${encodeURIComponent(jobId)}/${action}`,
        {
          method: 'POST',
          body: JSON.stringify(input),
        },
      )
      return adaptPublishJob(payload.job)
    },
    // Aggregate metrics per destination over a date range (B2G-safe daily counters).
    async listDestinationMetricsSummary(filters: { startDate?: string; endDate?: string; regionId?: string; limit?: number } = {}) {
      const query = new URLSearchParams()
      if (filters.startDate) query.set('startDate', filters.startDate)
      if (filters.endDate) query.set('endDate', filters.endDate)
      if (filters.regionId) query.set('regionId', filters.regionId)
      query.set('limit', String(filters.limit ?? DEFAULT_LIMIT))
      const suffix = query.toString() ? `?${query.toString()}` : ''
      const payload = await request<DestinationMetricsSummaryListResponse>(`/api/v1/admin/metrics/destinations${suffix}`)
      return (payload.items ?? []).map(adaptDestinationMetricsSummary)
    },
    // Operator notices CRUD + draft/published/archived transitions (step 16).
    async listNotices(filters: { status?: string; limit?: number } = {}) {
      const query = new URLSearchParams()
      if (filters.status) query.set('status', filters.status)
      query.set('limit', String(filters.limit ?? DEFAULT_LIMIT))
      const suffix = query.toString() ? `?${query.toString()}` : ''
      const payload = await request<AdminNoticeListResponse>(`/api/v1/admin/notices${suffix}`)
      return (payload.items ?? []).map(adaptAdminNotice)
    },
    async createNotice(input: AdminNoticeRequest) {
      const payload = await request<AdminNoticeMutationResponse>('/api/v1/admin/notices', {
        method: 'POST',
        body: JSON.stringify(input),
      })
      return adaptAdminNotice(payload.notice)
    },
    async transitionNotice(noticeId: string, action: AdminNoticeAction) {
      const payload = await request<AdminNoticeMutationResponse>(
        `/api/v1/admin/notices/${encodeURIComponent(noticeId)}/${action}`,
        { method: 'POST', body: JSON.stringify({}) },
      )
      return adaptAdminNotice(payload.notice)
    },
    // Recommendation policies CRUD + draft/active/archived transitions (step 16).
    async listRecommendationPolicies(filters: { status?: string; limit?: number } = {}) {
      const query = new URLSearchParams()
      if (filters.status) query.set('status', filters.status)
      query.set('limit', String(filters.limit ?? DEFAULT_LIMIT))
      const suffix = query.toString() ? `?${query.toString()}` : ''
      const payload = await request<RecommendationPolicyListResponse>(`/api/v1/admin/recommendation-policies${suffix}`)
      return (payload.items ?? []).map(adaptRecommendationPolicy)
    },
    async createRecommendationPolicy(input: RecommendationPolicyRequest) {
      const payload = await request<RecommendationPolicyMutationResponse>('/api/v1/admin/recommendation-policies', {
        method: 'POST',
        body: JSON.stringify(input),
      })
      return adaptRecommendationPolicy(payload.policy)
    },
    async transitionRecommendationPolicy(policyId: string, action: RecommendationPolicyAction) {
      const payload = await request<RecommendationPolicyMutationResponse>(
        `/api/v1/admin/recommendation-policies/${encodeURIComponent(policyId)}/${action}`,
        { method: 'POST', body: JSON.stringify({}) },
      )
      return adaptRecommendationPolicy(payload.policy)
    },
    // Read-only audit trail (admin-only). Filters: action/resourceType/result/actorUserId.
    async listAuditLogs(filters: { action?: string; resourceType?: string; result?: string; actorUserId?: string; limit?: number } = {}) {
      const query = new URLSearchParams()
      if (filters.action) query.set('action', filters.action)
      if (filters.resourceType) query.set('resourceType', filters.resourceType)
      if (filters.result) query.set('result', filters.result)
      if (filters.actorUserId) query.set('actorUserId', filters.actorUserId)
      query.set('limit', String(filters.limit ?? DEFAULT_LIMIT))
      const suffix = query.toString() ? `?${query.toString()}` : ''
      const payload = await request<AuditLogListResponse>(`/api/v1/admin/audit-logs${suffix}`)
      return (payload.items ?? []).map(adaptAuditLog)
    },
    async listHighRiskRequests(filters: { status?: HighRiskRequestStatus; operationType?: HighRiskOperationType; limit?: number } = {}) {
      const query = new URLSearchParams()
      if (filters.status) query.set('status', filters.status)
      if (filters.operationType) query.set('operationType', filters.operationType)
      query.set('limit', String(filters.limit ?? DEFAULT_LIMIT))
      const suffix = query.toString() ? `?${query.toString()}` : ''
      const payload = await request<HighRiskRequestListResponse>(`/api/v1/admin/high-risk-requests${suffix}`)
      return (payload.items ?? []).map(adaptHighRiskRequest)
    },
    async createHighRiskRequest(input: HighRiskChangeRequestInput) {
      const payload = await request<HighRiskRequestMutationResponse>('/api/v1/admin/high-risk-requests', {
        method: 'POST',
        body: JSON.stringify(input),
      })
      return adaptHighRiskRequest(payload.request)
    },
    async approveHighRiskRequest(requestId: string, input: HighRiskDecisionRequest = {}) {
      const payload = await request<HighRiskRequestMutationResponse>(
        `/api/v1/admin/high-risk-requests/${encodeURIComponent(requestId)}/approve`,
        {
          method: 'POST',
          body: JSON.stringify(input),
        },
      )
      return adaptHighRiskRequest(payload.request)
    },
    async rejectHighRiskRequest(requestId: string, input: HighRiskDecisionRequest) {
      const payload = await request<HighRiskRequestMutationResponse>(
        `/api/v1/admin/high-risk-requests/${encodeURIComponent(requestId)}/reject`,
        {
          method: 'POST',
          body: JSON.stringify(input),
        },
      )
      return adaptHighRiskRequest(payload.request)
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
    // Intentional || (not ??): empty strings should also fall through to the next
    // candidate, so a blank cityName uses cityId/regionId before the '미지정' default.
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

export function adaptPublishJob(job: PublishJobResponse | undefined): PublishJob {
  return {
    id: job?.id ?? '',
    destinationId: job?.monthlyCuratedDestinationId ?? '',
    jobType: job?.jobType ?? 'catalog_sync',
    status: job?.status ?? 'queued',
    attemptCount: job?.attemptCount ?? 0,
    lastErrorMessage: job?.lastErrorMessage ?? null,
    updatedAt: job?.updatedAt ?? null,
  }
}

export function adaptDestinationMetricsSummary(item: DestinationMetricsSummaryResponse | undefined): DestinationMetricsSummary {
  const officialClicks = item?.officialLinkClicks ?? 0
  const partnerClicks = item?.partnerLinkClicks ?? 0
  const startDate = item?.startDate ?? ''
  const endDate = item?.endDate ?? ''
  return {
    destinationId: item?.monthlyCuratedDestinationId ?? '',
    cityId: item?.cityId ?? '',
    regionId: item?.regionId ?? '',
    dateRange: startDate && endDate ? `${startDate} ~ ${endDate}` : startDate || endDate || '-',
    destinationImpressions: item?.destinationImpressions ?? 0,
    destinationDetailOpens: item?.destinationDetailOpens ?? 0,
    itineraryGenerated: item?.itineraryGenerated ?? 0,
    itinerarySaved: item?.itinerarySaved ?? 0,
    officialLinkClicks: officialClicks,
    partnerLinkClicks: partnerClicks,
    linkClicks: officialClicks + partnerClicks,
    visitIntentSubmitted: item?.visitIntentSubmitted ?? 0,
    visitConfirmed: item?.visitConfirmed ?? 0,
    distinctUserCount: item?.distinctUserCount ?? 0,
    minGroupSizeMet: Boolean(item?.minGroupSizeMet),
  }
}

export function adaptAdminNotice(item: AdminNoticeResponse | undefined): AdminNotice {
  return {
    id: item?.id ?? '',
    title: item?.title ?? '제목 없음',
    body: item?.body ?? '',
    audience: item?.audience ?? 'all',
    severity: item?.severity ?? 'info',
    status: item?.status ?? 'draft',
    updatedAt: item?.updatedAt ?? null,
  }
}

export function adaptRecommendationPolicy(item: RecommendationPolicyResponse | undefined): RecommendationPolicy {
  return {
    id: item?.id ?? '',
    policyKey: item?.policyKey ?? '',
    title: item?.title ?? '정책명 없음',
    description: item?.description ?? null,
    rules: item?.rules ?? {},
    priority: item?.priority ?? 0,
    status: item?.status ?? 'draft',
    updatedAt: item?.updatedAt ?? null,
  }
}

export function adaptAuditLog(entry: AuditLogResponse | undefined): AuditLogEntry {
  return {
    id: entry?.id ?? '',
    occurredAt: entry?.occurredAt ?? null,
    actorUserId: entry?.actorUserId ?? null,
    actorDisplayName: entry?.actorDisplayName ?? null,
    actorEmail: entry?.actorEmail ?? null,
    rolesSnapshot: entry?.rolesSnapshot ?? [],
    action: entry?.action ?? '',
    resourceType: entry?.resourceType ?? null,
    resourceId: entry?.resourceId ?? null,
    resourceDisplayName: entry?.resourceDisplayName ?? null,
    result: entry?.result ?? 'succeeded',
    reasonCode: entry?.reasonCode ?? null,
    afterSummary: entry?.afterSummary ?? {},
    metadata: entry?.metadata ?? {},
  }
}

export function adaptHighRiskRequest(item: HighRiskChangeRequestResponse | undefined): HighRiskChangeRequest {
  return {
    id: item?.id ?? '',
    operationType: item?.operationType ?? 'role_grant',
    targetUserId: item?.targetUserId ?? null,
    payload: item?.payload ?? {},
    status: item?.status ?? 'pending',
    reason: item?.reason ?? '',
    requestedBy: item?.requestedBy ?? null,
    decidedBy: item?.decidedBy ?? null,
    decisionReason: item?.decisionReason ?? null,
    requestedAt: item?.requestedAt ?? null,
    decidedAt: item?.decidedAt ?? null,
    executedAt: item?.executedAt ?? null,
    executionSummary: item?.executionSummary ?? {},
    updatedAt: item?.updatedAt ?? null,
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

function isGatewayAuthenticationFailure(response: Response, payload: unknown): boolean {
  if (response.status === 401) {
    return true
  }
  if (response.status !== 403 || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return false
  }
  const record = payload as Record<string, unknown>
  return Object.keys(record).length === 1 &&
    (record.message === 'Unauthorized' || record.message === 'Forbidden')
}

function toAdminApiError(response: Response, payload: unknown): AdminApiError {
  const record = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {}
  const error = record.error && typeof record.error === 'object' && !Array.isArray(record.error)
    ? record.error as Record<string, unknown>
    : {}
  const isGatewayUnauthorized = isGatewayAuthenticationFailure(response, payload)
  return new AdminApiError(
    response.status,
    typeof error.code === 'string'
      ? error.code
      : isGatewayUnauthorized
        ? 'GATEWAY_UNAUTHORIZED'
        : 'ADMIN_API_ERROR',
    typeof error.message === 'string'
      ? error.message
      : isGatewayUnauthorized
        ? 'Admin session is unauthorized.'
        : 'Admin API request failed.',
  )
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
        // Backend contract (shared/http.error_response): every error is
        // { "error": { "code", "message" } }, used consistently by the auth
        // handler too. The typeof guards still fail safe if that ever changes.
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
