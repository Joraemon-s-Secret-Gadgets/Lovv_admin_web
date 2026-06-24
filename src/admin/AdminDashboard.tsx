// Admin console shell. The active session role is derived from the access token
// (see ./session), and that role gates which tabs/actions are shown. All proposal
// data flows through ./adminApi; the backend re-authorizes every call, so this
// gating is UX, not a security boundary.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { createAdminApiClient, createAdminAuthClient } from './adminApi'
import { localMetrics, proposalDraft, roleLanes, summaryMetrics } from './adminData'
import { getSessionRoles, getStoredAccessToken, resolvePrimaryRole, storeAccessToken } from './session'
import type {
  AdminNotice,
  AdminNoticeAction,
  AdminNoticeRequest,
  AdminProposalRequest,
  AdminRole,
  AdminTab,
  AuditLogEntry,
  DestinationMetricsSummary,
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
  { id: 'audit', label: '감사 로그' },
]

// Which tabs each role may open. Mirrors the backend role matrix; the server is
// still the enforcer (a hidden tab's API would 403 anyway).
const roleTabPermissions: RoleTabPermissions = {
  'R-LOCAL-OPERATOR': ['metrics'],
  'R-DATA-PROVIDER': ['proposal'],
  'R-ADMIN': ['metrics', 'review', 'publish', 'operations', 'audit'],
}

