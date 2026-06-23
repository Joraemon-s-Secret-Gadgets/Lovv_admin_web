import type { LocalMetric, ProposalDraft, PublishEvent, RoleLane, SummaryMetric } from './types'

export const summaryMetrics: SummaryMetric[] = [
  {
    label: '제출 제안',
    value: 'API',
    detail: '백엔드 제안 목록 기준',
    tone: 'amber',
  },
  {
    label: '승인 완료',
    value: '실시간',
    detail: '승인 상태 전환 반영',
    tone: 'green',
  },
  {
    label: '반려/수정 요청',
    value: '이력',
    detail: '검토 이력으로 추적',
    tone: 'red',
  },
  {
    label: '반영 상태',
    value: '다음 단계',
    detail: '승인 데이터 반영 작업에서 연결',
    tone: 'blue',
  },
]

export const roleLanes: RoleLane[] = [
  {
    role: 'R-LOCAL-OPERATOR',
    title: '담당 지역 운영 지표 조회',
    description: '지역 운영자는 담당 지역의 제안과 운영 지표를 조회합니다. 승인·반려 결정은 관리자 권한에서만 처리합니다.',
    responsibilities: ['담당 지역 제안 조회', '지역 운영 지표 확인', '수요 분산/관심도 확인', '데이터 최신성 모니터링'],
  },
  {
    role: 'R-DATA-PROVIDER',
    title: '관광지/축제/체험 데이터 제안',
    description: '데이터 제공자는 공식 근거와 함께 관광 데이터를 제안하고, 제출 이후 검토 상태를 확인합니다.',
    responsibilities: ['관광지/명소 제안', '축제/행사 제안', '체험/액티비티 제안', '공식 링크와 설명 첨부'],
  },
  {
    role: 'R-ADMIN',
    title: '데이터 제안 검토',
    description: '관리자는 제출된 제안의 근거를 확인하고 검토·승인·반려 상태를 변경합니다.',
    responsibilities: ['제안 목록 조회', '검토 시작', '승인/반려 결정', '변경 이력 확인'],
  },
]

export const localMetrics: LocalMetric[] = [
  { label: '강릉 제안 조회', value: 'API 연동 예정', trend: '+0%' },
  { label: '추천 노출 전환', value: '다음 단계', trend: '+0%' },
  { label: '리뷰 수집', value: '다음 단계', trend: '+0' },
  { label: '데이터 최신성 경고', value: '다음 단계', trend: '-0' },
]

export const proposalDraft: ProposalDraft = {
  type: 'festival',
  title: '강릉 커피축제 공식 정보 갱신',
  region: '강릉',
  evidence: '공식 홈페이지 공지와 운영 일정 링크를 근거로 제출합니다.',
  summary: '강릉 커피축제 일정, 공식 링크, 주요 프로그램 정보를 최신 데이터로 갱신합니다.',
}

export const publishEvents: PublishEvent[] = [
  {
    key: 'approved',
    title: '제안 승인 완료',
    status: 'approved',
    description: '관리자가 제안을 승인하면 이력과 approvedContentHash가 저장됩니다.',
    timestamp: '5번 완료',
  },
  {
    key: 'publish',
    title: '서비스 데이터 반영',
    status: 'published',
    description: '승인 데이터를 실제 추천/월간 여행지 데이터로 반영하는 작업은 다음 단계에서 연결합니다.',
    timestamp: '7번 예정',
  },
  {
    key: 'index',
    title: '추천/RAG 인덱스 갱신',
    status: 'indexed',
    description: '반영된 데이터를 추천 후보와 검색 인덱스에 동기화합니다.',
    timestamp: '7번 이후',
  },
]
