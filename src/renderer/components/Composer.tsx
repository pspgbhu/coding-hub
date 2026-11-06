import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowUp, ImagePlus, LoaderCircle, Square } from 'lucide-react'
import type {
  ComposerDraft,
  ContextItem,
  ProviderInfo,
  Settings,
  TurnInput,
} from '../../shared/types'
import { api } from '../lib/api'
import { registerCloseFlush } from '../lib/close-flush'
import ContextPreview from './ContextPreview'

interface ComposerProps<T extends ComposerDraft> {
  draftKey: string
  loadDraft: () => Promise<T>
  saveDraft: (draft: T) => Promise<void>
  onSend: (input: TurnInput, draft: T) => Promise<void>
  onError: (error: unknown) => void
  provider?: ProviderInfo
  getProvider?: (draft: T) => ProviderInfo | undefined
  running?: boolean
  onStop?: () => void
  disabled?: boolean
  canSend?: (draft: T) => boolean
  clearOnSend?: boolean
  serverClearsDraft?: boolean
  context?: ContextItem
  clearContext: () => void
  settings?: Settings
  editRequest?: { draftKey: string; text: string; nonce: number }
  focusRequest?: number
  renderControls?: (draft: T, update: (patch: Partial<T>) => void, busy: boolean) => ReactNode
}

