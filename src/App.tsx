import { useEffect, useRef, useState } from 'react'
import {
  Activity,
  ArrowDown,
  ArrowRight,
  Check,
  CheckCheck,
  ChevronDown,
  CircleHelp,
  Clock3,
  Gavel,
  Headphones,
  MessageSquareText,
  Mic2,
  MoreHorizontal,
  Pause,
  Play,
  Radio,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  X,
} from 'lucide-react'

type Side = 'pro' | 'con'
type Turn = { name: string; role: string; side: Side; kind: string }
type Statement = { speaker: string; side: Side; kind: string; text: string; time: string }
type Request = { id: number; name: string; side: Side; target: string; reason: string }
type JudgeScore = { pro: number; con: number; rationale: string }
type OllamaMessage = { role: 'system' | 'user' | 'assistant'; content: string }

const defaultDebateModel = 'qwen2.5:3b'
const judgeModel = 'qwen2.5:1.5b'
const freeMonitorIntervalMs = 5000

function cleanSpeech(text: string) {
  return text.replace(/^\s*(?:(?:[가-힣]{2,4})|(?:찬성\s*측)|(?:반대\s*측))\s*[:：]\s*/, '').trimStart()
}

async function ollamaChat(model: string, messages: OllamaMessage[], json = false) {
  const response = await fetch('/ollama/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: false, ...(json ? { format: 'json', options: { temperature: 0, num_predict: 160 } } : {}) }),
  })
  if (!response.ok) throw new Error(`Ollama 요청 실패 (${response.status})`)
  const result = await response.json() as { message?: { content?: string } }
  if (!result.message?.content) throw new Error('모델 응답이 비어 있습니다.')
  return result.message.content
}

async function streamOllamaChat(
  model: string,
  messages: OllamaMessage[],
  signal: AbortSignal,
  onUpdate: (text: string) => void,
) {
  const response = await fetch('/ollama/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: true, options: { num_predict: 280, temperature: 0.7 } }),
    signal,
  })
  if (!response.ok) throw new Error(`Ollama 요청 실패 (${response.status})`)
  if (!response.body) throw new Error('Ollama 스트림을 읽을 수 없습니다.')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let generated = ''
  const readLine = (line: string) => {
    if (!line.trim()) return
    const event = JSON.parse(line) as { message?: { content?: string }; done?: boolean; error?: string }
    if (event.error) throw new Error(event.error)
    generated += event.message?.content ?? ''
    onUpdate(generated)
  }

  while (true) {
    const { value, done } = await reader.read()
    buffer += decoder.decode(value, { stream: !done })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    lines.forEach(readLine)
    if (done) break
  }
  if (buffer.trim()) readLine(buffer)
  return generated.trim()
}

function parseModelJson<T>(content: string): T {
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  return JSON.parse(cleaned) as T
}

const turns: Turn[] = [
  { name: '서윤', role: '정책 분석가', side: 'pro', kind: '입론' },
  { name: '도현', role: '기술 윤리학자', side: 'con', kind: '입론' },
  { name: '지민', role: '도시 데이터 연구자', side: 'pro', kind: '반론' },
  { name: '하준', role: '인권 변호사', side: 'con', kind: '반론' },
  { name: '유나', role: '공공안전 전문가', side: 'pro', kind: '최종 정리' },
  { name: '민재', role: '시민사회 활동가', side: 'con', kind: '최종 정리' },
]

const judges = [
  { name: '논리 구조', initials: '논', rubric: '주장, 근거, 결론의 연결과 논리적 일관성' },
  { name: '근거의 질', initials: '근', rubric: '근거의 구체성, 신뢰성, 주장과의 관련성' },
  { name: '반박 능력', initials: '반', rubric: '상대 측 핵심 논거를 정확히 다루고 반박하는 능력' },
  { name: '설득력', initials: '설', rubric: '설명의 명료성, 청중 설득력, 제안의 현실성' },
  { name: '균형과 명료성', initials: '균', rubric: '정책 영향과 한계를 균형 있게 다루는 정도 및 표현의 명료성' },
]

