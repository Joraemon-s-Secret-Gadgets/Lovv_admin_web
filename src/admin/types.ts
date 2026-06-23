// Shared types for the admin console: UI enums (tab/role/status), the API
// request/response contracts, and the adapted view models used by components.
export type AdminTab = 'metrics' | 'proposal' | 'review' | 'publish'

export type AdminRole = 'R-LOCAL-OPERATOR' | 'R-DATA-PROVIDER' | 'R-ADMIN'

export type RoleTabPermissions = Record<AdminRole, readonly AdminTab[]>

export type ProposalStatus =
  | 'draft'
  | 'submitted'
  | 'in_review'
  | 'approved'
  | 'rejected'
  | 'change_requested'
  | 'withdrawn'
  | 'archived'
  | 'pending'
  | 'published'
  | 'indexed'

export type SummaryMetric = {
  label: string
  value: string
  detail: string
  tone: 'blue' | 'green' | 'purple' | 'amber' | 'red'
}

export type RoleLane = {
  role: AdminRole
  title: string
  description: string
  responsibilities: string[]
}

export type LocalMetric = {
  label: string
  value: string
  trend: string
}

export type ProposalDraft = {
  type: 'tour' | 'festival' | 'activity'
  title: string
  region: string
  evidence: string
  summary: string
}

export type ReviewProposal = {
  id: string
  code?: string
  title: string
  proposerRole: AdminRole
  region: string
  regionId?: string
  status: ProposalStatus
  submittedAt: string
  evidence: string
  reviewedBy?: string | null
  reviewedAt?: string | null
  reviewNote?: string | null
}

export type ProposalHistoryItem = {
  historyId: string
  proposalId: string
  action: string
  fromStatus?: string | null
  toStatus?: string | null
  actorUserId?: string | null
  note?: string | null
  createdAt?: string | null
}

export type AdminProposalResponse = {
  proposalId?: string
  proposalCode?: string
  contentType?: string
  regionId?: string
  cityId?: string | null
  cityName?: string | null
  title?: string
  description?: string | null
  officialSourceName?: string | null
  officialSourceUrl?: string | null
  sourceUpdatedAt?: string | null
  status?: ProposalStatus
  createdBy?: string
  organizationId?: string | null
  submittedAt?: string | null
  reviewedBy?: string | null
  reviewedAt?: string | null
  reviewNote?: string | null
  evidenceText?: string | null
  createdAt?: string | null
  updatedAt?: string | null
}

export type AdminProposalRequest = {
  contentType: 'attraction' | 'festival' | 'experience' | 'transport' | 'monthly_destination'
  regionId: string
  cityName?: string
  title: string
  description?: string
  officialSourceUrl?: string
  evidenceText?: string
  payload?: Record<string, unknown>
}

export type AdminProposalHistoryResponse = {
  historyId?: string
  proposalId?: string
  action?: string
  fromStatus?: string | null
  toStatus?: string | null
  actorUserId?: string | null
  note?: string | null
  createdAt?: string | null
}

export type PublishEvent = {
  key: string
  title: string
  status: ProposalStatus
  description: string
  timestamp: string
}

// Monthly curated destination (step 11). Its own status enum, kept separate from
// ProposalStatus because the publish state machine is distinct from review.
export type MonthlyDestinationStatus =
  | 'candidate'
  | 'scheduled'
  | 'published'
  | 'hidden'
  | 'expired'
  | 'rejected'

export type MonthlyDestinationAction = 'schedule' | 'publish' | 'hide' | 'expire' | 'reject'

export type MonthlyDestinationResponse = {
  id?: string
  cityId?: string | null
  cityName?: string | null
  regionId?: string
  sourceProposalId?: string | null
  curationMonth?: string
  themeCodes?: string[]
  officialSourceName?: string | null
  officialSourceUrl?: string | null
  sourceUpdatedAt?: string | null
  validFrom?: string | null
  validUntil?: string | null
  status?: MonthlyDestinationStatus
  publishReason?: string | null
  publishedBy?: string | null
  publishedAt?: string | null
  hiddenBy?: string | null
  hiddenAt?: string | null
  hiddenReason?: string | null
  createdAt?: string | null
  updatedAt?: string | null
}

// Adapted view model used by the publish panel.
export type MonthlyDestination = {
  id: string
  cityName: string
  regionId: string
  curationMonth: string
  themeCodes: string[]
  status: MonthlyDestinationStatus
  officialSourceUrl?: string | null
  publishReason?: string | null
  hiddenReason?: string | null
  updatedAt?: string | null
}

export type MonthlyDestinationPromoteRequest = {
  sourceProposalId: string
  curationMonth: string
  themeCodes: string[]
  cityName?: string
  regionId?: string
}

export type MonthlyDestinationActionRequest = {
  reason?: string
  validFrom?: string
  validUntil?: string
}

// Publish (reflection) job (step 12). A publish fans out into one job per
// downstream surface; each runs through its own status machine.
export type PublishJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'
export type PublishJobType =
  | 'catalog_sync'
  | 'rag_index_sync'
  | 'search_cache_sync'
  | 'recommendation_cache_sync'
export type PublishJobAction = 'start' | 'succeed' | 'fail' | 'retry' | 'cancel'

export type PublishJobResponse = {
  id?: string
  monthlyCuratedDestinationId?: string | null
  jobType?: PublishJobType
  status?: PublishJobStatus
  attemptCount?: number
  lastErrorCode?: string | null
  lastErrorMessage?: string | null
  requestedBy?: string | null
  startedAt?: string | null
  finishedAt?: string | null
  createdAt?: string | null
  updatedAt?: string | null
}

export type PublishJob = {
  id: string
  destinationId: string
  jobType: PublishJobType
  status: PublishJobStatus
  attemptCount: number
  lastErrorMessage?: string | null
  updatedAt?: string | null
}

export type PublishJobActionRequest = {
  errorCode?: string
  errorMessage?: string
}

// Basic destination metrics (step 13). These are aggregated daily/server-side
// counters; the UI never receives raw user-level events.
export type DestinationMetricsSummaryResponse = {
  monthlyCuratedDestinationId?: string
  cityId?: string | null
  regionId?: string | null
  startDate?: string | null
  endDate?: string | null
  destinationImpressions?: number
  destinationDetailOpens?: number
  itineraryGenerated?: number
  transportDetailOpens?: number
  itinerarySaved?: number
  itinerarySharedOrExported?: number
  officialLinkClicks?: number
  partnerLinkClicks?: number
  visitIntentSubmitted?: number
  visitConfirmed?: number
  distinctUserCount?: number
  minGroupSizeMet?: boolean
}

export type DestinationMetricsSummary = {
  destinationId: string
  cityId: string
  regionId: string
  dateRange: string
  destinationImpressions: number
  destinationDetailOpens: number
  itineraryGenerated: number
  itinerarySaved: number
  linkClicks: number
  visitIntentSubmitted: number
  visitConfirmed: number
  distinctUserCount: number
  minGroupSizeMet: boolean
}