export default function Composer<T extends ComposerDraft>(props: ComposerProps<T>) {
  const latest = useRef(props)
  latest.current = props
  const [draft, setDraft] = useState<T>()
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [sending, setSending] = useState(false)
  const submitting = useRef(false)
  const input = useRef<HTMLTextAreaElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const current = useRef<{ key: string; draft: T; save: (draft: T) => Promise<void> } | undefined>(
    undefined,
  )
  const loadingKey = useRef<string | undefined>(undefined)
  const consumed = useRef(new Set<string>())
  const lastEdit = useRef<number | undefined>(undefined)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  async function flush() {
    clearTimeout(timer.current)
    const value = current.current
    if (value && !consumed.current.has(value.key)) await value.save(value.draft)
  }
  useEffect(() => registerCloseFlush(flush), [])
  useEffect(() => {
    const unload = () => void flush().catch((error) => latest.current.onError(error))
    window.addEventListener('beforeunload', unload)
    return () => window.removeEventListener('beforeunload', unload)
  }, [])
  useEffect(() => {
    void flush().catch((error) => latest.current.onError(error))
    const { draftKey, loadDraft, saveDraft } = latest.current
    const focusAtStart = document.activeElement
    loadingKey.current = draftKey
    current.current = undefined
    setDraft(undefined)
    setLoading(true)
    setFailed(false)
    let stale = false
    void loadDraft()
      .then((saved) => {
        if (stale) return
        consumed.current.delete(draftKey)
        current.current = { key: draftKey, draft: saved, save: saveDraft }
        setDraft(saved)
      })
      .catch((error) => {
        if (!stale) {
          setFailed(true)
          latest.current.onError(error)
        }
      })
      .finally(() => {
        if (!stale) {
          setLoading(false)
          requestAnimationFrame(() => {
            if (
              mounted.current &&
              (document.activeElement === document.body || document.activeElement === focusAtStart)
            )
              input.current?.focus()
          })
        }
      })
    return () => {
      stale = true
      void flush().catch((error) => latest.current.onError(error))
    }
  }, [props.draftKey, attempt])

  function update(patch: Partial<T>) {
    if (!mounted.current) return
    const value = current.current
    if (!value || value.key !== props.draftKey || consumed.current.has(value.key)) return
    const next = {
      ...value.draft,
      ...patch,
      updatedAt: Math.max(Date.now(), value.draft.updatedAt + 1),
    }
    current.current = { ...value, draft: next }
    setDraft(next)
    clearTimeout(timer.current)
    timer.current = setTimeout(
      () => void flush().catch((error) => latest.current.onError(error)),
      250,
    )
  }
  useEffect(() => {
    const context = props.context
    const value = current.current
    if (!context || loading || failed || sending || !value || value.key !== props.draftKey) return
    if ((context.content?.length ?? 0) > 60000 || value.draft.context.length >= 20) {
      props.onError('最多添加 20 项引用，单项文本上限为 60,000 字符。请缩小引用内容。')
      props.clearContext()
      return
    }
    if (!value.draft.context.some((item) => item.id === context.id))
      update({ context: [...value.draft.context, context] } as Partial<T>)
    props.clearContext()
  }, [props.context, props.draftKey, loading, failed, sending])
  useEffect(() => {
    if (
      !props.editRequest ||
      loading ||
      failed ||
      props.editRequest.draftKey !== props.draftKey ||
      lastEdit.current === props.editRequest.nonce
    )
      return
    lastEdit.current = props.editRequest.nonce
    update({ text: props.editRequest.text } as Partial<T>)
    input.current?.focus()
  }, [props.editRequest, loading, failed])
  useEffect(() => {
    input.current?.focus()
  }, [props.focusRequest])
  useEffect(() => {
    if (!input.current) return
    input.current.style.height = 'auto'
    input.current.style.height = Math.min(input.current.scrollHeight, 190) + 'px'
  }, [draft?.text])

  const provider = draft ? (props.getProvider?.(draft) ?? props.provider) : props.provider
  const blocked =
    !draft || loading || failed || props.disabled || (draft && props.canSend?.(draft) === false)
  async function send() {
    const value = current.current
    if (
      !value ||
      value.key !== props.draftKey ||
      blocked ||
      props.running ||
      submitting.current ||
      !value.draft.text.trim()
    )
      return
    if (
      value.draft.text.length +
        value.draft.context.reduce((sum, item) => sum + (item.content?.length ?? 0), 0) >
      95000
    ) {
      props.onError('消息与引用内容合计超过 95,000 字符。请缩短消息或选择较小的代码片段后发送。')
      return
    }
    submitting.current = true
    setSending(true)
    try {
      await flush()
      await props.onSend(
        { text: value.draft.text.trim(), context: value.draft.context },
        value.draft,
      )
      if (props.clearOnSend === false) consumed.current.add(value.key)
      else if (
        mounted.current &&
        current.current?.key === value.key &&
        current.current.draft === value.draft
      ) {
        const empty = {
          ...value.draft,
          text: '',
          context: [],
          updatedAt: Math.max(Date.now(), value.draft.updatedAt + 1),
        }
        current.current = { ...value, draft: empty }
        setDraft(empty)
        if (!props.serverClearsDraft) await value.save(empty)
      }
    } catch (error) {
      if (props.serverClearsDraft && mounted.current && current.current?.draft === value.draft) {
        try {
          const saved = await props.loadDraft()
          if (mounted.current && current.current?.draft === value.draft) {
            current.current = { ...value, draft: saved }
            setDraft(saved)
          }
        } catch {
          // Preserve the local buffer when recovery storage is also unavailable.
        }
      }
      props.onError(error)
    } finally {
      submitting.current = false
      setSending(false)
      if (loadingKey.current === value.key) input.current?.focus()
    }
  }

  return (
    <div className="composer-area" aria-busy={sending || loading}>
      {failed && (
        <div className="inline-warning" role="alert">
          草稿读取失败，请重试以保留已有内容。
          <button
            className="button secondary small"
            onClick={() => setAttempt((value) => value + 1)}
          >
            重新读取草稿
          </button>
        </div>
      )}
      <div className="composer">
        {draft?.context.map((item) => (
          <ContextPreview
            key={item.id}
            item={item}
            disabled={sending}
            onRemove={() =>
              update({
                context: draft.context.filter((entry) => entry.id !== item.id),
              } as Partial<T>)
            }
          />
        ))}
        <textarea
          aria-label="消息输入框"
          ref={input}
          value={draft?.text ?? ''}
          onChange={(event) => update({ text: event.target.value } as Partial<T>)}
          placeholder={props.running ? 'Agent 正在处理，完成后继续对话…' : '描述你想完成的任务…'}
          rows={2}
          disabled={loading || failed || sending}
          onKeyDown={(event) => {
            if (
              event.key === 'Enter' &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing &&
              (props.settings?.sendKey !== 'mod-enter' || event.metaKey || event.ctrlKey)
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
            aria-label="添加图片"
            disabled={!provider?.capabilities?.images || loading || failed || sending}
            onClick={() => {
              const key = props.draftKey
              void api
                .addImages()
                .then((images) => {
                  const value = current.current
                  if (!mounted.current || !value || value.key !== key || consumed.current.has(key))
                    return
                  if (value.draft.context.length + images.length > 20) {
                    props.onError('最多添加 20 项引用。请移除部分引用后再选择图片。')
                    return
                  }
                  update({ context: [...value.draft.context, ...images] } as Partial<T>)
                })
                .catch(props.onError)
            }}
          >
            <ImagePlus size={15} />
          </button>
          <div className="composer-options">
            {draft && props.renderControls?.(draft, update, sending)}
          </div>
          {props.running ? (
            <button
              className="send-button stop-button"
              title="停止执行"
              aria-label="停止执行"
              onClick={props.onStop}
            >
              <Square size={14} fill="currentColor" />
            </button>
          ) : (
            <button
              className="send-button"
              title="发送消息"
              aria-label="发送消息"
              disabled={Boolean(blocked) || sending || !draft?.text.trim()}
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
          {loading
            ? '正在恢复草稿…'
            : props.settings?.sendKey === 'mod-enter'
              ? '⌘/Ctrl + Enter 发送'
              : 'Enter 发送 · Shift + Enter 换行'}
        </span>
      </div>
    </div>
  )
}
