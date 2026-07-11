// Admin console shell. Session roles are derived from the access token (see
// ./session), and their union gates which tabs/actions are shown. All proposal
// data flows through ./adminApi; the backend re-authorizes every call, so this
// gating is UX, not a security boundary.
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { AdminApiError, createAdminApiClient, createAdminAuthClient } from './adminApi'
import {
  localMetrics,
  proposalDraft,
  roleLanes,
  sampleDestinationMetrics,
  sampleProposals,
  summaryMetrics,
} from './adminData'
import { getDevAccessToken, getSessionRoles, getStoredAccessToken, resolvePrimaryRole, storeAccessToken } from './session'
import type {
  AdminNotice,
  AdminMfaEnrollment,
  AdminMfaStatus,
  AdminNoticeAction,
  AdminNoticeRequest,
  AdminProposalRequest,
  AdminRole,
  AdminTab,
  AuditLogEntry,
  AuditLogResult,
  DestinationMetricsSummary,
  HighRiskChangeRequest,
  HighRiskChangeRequestInput,
  HighRiskOperationType,
  MonthlyDestination,
  MonthlyDestinationAction,
  MonthlyDestinationStatus,
  ProposalHistoryItem,
  ProposalStatus,
  PublishJob,
  PublishJobAction,
  PublishJobStatus,
  PublishJobType,
  RecommendationPolicy,
  RecommendationPolicyAction,
  RecommendationPolicyRequest,
  ReviewProposal,
  RoleTabPermissions,
  SummaryMetric,
} from './types'

const tabs: { id: AdminTab; label: string }[] = [
  { id: 'metrics', label: '운영 지표' },
  { id: 'proposal', label: '데이터 제안' },
  { id: 'review', label: '제안 검토' },
  { id: 'publish', label: '반영 상태' },
  { id: 'operations', label: '공지·정책' },
  { id: 'highRisk', label: '권한 승인' },
  { id: 'audit', label: '감사 로그' },
]

// Which tabs each role may open. Mirrors the backend role matrix; the server is
// still the enforcer (a hidden tab's API would 403 anyway).
const roleTabPermissions: RoleTabPermissions = {
  'R-LOCAL-OPERATOR': ['metrics'],
  'R-DATA-PROVIDER': ['proposal'],
  'R-ADMIN': ['metrics', 'review', 'publish', 'operations', 'highRisk', 'audit'],
  'R-SUPER-ADMIN': ['highRisk'],
}

const roleDefaultTab: Record<AdminRole, AdminTab> = {
  'R-LOCAL-OPERATOR': 'metrics',
  'R-DATA-PROVIDER': 'proposal',
  'R-ADMIN': 'metrics',
  'R-SUPER-ADMIN': 'highRisk',
}

const toneLabelClassNames: Record<SummaryMetric['tone'], string> = {
  blue: 'tone-blue',
  green: 'tone-green',
  purple: 'tone-purple',
  amber: 'tone-amber',
  red: 'tone-red',
}

const highContrastStatusText = new Set<ProposalStatus>(['approved', 'published', 'indexed', 'rejected'])

function getStatusContrast(status: ProposalStatus) {
  return highContrastStatusText.has(status) ? 'on-dark' : undefined
}

function hasRole(roles: readonly AdminRole[], role: AdminRole) {
  return roles.includes(role)
}

function getMetricsDashboardLabel(roles: readonly AdminRole[]) {
  return hasRole(roles, 'R-ADMIN') ? '지역별/전체 운영 지표' : '담당 지역 운영 지표'
}

function isTabAllowed(roles: readonly AdminRole[], tabId: AdminTab) {
  return roles.some((role) => roleTabPermissions[role].includes(tabId))
}

function getTabLockReason(roles: readonly AdminRole[], tabLabel: string) {
  const roleLabel = roles.length > 0 ? roles.join(', ') : '권한 없음'
  return `역할 접근 제한: ${roleLabel} 역할은 ${tabLabel} 작업 영역을 사용할 수 없습니다.`
}

const samplePreviewRoles: AdminRole[] = [
  'R-SUPER-ADMIN',
  'R-ADMIN',
  'R-DATA-PROVIDER',
  'R-LOCAL-OPERATOR',
]

// Map each summary card to a live count derived from the proposal list.
// Counts are computed from the same API data the review queue uses.
function SummaryCards({ proposals, isLoading }: { proposals: ReviewProposal[]; isLoading: boolean }) {
  const counts = useMemo(() => {
    const countByStatus = (statuses: ProposalStatus[]) =>
      proposals.filter((proposal) => statuses.includes(proposal.status)).length

    return {
      '제출 제안': proposals.length,
      '승인 완료': countByStatus(['approved']),
      '반려/수정 요청': countByStatus(['rejected', 'change_requested']),
      '반영 상태': countByStatus(['published', 'indexed']),
    } as Record<string, number>
  }, [proposals])

  return (
    <section className="summary-grid" aria-label="관리자 처리 현황">
      {summaryMetrics.map((metric) => {
        const count = counts[metric.label]
        const display = isLoading ? '—' : count !== undefined ? String(count) : metric.value
        return (
          <article className={`summary-card ${toneLabelClassNames[metric.tone]}`} key={metric.label}>
            <span>{metric.label}</span>
            <strong>{display}</strong>
            <p>{metric.detail}</p>
          </article>
        )
      })}
    </section>
  )
}

// Orange value ramp (dark → light) for inline SVG charts; brightness separates segments.
const INSIGHT_SHADES = ['#7a3100', '#a8460c', '#d65f12', '#ff7017', '#ff9a52', '#ffc394']

type ChartDatum = { label: string; value: number }

