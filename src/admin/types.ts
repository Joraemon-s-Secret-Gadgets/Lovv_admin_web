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
