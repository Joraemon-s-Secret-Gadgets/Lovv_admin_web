// Admin console shell. The active session role is derived from the access token
// (see ./session), and that role gates which tabs/actions are shown. All proposal
// data flows through ./adminApi; the backend re-authorizes every call, so this
// gating is UX, not a security boundary.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { createAdminApiClient } from './adminApi'
import { localMetrics, proposalDraft, publishEvents, roleLanes, summaryMetrics } from './adminData'
import { getSessionRoles, resolvePrimaryRole } from './session'
import type {
  AdminProposalRequest,
  AdminRole,
  AdminTab,
  ProposalHistoryItem,
  ProposalStatus,
  ReviewProposal,
  RoleTabPermissions,
  SummaryMetric,
} from './types'

const tabs: { id: AdminTab; label: string }[] = [
  { id: 'metrics', label: '운영 지표' },
  { id: 'proposal', label: '데이터 제안' },
  { id: 'review', label: '제안 검토' },
  { id: 'publish', label: '반영 상태' },
]

// Which tabs each role may open. Mirrors the backend role matrix; the server is
// still the enforcer (a hidden tab's API would 403 anyway).
const roleTabPermissions: RoleTabPermissions = {
  'R-LOCAL-OPERATOR': ['metrics'],
  'R-DATA-PROVIDER': ['proposal'],
  'R-ADMIN': ['metrics', 'review', 'publish'],
}

const roleDefaultTab: Record<AdminRole, AdminTab> = {
  'R-LOCAL-OPERATOR': 'metrics',
  'R-DATA-PROVIDER': 'proposal',
  'R-ADMIN': 'metrics',
}

const statusLabels: Record<ProposalStatus, string> = {
  draft: '초안',
  pending: '대기',
  submitted: '제출',
  in_review: '검토중',
  approved: '승인',
  rejected: '반려',
  change_requested: '수정 요청',
  withdrawn: '철회',
  archived: '보관',
  published: '반영',
  indexed: '인덱스 갱신',
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

function LocalOperatorMetrics() {
  return (
    <section className="panel" aria-labelledby="local-metrics-title">
      <div className="section-heading">
        <span className="section-kicker">Local Metrics</span>
        <h2 id="local-metrics-title">담당 지역 데이터 운영 지표 조회</h2>
      </div>
      <div className="metric-table" role="table" aria-label="담당 지역 운영 지표">
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
            <div className="decision-actions">
              <button
                type="button"
                className="approve-button"
                onClick={() => selectedProposal && onReview(selectedProposal.id)}
                disabled={!selectedProposal || isMutating}
              >
                검토 시작
              </button>
              <button
                type="button"
                className="approve-button"
                onClick={() => selectedProposal && onApprove(selectedProposal.id)}
                disabled={!selectedProposal || isMutating}
              >
                승인
              </button>
              <button
                type="button"
                className="reject-button"
                onClick={() => selectedProposal && onReject(selectedProposal.id)}
                disabled={!selectedProposal || isMutating}
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

function PublishStatusTimeline() {
  return (
    <section className="panel" aria-labelledby="publish-title">
      <div className="section-heading">
        <span className="section-kicker">Publish Pipeline</span>
        <h2 id="publish-title">데이터 반영 타임라인</h2>
      </div>
      <ol className="timeline">
        {publishEvents.map((event) => (
          <li key={event.key}>
            <time>{event.timestamp}</time>
            <div>
              <h3>{event.title}</h3>
              <p>{event.description}</p>
              <span
                className={`status-pill status-${event.status}`}
                data-alignment="centered"
                data-contrast={getStatusContrast(event.status)}
              >
                {statusLabels[event.status]}
              </span>
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
}

export function AdminDashboard() {
  // Session role comes from the token, not a manual switcher, so the UI matches
  // what the backend will actually allow for this caller.
  const sessionRoles = useMemo(() => getSessionRoles(), [])
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
  const adminApi = useMemo(() => createAdminApiClient(), [])

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
  }, [adminApi])

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
                <LocalOperatorMetrics />
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
            {activeTab === 'publish' && <PublishStatusTimeline />}
          </>
        )}
      </div>
    </main>
  )
}