// Donut chart of proposal status distribution (no chart library; inline SVG).
function StatusDonut({ data, total }: { data: ChartDatum[]; total: number }) {
  const radius = 52
  const circumference = 2 * Math.PI * radius
  const segments = data.map((datum, index) => {
    const fraction = total > 0 ? datum.value / total : 0
    const previousFraction =
      total > 0 ? data.slice(0, index).reduce((sum, item) => sum + item.value / total, 0) : 0
    const dash = fraction * circumference
    const rotation = previousFraction * 360 - 90
    return {
      ...datum,
      color: INSIGHT_SHADES[index % INSIGHT_SHADES.length],
      dash,
      gap: circumference - dash,
      rotation,
    }
  })

  return (
    <div className="donut-wrap">
      <svg className="donut" viewBox="0 0 140 140" role="img" aria-label="제안 상태 분포 도넛 차트">
        <circle cx="70" cy="70" r={radius} fill="none" stroke="#eceef2" strokeWidth="16" />
        {segments.map((segment) => (
          <circle
            key={segment.label}
            cx="70"
            cy="70"
            r={radius}
            fill="none"
            stroke={segment.color}
            strokeWidth="16"
            strokeDasharray={`${segment.dash} ${segment.gap}`}
            transform={`rotate(${segment.rotation} 70 70)`}
          />
        ))}
        <text x="70" y="68" textAnchor="middle" className="donut-total">
          {total}
        </text>
        <text x="70" y="86" textAnchor="middle" className="donut-total-label">
          전체
        </text>
      </svg>
      <ul className="donut-legend">
        {segments.map((segment) => (
          <li key={segment.label}>
            <span className="swatch" style={{ background: segment.color }} aria-hidden="true" />
            <span className="legend-label">{segment.label}</span>
            <span className="legend-value">{segment.value}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

// Pipeline funnel: how many proposals reach each stage, drawn as inline SVG bars.
function StatusFunnel({ stages, total }: { stages: ChartDatum[]; total: number }) {
  return (
    <ul className="funnel">
      {stages.map((stage) => {
        const pct = total > 0 ? Math.round((stage.value / total) * 100) : 0
        const width = total > 0 ? (stage.value / total) * 100 : 0
        return (
          <li key={stage.label} className="funnel-row">
            <div className="funnel-meta">
              <span className="funnel-label">{stage.label}</span>
              <span className="funnel-value">
                {stage.value} · {pct}%
              </span>
            </div>
            <svg className="funnel-bar" viewBox="0 0 100 12" preserveAspectRatio="none" aria-hidden="true">
              <rect x="0" y="0" width="100" height="12" rx="2.5" fill="#eceef2" />
              <rect x="0" y="0" width={width} height="12" rx="2.5" fill="#ff7017" />
            </svg>
          </li>
        )
      })}
    </ul>
  )
}

// Live visualizations derived from the same proposal list the review queue uses.
function ProposalInsights({ proposals, isLoading }: { proposals: ReviewProposal[]; isLoading: boolean }) {
  const { total, distribution, funnel } = useMemo(() => {
    const countByStatus = (statuses: ProposalStatus[]) =>
      proposals.filter((proposal) => statuses.includes(proposal.status)).length

    const distribution: ChartDatum[] = [
      { label: '대기·제출', value: countByStatus(['pending', 'submitted']) },
      { label: '검토중', value: countByStatus(['in_review']) },
      { label: '승인', value: countByStatus(['approved']) },
      { label: '반려·수정', value: countByStatus(['rejected', 'change_requested']) },
      { label: '반영', value: countByStatus(['published', 'indexed']) },
      { label: '보관·철회', value: countByStatus(['withdrawn', 'archived', 'draft']) },
    ].filter((datum) => datum.value > 0)

    const funnel: ChartDatum[] = [
      { label: '전체 제안', value: proposals.length },
      {
        label: '검토 진입',
        value: countByStatus(['in_review', 'approved', 'rejected', 'change_requested', 'published', 'indexed']),
      },
      { label: '승인', value: countByStatus(['approved', 'published', 'indexed']) },
      { label: '반영', value: countByStatus(['published', 'indexed']) },
    ]

    return { total: proposals.length, distribution, funnel }
  }, [proposals])

  return (
    <section className="insights-grid" aria-label="제안 데이터 시각화">
      <article className="insight-card">
        <h3>제안 상태 분포</h3>
        {isLoading ? (
          <p className="empty-state">불러오는 중…</p>
        ) : total === 0 ? (
          <p className="empty-state">시각화할 제안이 없습니다.</p>
        ) : (
          <StatusDonut data={distribution} total={total} />
        )}
      </article>
      <article className="insight-card">
        <h3>진행 단계</h3>
        {isLoading ? (
          <p className="empty-state">불러오는 중…</p>
        ) : total === 0 ? (
          <p className="empty-state">시각화할 제안이 없습니다.</p>
        ) : (
          <StatusFunnel stages={funnel} total={total} />
        )}
      </article>
    </section>
  )
}

function RoleStatusPanel({ sessionRoles }: { sessionRoles: readonly AdminRole[] }) {
  const [isExpanded, setIsExpanded] = useState(false)
  const roleLanesId = 'role-status-lanes'

  return (
    <section className="panel role-status-panel" aria-labelledby="role-status-title">
      <div className="collapsible-summary">
        <span className="collapsible-heading">
          <span className="section-kicker">Role Gate</span>
          <h2 id="role-status-title">역할 확인</h2>
        </span>
        <button
          aria-controls={roleLanesId}
          aria-expanded={isExpanded}
          className="collapsible-toggle"
          onClick={() => setIsExpanded((expanded) => !expanded)}
          type="button"
        >
          {isExpanded ? '역할 상세 접기' : '역할 상세 보기'}
          <span className="collapsible-chevron" aria-hidden="true" />
        </button>
      </div>
      {isExpanded && (
        <div className="role-lanes" id={roleLanesId}>
          {roleLanes.map((lane) => {
            const owned = sessionRoles.includes(lane.role)

            return (
              <article
                aria-label={`${lane.role} 역할 ${owned ? '보유 중' : '미보유'}`}
                className={owned ? 'role-lane role-lane-owned' : 'role-lane'}
                data-owned={owned ? 'true' : 'false'}
                data-testid={`role-lane-${lane.role}`}
                key={lane.role}
              >
                <div className="role-lane-header">
                  <span className="role-badge">{lane.role}</span>
                  {owned && <span className="role-owned-badge">보유 중</span>}
                </div>
                <strong className="role-lane-title">{lane.title}</strong>
                <p>{lane.description}</p>
                <ul>
                  {lane.responsibilities.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}

function formatDashboardNumber(value: number) {
  return new Intl.NumberFormat('ko-KR').format(value)
}

function formatDashboardRate(part: number, total: number) {
  if (total <= 0) {
    return '0%'
  }
  return `${Math.round((part / total) * 100)}%`
}

// Sum one numeric field across every metrics row.
function sumMetric(items: DestinationMetricsSummary[], pick: (item: DestinationMetricsSummary) => number) {
  return items.reduce((total, item) => total + pick(item), 0)
}

// Roll up the per-destination metric rows into the local-operator dashboard
// totals. Official and partner link clicks are kept separate (step 14) and also
// summed; sampleReadyCount counts only rows that met the k-anonymity threshold.
function buildLocalOperatorDashboard(items: DestinationMetricsSummary[]) {
  const destinationCount = items.length
  const totalImpressions = sumMetric(items, (item) => item.destinationImpressions)
  const totalDetailOpens = sumMetric(items, (item) => item.destinationDetailOpens)
  const totalItineraryGenerated = sumMetric(items, (item) => item.itineraryGenerated)
  const totalSaved = sumMetric(items, (item) => item.itinerarySaved)
  const totalOfficialLinkClicks = sumMetric(items, (item) => item.officialLinkClicks)
  const totalPartnerLinkClicks = sumMetric(items, (item) => item.partnerLinkClicks)
  const totalLinkClicks = totalOfficialLinkClicks + totalPartnerLinkClicks
  const totalVisitIntent = sumMetric(items, (item) => item.visitIntentSubmitted)
  const totalVisitConfirmed = sumMetric(items, (item) => item.visitConfirmed)
  const sampleReadyCount = items.filter((item) => item.minGroupSizeMet).length
  const topDestination = [...items].sort((a, b) => b.destinationImpressions - a.destinationImpressions)[0]

  return {
    destinationCount,
    totalImpressions,
    totalDetailOpens,
    totalItineraryGenerated,
    totalSaved,
    totalOfficialLinkClicks,
    totalPartnerLinkClicks,
    totalLinkClicks,
    totalVisitIntent,
    totalVisitConfirmed,
    sampleReadyCount,
    topDestination,
  }
}

// Region-scoped metrics dashboard for local operators: KPI totals plus the
// official/partner link split and a top-destination highlight.
function LocalOperatorMetrics({
  items,
  isLoading,
  errorMessage,
  metricsLabel,
  onRefresh,
}: {
  items: DestinationMetricsSummary[]
  isLoading: boolean
  errorMessage: string | null
  metricsLabel: string
  onRefresh: () => void
}) {
  const dashboard = buildLocalOperatorDashboard(items)

  return (
    <section className="panel" aria-labelledby="local-metrics-title">
      <div className="section-heading">
        <span className="section-kicker">Local Metrics</span>
        <h2 id="local-metrics-title">{metricsLabel}</h2>
      </div>
      <div className="api-status-row">
        {isLoading && <span role="status">지표를 불러오는 중입니다.</span>}
        {errorMessage && <span role="alert">{errorMessage}</span>}
        <button type="button" onClick={onRefresh} disabled={isLoading}>
          새로고침
        </button>
      </div>
      {items.length > 0 ? (
        <>
          <section className="local-dashboard-grid" aria-label="지역 운영자 집계 대시보드">
            <article className="local-dashboard-card">
              <span>총 노출</span>
              <strong>{formatDashboardNumber(dashboard.totalImpressions)}</strong>
              <p>
                {dashboard.destinationCount}개 후보 · 상위{' '}
                {dashboard.topDestination?.regionId || dashboard.topDestination?.cityId || '-'}
              </p>
            </article>
            <article className="local-dashboard-card">
              <span>관심 행동</span>
              <strong>{formatDashboardNumber(dashboard.totalItineraryGenerated)}</strong>
              <p>
                상세 {formatDashboardNumber(dashboard.totalDetailOpens)} · 저장{' '}
                {formatDashboardNumber(dashboard.totalSaved)}
              </p>
            </article>
            <article className="local-dashboard-card">
              <span>저장 전환율</span>
              <strong>{formatDashboardRate(dashboard.totalSaved, dashboard.totalDetailOpens)}</strong>
              <p>상세 열람 대비 저장 행동 기준</p>
            </article>
            <article className="local-dashboard-card">
              <span>링크 클릭</span>
              <strong>{formatDashboardNumber(dashboard.totalLinkClicks)}</strong>
              <p>
                공식 {formatDashboardNumber(dashboard.totalOfficialLinkClicks)} / 제휴{' '}
                {formatDashboardNumber(dashboard.totalPartnerLinkClicks)}
              </p>
            </article>
            <article className="local-dashboard-card">
              <span>방문 의향</span>
              <strong>{formatDashboardNumber(dashboard.totalVisitIntent)}</strong>
              <p>확정 {formatDashboardNumber(dashboard.totalVisitConfirmed)}건</p>
            </article>
            <article className="local-dashboard-card">
              <span>표본 충족</span>
              <strong>
                {dashboard.sampleReadyCount}/{dashboard.destinationCount}
              </strong>
              <p>최소 집계 기준을 충족한 후보</p>
            </article>
          </section>
          <div className="metric-viz">
            <h3>지역별 노출 비중</h3>
            <StatusFunnel
              stages={[...items]
                .sort((a, b) => b.destinationImpressions - a.destinationImpressions)
                .slice(0, 6)
                .map((item) => ({
                  label: item.regionId || item.cityId || '-',
                  value: item.destinationImpressions,
                }))}
              total={dashboard.totalImpressions}
            />
          </div>
          <div className="metric-table" role="table" aria-label={metricsLabel}>
            <div role="row" className="metric-row metric-row-head metric-row-wide">
              <span role="columnheader">지역/도시</span>
              <span role="columnheader">노출</span>
              <span role="columnheader">상세</span>
              <span role="columnheader">일정</span>
              <span role="columnheader">저장</span>
              <span role="columnheader">공식 링크</span>
              <span role="columnheader">제휴 링크</span>
              <span role="columnheader">링크 합계</span>
              <span role="columnheader">표본</span>
            </div>
            {items.map((metric) => (
              <div
                role="row"
                className="metric-row metric-row-wide"
                key={metric.destinationId || `${metric.regionId}-${metric.cityId}`}
              >
                <span role="cell">{metric.regionId || metric.cityId || '-'}</span>
                <strong role="cell">{metric.destinationImpressions}</strong>
                <span role="cell">{metric.destinationDetailOpens}</span>
                <span role="cell">{metric.itineraryGenerated}</span>
                <span role="cell">{metric.itinerarySaved}</span>
                <span role="cell">{metric.officialLinkClicks}</span>
                <span role="cell">{metric.partnerLinkClicks}</span>
                <span role="cell">{metric.linkClicks}</span>
                <span role="cell">{metric.minGroupSizeMet ? `${metric.distinctUserCount}명` : '표본 부족'}</span>
              </div>
            ))}
          </div>
        </>
      ) : (
        <div className="metric-table" role="table" aria-label={metricsLabel}>
          <div role="row" className="metric-row metric-row-head">
            <span role="columnheader">지표</span>
            <span role="columnheader">현재 값</span>
            <span role="columnheader">변화</span>
          </div>
          {localMetrics.map((metric) => (
            <div role="row" className="metric-row" key={metric.label}>
              <span role="cell">{metric.label}</span>
              <strong role="cell">{metric.value}</strong>
              <span role="cell" className={metric.trend.startsWith('-') ? 'trend-down' : 'trend-up'}>
                {metric.trend}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

function NoSessionRolePanel() {
  return (
    <section className="panel" aria-labelledby="no-role-title">
      <div className="section-heading">
        <span className="section-kicker">Role Gate</span>
        <h2 id="no-role-title">유효한 세션 역할이 없습니다</h2>
      </div>
      <p>
        액세스 토큰에서 관리자 역할을 확인하지 못했습니다. 로그인 세션 또는 개발용
        <code> VITE_LOVV_ADMIN_ACCESS_TOKEN </code>
        값을 확인해 주세요. 권한 판단은 백엔드에서 다시 검증됩니다.
      </p>
    </section>
  )
}

const auditResultLabels: Record<AuditLogEntry['result'], string> = {
  allowed: '허용',
  denied: '거부',
  succeeded: '성공',
  failed: '실패',
}

type AuditLogFilters = {
  action: string
  resourceType: string
  result: '' | AuditLogResult
  actorUserId: string
  limit: 20 | 50
}

type AuditLogRequestFilters = {
  action?: string
  resourceType?: string
  result?: AuditLogResult
  actorUserId?: string
  limit: number
}

const defaultAuditLogFilters: AuditLogFilters = {
  action: '',
  resourceType: '',
  result: '',
  actorUserId: '',
  limit: 50,
}

const auditResultFilterOptions: { value: AuditLogFilters['result']; label: string }[] = [
  { value: '', label: '전체' },
  { value: 'succeeded', label: '성공' },
  { value: 'allowed', label: '허용' },
  { value: 'denied', label: '거부' },
  { value: 'failed', label: '실패' },
]

const auditActionLabels: Record<string, string> = {
  'admin_mfa.enroll': '추가 인증 등록',
  'admin_mfa.confirm': '추가 인증 등록 확인',
  'admin_mfa.verify': '추가 인증 검증',
  'admin_mfa.recover': '추가 인증 복구',
  'admin_mfa.recovery_enroll': '복구 코드 등록',
  'high_risk_request.create': '고위험 요청 생성',
  'high_risk_request.approve': '고위험 요청 승인',
  'high_risk_request.reject': '고위험 요청 거절',
  'role_grant.execute': '역할 부여 실행',
  'role_revoke.execute': '역할 회수 실행',
  'region_grant.execute': '지역 권한 부여 실행',
  'region_revoke.execute': '지역 권한 회수 실행',
  'data_proposal.approve': '데이터 제안 승인',
  'data_proposal.reject': '데이터 제안 거절',
  'data_proposal.request_changes': '데이터 제안 수정 요청',
  'monthly_destination.publish': '월간 후보 게시',
  'notice.publish': '공지 게시',
  'recommendation_policy.update': '추천 정책 수정',
}

const auditResourceLabels: Record<string, string> = {
  admin_mfa: '관리자 추가 인증',
  high_risk_request: '고위험 요청',
  data_proposal: '데이터 제안',
  monthly_destination: '월간 여행지 후보',
  notice: '공지',
  recommendation_policy: '추천 정책',
  role_grant: '역할 부여',
  role_revoke: '역할 회수',
  region_grant: '지역 권한 부여',
  region_revoke: '지역 권한 회수',
}

const auditActionFilterOptions = Object.entries(auditActionLabels).map(([value, label]) => ({ value, label }))
const auditResourceFilterOptions = Object.entries(auditResourceLabels).map(([value, label]) => ({ value, label }))
const auditLimitOptions: AuditLogFilters['limit'][] = [20, 50]

const auditDetailKeyLabels: Record<string, string> = {
  status: '상태',
  targetUserId: '대상 사용자',
  roleCode: '역할',
  requestId: '요청 ID',
  risk: '위험도',
  operationType: '작업 유형',
  targetRegionId: '대상 지역',
  targetDestinationId: '대상 여행지',
  reason: '사유',
  requestedBy: '요청자',
  approvedBy: '승인자',
  rejectedBy: '거절자',
}

function getAuditDetailKeyLabel(key: string) {
  return auditDetailKeyLabels[key] ?? key
}

function toAuditRequestFilters(filters: AuditLogFilters): AuditLogRequestFilters {
  const actorUserId = filters.actorUserId.trim()

  return {
    ...(filters.action ? { action: filters.action } : {}),
    ...(filters.resourceType ? { resourceType: filters.resourceType } : {}),
    ...(filters.result ? { result: filters.result } : {}),
    ...(actorUserId ? { actorUserId } : {}),
    limit: filters.limit,
  }
}

function formatAuditToken(value: string | null | undefined) {
  return value ? value.replace(/[_.-]+/g, ' ') : '-'
}

function getAuditActionLabel(action: string) {
  return auditActionLabels[action] ?? formatAuditToken(action)
}

function getAuditResourceLabel(resourceType: string | null) {
  if (!resourceType) {
    return '대상 없음'
  }

  return auditResourceLabels[resourceType] ?? formatAuditToken(resourceType)
}

function getAuditActorDisplay(entry: AuditLogEntry) {
  return entry.actorDisplayName || entry.actorEmail || entry.actorUserId || '-'
}

function getAuditActorSubtext(entry: AuditLogEntry) {
  if (entry.actorDisplayName && entry.actorEmail) {
    return entry.actorEmail
  }

  if ((entry.actorDisplayName || entry.actorEmail) && entry.actorUserId) {
    return `원본 ${abbreviateAuditId(entry.actorUserId)}`
  }

  return null
}

function getAuditResourceDisplay(entry: AuditLogEntry) {
  return entry.resourceDisplayName || entry.resourceId || getAuditResourceLabel(entry.resourceType)
}

function getAuditResourceSubtext(entry: AuditLogEntry) {
  const typeLabel = getAuditResourceLabel(entry.resourceType)

  if (entry.resourceDisplayName && entry.resourceId) {
    return `${typeLabel} · 원본 ${abbreviateAuditId(entry.resourceId)}`
  }

  if (entry.resourceDisplayName || entry.resourceId) {
    return typeLabel
  }

  return null
}

function abbreviateAuditId(value: string | null | undefined) {
  if (!value) {
    return '-'
  }

  return value.length > 16 ? `${value.slice(0, 8)}...${value.slice(-4)}` : value
}

function getDatePart(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes) {
  return parts.find((part) => part.type === type)?.value ?? ''
}

function formatAuditTimestamp(value: string | null) {
  if (!value) {
    return {
      groupLabel: '날짜 없음',
      timeLabel: '-',
      detailLabel: '시각 정보 없음',
    }
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return {
      groupLabel: '날짜 미상',
      timeLabel: value,
      detailLabel: value,
    }
  }

  const kstParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const year = getDatePart(kstParts, 'year')
  const month = getDatePart(kstParts, 'month')
  const day = getDatePart(kstParts, 'day')
  const hour = getDatePart(kstParts, 'hour')
  const minute = getDatePart(kstParts, 'minute')
  const second = getDatePart(kstParts, 'second')

  return {
    groupLabel: `${year}.${month}.${day}`,
    timeLabel: `${hour}:${minute}`,
    detailLabel: `${year}-${month}-${day} ${hour}:${minute}:${second} KST · 원본 UTC ${value}`,
  }
}

function formatAuditValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '-'
  }

  if (Array.isArray(value)) {
    return value.map((item) => formatAuditValue(item)).join(', ')
  }

  if (typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }

  return String(value)
}

function renderAuditDetailRows(entry: AuditLogEntry) {
  const rows: { label: string; value: string }[] = []

  if (entry.reasonCode) {
    rows.push({ label: '사유 코드', value: entry.reasonCode })
  }

  Object.entries(entry.afterSummary).forEach(([key, value]) => {
    rows.push({ label: `변경 후.${getAuditDetailKeyLabel(key)}`, value: formatAuditValue(value) })
  })

  Object.entries(entry.metadata).forEach(([key, value]) => {
    rows.push({ label: `메타데이터.${getAuditDetailKeyLabel(key)}`, value: formatAuditValue(value) })
  })

  if (entry.actorDisplayName) {
    rows.push({ label: '행위자 표시명', value: entry.actorDisplayName })
  }

  if (entry.actorEmail) {
    rows.push({ label: '행위자 이메일', value: entry.actorEmail })
  }

  if (entry.actorUserId) {
    rows.push({ label: '행위자 원본 ID', value: entry.actorUserId })
  }

  if (entry.resourceDisplayName) {
    rows.push({ label: '대상 표시명', value: entry.resourceDisplayName })
  }

  if (entry.resourceType) {
    rows.push({ label: '대상 원본 유형', value: entry.resourceType })
  }

  if (entry.resourceId) {
    rows.push({ label: '대상 원본 ID', value: entry.resourceId })
  }

  if (entry.action) {
    rows.push({ label: '원본 액션', value: entry.action })
  }

  return rows
}

// 감사 로그 tab: read-only audit trail (most recent admin mutations) and the
// console's primary monitoring surface.
function AuditLogPanel({
  entries,
  isLoading,
  errorMessage,
  filters,
  onApplyFilters,
  onRefresh,
}: {
  entries: AuditLogEntry[]
  isLoading: boolean
  errorMessage: string | null
  filters: AuditLogFilters
  onApplyFilters: (filters: AuditLogFilters) => void
  onRefresh: () => void
}) {
  const [draftFilters, setDraftFilters] = useState(filters)

  useEffect(() => {
    setDraftFilters(filters)
  }, [filters])

  const auditGroups = useMemo(() => {
    const groups: { dateLabel: string; entries: AuditLogEntry[] }[] = []

    entries.forEach((entry) => {
      const dateLabel = formatAuditTimestamp(entry.occurredAt).groupLabel
      const existing = groups.find((group) => group.dateLabel === dateLabel)
      if (existing) {
        existing.entries.push(entry)
      } else {
        groups.push({ dateLabel, entries: [entry] })
      }
    })

    return groups
  }, [entries])

  const resultCounts = useMemo(
    () =>
      entries.reduce(
        (counts, entry) => ({
          ...counts,
          [entry.result]: counts[entry.result] + 1,
        }),
        { allowed: 0, denied: 0, succeeded: 0, failed: 0 },
      ),
    [entries],
  )
  const latestTimestamp = entries[0]?.occurredAt ? formatAuditTimestamp(entries[0].occurredAt).detailLabel : '-'
  const handleFilterSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    onApplyFilters({ ...draftFilters, actorUserId: draftFilters.actorUserId.trim() })
  }

  return (
    <section className="panel audit-panel" aria-labelledby="audit-title">
      <div className="section-heading">
        <div>
          <span className="section-kicker">Audit Trail</span>
          <h2 id="audit-title">감사 로그</h2>
        </div>
        <button type="button" className="ghost-button" onClick={onRefresh} disabled={isLoading}>
          새로고침
        </button>
      </div>
      <form className="audit-filter-form" aria-label="감사 로그 필터" onSubmit={handleFilterSubmit}>
        <label>
          <span>결과</span>
          <select
            value={draftFilters.result}
            onChange={(event) =>
              setDraftFilters((current) => ({ ...current, result: event.target.value as AuditLogFilters['result'] }))
            }
          >
            {auditResultFilterOptions.map((option) => (
              <option key={option.value || 'all'} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>대상 유형</span>
          <select
            value={draftFilters.resourceType}
            onChange={(event) => setDraftFilters((current) => ({ ...current, resourceType: event.target.value }))}
          >
            <option value="">전체</option>
            {auditResourceFilterOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>액션</span>
          <select
            value={draftFilters.action}
            onChange={(event) => setDraftFilters((current) => ({ ...current, action: event.target.value }))}
          >
            <option value="">전체</option>
            {auditActionFilterOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>행위자 ID</span>
          <input
            value={draftFilters.actorUserId}
            onChange={(event) => setDraftFilters((current) => ({ ...current, actorUserId: event.target.value }))}
            placeholder="actorUserId"
            type="text"
          />
        </label>
        <label>
          <span>표시 건수</span>
          <select
            value={draftFilters.limit}
            onChange={(event) =>
              setDraftFilters((current) => ({
                ...current,
                limit: Number(event.target.value) as AuditLogFilters['limit'],
              }))
            }
          >
            {auditLimitOptions.map((limit) => (
              <option key={limit} value={limit}>
                {limit}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="primary-button" disabled={isLoading}>
          적용
        </button>
      </form>
      {errorMessage ? (
        <p role="alert" className="error-text">
          {errorMessage}
        </p>
      ) : null}
      {isLoading ? (
        <p>감사 로그를 불러오는 중입니다.</p>
      ) : entries.length === 0 ? (
        <p>기록된 감사 로그가 없습니다.</p>
      ) : (
        <>
          <div className="audit-summary" aria-label="현재 로드된 감사 로그 요약">
            <span>최근 {entries.length}건</span>
            <span>성공 {resultCounts.succeeded}</span>
            <span>허용 {resultCounts.allowed}</span>
            <span>거부 {resultCounts.denied}</span>
            <span>실패 {resultCounts.failed}</span>
            <span>마지막 로그 {latestTimestamp}</span>
          </div>
          <div className="audit-table-wrap">
            <table aria-label="감사 로그 목록" className="audit-table">
              <thead>
                <tr>
                  <th scope="col">시각</th>
                  <th scope="col">이벤트</th>
                  <th scope="col">행위자</th>
                  <th scope="col">대상</th>
                  <th scope="col">결과</th>
                </tr>
              </thead>
              {auditGroups.map((group) => (
                <tbody key={group.dateLabel}>
                  <tr className="audit-date-row">
                    <th scope="rowgroup" colSpan={5}>
                      {group.dateLabel}
                    </th>
                  </tr>
                  {group.entries.map((entry) => {
                    const timestamp = formatAuditTimestamp(entry.occurredAt)
                    const resourceLabel = getAuditResourceLabel(entry.resourceType)
                    const actorDisplay = getAuditActorDisplay(entry)
                    const actorSubtext = getAuditActorSubtext(entry)
                    const resourceDisplay = getAuditResourceDisplay(entry)
                    const resourceSubtext = getAuditResourceSubtext(entry)
                    const detailRows = renderAuditDetailRows(entry)

                    return (
                      <tr key={entry.id} className="audit-entry-row">
                        <td className="audit-time-cell">
                          <strong>{timestamp.timeLabel}</strong>
                          <span>{timestamp.detailLabel}</span>
                        </td>
                        <td className="audit-event-cell">
                          <strong>{getAuditActionLabel(entry.action)}</strong>
                          <span>
                            {actorDisplay}
                            {' -> '}
                            {resourceDisplay}
                          </span>
                          <details className="audit-details">
                            <summary>상세 정보</summary>
                            <dl>
                              {detailRows.map((row) => (
                                <div key={`${entry.id}-${row.label}`} className="audit-detail-row">
                                  <dt>{row.label}</dt>
                                  <dd>{row.value}</dd>
                                </div>
                              ))}
                            </dl>
                          </details>
                        </td>
                        <td>
                          <span className="audit-display-name" title={entry.actorDisplayName ?? entry.actorEmail ?? entry.actorUserId ?? undefined}>
                            {actorDisplay}
                          </span>
                          {actorSubtext ? <span className="audit-secondary-text">{actorSubtext}</span> : null}
                          {entry.rolesSnapshot.length > 0 ? (
                            <div className="audit-role-list" aria-label="행위자 역할 스냅샷">
                              {entry.rolesSnapshot.map((role) => (
                                <span key={role} className="audit-role-badge">
                                  {role}
                                </span>
                              ))}
                            </div>
                          ) : null}
                        </td>
                        <td>
                          <span className="audit-resource-badge">{resourceLabel}</span>
                          <span className="audit-display-name" title={entry.resourceDisplayName ?? entry.resourceId ?? undefined}>
                            {resourceDisplay}
                          </span>
                          {resourceSubtext ? <span className="audit-secondary-text">{resourceSubtext}</span> : null}
                        </td>
                        <td>
                          <span className={`status-pill status-${entry.result}`}>{auditResultLabels[entry.result]}</span>
                          {entry.reasonCode ? <span className="audit-reason">{entry.reasonCode}</span> : null}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              ))}
            </table>
          </div>
        </>
      )}
    </section>
  )
}

const highRiskOperationLabels: Record<HighRiskOperationType, string> = {
  role_grant: '역할 부여',
  role_revoke: '역할 회수',
  region_grant: '지역 권한 부여',
  region_revoke: '지역 권한 회수',
  bulk_publish: '월간 후보 일괄 게시',
}

const highRiskStatusLabels: Record<HighRiskChangeRequest['status'], string> = {
  pending: '승인 대기',
  executed: '실행 완료',
  rejected: '거절',
}

// The pending list is fetched with limit=50 (server-side clamp, no cursor), so a
// full page of 50 means "50 or more". Render 50+ rather than implying an exact 50.
const HIGH_RISK_PENDING_PAGE_SIZE = 50
function formatPendingBadge(count: number) {
  return count >= HIGH_RISK_PENDING_PAGE_SIZE ? `${HIGH_RISK_PENDING_PAGE_SIZE}+` : String(count)
}
function formatPendingCountText(count: number) {
  return count >= HIGH_RISK_PENDING_PAGE_SIZE ? `${HIGH_RISK_PENDING_PAGE_SIZE}건 이상` : `${count}건`
}

type HighRiskRequestFormState = {
  operationType: HighRiskOperationType
  targetUserId: string
  roleCode: AdminRole
  regionId: string
  organizationId: string
  validUntil: string
  destinationIds: string
  reason: string
}

const defaultHighRiskForm: HighRiskRequestFormState = {
  operationType: 'role_grant',
  targetUserId: '',
  roleCode: 'R-LOCAL-OPERATOR',
  regionId: '',
  organizationId: '',
  validUntil: '',
  destinationIds: '',
  reason: '',
}

function isRoleHighRiskOperation(operationType: HighRiskOperationType) {
  return operationType === 'role_grant' || operationType === 'role_revoke'
}

function isRegionHighRiskOperation(operationType: HighRiskOperationType) {
  return operationType === 'region_grant' || operationType === 'region_revoke'
}

function getHighRiskTargetText(request: HighRiskChangeRequest) {
  if (request.operationType === 'bulk_publish') {
    const destinationIds = request.payload.destinationIds
    return Array.isArray(destinationIds) ? `${destinationIds.length}개 후보` : '월간 후보'
  }
  return request.targetUserId || String(request.payload.targetUserId ?? '-')
}

function getHighRiskPayloadSummary(request: HighRiskChangeRequest) {
  if (isRoleHighRiskOperation(request.operationType)) {
    return String(request.payload.roleCode ?? '-')
  }
  if (isRegionHighRiskOperation(request.operationType)) {
    return String(request.payload.regionId ?? '-')
  }
  const destinationIds = request.payload.destinationIds
  return Array.isArray(destinationIds) ? destinationIds.join(', ') : '-'
}

function HighRiskRequestPanel({
  requests,
  form,
  decisionReason,
  isLoading,
  isMutating,
  errorMessage,
  canCreate,
  canDecide,
  onFormChange,
  onDecisionReasonChange,
  onCreate,
  onApprove,
  onReject,
  onRefresh,
}: {
  requests: HighRiskChangeRequest[]
  form: HighRiskRequestFormState
  decisionReason: string
  isLoading: boolean
  isMutating: boolean
  errorMessage: string | null
  canCreate: boolean
  canDecide: boolean
  onFormChange: (form: HighRiskRequestFormState) => void
  onDecisionReasonChange: (value: string) => void
  onCreate: () => void
  onApprove: (requestId: string) => void
  onReject: (requestId: string) => void
  onRefresh: () => void
}) {
  const operationType = form.operationType
  const requiresTargetUser = operationType !== 'bulk_publish'
  const requiresRole = isRoleHighRiskOperation(operationType)
  const requiresRegion = isRegionHighRiskOperation(operationType)
  const requiresDestinationIds = operationType === 'bulk_publish'
  const canSubmit =
    canCreate &&
    form.reason.trim().length > 0 &&
    (!requiresTargetUser || form.targetUserId.trim().length > 0) &&
    (!requiresRegion || form.regionId.trim().length > 0) &&
    (!requiresDestinationIds || form.destinationIds.trim().length > 0)
  const canSubmitDecision = canDecide

  return (
    <section className="high-risk-layout" aria-label="고위험 변경 승인 작업 영역">
      <div className="panel">
        <div className="section-heading">
          <span className="section-kicker">C2 Approval</span>
          <h2>권한 승인 요청</h2>
          <button type="button" className="ghost-button" onClick={onRefresh} disabled={isLoading}>
            새로고침
          </button>
        </div>
        <form
          className="high-risk-form"
          onSubmit={(event) => {
            event.preventDefault()
            if (canSubmit) {
              onCreate()
            }
          }}
        >
          <label>
            작업 유형
            <select
              value={operationType}
              onChange={(event) =>
                onFormChange({ ...form, operationType: event.target.value as HighRiskOperationType })
              }
            >
              {Object.entries(highRiskOperationLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {requiresTargetUser ? (
            <label>
              대상 사용자 ID
              <input
                value={form.targetUserId}
                onChange={(event) => onFormChange({ ...form, targetUserId: event.target.value })}
                placeholder="target-user-id"
              />
            </label>
          ) : null}
          {requiresRole ? (
            <label>
              역할
              <select
                value={form.roleCode}
                onChange={(event) => onFormChange({ ...form, roleCode: event.target.value as AdminRole })}
              >
                <option value="R-ADMIN">R-ADMIN</option>
                <option value="R-SUPER-ADMIN">R-SUPER-ADMIN</option>
                <option value="R-DATA-PROVIDER">R-DATA-PROVIDER</option>
                <option value="R-LOCAL-OPERATOR">R-LOCAL-OPERATOR</option>
              </select>
            </label>
          ) : null}
          {requiresRegion ? (
            <label>
              지역 ID
              <input
                value={form.regionId}
                onChange={(event) => onFormChange({ ...form, regionId: event.target.value })}
                placeholder="KR-42-150"
              />
            </label>
          ) : null}
          {requiresDestinationIds ? (
            <label className="high-risk-wide-field">
              월간 후보 ID
              <textarea
                value={form.destinationIds}
                onChange={(event) => onFormChange({ ...form, destinationIds: event.target.value })}
                placeholder="monthly-1, monthly-2, monthly-3"
              />
            </label>
          ) : null}
          {!requiresDestinationIds ? (
            <>
              <label>
                조직 ID
                <input
                  value={form.organizationId}
                  onChange={(event) => onFormChange({ ...form, organizationId: event.target.value })}
                  placeholder="선택"
                />
              </label>
              {(operationType === 'role_grant' || operationType === 'region_grant') ? (
                <label>
                  만료일
                  <input
                    value={form.validUntil}
                    onChange={(event) => onFormChange({ ...form, validUntil: event.target.value })}
                    placeholder="2026-12-31T00:00:00Z"
                  />
                </label>
              ) : null}
            </>
          ) : null}
          <label className="high-risk-wide-field">
            요청 사유
            <textarea
              value={form.reason}
              onChange={(event) => onFormChange({ ...form, reason: event.target.value })}
              placeholder="감사 로그에 남길 업무 사유"
            />
          </label>
          <div className="form-actions high-risk-wide-field">
            <button type="submit" disabled={!canSubmit || isMutating}>
              고위험 요청 생성
            </button>
          </div>
        </form>
        {errorMessage ? (
          <p role="alert" className="error-text">
            {errorMessage}
          </p>
        ) : null}
      </div>

      <div className="panel">
        <div className="section-heading">
          <span className="section-kicker">Pending Queue</span>
          <h2>승인 대기 목록{requests.length > 0 ? ` (${formatPendingCountText(requests.length)})` : ''}</h2>
        </div>
        {canDecide ? (
          <div className="high-risk-decision-box">
            <label>
              결정 사유
              <input
                value={decisionReason}
                onChange={(event) => onDecisionReasonChange(event.target.value)}
                placeholder="거절 시 필수"
              />
            </label>
            <p className="high-risk-mfa-hint">승인·거절 시 인증 앱의 TOTP 코드가 필요합니다.</p>
          </div>
        ) : (
          <p className="role-action-lock">승인·거절은 R-SUPER-ADMIN 역할만 수행할 수 있습니다.</p>
        )}
        {isLoading ? (
          <p>고위험 요청을 불러오는 중입니다.</p>
        ) : requests.length === 0 ? (
          <p>승인 대기 중인 고위험 요청이 없습니다.</p>
        ) : (
          <div className="proposal-table-wrap">
            <table aria-label="고위험 변경 요청 목록" className="proposal-table">
              <thead>
                <tr>
                  <th scope="col">작업</th>
                  <th scope="col">대상</th>
                  <th scope="col">상세</th>
                  <th scope="col">상태</th>
                  <th scope="col">요청자</th>
                  {canDecide ? <th scope="col">결정</th> : null}
                </tr>
              </thead>
              <tbody>
                {requests.map((request) => (
                  <tr key={request.id}>
                    <td>
                      <strong>{highRiskOperationLabels[request.operationType]}</strong>
                      <span>{request.reason || request.id}</span>
                    </td>
                    <td>{getHighRiskTargetText(request)}</td>
                    <td>{getHighRiskPayloadSummary(request)}</td>
                    <td>
                      <span className={`status-pill status-${request.status}`}>
                        {highRiskStatusLabels[request.status]}
                      </span>
                    </td>
                    <td>{request.requestedBy ?? '-'}</td>
                    {canDecide ? (
                      <td>
                        <div className="inline-actions">
                          <button
                            type="button"
                            className="approve-button"
                            disabled={isMutating || !canSubmitDecision}
                            onClick={() => onApprove(request.id)}
                          >
                            승인 실행
                          </button>
                          <button
                            type="button"
                            className="reject-button"
                            disabled={isMutating || !canSubmitDecision || !decisionReason.trim()}
                            onClick={() => onReject(request.id)}
                          >
                            거절 실행
                          </button>
                        </div>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  )
}

// 공지·정책 tab: side-by-side notice and recommendation-policy cards with
// create + lifecycle (publish/activate/archive) actions for R-ADMIN.
function OperationsPolicyPanel({
  notices,
  policies,
  isLoading,
  errorMessage,
  onRefresh,
  onCreateNotice,
  onTransitionNotice,
  onCreatePolicy,
  onTransitionPolicy,
}: {
  notices: AdminNotice[]
  policies: RecommendationPolicy[]
  isLoading: boolean
  errorMessage: string | null
  onRefresh: () => void
  onCreateNotice: () => void
  onTransitionNotice: (noticeId: string, action: AdminNoticeAction) => void
  onCreatePolicy: () => void
  onTransitionPolicy: (policyId: string, action: RecommendationPolicyAction) => void
}) {
  return (
    <section className="panel" aria-labelledby="operations-title">
      <div className="section-heading">
        <span className="section-kicker">R-ADMIN</span>
        <h2 id="operations-title">공지·추천 정책 관리</h2>
      </div>
      <div className="api-status-row">
        {isLoading && <span role="status">공지와 추천 정책을 불러오는 중입니다.</span>}
        {errorMessage && <span role="alert">{errorMessage}</span>}
        <button type="button" onClick={onRefresh} disabled={isLoading}>
          새로고침
        </button>
        <button type="button" onClick={onCreateNotice} disabled={isLoading}>
          공지 초안 생성
        </button>
        <button type="button" onClick={onCreatePolicy} disabled={isLoading}>
          추천 정책 초안 생성
        </button>
      </div>
      <div className="operations-grid">
        <article className="operations-card" aria-labelledby="notices-title">
          <h3 id="notices-title">운영 공지</h3>
          {notices.length === 0 ? (
            <p className="empty-state">등록된 공지가 없습니다.</p>
          ) : (
            <ul className="operations-list">
              {notices.map((notice) => (
                <li key={notice.id}>
                  <div>
                    <strong>{notice.title}</strong>
                    <p>{notice.body}</p>
                    <span>
                      {notice.audience} · {notice.severity} · {notice.status}
                    </span>
                  </div>
                  <div className="inline-actions">
                    {notice.status !== 'published' && (
                      <button type="button" onClick={() => onTransitionNotice(notice.id, 'publish')}>
                        게시
                      </button>
                    )}
                    {notice.status !== 'archived' && (
                      <button type="button" onClick={() => onTransitionNotice(notice.id, 'archive')}>
                        보관
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </article>
        <article className="operations-card" aria-labelledby="policies-title">
          <h3 id="policies-title">추천 정책</h3>
          {policies.length === 0 ? (
            <p className="empty-state">등록된 추천 정책이 없습니다.</p>
          ) : (
            <ul className="operations-list">
              {policies.map((policy) => (
                <li key={policy.id}>
                  <div>
                    <strong>{policy.title}</strong>
                    <p>{policy.description || policy.policyKey}</p>
                    <span>
                      우선순위 {policy.priority} · {policy.status}
                    </span>
                  </div>
                  <div className="inline-actions">
                    {policy.status !== 'active' && (
                      <button type="button" onClick={() => onTransitionPolicy(policy.id, 'activate')}>
                        활성
                      </button>
                    )}
                    {policy.status !== 'archived' && (
                      <button type="button" onClick={() => onTransitionPolicy(policy.id, 'archive')}>
                        보관
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </article>
      </div>
    </section>
  )
}

function DataProposalPanel({
  canSaveProposal,
  isSubmitting,
  onCreateProposal,
}: {
  canSaveProposal: boolean
  isSubmitting: boolean
  onCreateProposal: () => void
}) {
  return (
    <section className="panel form-panel" aria-labelledby="proposal-title">
      <div className="section-heading">
        <span className="section-kicker">R-DATA-PROVIDER</span>
        <h2 id="proposal-title">관광지/축제/체험 데이터 제안</h2>
      </div>
      <form className="proposal-form">
        <label>
          제안 유형
          <select defaultValue={proposalDraft.type} aria-label="제안 유형">
            <option value="tour">관광지</option>
            <option value="festival">축제</option>
            <option value="activity">체험</option>
          </select>
        </label>
        <label>
          담당 지역
          <input value={proposalDraft.region} readOnly aria-label="담당 지역" />
        </label>
        <label className="wide-field">
          제안 제목
          <input value={proposalDraft.title} readOnly aria-label="제안 제목" />
        </label>
        <label className="wide-field">
          제안 설명
          <textarea value={proposalDraft.summary} readOnly aria-label="제안 설명" />
        </label>
        <label className="wide-field">
          근거 자료
          <textarea value={proposalDraft.evidence} readOnly aria-label="근거 자료" />
        </label>
        <div className="form-actions">
          <span className="status-pill status-submitted" data-alignment="centered">
            submitted
          </span>
          {canSaveProposal ? (
            <button type="button" onClick={onCreateProposal} disabled={isSubmitting}>
              {isSubmitting ? '저장 중...' : '제안 등록'}
            </button>
          ) : (
            <span className="role-action-lock">R-DATA-PROVIDER 역할에서만 저장할 수 있습니다.</span>
          )}
        </div>
      </form>
    </section>
  )
}

function ReviewQueuePanel({
  canMakeDecision,
  proposals,
  isLoading,
  errorMessage,
  isMutating,
  onRefresh,
  onReview,
  onApprove,
  onReject,
  onLoadHistory,
  historyItems,
  isHistoryLoading,
}: {
  canMakeDecision: boolean
  proposals: ReviewProposal[]
  isLoading: boolean
  errorMessage: string | null
  isMutating: boolean
  onRefresh: () => void
  onReview: (proposalId: string) => void
  onApprove: (proposalId: string) => void
  onReject: (proposalId: string) => void
  onLoadHistory: (proposalId: string) => void
  historyItems: ProposalHistoryItem[]
  isHistoryLoading: boolean
}) {
  const selectedProposal = proposals[0]
  const canStartReview = selectedProposal?.status === 'submitted'
  const canDecideProposal = selectedProposal?.status === 'in_review'
  const decisionHint = selectedProposal
    ? canStartReview
      ? '제출된 제안은 검토를 시작할 수 있습니다.'
      : canDecideProposal
        ? '검토 중인 제안은 승인 또는 반려할 수 있습니다.'
        : '이미 처리된 제안은 이력만 조회할 수 있습니다.'
    : '검토할 제안이 없습니다.'

  return (
    <section className="review-layout" aria-label="관리자 검토 작업 영역">
      <div className="panel">
        <div className="section-heading">
          <span className="section-kicker">R-ADMIN</span>
          <h2>데이터 제안 검토</h2>
        </div>
        <div className="api-status-row">
          {isLoading && <span role="status">API 제안 목록을 불러오는 중입니다.</span>}
          {errorMessage && <span role="alert">{errorMessage}</span>}
          <button type="button" onClick={onRefresh} disabled={isLoading}>
            새로고침
          </button>
        </div>
        <div className="proposal-table-wrap">
          <table aria-label="데이터 제안 목록" className="proposal-table">
            <thead>
              <tr>
                <th scope="col">제안</th>
                <th scope="col">지역</th>
                <th scope="col">상태</th>
                <th scope="col">제출</th>
              </tr>
            </thead>
            <tbody>
              {proposals.map((proposal) => (
                <tr key={proposal.id}>
                  <td>
                    <strong>{proposal.title}</strong>
                    <span>{proposal.code || proposal.id}</span>
                  </td>
                  <td>{proposal.region}</td>
                  <td>
                    <span
                      className={`status-pill status-${proposal.status}`}
                      data-alignment="centered"
                      data-contrast={getStatusContrast(proposal.status)}
                    >
                      {proposal.status}
                    </span>
                  </td>
                  <td>{proposal.submittedAt}</td>
                </tr>
              ))}
              {!isLoading && proposals.length === 0 && (
                <tr>
                  <td colSpan={4}>표시할 제안이 없습니다.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      <aside className="panel decision-panel" aria-labelledby="decision-title">
        <div className="section-heading">
          <span className="section-kicker">Decision</span>
          <h2 id="decision-title">승인 여부</h2>
        </div>
        <dl>
          <div>
            <dt>검토 대상</dt>
            <dd>{selectedProposal?.title ?? '선택된 제안 없음'}</dd>
          </div>
          <div>
            <dt>근거 자료</dt>
            <dd>{selectedProposal?.evidence ?? '-'}</dd>
          </div>
          <div>
            <dt>제안자</dt>
            <dd>{selectedProposal?.proposerRole ?? '-'}</dd>
          </div>
        </dl>
        {canMakeDecision && (
          <>
            <p className="decision-state-note">{decisionHint}</p>
            <div className="decision-actions">
              <button
                type="button"
                className="approve-button"
                onClick={() => selectedProposal && onReview(selectedProposal.id)}
                disabled={!selectedProposal || isMutating || !canStartReview}
              >
                검토 시작
              </button>
              <button
                type="button"
                className="approve-button"
                onClick={() => selectedProposal && onApprove(selectedProposal.id)}
                disabled={!selectedProposal || isMutating || !canDecideProposal}
              >
                승인
              </button>
              <button
                type="button"
                className="reject-button"
                onClick={() => selectedProposal && onReject(selectedProposal.id)}
                disabled={!selectedProposal || isMutating || !canDecideProposal}
              >
                반려
              </button>
              <button
                type="button"
                className="approve-button"
                onClick={() => selectedProposal && onLoadHistory(selectedProposal.id)}
                disabled={!selectedProposal || isHistoryLoading}
              >
                {isHistoryLoading ? '이력 조회 중...' : '이력 조회'}
              </button>
            </div>
            <div className="reason-box">
              <strong>제안자에게 사유 표시</strong>
              <p>승인·반려 사유는 백엔드 제안 이력에 남고 이후 반영 상태 추적에 사용됩니다.</p>
            </div>
            <ol className="history-list" aria-label="제안 변경 이력">
              {historyItems.map((item) => (
                <li key={item.historyId || `${item.action}-${item.createdAt}`}>
                  <strong>{item.action}</strong>
                  <span>
                    {item.fromStatus || '-'} → {item.toStatus || '-'}
                  </span>
                  <p>{item.note || item.createdAt || '기록된 메모 없음'}</p>
                </li>
              ))}
              {!isHistoryLoading && historyItems.length === 0 && <li>조회된 이력이 없습니다.</li>}
            </ol>
          </>
        )}
      </aside>
    </section>
  )
}

const monthlyStatusLabels: Record<MonthlyDestinationStatus, string> = {
  candidate: '후보',
  scheduled: '게시 예약',
  published: '게시됨',
  hidden: '숨김',
  expired: '만료',
  rejected: '거부',
}

// Mirror of the backend publish state machine. The UI only offers the actions
// that are legal for a row's current status; the server re-validates anyway.
const monthlyAllowedActions: Record<MonthlyDestinationStatus, MonthlyDestinationAction[]> = {
  candidate: ['schedule', 'publish', 'reject'],
  scheduled: ['publish', 'expire', 'reject'],
  published: ['hide', 'expire'],
  hidden: ['publish', 'expire'],
  expired: [],
  rejected: [],
}

const monthlyActionLabels: Record<MonthlyDestinationAction, string> = {
  schedule: '예약',
  publish: '게시',
  hide: '숨김',
  expire: '만료',
  reject: '거부',
}

const publishJobStatusLabels: Record<PublishJobStatus, string> = {
  queued: '대기',
  running: '실행중',
  succeeded: '성공',
  failed: '실패',
  canceled: '취소',
}

const publishJobTypeLabels: Record<PublishJobType, string> = {
  catalog_sync: '카탈로그 동기화',
  rag_index_sync: 'RAG 인덱스',
  search_cache_sync: '검색 캐시',
  recommendation_cache_sync: '추천 캐시',
}

// Mirror of the backend reflection-job state machine.
const publishJobAllowedActions: Record<PublishJobStatus, PublishJobAction[]> = {
  queued: ['start', 'fail', 'cancel'],
  running: ['succeed', 'fail', 'cancel'],
  failed: ['retry'],
  succeeded: [],
  canceled: [],
}

const publishJobActionLabels: Record<PublishJobAction, string> = {
  start: '시작',
  succeed: '완료',
  fail: '실패 처리',
  retry: '재시도',
  cancel: '취소',
}

type MonthlyDestinationPanelProps = {
  items: MonthlyDestination[]
  isLoading: boolean
  errorMessage: string | null
  isMutating: boolean
  canManage: boolean
  onTransition: (destinationId: string, action: MonthlyDestinationAction) => void
  onRefresh: () => void
  jobs: PublishJob[]
  jobsDestinationId: string | null
  isJobsLoading: boolean
  jobsError: string | null
  isJobMutating: boolean
  onLoadJobs: (destinationId: string) => void
  onJobTransition: (jobId: string, action: PublishJobAction) => void
}

// 반영 상태 tab: the monthly curated destination list with admin publish-state
// controls and an expandable per-destination reflection-job history.
function MonthlyDestinationPanel({
  items,
  isLoading,
  errorMessage,
  isMutating,
  canManage,
  onTransition,
  onRefresh,
  jobs,
  jobsDestinationId,
  isJobsLoading,
  jobsError,
  isJobMutating,
  onLoadJobs,
  onJobTransition,
}: MonthlyDestinationPanelProps) {
  return (
    <section className="panel" aria-labelledby="publish-title">
      <div className="section-heading">
        <span className="section-kicker">Publish Pipeline</span>
        <h2 id="publish-title">월간 여행지 후보·게시 상태</h2>
        <button type="button" className="ghost-button" onClick={onRefresh} disabled={isLoading}>
          새로고침
        </button>
      </div>
      {errorMessage ? (
        <p role="alert" className="error-text">
          {errorMessage}
        </p>
      ) : null}
      {isLoading ? (
        <p>월간 후보를 불러오는 중입니다.</p>
      ) : items.length === 0 ? (
        <p>표시할 월간 후보가 없습니다. 승인된 제안을 후보로 등록하세요.</p>
      ) : (
        <table aria-label="월간 여행지 후보 목록">
          <thead>
            <tr>
              <th scope="col">도시</th>
              <th scope="col">대상 월</th>
              <th scope="col">테마</th>
              <th scope="col">상태</th>
              <th scope="col">반영</th>
              {canManage ? <th scope="col">상태 변경</th> : null}
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td>{item.cityName}</td>
                <td>{item.curationMonth}</td>
                <td>{item.themeCodes.join(', ')}</td>
                <td>
                  <span className={`status-pill status-${item.status}`}>{monthlyStatusLabels[item.status]}</span>
                </td>
                <td>
                  <button type="button" onClick={() => onLoadJobs(item.id)}>
                    반영 이력
                  </button>
                </td>
                {canManage ? (
                  <td>
                    {monthlyAllowedActions[item.status].length === 0 ? (
                      <span>—</span>
                    ) : (
                      monthlyAllowedActions[item.status].map((action) => (
                        <button
                          key={action}
                          type="button"
                          disabled={isMutating}
                          onClick={() => onTransition(item.id, action)}
                        >
                          {monthlyActionLabels[action]}
                        </button>
                      ))
                    )}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {jobsDestinationId ? (
        <div className="reflection-history">
          <h3>데이터 반영 이력</h3>
          {jobsError ? (
            <p role="alert" className="error-text">
              {jobsError}
            </p>
          ) : null}
          {isJobsLoading ? (
            <p>반영 이력을 불러오는 중입니다.</p>
          ) : jobs.length === 0 ? (
            <p>이 후보에 대한 반영 작업이 아직 없습니다. 게시하면 반영 작업이 생성됩니다.</p>
          ) : (
            <table aria-label="데이터 반영 작업">
              <thead>
                <tr>
                  <th scope="col">반영 대상</th>
                  <th scope="col">상태</th>
                  <th scope="col">시도</th>
                  {canManage ? <th scope="col">작업</th> : null}
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.id}>
                    <td>{publishJobTypeLabels[job.jobType]}</td>
                    <td>
                      <span className={`status-pill status-${job.status}`}>{publishJobStatusLabels[job.status]}</span>
                    </td>
                    <td>{job.attemptCount}</td>
                    {canManage ? (
                      <td>
                        {publishJobAllowedActions[job.status].length === 0 ? (
                          <span>—</span>
                        ) : (
                          publishJobAllowedActions[job.status].map((action) => (
                            <button
                              key={action}
                              type="button"
                              disabled={isJobMutating}
                              onClick={() => onJobTransition(job.id, action)}
                            >
                              {publishJobActionLabels[action]}
                            </button>
                          ))
                        )}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : null}
    </section>
  )
}

function AdminMfaGate({
  status,
  enrollment,
  recoveryCodes,
  code,
  recoveryCode,
  isLoading,
  errorMessage,
  hideRecovery = false,
  onCodeChange,
  onRecoveryCodeChange,
  onEnroll,
  onConfirm,
  onVerify,
  onRecover,
  onAcknowledgeRecoveryCodes,
}: {
  status: AdminMfaStatus | null
  enrollment: AdminMfaEnrollment | null
  recoveryCodes: string[]
  code: string
  recoveryCode: string
  isLoading: boolean
  errorMessage: string | null
  hideRecovery?: boolean
  onCodeChange: (value: string) => void
  onRecoveryCodeChange: (value: string) => void
  onEnroll: () => void
  onConfirm: () => void
  onVerify: () => void
  onRecover: () => void
  onAcknowledgeRecoveryCodes: () => void
}) {
  return (
    <section className="panel mfa-panel" aria-labelledby="admin-mfa-title">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Admin Security</p>
          <h2 id="admin-mfa-title">관리자 추가 인증</h2>
        </div>
        <span className="status-pill status-pending">필수</span>
      </div>

      {errorMessage && <p className="error-text" role="alert">{errorMessage}</p>}

      {recoveryCodes.length > 0 ? (
        <div className="mfa-recovery-block">
          <strong>복구 코드</strong>
          <div className="mfa-code-grid">
            {recoveryCodes.map((item) => <code key={item}>{item}</code>)}
          </div>
          <button type="button" onClick={onAcknowledgeRecoveryCodes}>보관 완료</button>
        </div>
      ) : !status && isLoading ? (
        <p role="status">MFA 상태를 확인하는 중입니다.</p>
      ) : !status && errorMessage ? (
        <p>MFA 상태를 확인할 수 없습니다. 모달을 닫고 다시 시도하세요.</p>
      ) : !status || status.credentialStatus === 'not_enrolled' || status.credentialStatus === 'pending' ? (
        enrollment ? (
          <div className="mfa-form-stack">
            <label>
              설정 키
              <input readOnly value={enrollment.secret} />
            </label>
            <label>
              인증 코드
              <input
                autoComplete="one-time-code"
                inputMode="numeric"
                maxLength={6}
                onChange={(event) => onCodeChange(event.target.value.replace(/\D/g, ''))}
                value={code}
              />
            </label>
            <button disabled={isLoading || code.length !== 6} onClick={onConfirm} type="button">등록 확인</button>
          </div>
        ) : (
          <button disabled={isLoading} onClick={onEnroll} type="button">MFA 등록 시작</button>
        )
      ) : (
        <div className="mfa-form-stack">
          <label>
            인증 코드
            <input
              autoComplete="one-time-code"
              inputMode="numeric"
              maxLength={6}
              onChange={(event) => onCodeChange(event.target.value.replace(/\D/g, ''))}
              value={code}
            />
          </label>
          <button disabled={isLoading || code.length !== 6} onClick={onVerify} type="button">인증</button>
          {!hideRecovery ? (
            <div className="mfa-recovery-row">
              <input
                aria-label="복구 코드"
                onChange={(event) => onRecoveryCodeChange(event.target.value)}
                placeholder="복구 코드"
                value={recoveryCode}
              />
              <button disabled={isLoading || !recoveryCode.trim()} onClick={onRecover} type="button">복구 코드 사용</button>
            </div>
          ) : null}
        </div>
      )}
      {isLoading && <span role="status">처리 중입니다.</span>}
    </section>
  )
}

type PendingDecision = { action: 'approve' | 'reject'; requestId: string; decisionReason: string }

export function AdminDashboard() {
  // Access token drives both the API client (Bearer header) and the session role.
  // Initial value is the cached token (survives refresh); if absent we restore it
  // from /api/v1/auth/session below. getSessionRoles() also falls back to the Vite
  // dev token, so local development still works without a real login.
  const [accessToken, setAccessToken] = useState<string>(() => getStoredAccessToken() || getDevAccessToken())
  const useSamplePreview =
    import.meta.env.DEV && import.meta.env.VITE_LOVV_USE_SAMPLE_DATA === 'true' && !accessToken
  // Session roles come from the token, not a manual switcher. currentRole is the
  // display/default-tab role; tab/action access uses the full role union.
  const sessionRoles = useMemo(() => {
    const tokenRoles = getSessionRoles(accessToken)
    return tokenRoles.length > 0 || !useSamplePreview ? tokenRoles : samplePreviewRoles
  }, [accessToken, useSamplePreview])
  const currentRole = useMemo(() => resolvePrimaryRole(sessionRoles), [sessionRoles])
  const [activeTab, setActiveTab] = useState<AdminTab>(() =>
    currentRole ? roleDefaultTab[currentRole] : 'metrics',
  )
  const roleBadgeLabel = currentRole
    ? sessionRoles.length > 1
      ? `${currentRole} 외 ${sessionRoles.length - 1}개 역할`
      : currentRole
    : '역할 없음'
  const metricsLabel = useMemo(() => getMetricsDashboardLabel(sessionRoles), [sessionRoles])
  const [apiProposals, setApiProposals] = useState<ReviewProposal[]>([])
  const [isProposalLoading, setIsProposalLoading] = useState(true)
  const [proposalError, setProposalError] = useState<string | null>(null)
  const [isProposalMutating, setIsProposalMutating] = useState(false)
  const [proposalHistory, setProposalHistory] = useState<ProposalHistoryItem[]>([])
  const [isHistoryLoading, setIsHistoryLoading] = useState(false)
  const activePanelId = useMemo(() => `admin-panel-${activeTab}`, [activeTab])
  const adminApi = useMemo(
    () => createAdminApiClient(accessToken ? { accessToken } : {}),
    [accessToken],
  )
  const authClient = useMemo(() => createAdminAuthClient(), [])
  const [metricsItems, setMetricsItems] = useState<DestinationMetricsSummary[]>([])
  const [isMetricsLoading, setIsMetricsLoading] = useState(false)
  const [metricsError, setMetricsError] = useState<string | null>(null)
  const [notices, setNotices] = useState<AdminNotice[]>([])
  const [policies, setPolicies] = useState<RecommendationPolicy[]>([])
  const [isOperationsLoading, setIsOperationsLoading] = useState(false)
  const [operationsError, setOperationsError] = useState<string | null>(null)
  const [auditEntries, setAuditEntries] = useState<AuditLogEntry[]>([])
  const [auditQuery, setAuditQuery] = useState({ filters: defaultAuditLogFilters, requestId: 0 })
  const [isAuditLoading, setIsAuditLoading] = useState(false)
  const [auditError, setAuditError] = useState<string | null>(null)
  const [highRiskRequests, setHighRiskRequests] = useState<HighRiskChangeRequest[]>([])
  const [highRiskForm, setHighRiskForm] = useState<HighRiskRequestFormState>(defaultHighRiskForm)
  const [highRiskDecisionReason, setHighRiskDecisionReason] = useState('')
  const [isHighRiskLoading, setIsHighRiskLoading] = useState(false)
  const [isHighRiskMutating, setIsHighRiskMutating] = useState(false)
  const [highRiskError, setHighRiskError] = useState<string | null>(null)
  const [mfaPrompt, setMfaPrompt] = useState<{ pending: PendingDecision; notice: string | null } | null>(null)
  const [mfaStatus, setMfaStatus] = useState<AdminMfaStatus | null>(null)
  const [mfaEnrollment, setMfaEnrollment] = useState<AdminMfaEnrollment | null>(null)
  const [mfaRecoveryCodes, setMfaRecoveryCodes] = useState<string[]>([])
  const [mfaCode, setMfaCode] = useState('')
  const [mfaRecoveryCode, setMfaRecoveryCode] = useState('')
  const [isMfaLoading, setIsMfaLoading] = useState(false)
  const [mfaError, setMfaError] = useState<string | null>(null)

  const loadMetrics = useCallback(async () => {
    setIsMetricsLoading(true)
    setMetricsError(null)
    try {
      const items = await adminApi.listDestinationMetricsSummary({ limit: 10 })
      setMetricsItems(items)
    } catch (error) {
      setMetricsError(error instanceof Error ? error.message : '운영 지표를 불러오지 못했습니다.')
      setMetricsItems([])
    } finally {
      setIsMetricsLoading(false)
    }
  }, [adminApi])

  const loadOperations = useCallback(async () => {
    setIsOperationsLoading(true)
    setOperationsError(null)
    try {
      const [noticeItems, policyItems] = await Promise.all([
        adminApi.listNotices({ limit: 20 }),
        adminApi.listRecommendationPolicies({ limit: 20 }),
      ])
      setNotices(noticeItems)
      setPolicies(policyItems)
    } catch (error) {
      setOperationsError(error instanceof Error ? error.message : '공지와 추천 정책을 불러오지 못했습니다.')
      setNotices([])
      setPolicies([])
    } finally {
      setIsOperationsLoading(false)
    }
  }, [adminApi])

  const loadAudit = useCallback(async (filters: AuditLogFilters) => {
    setIsAuditLoading(true)
    setAuditError(null)
    try {
      const items = await adminApi.listAuditLogs(toAuditRequestFilters(filters))
      setAuditEntries(items)
    } catch (error) {
      setAuditError(error instanceof Error ? error.message : '감사 로그를 불러오지 못했습니다.')
      setAuditEntries([])
    } finally {
      setIsAuditLoading(false)
    }
  }, [adminApi])

  const requestAuditRefresh = useCallback(() => {
    setAuditQuery((current) => ({ ...current, requestId: current.requestId + 1 }))
  }, [])

  const applyAuditFilters = useCallback((filters: AuditLogFilters) => {
    setAuditQuery((current) => ({ filters, requestId: current.requestId + 1 }))
  }, [])

  const loadHighRiskRequests = useCallback(async () => {
    setIsHighRiskLoading(true)
    setHighRiskError(null)
    try {
      const items = await adminApi.listHighRiskRequests({ status: 'pending', limit: 50 })
      setHighRiskRequests(items)
    } catch (error) {
      setHighRiskError(error instanceof Error ? error.message : '고위험 요청 목록을 불러오지 못했습니다.')
      setHighRiskRequests([])
    } finally {
      setIsHighRiskLoading(false)
    }
  }, [adminApi])

  const handleCreateNotice = useCallback(async () => {
    setIsOperationsLoading(true)
    setOperationsError(null)
    // TODO(operations): PoC placeholder content. Replace with a notice form
    // (title/body/audience/severity inputs) before production use.
    const request: AdminNoticeRequest = {
      title: '추천 데이터 반영 일정 안내',
      body: '승인된 월간 여행지 후보가 추천 캐시에 반영되는 운영 일정을 공지합니다.',
      audience: 'admin',
      severity: 'info',
    }
    try {
      await adminApi.createNotice(request)
      await loadOperations()
    } catch (error) {
      setOperationsError(error instanceof Error ? error.message : '공지 초안 생성에 실패했습니다.')
    } finally {
      setIsOperationsLoading(false)
    }
  }, [adminApi, loadOperations])

  const handleTransitionNotice = useCallback(
    async (noticeId: string, action: AdminNoticeAction) => {
      setIsOperationsLoading(true)
      setOperationsError(null)
      try {
        await adminApi.transitionNotice(noticeId, action)
        await loadOperations()
      } catch (error) {
        setOperationsError(error instanceof Error ? error.message : '공지 상태 변경에 실패했습니다.')
      } finally {
        setIsOperationsLoading(false)
      }
    },
    [adminApi, loadOperations],
  )

  const handleCreatePolicy = useCallback(async () => {
    setIsOperationsLoading(true)
    setOperationsError(null)
    // TODO(operations): PoC placeholder content. Replace with a policy form
    // (key/title/priority/rules inputs) before production use.
    const request: RecommendationPolicyRequest = {
      policyKey: 'small_city_balance',
      title: '소도시 노출 균형 정책',
      description: '품질 점수가 비슷한 후보에서는 과소 노출 소도시를 우선 고려합니다.',
      priority: 80,
      rules: {
        underExposedBoost: 0.15,
        maxSameRegionShare: 0.35,
      },
    }
    try {
      await adminApi.createRecommendationPolicy(request)
      await loadOperations()
    } catch (error) {
      setOperationsError(error instanceof Error ? error.message : '추천 정책 초안 생성에 실패했습니다.')
    } finally {
      setIsOperationsLoading(false)
    }
  }, [adminApi, loadOperations])

  const handleTransitionPolicy = useCallback(
    async (policyId: string, action: RecommendationPolicyAction) => {
      setIsOperationsLoading(true)
      setOperationsError(null)
      try {
        await adminApi.transitionRecommendationPolicy(policyId, action)
        await loadOperations()
      } catch (error) {
        setOperationsError(error instanceof Error ? error.message : '추천 정책 상태 변경에 실패했습니다.')
      } finally {
        setIsOperationsLoading(false)
      }
    },
    [adminApi, loadOperations],
  )

  // On first load without a cached/dev token, exchange the session cookie for an
  // access token. Failures are swallowed: an unauthenticated visitor simply sees
  // the "no session role" panel, and the backend still rejects any API call.
  useEffect(() => {
    if (getSessionRoles(accessToken).length > 0) {
      return
    }
    let isCurrent = true
    authClient
      .restoreSession()
      .then((session) => {
        if (isCurrent && session.accessToken) {
          storeAccessToken(session.accessToken)
          setAccessToken(session.accessToken)
        }
      })
      .catch(() => {
        // Unauthenticated or session expired; gating falls back to "no role".
      })
    return () => {
      isCurrent = false
    }
  }, [accessToken, authClient])

  useEffect(() => {
    if (sessionRoles.length === 0 || isTabAllowed(sessionRoles, activeTab)) {
      return
    }
    const task = window.setTimeout(() => {
      setActiveTab(currentRole ? roleDefaultTab[currentRole] : 'metrics')
    }, 0)
    return () => window.clearTimeout(task)
  }, [activeTab, currentRole, sessionRoles])

  useEffect(() => {
    if (!accessToken || activeTab !== 'metrics' || sessionRoles.length === 0) {
      return
    }
    const task = window.setTimeout(() => {
      void loadMetrics()
    }, 0)
    return () => window.clearTimeout(task)
  }, [accessToken, activeTab, sessionRoles, loadMetrics])

  // Dev preview: seed sample metrics when opted in and no real backend session,
  // so the Local Metrics panel shows its full dashboard instead of the fallback.
  useEffect(() => {
    if (!useSamplePreview) {
      return
    }
    const task = window.setTimeout(() => {
      setMetricsItems(sampleDestinationMetrics)
    }, 0)
    return () => window.clearTimeout(task)
  }, [useSamplePreview])

  useEffect(() => {
    if (!accessToken || activeTab !== 'operations' || !hasRole(sessionRoles, 'R-ADMIN')) {
      return
    }
    const task = window.setTimeout(() => {
      void loadOperations()
    }, 0)
    return () => window.clearTimeout(task)
  }, [accessToken, activeTab, sessionRoles, loadOperations])

  // Load the audit trail lazily, only when an admin opens the 감사 로그 tab.
  useEffect(() => {
    if (!accessToken || activeTab !== 'audit' || !hasRole(sessionRoles, 'R-ADMIN')) {
      return
    }
    const task = window.setTimeout(() => {
      void loadAudit(auditQuery.filters)
    }, 0)
    return () => window.clearTimeout(task)
  }, [accessToken, activeTab, sessionRoles, loadAudit, auditQuery])

  // Load pending high-risk requests eagerly (not only when the tab is open) so the
  // "권한 승인" tab can surface a pending-count badge for admins/super-admins.
  useEffect(() => {
    if (
      !accessToken ||
      (!hasRole(sessionRoles, 'R-ADMIN') && !hasRole(sessionRoles, 'R-SUPER-ADMIN'))
    ) {
      return
    }
    const task = window.setTimeout(() => {
      void loadHighRiskRequests()
    }, 0)
    return () => window.clearTimeout(task)
  }, [accessToken, sessionRoles, loadHighRiskRequests])

  const loadProposals = useCallback(async () => {
    setIsProposalLoading(true)
    setProposalError(null)
    try {
      const items = await adminApi.listProposals()
      setApiProposals(items)
    } catch (error) {
      setProposalError(error instanceof Error ? error.message : '제안 목록을 불러오지 못했습니다.')
      setApiProposals([])
    } finally {
      setIsProposalLoading(false)
    }
  }, [adminApi])

  useEffect(() => {
    if (!accessToken || sessionRoles.length === 0) {
      // Dev preview: with no real Bearer token the API is never called, so seed
      // sample proposals when explicitly opted in (VITE_LOVV_USE_SAMPLE_DATA=true).
      const shouldSeed = useSamplePreview
      const task = window.setTimeout(() => {
        if (shouldSeed) {
          setApiProposals(sampleProposals)
        }
        setIsProposalLoading(false)
      }, 0)
      return () => window.clearTimeout(task)
    }
    let isCurrent = true

    adminApi
      .listProposals()
      .then((items) => {
        if (isCurrent) {
          setApiProposals(items)
        }
      })
      .catch((error: unknown) => {
        if (isCurrent) {
          setProposalError(error instanceof Error ? error.message : '제안 목록을 불러오지 못했습니다.')
          setApiProposals([])
        }
      })
      .finally(() => {
        if (isCurrent) {
          setIsProposalLoading(false)
        }
      })

    return () => {
      isCurrent = false
    }
  }, [accessToken, adminApi, sessionRoles, useSamplePreview])

  const [publishJobs, setPublishJobs] = useState<PublishJob[]>([])
  const [jobsDestinationId, setJobsDestinationId] = useState<string | null>(null)
  const [isJobsLoading, setIsJobsLoading] = useState(false)
  const [jobsError, setJobsError] = useState<string | null>(null)
  const [isJobMutating, setIsJobMutating] = useState(false)

  const loadPublishJobs = useCallback(
    async (destinationId: string) => {
      setJobsDestinationId(destinationId)
      setIsJobsLoading(true)
      setJobsError(null)
      try {
        const items = await adminApi.listDestinationPublishJobs(destinationId)
        setPublishJobs(items)
      } catch (error) {
        setJobsError(error instanceof Error ? error.message : '반영 이력을 불러오지 못했습니다.')
        setPublishJobs([])
      } finally {
        setIsJobsLoading(false)
      }
    },
    [adminApi],
  )

  const handleJobTransition = useCallback(
    async (jobId: string, action: PublishJobAction) => {
      setIsJobMutating(true)
      setJobsError(null)
      try {
        await adminApi.transitionPublishJob(jobId, action)
        if (jobsDestinationId) {
          await loadPublishJobs(jobsDestinationId)
        }
      } catch (error) {
        setJobsError(error instanceof Error ? error.message : '반영 작업 상태 변경에 실패했습니다.')
      } finally {
        setIsJobMutating(false)
      }
    },
    [adminApi, jobsDestinationId, loadPublishJobs],
  )

  const [monthlyItems, setMonthlyItems] = useState<MonthlyDestination[]>([])
  const [isMonthlyLoading, setIsMonthlyLoading] = useState(false)
  const [monthlyError, setMonthlyError] = useState<string | null>(null)
  const [isMonthlyMutating, setIsMonthlyMutating] = useState(false)

  const loadMonthly = useCallback(async () => {
    setIsMonthlyLoading(true)
    setMonthlyError(null)
    try {
      const items = await adminApi.listMonthlyDestinations()
      setMonthlyItems(items)
    } catch (error) {
      setMonthlyError(error instanceof Error ? error.message : '월간 후보를 불러오지 못했습니다.')
      setMonthlyItems([])
    } finally {
      setIsMonthlyLoading(false)
    }
  }, [adminApi])

  // Load monthly candidates lazily, only when the 반영 상태 tab is opened.
  useEffect(() => {
    if (!accessToken || activeTab !== 'publish') {
      return
    }
    const task = window.setTimeout(() => {
      void loadMonthly()
    }, 0)
    return () => window.clearTimeout(task)
  }, [accessToken, activeTab, loadMonthly])

  const handleMonthlyTransition = useCallback(
    async (destinationId: string, action: MonthlyDestinationAction) => {
      setIsMonthlyMutating(true)
      setMonthlyError(null)
      try {
        await adminApi.transitionMonthlyDestination(destinationId, action)
        await loadMonthly()
        // If this destination's reflection history is open, refresh it so the
        // jobs created by a publish appear immediately.
        if (jobsDestinationId === destinationId) {
          await loadPublishJobs(destinationId)
        }
      } catch (error) {
        setMonthlyError(error instanceof Error ? error.message : '상태 변경에 실패했습니다.')
      } finally {
        setIsMonthlyMutating(false)
      }
    },
    [adminApi, loadMonthly, jobsDestinationId, loadPublishJobs],
  )

  function buildHighRiskRequestInput(): HighRiskChangeRequestInput {
    const operationType = highRiskForm.operationType
    const input: HighRiskChangeRequestInput = {
      operationType,
      reason: highRiskForm.reason.trim(),
    }
    if (isRoleHighRiskOperation(operationType)) {
      input.targetUserId = highRiskForm.targetUserId.trim()
      input.roleCode = highRiskForm.roleCode
      if (highRiskForm.organizationId.trim() && highRiskForm.roleCode !== 'R-SUPER-ADMIN') {
        input.organizationId = highRiskForm.organizationId.trim()
      }
      if (operationType === 'role_grant' && highRiskForm.validUntil.trim()) {
        input.validUntil = highRiskForm.validUntil.trim()
      }
    } else if (isRegionHighRiskOperation(operationType)) {
      input.targetUserId = highRiskForm.targetUserId.trim()
      input.regionId = highRiskForm.regionId.trim()
      if (highRiskForm.organizationId.trim()) {
        input.organizationId = highRiskForm.organizationId.trim()
      }
      if (operationType === 'region_grant' && highRiskForm.validUntil.trim()) {
        input.validUntil = highRiskForm.validUntil.trim()
      }
    } else {
      input.destinationIds = Array.from(
        new Set(
          highRiskForm.destinationIds
            .split(/[\s,]+/)
            .map((item) => item.trim())
            .filter(Boolean),
        ),
      )
    }
    return input
  }

  async function handleCreateHighRiskRequest() {
    setIsHighRiskMutating(true)
    setHighRiskError(null)
    try {
      const request = await adminApi.createHighRiskRequest(buildHighRiskRequestInput())
      setHighRiskRequests((items) => [request, ...items.filter((item) => item.id !== request.id)])
      setHighRiskForm(defaultHighRiskForm)
    } catch (error) {
      setHighRiskError(error instanceof Error ? error.message : '고위험 요청 생성에 실패했습니다.')
    } finally {
      setIsHighRiskMutating(false)
    }
  }

  // Perform the actual approve/reject call (assumes a valid MFA session already exists).
  async function runHighRiskDecision(action: 'approve' | 'reject', requestId: string, decisionReason: string) {
    if (action === 'approve') {
      await adminApi.approveHighRiskRequest(requestId, decisionReason ? { decisionReason } : {})
    } else {
      await adminApi.rejectHighRiskRequest(requestId, { decisionReason })
    }
    setHighRiskDecisionReason('')
    await loadHighRiskRequests()
  }

  function openDecisionMfaPrompt(pending: PendingDecision, notice: string | null) {
    setMfaCode('')
    setMfaRecoveryCode('')
    setMfaRecoveryCodes([])
    setMfaEnrollment(null)
    setMfaStatus(null)
    setMfaError(null)
    setIsMfaLoading(true)
    // Populate the credential status so the modal shows enroll vs. verify correctly.
    void adminApi
      .getMfaStatus()
      .then((status) => setMfaStatus(status))
      .catch((error) => {
        setMfaStatus(null)
        setMfaError(error instanceof Error ? error.message : 'MFA 상태를 확인하지 못했습니다.')
      })
      .finally(() => setIsMfaLoading(false))
    setMfaPrompt({ pending, notice })
  }

  function closeDecisionMfaPrompt() {
    setMfaPrompt(null)
    setMfaCode('')
    setMfaRecoveryCode('')
    setMfaRecoveryCodes([])
    setMfaEnrollment(null)
    setMfaError(null)
  }

  // MFA is enforced by the backend only at approve/reject time. Map the backend's
  // 403 codes to the right recovery UI instead of pre-verifying on the client.
  function handleHighRiskDecisionError(error: unknown, pending: PendingDecision) {
    if (error instanceof AdminApiError) {
      if (error.code === 'ADMIN_MFA_REQUIRED') {
        openDecisionMfaPrompt(pending, null)
        return
      }
      if (error.code === 'ADMIN_MFA_TOTP_REQUIRED') {
        openDecisionMfaPrompt(pending, '복구 코드로는 승인/거절할 수 없습니다. 인증 앱의 TOTP 코드를 입력하세요.')
        return
      }
      if (error.code === 'ADMIN_MFA_ENROLLMENT_REQUIRED') {
        openDecisionMfaPrompt(pending, 'MFA 등록이 필요합니다. 등록을 완료한 뒤 다시 시도하세요.')
        return
      }
      if (error.code === 'SUPER_ADMIN_REQUIRED') {
        setHighRiskError('슈퍼관리자 전용 작업입니다.')
        return
      }
      if (error.code === 'ADMIN_MFA_LOCKED' || error.status === 429) {
        setHighRiskError('추가 인증이 잠겼습니다. 잠시 후 다시 시도하세요.')
        return
      }
    }
    setHighRiskError(error instanceof Error ? error.message : '고위험 요청 결정에 실패했습니다.')
  }

  async function handleHighRiskDecision(action: 'approve' | 'reject', requestId: string) {
    const decisionReason = highRiskDecisionReason.trim()
    if (action === 'reject' && !decisionReason) {
      setHighRiskError('거절 사유를 입력해야 합니다.')
      return
    }
    setIsHighRiskMutating(true)
    setHighRiskError(null)
    try {
      await runHighRiskDecision(action, requestId, decisionReason)
    } catch (error) {
      handleHighRiskDecisionError(error, { action, requestId, decisionReason })
    } finally {
      setIsHighRiskMutating(false)
    }
  }

  // Called from the MFA modal: create a fresh TOTP session, then retry the pending decision.
  async function handleDecisionMfaVerify() {
    setIsMfaLoading(true)
    setMfaError(null)
    try {
      setMfaStatus(await adminApi.verifyMfa(mfaCode))
      setMfaCode('')
      const pending = mfaPrompt?.pending
      if (pending) {
        setIsHighRiskMutating(true)
        try {
          await runHighRiskDecision(pending.action, pending.requestId, pending.decisionReason)
          setMfaPrompt(null)
        } finally {
          setIsHighRiskMutating(false)
        }
      }
    } catch (error) {
      if (error instanceof AdminApiError && error.code === 'ADMIN_MFA_TOTP_REQUIRED') {
        setMfaError('인증 앱의 TOTP 코드가 필요합니다. 복구 코드로는 승인/거절할 수 없습니다.')
      } else {
        setMfaError(error instanceof Error ? error.message : 'MFA 인증에 실패했습니다.')
      }
    } finally {
      setIsMfaLoading(false)
    }
  }

  async function handleMfaEnroll() {
    setIsMfaLoading(true)
    setMfaError(null)
    try {
      setMfaEnrollment(await adminApi.enrollMfa())
      setMfaCode('')
    } catch (error) {
      setMfaError(error instanceof Error ? error.message : 'MFA 등록을 시작하지 못했습니다.')
    } finally {
      setIsMfaLoading(false)
    }
  }

  async function handleMfaConfirm() {
    setIsMfaLoading(true)
    setMfaError(null)
    try {
      const result = await adminApi.confirmMfa(mfaCode)
      setMfaStatus(result.status)
      setMfaRecoveryCodes(result.recoveryCodes)
      setMfaEnrollment(null)
      setMfaCode('')
    } catch (error) {
      setMfaError(error instanceof Error ? error.message : 'MFA 등록을 확인하지 못했습니다.')
    } finally {
      setIsMfaLoading(false)
    }
  }

  async function handleMfaRecover() {
    setIsMfaLoading(true)
    setMfaError(null)
    try {
      setMfaStatus(await adminApi.recoverMfa(mfaRecoveryCode))
      setMfaRecoveryCode('')
    } catch (error) {
      setMfaError(error instanceof Error ? error.message : '복구 코드 인증에 실패했습니다.')
    } finally {
      setIsMfaLoading(false)
    }
  }

  async function handleCreateProposal() {
    setIsProposalMutating(true)
    setProposalError(null)
    const request: AdminProposalRequest = {
      contentType: proposalDraft.type === 'activity' ? 'experience' : proposalDraft.type === 'tour' ? 'attraction' : 'festival',
      regionId: 'KR-42-150',
      cityName: proposalDraft.region,
      title: proposalDraft.title,
      description: proposalDraft.summary,
      evidenceText: proposalDraft.evidence,
      payload: {
        source: 'lovv-admin-web',
        draftType: proposalDraft.type,
      },
    }
    try {
      const proposal = await adminApi.createProposal(request)
      setApiProposals((items) => [proposal, ...items.filter((item) => item.id !== proposal.id)])
    } catch (error) {
      setProposalError(error instanceof Error ? error.message : '제안을 저장하지 못했습니다.')
    } finally {
      setIsProposalMutating(false)
    }
  }

  async function mutateProposal(action: 'review' | 'approve' | 'reject', proposalId: string) {
    setIsProposalMutating(true)
    setProposalError(null)
    try {
      const reviewNote =
        action === 'reject'
          ? '관리자 콘솔에서 반려했습니다.'
          : action === 'approve'
            ? '관리자 콘솔에서 승인했습니다.'
            : '관리자 콘솔에서 검토를 시작했습니다.'
      const proposal =
        action === 'review'
          ? await adminApi.reviewProposal(proposalId, reviewNote)
          : action === 'approve'
            ? await adminApi.approveProposal(proposalId, reviewNote)
            : await adminApi.rejectProposal(proposalId, reviewNote)
      setApiProposals((items) => items.map((item) => (item.id === proposal.id ? proposal : item)))
    } catch (error) {
      setProposalError(error instanceof Error ? error.message : '제안 상태를 변경하지 못했습니다.')
    } finally {
      setIsProposalMutating(false)
    }
  }

  async function handleLoadHistory(proposalId: string) {
    setIsHistoryLoading(true)
    setProposalError(null)
    try {
      const items = await adminApi.listProposalHistory(proposalId)
      setProposalHistory(items)
    } catch (error) {
      setProposalError(error instanceof Error ? error.message : '제안 이력을 불러오지 못했습니다.')
      setProposalHistory([])
    } finally {
      setIsHistoryLoading(false)
    }
  }

  return (
    <>
    <main className="app-shell" data-testid="lovv-admin-shell" data-theme="lovv">
      <header className="topbar">
        <div>
          <p className="eyebrow">Lovv Operations</p>
          <h1>Lovv Admin Console</h1>
        </div>
        <div className="operator-card" aria-label="현재 관리자 세션">
          <span className="operator-avatar" data-alignment="centered" data-testid="operator-avatar">
            A
          </span>
          <div className="operator-session">
            <strong>운영자 콘솔 세션</strong>
            <span className="session-type">API Session Preview</span>
            <span className="current-role-badge" data-testid="current-role-badge">
              현재 {roleBadgeLabel}
            </span>
            <span className="role-source-note">
              {useSamplePreview
                ? '개발 샘플 모드의 프리뷰 역할을 사용 중입니다.'
                : '세션 역할은 액세스 토큰에서 확인됩니다.'}
            </span>
          </div>
        </div>
      </header>

      {sessionRoles.length > 0 && <RoleStatusPanel sessionRoles={sessionRoles} />}

      <SummaryCards proposals={apiProposals} isLoading={isProposalLoading} />

      <ProposalInsights proposals={apiProposals} isLoading={isProposalLoading} />

      <nav className="tab-list" role="tablist" aria-label="관리자 콘솔 메뉴">
        {tabs.map((tab) => {
          const tabAllowed = isTabAllowed(sessionRoles, tab.id)
          const lockReason = getTabLockReason(sessionRoles, tab.label)
          const lockReasonId = `admin-tab-${tab.id}-lock-reason`

          return (
            <button
              aria-controls={`admin-panel-${tab.id}`}
              aria-describedby={tabAllowed ? undefined : lockReasonId}
              aria-disabled={!tabAllowed}
              aria-label={tab.label}
              aria-selected={activeTab === tab.id}
              className={activeTab === tab.id ? 'tab-button active' : 'tab-button'}
              data-locked={tabAllowed ? undefined : 'true'}
              disabled={!tabAllowed}
              id={`admin-tab-${tab.id}`}
              key={tab.id}
              onClick={() => {
                if (tabAllowed) {
                  setActiveTab(tab.id)
                }
              }}
              role="tab"
              type="button"
            >
              <span className="tab-label">{tab.label}</span>
              {tab.id === 'highRisk' && tabAllowed && highRiskRequests.length > 0 ? (
                <span
                  className="tab-pending-badge"
                  aria-label={`승인 대기 ${formatPendingCountText(highRiskRequests.length)}`}
                >
                  {formatPendingBadge(highRiskRequests.length)}
                </span>
              ) : null}
              {!tabAllowed && (
                <>
                  <span className="tab-lock" aria-hidden="true">
                    잠금
                  </span>
                  <span className="tab-lock-reason" id={lockReasonId}>
                    {lockReason}
                  </span>
                </>
              )}
            </button>
          )
        })}
      </nav>

      <div aria-labelledby={`admin-tab-${activeTab}`} className="tab-panel" id={activePanelId} role="tabpanel">
        {sessionRoles.length === 0 ? (
          <NoSessionRolePanel />
        ) : (
          <>
            {activeTab === 'metrics' && (
              <div className="stack">
                <LocalOperatorMetrics
                  items={metricsItems}
                  isLoading={isMetricsLoading}
                  errorMessage={metricsError}
                  metricsLabel={metricsLabel}
                  onRefresh={() => void loadMetrics()}
                />
              </div>
            )}
            {activeTab === 'proposal' && (
              <DataProposalPanel
                canSaveProposal={hasRole(sessionRoles, 'R-DATA-PROVIDER')}
                isSubmitting={isProposalMutating}
                onCreateProposal={handleCreateProposal}
              />
            )}
            {activeTab === 'review' && (
              <ReviewQueuePanel
                canMakeDecision={hasRole(sessionRoles, 'R-ADMIN')}
                proposals={apiProposals}
                isLoading={isProposalLoading}
                errorMessage={proposalError}
                isMutating={isProposalMutating}
                onRefresh={loadProposals}
                onReview={(proposalId) => void mutateProposal('review', proposalId)}
                onApprove={(proposalId) => void mutateProposal('approve', proposalId)}
                onReject={(proposalId) => void mutateProposal('reject', proposalId)}
                onLoadHistory={(proposalId) => void handleLoadHistory(proposalId)}
                historyItems={proposalHistory}
                isHistoryLoading={isHistoryLoading}
              />
            )}
            {activeTab === 'publish' && (
              <MonthlyDestinationPanel
                items={monthlyItems}
                isLoading={isMonthlyLoading}
                errorMessage={monthlyError}
                isMutating={isMonthlyMutating}
                canManage={hasRole(sessionRoles, 'R-ADMIN')}
                onTransition={(destinationId, action) => void handleMonthlyTransition(destinationId, action)}
                onRefresh={() => void loadMonthly()}
                jobs={publishJobs}
                jobsDestinationId={jobsDestinationId}
                isJobsLoading={isJobsLoading}
                jobsError={jobsError}
                isJobMutating={isJobMutating}
                onLoadJobs={(destinationId) => void loadPublishJobs(destinationId)}
                onJobTransition={(jobId, action) => void handleJobTransition(jobId, action)}
              />
            )}
            {activeTab === 'operations' && (
              <OperationsPolicyPanel
                notices={notices}
                policies={policies}
                isLoading={isOperationsLoading}
                errorMessage={operationsError}
                onRefresh={() => void loadOperations()}
                onCreateNotice={() => void handleCreateNotice()}
                onTransitionNotice={(noticeId, action) => void handleTransitionNotice(noticeId, action)}
                onCreatePolicy={() => void handleCreatePolicy()}
                onTransitionPolicy={(policyId, action) => void handleTransitionPolicy(policyId, action)}
              />
            )}
            {activeTab === 'highRisk' && (
              <HighRiskRequestPanel
                requests={highRiskRequests}
                form={highRiskForm}
                decisionReason={highRiskDecisionReason}
                isLoading={isHighRiskLoading}
                isMutating={isHighRiskMutating}
                errorMessage={highRiskError}
                canCreate={hasRole(sessionRoles, 'R-ADMIN') || hasRole(sessionRoles, 'R-SUPER-ADMIN')}
                canDecide={hasRole(sessionRoles, 'R-SUPER-ADMIN')}
                onFormChange={setHighRiskForm}
                onDecisionReasonChange={setHighRiskDecisionReason}
                onCreate={() => void handleCreateHighRiskRequest()}
                onApprove={(requestId) => void handleHighRiskDecision('approve', requestId)}
                onReject={(requestId) => void handleHighRiskDecision('reject', requestId)}
                onRefresh={() => void loadHighRiskRequests()}
              />
            )}
            {activeTab === 'audit' && (
              <AuditLogPanel
                entries={auditEntries}
                isLoading={isAuditLoading}
                errorMessage={auditError}
                filters={auditQuery.filters}
                onApplyFilters={applyAuditFilters}
                onRefresh={requestAuditRefresh}
              />
            )}
          </>
        )}
      </div>
    </main>
    {mfaPrompt ? (
      <div className="modal-backdrop" role="presentation">
        <div
          aria-labelledby="decision-mfa-title"
          aria-modal="true"
          className="mfa-modal"
          role="dialog"
        >
          <div className="modal-heading">
            <div>
              <p className="eyebrow">High-risk decision</p>
              <h2 id="decision-mfa-title">승인 추가 인증</h2>
            </div>
            <button
              aria-label="MFA 모달 닫기"
              className="ghost-button"
              disabled={isMfaLoading || isHighRiskMutating}
              onClick={closeDecisionMfaPrompt}
              type="button"
            >
              닫기
            </button>
          </div>
          {mfaPrompt.notice ? <p className="mfa-notice">{mfaPrompt.notice}</p> : null}
          <AdminMfaGate
            status={mfaStatus}
            enrollment={mfaEnrollment}
            recoveryCodes={mfaRecoveryCodes}
            code={mfaCode}
            recoveryCode={mfaRecoveryCode}
            isLoading={isMfaLoading || isHighRiskMutating}
            errorMessage={mfaError}
            hideRecovery
            onCodeChange={setMfaCode}
            onRecoveryCodeChange={setMfaRecoveryCode}
            onEnroll={() => void handleMfaEnroll()}
            onConfirm={() => void handleMfaConfirm()}
            onVerify={() => void handleDecisionMfaVerify()}
            onRecover={() => void handleMfaRecover()}
            onAcknowledgeRecoveryCodes={() => setMfaRecoveryCodes([])}
          />
        </div>
      </div>
    ) : null}
    </>
  )
}