const roleDefaultTab: Record<AdminRole, AdminTab> = {
  'R-LOCAL-OPERATOR': 'metrics',
  'R-DATA-PROVIDER': 'proposal',
  'R-ADMIN': 'metrics',
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

function isTabAllowed(role: AdminRole | null, tabId: AdminTab) {
  return role ? roleTabPermissions[role].includes(tabId) : false
}

function getTabLockReason(role: AdminRole | null, tabLabel: string) {
  return `역할 접근 제한: ${role ?? '권한 없음'} 역할은 ${tabLabel} 작업 영역을 사용할 수 없습니다.`
}

function SummaryCards() {
  return (
    <section className="summary-grid" aria-label="관리자 처리 현황">
      {summaryMetrics.map((metric) => (
        <article className={`summary-card ${toneLabelClassNames[metric.tone]}`} key={metric.label}>
          <span>{metric.label}</span>
          <strong>{metric.value}</strong>
          <p>{metric.detail}</p>
        </article>
      ))}
    </section>
  )
}

function RoleStatusPanel() {
  return (
    <section className="panel" aria-labelledby="role-status-title">
      <div className="section-heading">
        <span className="section-kicker">Role Gate</span>
        <h2 id="role-status-title">역할 확인</h2>
      </div>
      <div className="role-lanes">
        {roleLanes.map((lane) => (
          <article className="role-lane" key={lane.role}>
            <span className="role-badge">{lane.role}</span>
            <h3>{lane.title}</h3>
            <p>{lane.description}</p>
            <ul>
              {lane.responsibilities.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </article>
        ))}
      </div>
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
  onRefresh,
}: {
  items: DestinationMetricsSummary[]
  isLoading: boolean
  errorMessage: string | null
  onRefresh: () => void
}) {
  const dashboard = buildLocalOperatorDashboard(items)

  return (
    <section className="panel" aria-labelledby="local-metrics-title">
      <div className="section-heading">
        <span className="section-kicker">Local Metrics</span>
        <h2 id="local-metrics-title">담당 지역 데이터 운영 지표 조회</h2>
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
          <div className="metric-table" role="table" aria-label="담당 지역 운영 지표">
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
        <div className="metric-table" role="table" aria-label="담당 지역 운영 지표 예시">
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

// 감사 로그 tab: read-only audit trail (most recent admin mutations) and the
// console's primary monitoring surface.
function AuditLogPanel({
  entries,
  isLoading,
  errorMessage,
  onRefresh,
}: {
  entries: AuditLogEntry[]
  isLoading: boolean
  errorMessage: string | null
  onRefresh: () => void
}) {
  return (
    <section className="panel" aria-labelledby="audit-title">
      <div className="section-heading">
        <span className="section-kicker">Audit Trail</span>
        <h2 id="audit-title">감사 로그</h2>
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
        <p>감사 로그를 불러오는 중입니다.</p>
      ) : entries.length === 0 ? (
        <p>기록된 감사 로그가 없습니다.</p>
      ) : (
        <table aria-label="감사 로그 목록">
          <thead>
            <tr>
              <th scope="col">시각</th>
              <th scope="col">행위자</th>
              <th scope="col">액션</th>
              <th scope="col">대상</th>
              <th scope="col">결과</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id}>
                <td>{entry.occurredAt ?? '-'}</td>
                <td>{entry.actorUserId ?? '-'}</td>
                <td>{entry.action}</td>
                <td>
                  {entry.resourceType ?? '-'}
                  {entry.resourceId ? ` · ${entry.resourceId}` : ''}
                </td>
                <td>
                  <span className={`status-pill status-${entry.result}`}>{auditResultLabels[entry.result]}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
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
  currentRole,
  isSubmitting,
  onCreateProposal,
}: {
  currentRole: AdminRole
  isSubmitting: boolean
  onCreateProposal: () => void
}) {
  const canSaveProposal = currentRole === 'R-DATA-PROVIDER'

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
  currentRole,
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
  currentRole: AdminRole
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
  const canMakeDecision = currentRole === 'R-ADMIN'
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

export function AdminDashboard() {
  // Access token drives both the API client (Bearer header) and the session role.
  // Initial value is the cached token (survives refresh); if absent we restore it
  // from /api/v1/auth/session below. getSessionRoles() also falls back to the Vite
  // dev token, so local development still works without a real login.
  const [accessToken, setAccessToken] = useState<string>(() => getStoredAccessToken())
  // Session role comes from the token, not a manual switcher, so the UI matches
  // what the backend will actually allow for this caller.
  const sessionRoles = useMemo(() => getSessionRoles(accessToken), [accessToken])
  const currentRole = useMemo(() => resolvePrimaryRole(sessionRoles), [sessionRoles])
  const [activeTab, setActiveTab] = useState<AdminTab>(() =>
    currentRole ? roleDefaultTab[currentRole] : 'metrics',
  )
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
  const [isAuditLoading, setIsAuditLoading] = useState(false)
  const [auditError, setAuditError] = useState<string | null>(null)

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

  const loadAudit = useCallback(async () => {
    setIsAuditLoading(true)
    setAuditError(null)
    try {
      const items = await adminApi.listAuditLogs({ limit: 50 })
      setAuditEntries(items)
    } catch (error) {
      setAuditError(error instanceof Error ? error.message : '감사 로그를 불러오지 못했습니다.')
      setAuditEntries([])
    } finally {
      setIsAuditLoading(false)
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
    if (!accessToken || activeTab !== 'metrics' || !currentRole) {
      return
    }
    void loadMetrics()
  }, [accessToken, activeTab, currentRole, loadMetrics])

  useEffect(() => {
    if (!accessToken || activeTab !== 'operations' || currentRole !== 'R-ADMIN') {
      return
    }
    void loadOperations()
  }, [accessToken, activeTab, currentRole, loadOperations])

  // Load the audit trail lazily, only when an admin opens the 감사 로그 tab.
  useEffect(() => {
    if (!accessToken || activeTab !== 'audit' || currentRole !== 'R-ADMIN') {
      return
    }
    void loadAudit()
  }, [accessToken, activeTab, currentRole, loadAudit])

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
    if (!accessToken || !currentRole) {
      setIsProposalLoading(false)
      return
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
  }, [accessToken, adminApi, currentRole])

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
    void loadMonthly()
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
              현재 {currentRole ?? '역할 없음'}
            </span>
            <span className="role-source-note">세션 역할은 액세스 토큰에서 확인됩니다.</span>
          </div>
        </div>
      </header>

      <SummaryCards />

      <nav className="tab-list" role="tablist" aria-label="관리자 콘솔 메뉴">
        {tabs.map((tab) => {
          const tabAllowed = isTabAllowed(currentRole, tab.id)
          const lockReason = getTabLockReason(currentRole, tab.label)
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
        {!currentRole ? (
          <NoSessionRolePanel />
        ) : (
          <>
            {activeTab === 'metrics' && (
              <div className="stack">
                <RoleStatusPanel />
                <LocalOperatorMetrics
                  items={metricsItems}
                  isLoading={isMetricsLoading}
                  errorMessage={metricsError}
                  onRefresh={() => void loadMetrics()}
                />
              </div>
            )}
            {activeTab === 'proposal' && (
              <DataProposalPanel
                currentRole={currentRole}
                isSubmitting={isProposalMutating}
                onCreateProposal={handleCreateProposal}
              />
            )}
            {activeTab === 'review' && (
              <ReviewQueuePanel
                currentRole={currentRole}
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
                canManage={currentRole === 'R-ADMIN'}
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
            {activeTab === 'audit' && (
              <AuditLogPanel
                entries={auditEntries}
                isLoading={isAuditLoading}
                errorMessage={auditError}
                onRefresh={() => void loadAudit()}
              />
            )}
          </>
        )}
      </div>
    </main>
  )
}