function App() {
  const [phase, setPhase] = useState<'structured' | 'free'>('structured')
  const [currentTurn, setCurrentTurn] = useState(0)
  const [statements, setStatements] = useState<Statement[]>([])
  const [requests, setRequests] = useState<Request[]>([])
  const [topic, setTopic] = useState('')
  const [topicChecked, setTopicChecked] = useState(false)
  const [topicReason, setTopicReason] = useState('')
  const [debateStarted, setDebateStarted] = useState(false)
  const [debateFinished, setDebateFinished] = useState(false)
  const [moderatorPrompt, setModeratorPrompt] = useState('')
  const [toast, setToast] = useState('')
  const [scores, setScores] = useState<JudgeScore[] | null>(null)
  const [paused, setPaused] = useState(false)
  const [availableModels, setAvailableModels] = useState<string[]>([])
  const [generating, setGenerating] = useState(false)
  const [judging, setJudging] = useState(false)
  const [monitoring, setMonitoring] = useState(false)
  const [monitorBusy, setMonitorBusy] = useState(false)
  const [draft, setDraft] = useState<Statement | null>(null)
  const [topicChecking, setTopicChecking] = useState(false)
  const [debateModel, setDebateModel] = useState(defaultDebateModel)
  const generationController = useRef<AbortController | null>(null)
  const monitorBusyRef = useRef(false)
  const transcriptListRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void window.debate?.getRuntimeConfig().then((config) => {
      if (config.dialogueModel) setDebateModel(config.dialogueModel)
    }).catch((error: unknown) => {
      console.warn('Could not read installed model configuration:', error)
    })
  }, [])

  useEffect(() => {
    const transcriptList = transcriptListRef.current
    if (transcriptList) transcriptList.scrollTop = transcriptList.scrollHeight
  }, [statements.length, draft?.text])

  useEffect(() => {
    let mounted = true
    const checkOllama = async () => {
      try {
        const response = await fetch('/ollama/api/tags')
        if (!response.ok) throw new Error('Ollama unavailable')
        const result = await response.json() as { models?: Array<{ name: string }> }
        if (mounted) setAvailableModels((result.models ?? []).map((model) => model.name))
      } catch {
        if (mounted) setAvailableModels([])
      }
    }
    void checkOllama()
    const interval = window.setInterval(checkOllama, 15000)
    return () => {
      mounted = false
      window.clearInterval(interval)
    }
  }, [])

  useEffect(() => {
    if (phase !== 'free' || !monitoring || monitorBusy || generating || requests.length > 0 || debateFinished) return
    const timer = window.setTimeout(() => void runFreeMonitor(statements), freeMonitorIntervalMs)
    return () => window.clearTimeout(timer)
  }, [phase, monitoring, monitorBusy, generating, requests.length, debateFinished, statements])

  const announce = (message: string) => {
    setToast(message)
    window.setTimeout(() => setToast(''), 2600)
  }

  const nextTurn = async () => {
    if (currentTurn >= turns.length) {
      setPhase('free')
      announce('순차 토론이 끝났습니다. 자유 토론으로 전환합니다.')
      return
    }
    const turn = turns[currentTurn]
    const controller = new AbortController()
    generationController.current = controller
    const timestamp = new Date().toLocaleTimeString('ko-KR', { hour12: false })
    let generated = ''
    setGenerating(true)
    setDraft({ speaker: turn.name, side: turn.side, kind: `${turn.kind} · 생성 중`, text: '', time: timestamp })
    try {
      const transcript = statements.map((item) => `${item.speaker}(${item.side === 'pro' ? '찬성' : '반대'}): ${item.text}`).join('\n\n')
      const response = await streamOllamaChat(debateModel, [
        { role: 'system', content: `당신은 3대3 토론의 ${turn.name}입니다. 역할은 ${turn.role}, 입장은 ${turn.side === 'pro' ? '찬성' : '반대'}, 이번 발언은 ${turn.kind}입니다. 한국어로 논제와 앞선 발언에 직접 대응하는 토론 발언만 작성하세요. 3~5문장으로 제한하고, 발언자의 이름이나 콜론으로 시작하는 머리말 없이 발언 본문만 출력하세요.` },
        { role: 'user', content: `논제: ${topic}\n\n사회자 지시: ${moderatorPrompt.trim() || '(추가 지시 없음)'}\n\n지금까지의 기록:\n${transcript || '(첫 발언)'}\n\n이번 차례의 발언을 작성하세요.` },
      ], controller.signal, (text) => {
        generated = cleanSpeech(text)
        setDraft({ speaker: turn.name, side: turn.side, kind: `${turn.kind} · 생성 중`, text: generated, time: timestamp })
      })
      generated = cleanSpeech(response)
      if (response) setStatements((items) => [...items, { speaker: turn.name, side: turn.side, kind: turn.kind, text: response, time: timestamp }])
      setCurrentTurn((index) => index + 1)
      setModeratorPrompt('')
      setPaused(false)
    } catch (error) {
      if (controller.signal.aborted) {
        if (generated.trim()) setStatements((items) => [...items, { speaker: turn.name, side: turn.side, kind: `${turn.kind} · 중지됨`, text: generated.trim(), time: timestamp }])
      } else {
        announce(error instanceof Error ? error.message : 'Ollama 발언 생성에 실패했습니다.')
      }
    } finally {
      generationController.current = null
      setDraft(null)
      setGenerating(false)
    }
  }

  const forceStop = () => {
    if (generationController.current) {
      generationController.current.abort()
      setCurrentTurn((index) => Math.min(index + 1, turns.length))
      setPaused(false)
      announce('생성을 중지하고 다음 순서로 넘겼습니다.')
      return
    }
    if (currentTurn >= turns.length) {
      setPhase('free')
      return
    }
    setCurrentTurn((index) => index + 1)
    setPaused(false)
    announce('현재 발언을 중지하고 다음 순서로 넘겼습니다.')
  }

  const startDebate = () => {
    if (!topicChecked) return
    setDebateStarted(true)
    setDebateFinished(false)
    announce('토론을 시작합니다. 첫 발언자는 서윤입니다.')
  }

  const resolveRequest = async (request: Request, approved: boolean) => {
    setRequests((items) => items.filter((item) => item.id !== request.id))
    if (!approved) {
      announce(`${request.name}의 발언 요청을 거절했습니다.`)
      if (monitoring) void runFreeMonitor(statements, [request.name])
      return
    }
    setGenerating(true)
    try {
      const transcript = statements.map((item) => `${item.speaker}(${item.side === 'pro' ? '찬성' : '반대'}): ${item.text}`).join('\n\n')
      const response = await ollamaChat(debateModel, [
        { role: 'system', content: `당신은 ${request.name}, ${request.side === 'pro' ? '찬성' : '반대'} 측 토론자입니다. 요청을 승인받았으므로 한국어로 2~4문장의 간결한 자유 발언을 작성하세요. 상대의 논점에 직접 대응하고, 발언자 이름이나 콜론으로 시작하는 머리말 없이 본문만 출력하세요.` },
        { role: 'user', content: `논제: ${topic}\n요청 내용: ${request.reason}\n발언 대상: ${request.target}\n\n토론 기록:\n${transcript}` },
      ])
      const statement = { speaker: request.name, side: request.side, kind: '자유 발언', text: cleanSpeech(response), time: new Date().toLocaleTimeString('ko-KR', { hour12: false }) }
      const updatedStatements = [...statements, statement]
      setStatements(updatedStatements)
      announce(`${request.name}의 발언을 생성했습니다.`)
      if (monitoring) void runFreeMonitor(updatedStatements, [request.name])
    } catch (error) {
      setRequests((items) => [request, ...items])
      announce(error instanceof Error ? error.message : '자유 발언 생성에 실패했습니다.')
    } finally {
      setGenerating(false)
    }
  }

  const trimmed = (side: Side) => {
    if (!scores || scores.length !== judges.length) return '—'
    const values = scores.map((score) => score[side]).sort((a, b) => a - b).slice(1, -1)
    return (values.reduce((total, value) => total + value, 0) / values.length).toFixed(1)
  }

  const runFreeMonitor = async (transcriptItems: Statement[] = statements, excludedNames: string[] = []) => {
    if (!judgeReady || monitorBusyRef.current) return
    monitorBusyRef.current = true
    setMonitorBusy(true)
    try {
      const transcript = transcriptItems.map((item) => `${item.speaker}(${item.side === 'pro' ? '찬성' : '반대'}, ${item.kind}): ${item.text}`).join('\n\n')
      const latestStatement = transcriptItems[transcriptItems.length - 1]
      const freeSpeakers = transcriptItems.filter((item) => item.kind === '자유 발언').map((item) => item.speaker)
      const response = await ollamaChat(judgeModel, [
        { role: 'system', content: `당신은 자유토론을 적극적으로 진행하는 발언 요청 판독기입니다. 자유토론의 목적은 논쟁을 이어가는 것입니다. 기록에 실질적인 발언이 하나라도 있으면 최신 발언에 답할 에이전트 한 명을 반드시 선택하세요. 순차 토론에서 다뤘던 쟁점도 더 구체적인 반박, 근거, 조건으로 이어갈 수 있습니다. 최신 발언자와 반대 입장인 팀을 우선 선택하고, 자유토론에서 아직 발언하지 않은 에이전트를 먼저 고르세요. 최신 발언의 구체적인 주장 하나를 대상으로 지정하세요. 제외할 에이전트는 선택하지 마세요: ${excludedNames.join(', ') || '없음'}. request를 null로 반환할 수 있는 경우는 기록이 비어 있거나 실질적인 발언이 전혀 없는 경우뿐입니다. 반드시 이 JSON 형식만 반환: {"request":null} 또는 {"request":{"name":"에이전트 이름","target":"답변할 구체적인 최신 주장","reason":"그 주장에 필요한 반박이나 보충을 요청하는 이유 한두 문장"}}. 에이전트 명단: ${turns.map((turn) => `${turn.name}(${turn.side === 'pro' ? '찬성' : '반대'}, ${turn.role})`).join(', ')}. 자유토론에서 이미 발언한 에이전트: ${[...new Set(freeSpeakers)].join(', ') || '없음'}.` },
        { role: 'user', content: `논제: ${topic}\n가장 최근 발언자: ${latestStatement?.speaker ?? '없음'} (${latestStatement?.side === 'pro' ? '찬성' : latestStatement?.side === 'con' ? '반대' : '없음'})\n\n토론 기록:\n${transcript || '(아직 발언 없음)'}\n\n최신 발언에 답할 발언 요청을 한 건 작성하세요.` },
      ], true)
      const result = parseModelJson<{ request: { name: string; target: string; reason: string } | null }>(response)
      const candidate = result.request
      const speaker = candidate && turns.find((turn) => turn.name === candidate.name && !excludedNames.includes(turn.name))
      if (!speaker || !candidate.target?.trim() || !candidate.reason?.trim()) {
        announce('추가 발언 요청이 없습니다. 5초 뒤 다시 판독합니다.')
        return
      }
      setRequests([{ id: Date.now(), name: speaker.name, side: speaker.side, target: candidate.target.trim(), reason: candidate.reason.trim() }])
      announce(`${speaker.name}의 발언 요청을 사회자 검토에 올렸습니다.`)
    } catch (error) {
      setMonitoring(false)
      announce(error instanceof Error ? error.message : '자유토론 판독에 실패했습니다.')
    } finally {
      monitorBusyRef.current = false
      setMonitorBusy(false)
    }
  }

  const startFreeDebate = () => {
    setPhase('free')
    setMonitoring(true)
    void runFreeMonitor(statements)
  }

  const finishFreeDebate = () => {
    setMonitoring(false)
    setDebateFinished(true)
    announce('자유 토론을 종료했습니다. 이제 심사를 실행할 수 있습니다.')
  }

  const checkTopic = async () => {
    setTopicChecking(true)
    setTopicChecked(false)
    setTopicReason('')
    try {
      const response = await ollamaChat(judgeModel, [
        { role: 'system', content: '입력 문장이 찬성과 반대 양쪽의 논거를 만들 수 있는 주장인지 판단하세요. 정책이나 가치에 대한 "해야 한다/허용해야 한다/금지해야 한다"는 문장은 원칙적으로 적합합니다. 반대 근거가 있다는 이유로 부적합 처리하지 마세요. 단순 사실 질문이나 취향만 묻는 문장만 false입니다. 예시: "공공장소의 AI 안면인식 기술 도입을 허용해야 한다" -> {"suitable":true,"reason":"안전과 개인정보 보호의 가치가 충돌해 찬반 논증이 가능합니다."}. JSON 객체 하나만 반환하고 suitable은 반드시 true 또는 false로 쓰세요.' },
        { role: 'user', content: topic },
      ], true)
      const result = parseModelJson<{ suitable: boolean; reason?: string }>(response)
      setTopicChecked(Boolean(result.suitable))
      setTopicReason(result.reason ?? '')
      announce(result.suitable ? `토론 논제로 적합합니다${result.reason ? `: ${result.reason}` : '.'}` : `논제 확인이 필요합니다${result.reason ? `: ${result.reason}` : '.'}`)
    } catch (error) {
      announce(error instanceof Error ? error.message : '1.5B 논제 판정에 실패했습니다.')
    } finally {
      setTopicChecking(false)
    }
  }

  const runJudges = async () => {
    if (!debateFinished) {
      announce('자유 토론을 종료한 뒤 심사를 실행해 주세요.')
      return
    }
    if (statements.length === 0) {
      announce('심사할 토론 기록이 없습니다.')
      return
    }
    setJudging(true)
    setScores([])
    const transcript = statements.map((item) => `${item.speaker}(${item.side === 'pro' ? '찬성' : '반대'}, ${item.kind}): ${item.text}`).join('\n\n')
    try {
      const results: JudgeScore[] = []
      for (const judge of judges) {
        const response = await ollamaChat(judgeModel, [
          { role: 'system', content: `당신은 독립 심사위원입니다. 평가 관점은 ${judge.name}이며 기준은 ${judge.rubric}입니다. 토론 내용을 기준으로 찬성 팀과 반대 팀에 각각 0~100의 정수 점수를 주세요. 양측을 같은 기준으로 평가하고, transcript에 없는 사실을 보태지 마세요. JSON 객체 하나만 반환하세요: {"pro":0,"con":0,"rationale":"점수 근거 한 문장"}` },
          { role: 'user', content: `논제: ${topic}\n\n토론 기록:\n${transcript}` },
        ], true)
        const score = parseModelJson<JudgeScore>(response)
        if (!Number.isFinite(score.pro) || !Number.isFinite(score.con)) throw new Error(`${judge.name} 심사 결과를 읽을 수 없습니다.`)
        results.push({ ...score, pro: Math.max(0, Math.min(100, Math.round(score.pro))), con: Math.max(0, Math.min(100, Math.round(score.con))) })
        setScores([...results])
      }
      announce('1.5B 심사위원단의 5개 평가가 완료됐습니다.')
    } catch (error) {
      announce(error instanceof Error ? error.message : '심사 실행에 실패했습니다.')
    } finally {
      setJudging(false)
    }
  }

  const debateReady = availableModels.includes(debateModel)
  const judgeReady = availableModels.includes(judgeModel)
  const ollamaReady = debateReady && judgeReady

  const activeSpeaker = turns[Math.min(currentTurn, turns.length - 1)]

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup">
          <div className="brand-mark"><MessageSquareText size={19} strokeWidth={2.2} /></div>
          <div><strong>THESIS</strong><span>DEBATE STUDIO</span></div>
        </div>
        <div className="workspace-label">워크스페이스</div>
        <button className="workspace-picker"><span className="workspace-avatar">T</span><span>토론 연구실<small>개인 워크스페이스</small></span><ChevronDown size={15} /></button>
        <div className="nav-heading">진행 중</div>
        <button className="nav-item selected"><Radio size={17} /><span>라이브 토론</span><i /></button>
        <button className="nav-item" onClick={() => announce('지난 토론 목록은 백엔드 연결 후 표시됩니다.')}><Clock3 size={17} /><span>토론 기록</span></button>
        <button className="nav-item" onClick={() => announce('에이전트 설정은 백엔드 연결 후 사용할 수 있습니다.')}><Settings2 size={17} /><span>에이전트 설정</span></button>
        <div className="sidebar-bottom">
          <div className="local-status"><span className={`status-light ${ollamaReady ? 'online' : ''}`} /><div><strong>로컬 런타임</strong><small>{ollamaReady ? 'Ollama 연결됨' : availableModels.length ? '필요한 모델 확인 중' : 'Ollama 연결 대기'}</small></div><button aria-label="런타임 상태 도움말" onClick={() => announce(`토론: ${debateReady ? '3B 준비됨' : '3B 모델 없음'} · 심사: ${judgeReady ? '1.5B 준비됨' : '1.5B 모델 없음'}`)}><CircleHelp size={15} /></button></div>
          <button className="profile-button"><span className="profile-avatar">MC</span><span><strong>사회자</strong><small>로컬 세션</small></span><MoreHorizontal size={18} /></button>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumb">토론 스튜디오 <span>/</span> <strong>새 토론</strong></div>
          <div className="topbar-actions"><span className={ollamaReady ? 'demo-pill online-pill' : 'demo-pill'}><span /> {ollamaReady ? 'Ollama 연결됨' : availableModels.length ? '모델 확인 필요' : 'Ollama 연결 안 됨'}</span><button className="icon-button" aria-label="도움말" onClick={() => announce(`토론 모델 ${debateModel} · 심사 모델 ${judgeModel}`)}><CircleHelp size={18} /></button><button className="icon-button" aria-label="더 보기"><MoreHorizontal size={20} /></button></div>
        </header>

        <div className="content-wrap">
          <section className="session-heading">
            <div>
              <div className="eyebrow"><span className="live-dot" /> LIVE SESSION <span className="session-id"># DB-0248</span></div>
              <h1>{topic || '새 토론'}</h1>
              <p>{debateFinished ? '토론 종료 · 심사 가능' : debateStarted ? '3 대 3 에이전트 토론 · 사회자 통제 중' : '논제를 확인한 뒤 토론을 시작하세요'}</p>
            </div>
            <button className="subtle-button" onClick={() => announce('토론 설정 패널은 다음 단계에서 연결됩니다.')}><Settings2 size={16} /> 설정</button>
          </section>

          <div className="phase-switch" role="tablist" aria-label="토론 페이즈">
            <button className={phase === 'structured' ? 'phase-tab active' : 'phase-tab'} onClick={() => setPhase('structured')} role="tab" aria-selected={phase === 'structured'}><span className="phase-number">01</span> 순차 토론 <small>STRUCTURED</small></button>
            <div className="phase-connector"><span /></div>
            <button className={phase === 'free' ? 'phase-tab active' : 'phase-tab'} onClick={startFreeDebate} disabled={!debateStarted || currentTurn < turns.length || debateFinished || phase === 'free' || requests.length > 0 || monitorBusy} role="tab" aria-selected={phase === 'free'}><span className="phase-number">02</span> 자유 토론 <small>HUMAN-IN-LOOP</small></button>
            <div className="phase-right"><span className="phase-live"><span /> {debateFinished ? '종료' : monitorBusy ? '판독 중' : phase === 'structured' ? '진행 중' : requests.length ? '승인 대기' : '감시 대기'}</span></div>
          </div>

          <div className="dashboard-grid">
            <div className="center-column">
              <section className="topic-bar">
                <div className="topic-icon"><Gavel size={17} /></div>
                <div className="topic-content"><label htmlFor="topic">토론 논제</label><input id="topic" value={topic} placeholder="예: 공공장소의 AI 안면인식 기술 도입을 허용해야 한다" disabled={debateStarted} onChange={(event) => { setTopic(event.target.value); setTopicChecked(false); setTopicReason(''); setScores(null) }} /><div className="topic-hint">{topicReason || '찬성과 반대 입장이 명확한 논제를 입력하세요.'}</div></div>
                <button className={topicChecked ? 'check-topic checked' : 'check-topic'} onClick={checkTopic} disabled={topicChecking || !judgeReady || debateStarted || !topic.trim()}><ShieldCheck size={15} /> {topicChecking ? '1.5B 판정 중' : topicChecked ? '적합성 확인됨' : '논제 확인'}</button>
              </section>

              <section className="turn-panel">
                <div className="section-head"><div><span className="section-kicker">PHASE 01</span><h2>발언 순서</h2></div><span className="turn-count">{Math.min(currentTurn, 6)} <span>/ 6</span></span></div>
                <div className="turn-track">
                  {turns.map((turn, index) => {
                    const completed = index < currentTurn
                    const active = phase === 'structured' && index === currentTurn
                    return <div className={`turn-step ${turn.side} ${completed ? 'completed' : ''} ${active ? 'active' : ''}`} key={turn.name}>
                      <div className="turn-marker">{completed ? <Check size={13} /> : <span>{String(index + 1).padStart(2, '0')}</span>}</div>
                      <div className="turn-info"><strong>{turn.name}<em>{turn.side === 'pro' ? '찬성' : '반대'}</em></strong><span>{turn.kind}</span></div>
                    </div>
                  })}
                </div>
                {!debateStarted ? <div className="speaker-callout start-callout"><div className="speaker-icon free"><Gavel size={18} /></div><div className="speaker-text"><span>토론 준비</span><strong>{topicChecked ? '논제가 확인되었습니다' : '먼저 논제 적합성을 확인하세요'} <small>{topicChecked ? '찬성 3명 · 반대 3명' : '1.5B 논제 판정'}</small></strong></div><div className="speaker-controls"><button className="speak-button" onClick={startDebate} disabled={!topicChecked}><Play size={15} fill="currentColor" /> 토론 시작</button></div></div> : phase === 'structured' && currentTurn < turns.length ? <div className="structured-controls">
                  <label className="moderator-prompt"><span>사회자 지시 <small>선택 사항</small></span><textarea value={moderatorPrompt} onChange={(event) => setModeratorPrompt(event.target.value)} placeholder="이번 발언에서 다룰 쟁점이나 시간 제한을 입력하세요." rows={2} disabled={generating} /></label>
                  <div className="speaker-callout">
                  <div className={`speaker-icon ${activeSpeaker.side}`}><Mic2 size={19} /></div>
                  <div className="speaker-text"><span>다음 발언자 <b>{activeSpeaker.side === 'pro' ? '찬성 측' : '반대 측'} · {activeSpeaker.kind}</b></span><strong>{activeSpeaker.name} <small>{activeSpeaker.role}</small></strong></div>
                  <div className="speaker-controls"><button className="stop-button" onClick={forceStop} disabled={!generating} title="현재 발언 생성을 중지하고 다음 순서로"><Square size={13} fill="currentColor" /> 강제 중지</button><button className="speak-button" onClick={nextTurn} disabled={paused || generating || judging || !debateReady}><Play size={15} fill="currentColor" /> {generating ? '생성 중…' : '발언 생성'}</button></div>
                  </div>
                </div> : phase === 'structured' ? <div className="speaker-callout free-callout"><div className="speaker-icon free"><Sparkles size={19} /></div><div className="speaker-text"><span>순차 토론 완료</span><strong>자유 토론으로 이어가세요 <small>1.5B가 발언 요청을 판독합니다</small></strong></div><div className="speaker-controls"><button className="speak-button" onClick={startFreeDebate} disabled={debateFinished}><ArrowRight size={15} /> 자유 토론 시작</button></div></div> : <div className="speaker-callout free-callout"><div className="speaker-icon free"><Sparkles size={19} /></div><div className="speaker-text"><span>{debateFinished ? '토론 종료' : '인간 승인 기반'}</span><strong>{debateFinished ? '심사위원단 평가를 실행하세요' : '자유 토론 진행 중'} <small>{monitoring ? '1.5B가 다음 발언을 판독합니다' : '감시를 다시 시작할 수 있습니다'}</small></strong></div><div className="speaker-controls"><button className="stop-button" onClick={finishFreeDebate} disabled={debateFinished || generating || monitorBusy || requests.length > 0}>토론 종료</button></div></div>}
              </section>

              <section className="transcript-section">
                <div className="section-head transcript-head"><div><span className="section-kicker">LIVE TRANSCRIPT</span><h2>토론 기록 <span className="recording-indicator"><i /> 기록 중</span></h2></div><button className="text-button" onClick={() => announce('전체 대화 기록 내보내기는 백엔드 연결 후 제공됩니다.')}>기록 내보내기 <ArrowDown size={14} /></button></div>
                <div className="transcript-list" ref={transcriptListRef} aria-live="polite">
                  {[...statements, ...(draft ? [draft] : [])].map((statement, index) => <article className={`statement ${statement.side}`} key={`${statement.speaker}-${index}`}>
                    <div className={`statement-avatar ${statement.side}`}>{statement.speaker.slice(0, 1)}</div>
                    <div className="statement-body"><div className="statement-meta"><strong>{statement.speaker}</strong><span className={`team-label ${statement.side}`}>{statement.side === 'pro' ? '찬성' : '반대'}</span><span className="statement-kind">{statement.kind}</span><time>{statement.time}</time></div><p>{statement.text}</p></div>
                  </article>)}
                </div>
                <button className="load-more" onClick={() => announce('현재 전체 기록을 표시하고 있습니다.')}>최신 발언 <ArrowDown size={14} /></button>
              </section>
            </div>

            <aside className="right-column">
              <section className="requests-panel">
                <div className="aside-heading"><div><span className="section-kicker">AI MODERATOR</span><h2>발언 요청</h2></div><span className="request-count">{requests.length}</span></div>
                <div className="monitor-status"><Activity size={15} /><span>{monitorBusy ? '발언 필요성 분석 중' : requests.length ? '사회자 승인 대기' : monitoring ? '1.5B 자동 감시 · 5초 간격' : judgeReady ? '1.5B 판독 대기' : '1.5B 모델 연결 대기'}</span><span className="monitor-pulse" /></div>
                {requests.length > 0 ? <div className="request-list">{requests.map((request) => <article className="request-item" key={request.id}>
                  <div className="request-top"><span className={`request-avatar ${request.side}`}>{request.name.slice(0, 1)}</span><div><strong>{request.name}</strong><span className={`team-label ${request.side}`}>{request.side === 'pro' ? '찬성' : '반대'}</span></div><button className="request-menu" aria-label="요청 메뉴"><MoreHorizontal size={17} /></button></div>
                  <div className="request-target"><span>발언 대상</span><strong>{request.target}</strong></div>
                  <p>{request.reason}</p>
                  <div className="request-actions"><button className="decline-button" onClick={() => resolveRequest(request, false)} disabled={generating}><X size={14} /> 거절</button><button className="approve-button" onClick={() => resolveRequest(request, true)} disabled={generating || !debateReady}><Check size={14} /> 승인</button></div>
                </article>)}</div> : <div className="empty-requests"><CheckCheck size={20} /><strong>검토할 요청이 없습니다</strong><span>새 발언 요청이 도착하면 여기에 표시됩니다.</span></div>}
                <button className="monitor-button" onClick={() => { if (monitoring) setMonitoring(false); else { setMonitoring(true); void runFreeMonitor(statements) } }} disabled={phase !== 'free' || debateFinished || monitorBusy || (!monitoring && requests.length > 0) || !judgeReady}>{monitorBusy ? <Activity size={14} /> : monitoring ? <Pause size={14} /> : <Activity size={14} />} {monitorBusy ? '발언 필요성 분석 중…' : monitoring ? '감시 일시 정지' : '감시 시작 / 다음 판독'}</button>
              </section>

              <section className="jury-panel">
                <div className="aside-heading"><div><span className="section-kicker">INDEPENDENT JURY</span><h2>심사위원단 <span className="jury-total">5</span></h2></div><button className="jury-settings" aria-label="심사위원 설정" onClick={() => announce('심사 관점 설정은 백엔드 연결 후 제공됩니다.')}><Settings2 size={16} /></button></div>
                <div className="jury-subtitle">각 관점별 독립 평가 <span>100점 만점</span></div>
                <div className="score-list">{judges.map((judge, index) => <div className="score-row" key={judge.initials}><span className="judge-avatar">{judge.initials}</span><span className="judge-name">{judge.name}</span><span className="score pro-score">{scores?.[index]?.pro ?? '—'}</span><span className="score con-score">{scores?.[index]?.con ?? '—'}</span></div>)}</div>
                {scores && scores.length > 0 && <div className="judge-rationales">{scores.map((score, index) => <div className="rationale-row" key={judges[index].initials}><strong>{judges[index].name}</strong><p>{score.rationale || '근거 설명을 반환하지 않았습니다.'}</p></div>)}</div>}
                <div className="score-legend"><span><i className="pro-dot" /> 찬성</span><span><i className="con-dot" /> 반대</span></div>
                <div className="jury-result"><span>절사 평균</span><div><b className="pro-number">{trimmed('pro')}</b><i>:</i><b className="con-number">{trimmed('con')}</b></div></div>
                {scores?.length === judges.length && <div className="winner-banner"><Sparkles size={15} /> {Number(trimmed('con')) === Number(trimmed('pro')) ? '무승부' : Number(trimmed('con')) > Number(trimmed('pro')) ? '반대 측 우세' : '찬성 측 우세'} · {judgeModel}</div>}
                <button className="judge-button" onClick={runJudges} disabled={judging || generating || !judgeReady || !debateFinished}><Sparkles size={15} /> {judging ? `심사 중 ${scores?.length ?? 0}/5` : scores?.length === judges.length ? '심사 다시 실행' : '심사 실행'} <ArrowRight size={15} /></button>
                <p className="trim-note">최고점과 최저점을 제외한 3명의 평균</p>
              </section>

              <section className="runtime-panel"><div className="runtime-head"><span className="runtime-icon"><Headphones size={15} /></span><strong>에이전트 런타임</strong><button onClick={() => announce(`사용 모델: ${debateModel}, ${judgeModel}`)} aria-label="런타임 세부 설정"><MoreHorizontal size={17} /></button></div><div className="runtime-row"><span className={`runtime-indicator ${debateReady ? 'connected' : ''}`} />토론 모델 <strong>{debateReady ? debateModel : '연결 대기'}</strong></div><div className="runtime-row"><span className={`runtime-indicator small ${judgeReady ? 'connected' : ''}`} />판단 모델 <strong>{judgeReady ? judgeModel : '연결 대기'}</strong></div></section>
            </aside>
          </div>
          <footer className="page-footer"><span>THESIS <i>·</i> 로컬 하이브리드 토론</span><button onClick={() => setPaused((value) => !value)}>{paused ? <Play size={13} /> : <Pause size={13} />}{paused ? '세션 재개' : '세션 일시 정지'}</button></footer>
        </div>
      </main>
      {toast && <div className="toast" role="status"><Check size={16} />{toast}</div>}
    </div>
  )
}

export default App