import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  ArrowUp,
  Square,
  ChevronDown,
  ChevronRight,
  Check,
  Copy,
  TerminalSquare,
  ShieldCheck,
  AlertCircle,
  LoaderCircle,
  MessageCircleQuestion,
  X,
  FileCode2,
  RotateCcw,
  ImagePlus,
} from 'lucide-react'
import {
  ACTIVE_STATUSES,
  PROVIDERS,
  type AgentEvent,
  type Session,
  type ProviderInfo,
  type ComposerDraft,
  type ContextItem,
  type Settings,
  type TurnInput,
} from '../../shared/types'
import { api } from '../lib/api'
import { registerCloseFlush } from '../lib/close-flush'

const Markdown = memo(function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ href, children: content }) => (
          <a
            href={href}
            onClick={(event) => {
              event.preventDefault()
              if (href && /^https?:\/\//i.test(href)) void api.openExternal(href)
            }}
          >
            {content}
          </a>
        ),
        pre: ({ children: content }) => (
          <div className="code-block">
            <button
              className="code-copy icon-button"
              title="复制代码"
              onClick={(event) => {
                const code = event.currentTarget.parentElement?.querySelector('pre')?.textContent
                if (code) void navigator.clipboard.writeText(code)
              }}
            >
              <Copy size={13} />
            </button>
            <pre>{content}</pre>
          </div>
        ),
      }}
    >
      {children}
    </ReactMarkdown>
  )
})
function ContextPreview({ item, onRemove }: { item: ContextItem; onRemove?: () => void }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const image =
    item.kind === 'image' && /^data:image\/(?:png|jpe?g|webp);base64,/i.test(item.dataUrl ?? '')
  return (
    <div className="context-reference">
      <div className="context-chip">
        <button
          className="context-preview-toggle"
          aria-expanded={open}
          aria-controls={id}
          title={`预览引用 ${item.name}`}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <FileCode2 size={13} />
          <span>
            {item.name}
            {item.startLine
              ? `:${item.startLine}${item.endLine && item.endLine !== item.startLine ? `–${item.endLine}` : ''}`
              : ''}
          </span>
        </button>
        {onRemove && (
          <button
            className="icon-button"
            title="移除引用"
            aria-label={`移除引用 ${item.name}`}
            onClick={onRemove}
          >
            <X size={12} />
          </button>
        )}
      </div>
      {open && (
        <div id={id} className="context-preview" role="region" aria-label={`${item.name} 引用预览`}>
          {item.path && <small>{item.path}</small>}
          {image ? (
            <img
              src={item.dataUrl}
              alt={item.name}
              loading="lazy"
              decoding="async"
              style={{ maxWidth: '100%', maxHeight: 320, objectFit: 'contain' }}
            />
          ) : item.kind === 'image' ? (
            <p>图片内容无法预览，请移除后重新选择。</p>
          ) : (
            <pre style={{ maxHeight: 280, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
              {item.content || '（空内容）'}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}
function Tool({
  event,
  sessionId,
  onError,
}: {
  event: AgentEvent
  sessionId: string
  onError: (error: unknown) => void
}) {
  const [open, setOpen] = useState(false)
  const [page, setPage] = useState<{
    text: string
    total: number
    hasMore: boolean
    nextOffset: number
    offset: number
  }>()
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const offsets = useRef<number[]>([])
  const attemptedPage = useRef({ offset: 0, previous: false })
  const request = useRef(0)
  useEffect(
    () => () => {
      request.current++
    },
    [],
  )
  async function load(offset: number, previous = false) {
    attemptedPage.current = { offset, previous }
    const token = ++request.current
    setLoading(true)
    setFailed(false)
    try {
      const result = await api.getEventOutput(sessionId, event.persistedId ?? event.id, {
        offset,
        limit: 32768,
      })
      if (token !== request.current) return
      if (previous) offsets.current.pop()
      else if (page && page.offset !== offset) offsets.current.push(page.offset)
      setPage({ ...result, offset })
    } catch (error) {
      if (token === request.current) {
        setFailed(true)
        onError(error)
      }
    } finally {
      if (token === request.current) setLoading(false)
    }
  }
  return (
    <div className={`tool-event ${event.state === 'error' ? 'failed' : ''}`}>
      <button
        className="tool-header"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open)
          if (open) {
            request.current++
            setLoading(false)
            setPage(undefined)
            offsets.current = []
          }
        }}
      >
        {event.state === 'running' ? (
          <LoaderCircle size={14} className="spin" />
        ) : event.state === 'error' ? (
          <AlertCircle size={14} />
        ) : (
          <Check size={14} />
        )}
        <TerminalSquare size={14} />
        <span>{event.name || '执行工具'}</span>
        <span className="tool-preview">
          {typeof event.input === 'object' && event.input !== null && 'command' in event.input
            ? String(event.input.command)
            : event.text || ''}
        </span>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      </button>
      {open && (
        <div className="tool-detail">
          {event.input != null && (
            <pre>
              {typeof event.input === 'string' ? event.input : JSON.stringify(event.input, null, 2)}
            </pre>
          )}
          {(event.output || page) && (
            <pre style={{ maxHeight: 360, overflow: 'auto' }}>{page?.text ?? event.output}</pre>
          )}
          {event.outputTruncated && (
            <p className="output-meta">
              普通历史仅显示输出预览
              {event.outputBytes !== undefined
                ? ` · ${event.outputBytes.toLocaleString()} 字节`
                : ''}
              。
            </p>
          )}
          {event.outputRef && (
            <div className="output-pages">
              {!page ? (
                <button
                  className="button secondary small"
                  disabled={loading}
                  onClick={() => void load(0)}
                >
                  {loading ? '正在读取…' : '按页查看完整输出'}
                </button>
              ) : (
                <>
                  <span>
                    输出 {page.offset.toLocaleString()}–{page.nextOffset.toLocaleString()} /{' '}
                    {page.total.toLocaleString()}
                  </span>
                  <button
                    className="button secondary small"
                    disabled={loading || !offsets.current.length}
                    onClick={() => {
                      const offset = offsets.current.at(-1)
                      if (offset !== undefined) void load(offset, true)
                    }}
                  >
                    上一页
                  </button>
                  <button
                    className="button secondary small"
                    disabled={loading || !page.hasMore}
                    onClick={() => void load(page.nextOffset)}
                  >
                    下一页
                  </button>
                </>
              )}
              {failed && (
                <button
                  className="button secondary small"
                  disabled={loading}
                  onClick={() =>
                    void load(attemptedPage.current.offset, attemptedPage.current.previous)
                  }
                >
                  重试读取输出
                </button>
              )}
            </div>
          )}
          {event.text && <p>{event.text}</p>}
        </div>
      )}
    </div>
  )
}
function RequestCard({
  event,
  sessionId,
  onError,
  completed,
}: {
  event: AgentEvent
  sessionId: string
  onError: (error: unknown) => void
  completed: boolean
}) {
  const [pending, setPending] = useState(false)
  const [sent, setSent] = useState(false)
  const [answers, setAnswers] = useState<Record<string, string[]>>(event.answers ?? {})
  const [scope, setScope] = useState<'turn' | 'session'>(
    event.scope === 'session' ? 'session' : 'turn',
  )
  useEffect(() => {
    if (event.answers) setAnswers(event.answers)
  }, [event.answers])
  async function reply(decision?: string) {
    if (!event.requestId) return
    setPending(true)
    try {
      await api.respond(sessionId, event.requestId, {
        decision,
        ...(event.kind === 'question' ? { answers } : {}),
        ...(event.scope && event.name === 'Grant permissions' ? { scope } : {}),
      })
      setSent(true)
    } catch (error) {
      onError(error)
    } finally {
      setPending(false)
    }
  }
  const inactive = sent || completed || event.state === 'completed'
  return (
    <div className="request-card">
      <div className="request-title">
        {event.kind === 'approval' ? (
          <ShieldCheck size={17} />
        ) : (
          <MessageCircleQuestion size={17} />
        )}
        <strong>{event.kind === 'approval' ? '需要你的授权' : 'Agent 需要你补充信息'}</strong>
        {inactive && (
          <span className="muted">
            {event.resolution
              ? {
                  approved: '已允许',
                  denied: '已拒绝',
                  cancelled: '已取消',
                  expired: '已过期',
                  external: '已在 CLI 处理',
                  failed: '回复失败',
                }[event.resolution]
              : sent
                ? '已回复'
                : '已结束'}
          </span>
        )}
      </div>
      {event.text && <Markdown>{event.text}</Markdown>}
      {event.input != null && (
        <pre className="request-input">
          {typeof event.input === 'string' ? event.input : JSON.stringify(event.input, null, 2)}
        </pre>
      )}
      {event.kind === 'approval' && event.scope && (
        <label className="permission-scope">
          授权范围
          {inactive ? (
            <span>
              {event.scope === 'session' ? '本会话' : event.scope === 'turn' ? '本轮' : '仅此一次'}
            </span>
          ) : event.name === 'Grant permissions' ? (
            <select
              aria-label="授权范围"
              className="input"
              value={scope}
              disabled={pending}
              onChange={(change) => setScope(change.target.value as 'turn' | 'session')}
            >
              <option value="turn">仅本轮</option>
              <option value="session">本会话后续轮次</option>
            </select>
          ) : (
            <span>按 CLI 所示决策授权</span>
          )}
        </label>
      )}
      {event.questions?.map((question) => (
        <div className="question" key={question.id}>
          <label>{question.title}</label>
          {question.options?.length ? (
            <div className="question-options">
              {question.options.map((option) => (
                <label className="question-option" key={option.label}>
                  <input
                    disabled={inactive || pending}
                    type={question.multiple ? 'checkbox' : 'radio'}
                    name={`${event.id}:${question.id}`}
                    checked={(answers[question.id] || []).includes(option.label)}
                    onChange={(e) =>
                      setAnswers((previous) => ({
                        ...previous,
                        [question.id]: question.multiple
                          ? e.target.checked
                            ? [...(previous[question.id] || []), option.label]
                            : (previous[question.id] || []).filter(
                                (value) => value !== option.label,
                              )
                          : [option.label],
                      }))
                    }
                  />
                  <span>
                    {option.label}
                    {option.description && <small>{option.description}</small>}
                  </span>
                </label>
              ))}
            </div>
          ) : (
            <input
              disabled={inactive || pending}
              placeholder="输入回答…"
              value={answers[question.id]?.[0] || ''}
              onChange={(e) =>
                setAnswers((previous) => ({ ...previous, [question.id]: [e.target.value] }))
              }
            />
          )}
        </div>
      ))}
      {!inactive && (
        <div className="request-actions">
          {event.kind === 'approval' ? (
            (event.decisions?.length ? event.decisions : ['allow', 'deny']).map((decision) => (
              <button
                key={decision}
                disabled={pending}
                className={
                  /deny|reject|cancel/i.test(decision) ? 'button secondary' : 'button primary'
                }
                onClick={() => void reply(decision)}
              >
                {pending ? <LoaderCircle size={14} className="spin" /> : null}
                {event.name === 'Grant permissions' && decision === 'accept'
                  ? scope === 'session'
                    ? '允许本会话'
                    : '允许本轮'
                  : (
                      {
                        allow: '允许一次',
                        allow_always: '始终允许',
                        deny: '拒绝',
                        accept: '允许一次',
                        acceptForSession: '本会话允许',
                        decline: '拒绝',
                        cancel: '取消',
                        once: '允许一次',
                        always: '始终允许',
                        reject: '拒绝',
                      } as Record<string, string>
                    )[decision] || decision}
              </button>
            ))
          ) : (
            <button
              className="button primary"
              disabled={pending || !event.questions?.every((q) => answers[q.id]?.some(Boolean))}
              onClick={() => void reply()}
            >
              提交回答
            </button>
          )}
        </div>
      )}
    </div>
  )
}
export interface ChatProps {
  session?: Session
  events: AgentEvent[]
  loading: boolean
  provider?: ProviderInfo
  onSend: (input: TurnInput) => Promise<void>
  onStop: () => void
  onError: (error: unknown) => void
  context?: ContextItem
  clearContext: () => void
  settings?: Settings
  disabled?: boolean
  hasMore?: boolean
  hasNewer?: boolean
  loadingMore?: boolean
  onLoadMore?: () => void
  onLoadNewer?: () => void
  onLatest?: () => void
  onInspectTurn?: (turnId: string) => void
  focusEventId?: string
}
export default function Chat({
  session,
  events,
  loading,
  provider,
  onSend,
  onStop,
  onError,
  context,
  clearContext,
  settings,
  disabled,
  hasMore,
  hasNewer,
  loadingMore,
  onLoadMore,
  onLoadNewer,
  onLatest,
  onInspectTurn,
  focusEventId,
}: ChatProps) {
  const [draft, setDraft] = useState<ComposerDraft>({ text: '', context: [], updatedAt: 0 })
  const [draftLoading, setDraftLoading] = useState(false)
  const [draftError, setDraftError] = useState(false)
  const [draftAttempt, setDraftAttempt] = useState(0)
  const draftRef = useRef<{ id: string; draft: ComposerDraft } | undefined>(undefined)
  const draftTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [sending, setSending] = useState(false)
  const [copiedId, setCopiedId] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const following = useRef(true)
  const focusedEvent = useRef<string | undefined>(undefined)
  const pagePosition = useRef<{ height: number; top: number; prepend: boolean } | undefined>(
    undefined,
  )
  const running = Boolean(session && ACTIVE_STATUSES.includes(session.status))
  const turnGroups = useMemo(() => {
    const groups = new Map<string, AgentEvent[]>()
    for (const event of events) {
      const group = groups.get(event.turnId)
      if (group) group.push(event)
      else groups.set(event.turnId, [event])
    }
    return groups
  }, [events])
  const resolutions = useMemo(
    () =>
      new Map(
        events
          .filter((event) => event.kind === 'requestResolved')
          .map((event) => [`${event.turnId}:${event.requestId}`, event]),
      ),
    [events],
  )
  const flushDraft = async () => {
    clearTimeout(draftTimer.current)
    const current = draftRef.current
    if (current) await api.saveDraft(current.id, current.draft)
  }
  useEffect(() => registerCloseFlush(flushDraft), [])
  function updateDraft(next: ComposerDraft) {
    if (!session || draftRef.current?.id !== session.id) return
    draftRef.current = { id: session.id, draft: next }
    setDraft(next)
    clearTimeout(draftTimer.current)
    draftTimer.current = setTimeout(() => void flushDraft().catch(onError), 250)
  }
  useEffect(() => {
    void flushDraft().catch(onError)
    draftRef.current = undefined
    setDraft({ text: '', context: [], updatedAt: 0 })
    setDraftLoading(Boolean(session))
    setDraftError(false)
    let stale = false
    if (session)
      void api
        .getDraft(session.id)
        .then((saved) => {
          if (stale) return
          draftRef.current = { id: session.id, draft: saved }
          setDraft(saved)
        })
        .catch((error) => {
          if (!stale) {
            setDraftError(true)
            onError(error)
          }
        })
        .finally(() => {
          if (!stale) setDraftLoading(false)
        })
    following.current = true
    inputRef.current?.focus()
    return () => {
      stale = true
      void flushDraft().catch(onError)
    }
  }, [session?.id, draftAttempt])
  useEffect(() => {
    const unload = () => void flushDraft().catch(onError)
    window.addEventListener('beforeunload', unload)
    return () => window.removeEventListener('beforeunload', unload)
  }, [])
  useEffect(() => {
    if (!context || draftLoading || !session || draftRef.current?.id !== session.id) return
    const current = draftRef.current.draft
    if ((context.content?.length ?? 0) > 60000 || current.context.length >= 20) {
      onError('最多添加 20 项引用，单项文本上限为 60,000 字符。请缩小引用内容。')
      clearContext()
      return
    }
    if (!current.context.some((item) => item.id === context.id))
      updateDraft({ ...current, context: [...current.context, context], updatedAt: Date.now() })
    clearContext()
  }, [context, draftLoading, session?.id])
  useLayoutEffect(() => {
    const position = pagePosition.current
    const scroller = scrollRef.current
    if (position && scroller) {
      scroller.scrollTop =
        position.top + (position.prepend ? scroller.scrollHeight - position.height : 0)
      pagePosition.current = undefined
    }
  }, [events])
  useEffect(() => {
    if (!loadingMore) pagePosition.current = undefined
  }, [loadingMore])
  useLayoutEffect(() => {
    if (loading) pagePosition.current = undefined
    if (loading || !focusEventId) {
      focusedEvent.current = undefined
      return
    }
    if (focusedEvent.current === focusEventId) return
    const target = document.getElementById(`event-${focusEventId}`)
    if (target) {
      target.scrollIntoView({ block: 'center' })
      focusedEvent.current = focusEventId
    }
  }, [focusEventId, events, loading])
  useEffect(() => {
    if (following.current && !focusEventId)
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [events, sending, focusEventId])
  useEffect(() => {
    const input = inputRef.current
    if (input) {
      input.style.height = 'auto'
      input.style.height = Math.min(input.scrollHeight, 190) + 'px'
    }
  }, [draft.text])
  async function send() {
    if (!draft.text.trim() || sending || running || !session || disabled || draftLoading) return
    if (
      draft.text.length +
        draft.context.reduce((sum, item) => sum + (item.content?.length ?? 0), 0) >
      95000
    ) {
      onError('消息与引用内容合计超过 95,000 字符。请缩短消息或选择较小的代码片段后发送。')
      return
    }
    setSending(true)
    following.current = true
    const sentDraft = draft
    const sentSessionId = session.id
    try {
      await onSend({ text: draft.text.trim(), context: draft.context })
      const empty = { text: '', context: [], updatedAt: Date.now() }
      if (draftRef.current?.id === sentSessionId && draftRef.current.draft === sentDraft) {
        updateDraft(empty)
        await api.saveDraft(sentSessionId, empty)
      } else if (draftRef.current?.id !== sentSessionId) {
        const persisted = await api.getDraft(sentSessionId)
        if (persisted.updatedAt <= sentDraft.updatedAt) await api.saveDraft(sentSessionId, empty)
      }
    } catch (error) {
      onError(error)
    } finally {
      setSending(false)
      inputRef.current?.focus()
    }
  }
  return (
    <div className="chat">
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          padding: 0,
          margin: -1,
          overflow: 'hidden',
          clipPath: 'inset(50%)',
          whiteSpace: 'nowrap',
        }}
      >
        {session
          ? {
              starting: 'Agent 正在启动',
              running: 'Agent 正在执行',
              waiting: 'Agent 等待授权或回答',
              stopping: '正在停止 Agent',
              stop_failed: '停止失败，请重试停止',
              idle: session.activeTurnId ? '本轮任务已完成' : '可以开始新任务',
              interrupted: '本轮任务已中断',
              error: '本轮任务执行失败',
            }[session.status]
          : '请选择会话'}
      </div>
      {hasNewer && (
        <div
          className="history-navigation"
          role="region"
          aria-label="历史片段导航"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 16px',
            flexShrink: 0,
          }}
        >
          <span>正在查看历史片段</span>
          <button
            className="button secondary small"
            disabled={loadingMore}
            onClick={() => {
              const scroller = scrollRef.current
              if (scroller)
                pagePosition.current = {
                  height: scroller.scrollHeight,
                  top: scroller.scrollTop,
                  prepend: false,
                }
              following.current = false
              onLoadNewer?.()
            }}
          >
            {loadingMore ? '正在加载…' : '加载更新的消息'}
          </button>
          <button
            className="button secondary small"
            onClick={() => {
              pagePosition.current = undefined
              following.current = true
              onLatest?.()
            }}
          >
            返回最新消息
          </button>
        </div>
      )}
      <div
        ref={scrollRef}
        className="chat-scroll"
        onScroll={(event) => {
          const el = event.currentTarget
          following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100
        }}
      >
        <div className="conversation">
          {hasMore && (
            <button
              className="button secondary history-more"
              disabled={loadingMore}
              onClick={() => {
                const scroller = scrollRef.current
                if (scroller)
                  pagePosition.current = {
                    height: scroller.scrollHeight,
                    top: scroller.scrollTop,
                    prepend: true,
                  }
                following.current = false
                onLoadMore?.()
              }}
            >
              {loadingMore ? '正在加载…' : '加载更早的消息'}
            </button>
          )}
          {loading ? (
            <div className="chat-loading">
              <LoaderCircle className="spin" size={20} />
              <span>正在恢复会话…</span>
            </div>
          ) : events.filter((event) => !['session', 'status', 'done', 'usage'].includes(event.kind))
              .length === 0 ? (
            <div className="session-welcome">
              <h2>新会话</h2>
              <p>输入任务，Agent 将在当前项目中执行。</p>
              <div className="prompt-suggestions">
                {['说明项目结构和主要入口', '检查当前未提交的修改', '运行项目测试并报告结果'].map(
                  (prompt) => (
                    <button
                      key={prompt}
                      onClick={() => {
                        updateDraft({ ...draft, text: prompt, updatedAt: Date.now() })
                        inputRef.current?.focus()
                      }}
                    >
                      <span>{prompt}</span>
                      <ArrowUp size={14} />
                    </button>
                  ),
                )}
              </div>
            </div>
          ) : (
            <>
              {events.map((event, index) => {
                const content = (() => {
                  if (event.kind === 'user')
                    return (
                      <div className="message user-message" key={event.id}>
                        <div className="user-bubble">
                          <Markdown>{event.text || ''}</Markdown>
                          {event.context?.map((item) => (
                            <ContextPreview key={item.id} item={item} />
                          ))}
                        </div>
                      </div>
                    )
                  if (event.kind === 'text')
                    return (
                      <div key={event.id} className="message assistant-message">
                        {index === 0 || !['text', 'tool'].includes(events[index - 1]?.kind) ? (
                          <div className="message-author">
                            <span
                              className="provider-dot"
                              style={{ background: session && PROVIDERS[session.provider].color }}
                            />
                            {session && PROVIDERS[session.provider].name}
                          </div>
                        ) : null}
                        <div className="markdown">
                          <Markdown>{event.text || ''}</Markdown>
                        </div>
                        <button
                          className="message-copy icon-button"
                          title="复制回答"
                          onClick={() => {
                            void navigator.clipboard.writeText(event.text || '')
                            setCopiedId(event.id)
                            setTimeout(() => setCopiedId(''), 1600)
                          }}
                        >
                          {copiedId === event.id ? <Check size={13} /> : <Copy size={13} />}
                        </button>
                      </div>
                    )
                  if (event.kind === 'tool')
                    return (
                      <Tool
                        key={`${event.turnId}:${event.itemId ?? event.id}`}
                        event={event}
                        sessionId={session!.id}
                        onError={onError}
                      />
                    )
                  if (event.kind === 'approval' || event.kind === 'question') {
                    const resolution = resolutions.get(`${event.turnId}:${event.requestId}`)
                    const completion = turnGroups
                      .get(event.turnId)
                      ?.find((item) => item.kind === 'done')
                    return (
                      <RequestCard
                        key={event.id}
                        event={
                          resolution
                            ? {
                                ...event,
                                decision: resolution.decision,
                                resolution: resolution.resolution,
                                scope: resolution.scope ?? event.scope,
                                answers: resolution.answers ?? event.answers,
                                state: resolution.resolution === 'failed' ? 'error' : 'completed',
                              }
                            : completion && !event.resolution
                              ? {
                                  ...event,
                                  resolution:
                                    completion.status === 'interrupted' ? 'cancelled' : 'expired',
                                }
                              : event
                        }
                        sessionId={session!.id}
                        onError={onError}
                        completed={Boolean(completion)}
                      />
                    )
                  }
                  if (event.kind === 'error')
                    return (
                      <div key={event.id} className="error-event">
                        <AlertCircle size={16} />
                        <div>
                          <strong>执行遇到问题</strong>
                          <p>{event.text || event.output || '请检查 CLI 连接状态后重试。'}</p>
                        </div>
                      </div>
                    )
                  if (event.kind === 'done') {
                    const turn = turnGroups.get(event.turnId) ?? []
                    const start = turn.find((item) => item.kind === 'user')?.timestamp
                    const usage = turn.findLast((item) => item.kind === 'usage')
                    return (
                      <div key={event.id} className="turn-summary">
                        <span>
                          {event.status === 'interrupted'
                            ? '已中断'
                            : event.status === 'error'
                              ? '执行失败'
                              : '本轮完成'}{' '}
                          ·{' '}
                          {start
                            ? `${Math.max(0, Math.round((event.timestamp - start) / 1000))} 秒`
                            : '耗时未知'}{' '}
                          · {turn.filter((item) => item.kind === 'tool').length} 项工具
                        </span>
                        <span>
                          {usage?.tokens !== undefined
                            ? `CLI 报告 ${usage.tokens} tokens`
                            : '用量未提供'}
                          {usage?.cost !== undefined ? ` · $${usage.cost.toFixed(4)}` : ''}
                        </span>
                        <button
                          className="button secondary small"
                          onClick={() => onInspectTurn?.(event.turnId)}
                        >
                          审阅变更与检查
                        </button>
                      </div>
                    )
                  }
                  return null
                })()
                return content ? (
                  <div
                    key={`${event.turnId}:${event.kind}:${event.itemId ?? event.id}`}
                    id={`event-${event.id}`}
                    className="conversation-event"
                    style={{
                      contentVisibility: focusEventId === event.id ? 'visible' : 'auto',
                      containIntrinsicSize: 'auto 120px',
                    }}
                  >
                    {content}
                  </div>
                ) : null
              })}
              {running && (
                <div className="activity-indicator">
                  <span className="pulse-dot" />
                  <span>{session?.status === 'waiting' ? '等待你的回复' : '正在处理…'}</span>
                  <span className="activity-time">
                    {session && PROVIDERS[session.provider].name}
                  </span>
                </div>
              )}
              {session?.status === 'interrupted' && (
                <div className="interrupted">
                  <RotateCcw size={14} />
                  上次执行已中断。发送消息即可继续当前会话。
                </div>
              )}
            </>
          )}
        </div>
      </div>
      <div className="composer-area">
        {draftError && (
          <div className="inline-warning" role="alert">
            草稿读取失败，请重试以保留已有内容。
            <button
              className="button secondary small"
              onClick={() => setDraftAttempt((attempt) => attempt + 1)}
            >
              重新读取草稿
            </button>
          </div>
        )}
        <div className="composer">
          {draft.context.map((item) => (
            <ContextPreview
              key={item.id}
              item={item}
              onRemove={() =>
                updateDraft({
                  ...draft,
                  context: draft.context.filter((entry) => entry.id !== item.id),
                  updatedAt: Date.now(),
                })
              }
            />
          ))}
          <textarea
            aria-label="消息输入框"
            ref={inputRef}
            value={draft.text}
            onChange={(event) =>
              updateDraft({ ...draft, text: event.target.value, updatedAt: Date.now() })
            }
            placeholder={running ? 'Agent 正在处理，完成后继续对话…' : '输入任务…'}
            rows={2}
            disabled={!session || draftLoading || draftError}
            onKeyDown={(event) => {
              if (
                event.key === 'Enter' &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing &&
                (settings?.sendKey !== 'mod-enter' || event.metaKey || event.ctrlKey)
              ) {
                event.preventDefault()
                void send()
              }
            }}
          />
          <div className="composer-footer">
            <button
              className="icon-button"
              title="添加图片"
              disabled={!provider?.capabilities?.images || draftLoading || draftError || !session}
              onClick={() => {
                const id = session?.id
                void api
                  .addImages()
                  .then((images) => {
                    const current = draftRef.current
                    if (!current || current.id !== id) return
                    if (current.draft.context.length + images.length > 20) {
                      onError('最多添加 20 项引用。请移除部分引用后再选择图片。')
                      return
                    }
                    updateDraft({
                      ...current.draft,
                      context: [...current.draft.context, ...images],
                      updatedAt: Date.now(),
                    })
                  })
                  .catch(onError)
              }}
            >
              <ImagePlus size={15} />
            </button>
            <div className="composer-meta">
              <span
                className="provider-dot"
                style={{ background: session && PROVIDERS[session.provider].color }}
              />
              <span>{session && PROVIDERS[session.provider].name}</span>
              <span className="meta-divider" />
              <span>{session?.model || '默认模型'}</span>
              {provider && !provider.available && <span className="text-warning">CLI 未就绪</span>}
            </div>
            {running ? (
              <button
                className="send-button stop-button"
                title="停止执行"
                aria-label="停止执行"
                onClick={onStop}
              >
                <Square size={14} fill="currentColor" />
              </button>
            ) : (
              <button
                className="send-button"
                title="发送消息 · Enter"
                aria-label="发送消息"
                disabled={!draft.text.trim() || sending || !session || disabled || draftLoading}
                onClick={() => void send()}
              >
                {sending ? (
                  <LoaderCircle size={17} className="spin" />
                ) : (
                  <ArrowUp size={18} strokeWidth={2.6} />
                )}
              </button>
            )}
          </div>
        </div>
        <div className="composer-hint">
          <span>Agent 可以修改文件和执行命令，请留意操作授权。</span>
          <span>
            {draftLoading
              ? '正在恢复草稿…'
              : settings?.sendKey === 'mod-enter'
                ? '⌘/Ctrl + Enter 发送'
                : 'Enter 发送 · Shift + Enter 换行'}
          </span>
        </div>
      </div>
    </div>
  )
}
