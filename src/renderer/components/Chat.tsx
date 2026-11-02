import { useEffect, useRef, useState } from 'react'
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
  Sparkles,
  RotateCcw,
} from 'lucide-react'
import { PROVIDERS, type AgentEvent, type Session, type ProviderInfo } from '../../shared/types'
import { api } from '../lib/api'

function Markdown({ children }: { children: string }) {
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
}
function Tool({ event }: { event: AgentEvent }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={`tool-event ${event.state === 'error' ? 'failed' : ''}`}>
      <button className="tool-header" onClick={() => setOpen(!open)}>
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
          {event.output && <pre>{event.output}</pre>}
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
  const [answers, setAnswers] = useState<Record<string, string[]>>({})
  async function reply(decision?: string) {
    if (!event.requestId) return
    setPending(true)
    try {
      await api.respond(sessionId, event.requestId, { decision, answers })
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
        {inactive && <span className="muted">{sent ? '已回复' : '已结束'}</span>}
      </div>
      {event.text && <Markdown>{event.text}</Markdown>}
      {event.input != null && (
        <pre className="request-input">
          {typeof event.input === 'string' ? event.input : JSON.stringify(event.input, null, 2)}
        </pre>
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
                    name={question.id}
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
                {(
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
  onSend: (text: string) => Promise<void>
  onStop: () => void
  onError: (error: unknown) => void
  context?: { path: string; content: string }
  clearContext: () => void
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
}: ChatProps) {
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [copiedId, setCopiedId] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const following = useRef(true)
  const running = session?.status === 'running' || session?.status === 'waiting'
  useEffect(() => {
    setDraft('')
    following.current = true
    inputRef.current?.focus()
  }, [session?.id])
  useEffect(() => {
    if (following.current) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [events, sending])
  useEffect(() => {
    const input = inputRef.current
    if (input) {
      input.style.height = 'auto'
      input.style.height = Math.min(input.scrollHeight, 190) + 'px'
    }
  }, [draft])
  async function send() {
    if (!draft.trim() || sending || running || !session) return
    if (context && context.content.length > 60000) {
      onError('引用内容超过 60,000 字符。请移除引用，并在编辑器中选择较小的代码片段。')
      return
    }
    const message = context
      ? `${draft.trim()}\n\n<file_context path=${JSON.stringify(context.path)}>\n${context.content}\n</file_context>`
      : draft.trim()
    if (message.length > 95000) {
      onError('消息与引用内容合计超过 95,000 字符。请缩短消息或选择较小的代码片段后发送。')
      return
    }
    setSending(true)
    following.current = true
    try {
      await onSend(message)
      setDraft('')
      clearContext()
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
        ref={scrollRef}
        className="chat-scroll"
        onScroll={(event) => {
          const el = event.currentTarget
          following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100
        }}
      >
        <div className="conversation">
          {loading ? (
            <div className="chat-loading">
              <LoaderCircle className="spin" size={20} />
              <span>正在恢复会话…</span>
            </div>
          ) : events.filter((event) => !['session', 'status', 'done', 'usage'].includes(event.kind))
              .length === 0 ? (
            <div className="session-welcome">
              <div className="welcome-symbol">
                <Sparkles size={26} />
              </div>
              <h2>从一个想法开始</h2>
              <p>
                描述你想实现的功能，或让 {session ? PROVIDERS[session.provider].name : 'Agent'}{' '}
                帮你理解代码。
                <br />
                它将在当前项目中读取文件、执行命令并完成修改。
              </p>
              <div className="prompt-suggestions">
                {[
                  '帮我了解这个项目的架构',
                  '检查代码，找出可以改进的地方',
                  '运行项目并解决发现的问题',
                ].map((prompt) => (
                  <button
                    key={prompt}
                    onClick={() => {
                      setDraft(prompt)
                      inputRef.current?.focus()
                    }}
                  >
                    <span>{prompt}</span>
                    <ArrowUp size={14} />
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <>
              {events.map((event, index) => {
                if (event.kind === 'user')
                  return (
                    <div className="message user-message" key={event.id}>
                      <div className="user-bubble">
                        <Markdown>{event.text || ''}</Markdown>
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
                if (event.kind === 'tool') return <Tool key={event.id} event={event} />
                if (event.kind === 'approval' || event.kind === 'question')
                  return (
                    <RequestCard
                      key={event.id}
                      event={event}
                      sessionId={session!.id}
                      onError={onError}
                      completed={events.some(
                        (later, i) =>
                          i > index && later.turnId === event.turnId && later.kind === 'done',
                      )}
                    />
                  )
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
                return null
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
        <div className="composer">
          {context && (
            <div className="context-chip">
              <FileCode2 size={13} />
              <span>{context.path}</span>
              <button className="icon-button" title="移除引用" onClick={clearContext}>
                <X size={12} />
              </button>
            </div>
          )}
          <textarea
            aria-label="消息输入框"
            ref={inputRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={
              running ? 'Agent 正在处理，完成后继续对话…' : '描述任务，交给你的 coding agent…'
            }
            rows={2}
            disabled={!session}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                void send()
              }
            }}
          />
          <div className="composer-footer">
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
                disabled={!draft.trim() || sending || !session}
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
          <span>Enter 发送 · Shift + Enter 换行</span>
        </div>
      </div>
    </div>
  )
}
