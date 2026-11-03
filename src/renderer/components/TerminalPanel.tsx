import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import {
  ArrowDown,
  ArrowUp,
  Copy,
  LoaderCircle,
  MessageSquarePlus,
  Plus,
  RotateCcw,
  Search,
  Square,
  TerminalSquare,
  X,
} from 'lucide-react'
import '@xterm/xterm/css/xterm.css'
import { api, errorText } from '../lib/api'
import type { Project, Settings, TerminalDescriptor, TerminalOutput } from '../../shared/types'

interface TerminalHandle {
  terminal: Terminal
  search: SearchAddon
}
const outputListeners = new Map<string, Set<(event: TerminalOutput) => void>>()
let unsubscribeOutput: (() => void) | undefined
function subscribeOutput(id: string, listener: (event: TerminalOutput) => void): () => void {
  const listeners = outputListeners.get(id) ?? new Set<(event: TerminalOutput) => void>()
  listeners.add(listener)
  outputListeners.set(id, listeners)
  unsubscribeOutput ??= api.onTerminal((event) => {
    for (const receive of outputListeners.get(event.id) ?? []) receive(event)
  })
  return () => {
    listeners.delete(listener)
    if (!listeners.size) outputListeners.delete(id)
    if (!outputListeners.size) {
      unsubscribeOutput?.()
      unsubscribeOutput = undefined
    }
  }
}
interface SessionProps {
  descriptor: TerminalDescriptor
  visible: boolean
  theme: string
  settings?: Settings
  onReady: (id: string, handle?: TerminalHandle) => void
  onExit: (id: string, code: number) => void
  onError: (error: unknown) => void
  onSearch: () => void
}
function terminalTheme() {
  const styles = getComputedStyle(document.documentElement)
  return {
    background: styles.getPropertyValue('--terminal-bg').trim(),
    foreground: styles.getPropertyValue('--text').trim(),
    cursor: styles.getPropertyValue('--text').trim(),
  }
}
function TerminalSession(props: SessionProps) {
  const container = useRef<HTMLDivElement>(null)
  const handle = useRef<TerminalHandle | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const latest = useRef(props)
  latest.current = props
  const [state, setState] = useState('正在重新连接…')
  useEffect(() => {
    if (!container.current) return
    let disposed = false
    let attached = false
    let lastSequence = 0
    let exited = props.descriptor.exitCode !== undefined
    const buffered: TerminalOutput[] = []
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
      fontSize: props.settings?.fontSize ?? 12,
      lineHeight: 1.35,
      scrollback: 5000,
      convertEol: false,
      theme: terminalTheme(),
    })
    const fit = new FitAddon()
    const search = new SearchAddon()
    terminal.loadAddon(fit)
    terminal.loadAddon(search)
    terminal.open(container.current)
    handle.current = { terminal, search }
    fitRef.current = fit
    latest.current.onReady(props.descriptor.id, handle.current)
    const report = (error: unknown) => {
      if (!disposed) latest.current.onError(error)
    }
    const output = (event: TerminalOutput) => {
      if (disposed || event.id !== props.descriptor.id) return
      if (!attached) {
        buffered.push(event)
        return
      }
      if (event.sequence !== undefined && event.sequence <= lastSequence) return
      if (event.sequence !== undefined) lastSequence = event.sequence
      if (event.data)
        terminal.write(event.data, () => {
          if (!disposed)
            void api
              .terminalAck(event.id, new TextEncoder().encode(event.data!).length)
              .catch(report)
        })
      if (event.exitCode !== undefined) {
        exited = true
        setState(`已退出 · ${event.exitCode}`)
        latest.current.onExit(event.id, event.exitCode)
        terminal.write(`\r\n\x1b[90m[终端已退出，代码 ${event.exitCode}]\x1b[0m\r\n`)
      }
    }
    const unsubscribe = subscribeOutput(props.descriptor.id, output)
    const input = terminal.onData((data) => {
      if (attached && !exited) void api.terminalWrite(props.descriptor.id, data).catch(report)
    })
    terminal.attachCustomKeyEventHandler((event) => {
      if (
        event.type === 'keydown' &&
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === 'f'
      ) {
        latest.current.onSearch()
        return false
      }
      return true
    })
    const resize = () => {
      if (
        disposed ||
        !latest.current.visible ||
        !container.current?.clientWidth ||
        !container.current.clientHeight
      )
        return
      fit.fit()
      if (attached && !exited)
        void api.terminalResize(props.descriptor.id, terminal.cols, terminal.rows).catch(report)
    }
    const observer = new ResizeObserver(resize)
    observer.observe(container.current)
    void api
      .terminalAttach(props.descriptor.id)
      .then((snapshot) => {
        if (disposed) return
        lastSequence = snapshot.sequence ?? 0
        exited = snapshot.exitCode !== undefined
        const completeAttach = () => {
          if (disposed) return
          attached = true
          setState(exited ? `已退出 · ${snapshot.exitCode}` : '')
          if (exited) latest.current.onExit(snapshot.id, snapshot.exitCode!)
          buffered.splice(0).forEach(output)
          resize()
          if (latest.current.visible) terminal.focus()
        }
        // write() parses asynchronously and can emit device replies through onData.
        // Historical queries must finish before live PTY input and buffered output resume.
        if (snapshot.buffer) terminal.write(snapshot.buffer, completeAttach)
        else completeAttach()
      })
      .catch((error) => {
        if (!disposed) {
          setState('连接失败，可新建终端')
          report(error)
        }
      })
    return () => {
      disposed = true
      unsubscribe()
      observer.disconnect()
      input.dispose()
      latest.current.onReady(props.descriptor.id)
      terminal.dispose()
      handle.current = null
      fitRef.current = null
      // Renderer lifetime never controls the PTY. Only explicit terminate closes it.
    }
  }, [props.descriptor.id])
  useEffect(() => {
    if (!props.visible) return
    const frame = requestAnimationFrame(() => {
      const terminal = handle.current?.terminal
      if (!terminal || !container.current?.clientWidth || !container.current.clientHeight) return
      fitRef.current?.fit()
      if (props.descriptor.exitCode === undefined)
        void api
          .terminalResize(props.descriptor.id, terminal.cols, terminal.rows)
          .catch(props.onError)
      terminal.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [props.visible, props.descriptor.id, props.descriptor.exitCode])
  useEffect(() => {
    if (handle.current) {
      handle.current.terminal.options.theme = terminalTheme()
      handle.current.terminal.options.fontSize = props.settings?.fontSize ?? 12
      if (props.visible) fitRef.current?.fit()
    }
  }, [props.theme, props.settings?.fontSize, props.visible])
  return (
    <div
      style={{
        display: props.visible ? 'flex' : 'none',
        flex: 1,
        minHeight: 0,
        flexDirection: 'column',
      }}
      role="tabpanel"
      id={`terminal-panel-${props.descriptor.id}`}
      aria-labelledby={`terminal-tab-${props.descriptor.id}`}
      aria-label={props.descriptor.title}
    >
      {state && (
        <div className="terminal-title" role="status" style={{ padding: '3px 15px' }}>
          {state}
        </div>
      )}
      <div className="terminal-container" ref={container} />
    </div>
  )
}
function selectedOrRecent(terminal: Terminal): string {
  const selection = terminal.getSelection()
  if (selection) return selection
  const buffer = terminal.buffer.active
  const lines: string[] = []
  for (let row = Math.max(0, buffer.length - 200); row < buffer.length; row++) {
    const line = buffer.getLine(row)
    if (line) lines.push(line.translateToString(true))
  }
  return lines.join('\n').trim().slice(-32000)
}
export default function TerminalPanel({
  project,
  visible,
  onClose,
  theme,
  onContext,
  onError,
  settings,
}: {
  project: Project
  visible: boolean
  onClose: () => void
  theme: string
  onContext?: (text: string) => void
  onError?: (error: unknown) => void
  settings?: Settings
}) {
  const [tabs, setTabs] = useState<TerminalDescriptor[]>([])
  const [active, setActive] = useState('')
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState('')
  const [searchResult, setSearchResult] = useState('')
  const searchInput = useRef<HTMLInputElement>(null)
  const handles = useRef(new Map<string, TerminalHandle>())
  const latest = useRef({ onError, onContext })
  latest.current = { onError, onContext }
  const report = (failure: unknown) => {
    setError(errorText(failure))
    latest.current.onError?.(failure)
  }
  const create = async () => {
    const id = await api.terminalCreate(project.id, 80, 24)
    return api.terminalAttach(id)
  }
  useEffect(() => {
    let disposed = false
    setBusy(true)
    setError('')
    void api
      .terminalList(project.id)
      .then(async (existing) => {
        if (disposed) return
        const entries = existing.length ? existing : [await create()]
        if (disposed) return
        setTabs(entries)
        setActive((entries.find((entry) => entry.exitCode === undefined) ?? entries.at(-1))!.id)
      })
      .catch((failure) => {
        if (!disposed) report(failure)
      })
      .finally(() => {
        if (!disposed) setBusy(false)
      })
    return () => {
      disposed = true
    }
  }, [project.id])
  useEffect(() => {
    if (searching && visible) searchInput.current?.focus()
  }, [searching, visible])
  const current = tabs.find((entry) => entry.id === active)
  const add = async () => {
    setBusy(true)
    setError('')
    try {
      const descriptor = await create()
      setTabs((entries) => [...entries, descriptor])
      setActive(descriptor.id)
    } catch (failure) {
      report(failure)
    } finally {
      setBusy(false)
    }
  }
  const terminate = async (restart = false) => {
    if (!current) return
    setBusy(true)
    setError('')
    try {
      if (current.exitCode === undefined) await api.terminalClose(current.id)
      setTabs((entries) =>
        entries.map((entry) =>
          entry.id === current.id ? { ...entry, exitCode: entry.exitCode ?? 130 } : entry,
        ),
      )
      if (restart) {
        const descriptor = await create()
        setTabs((entries) => [...entries, descriptor])
        setActive(descriptor.id)
      }
    } catch (failure) {
      report(failure)
    } finally {
      setBusy(false)
    }
  }
  const find = (previous = false, value = query, incremental = false) => {
    const handle = handles.current.get(active)
    if (!handle) return
    if (!value) {
      handle.search.clearDecorations()
      setSearchResult('')
      return
    }
    const found = previous
      ? handle.search.findPrevious(value)
      : handle.search.findNext(value, { incremental })
    setSearchResult(found ? '' : '未找到')
  }
  const copy = async () => {
    const handle = handles.current.get(active)
    if (!handle) return
    try {
      await navigator.clipboard.writeText(selectedOrRecent(handle.terminal))
      setError('')
    } catch (failure) {
      report(failure)
    }
  }
  return (
    <section
      className="terminal-panel"
      style={{
        display: visible ? undefined : 'none',
        height: settings?.terminalHeight || undefined,
      }}
      aria-label="项目终端"
    >
      <div className="terminal-toolbar" style={{ gap: 8 }}>
        <span className="panel-label">
          <TerminalSquare size={13} />
          终端
        </span>
        <span className="terminal-title">
          {busy && <LoaderCircle size={12} className="spin" />}
          {project.name}
        </span>
        <div className="flex-spacer" />
        <button
          className="icon-button"
          aria-label="搜索终端输出"
          title="搜索终端输出"
          onClick={() => setSearching((value) => !value)}
        >
          <Search size={14} />
        </button>
        <button
          className="icon-button"
          aria-label="复制终端输出"
          title="复制所选内容或最近 200 行"
          onClick={() => void copy()}
          disabled={!current}
        >
          <Copy size={14} />
        </button>
        {onContext && (
          <button
            className="icon-button"
            aria-label="引用终端输出"
            title="将所选内容或最近 200 行加入消息"
            disabled={!current}
            onClick={() => {
              const terminal = handles.current.get(active)?.terminal
              const text = terminal && selectedOrRecent(terminal)
              if (text) latest.current.onContext?.(text)
            }}
          >
            <MessageSquarePlus size={14} />
          </button>
        )}
        <button
          className="icon-button"
          aria-label="新建终端"
          title="新建终端"
          onClick={() => void add()}
          disabled={busy}
        >
          <Plus size={15} />
        </button>
        <button
          className="icon-button"
          aria-label="终止当前终端"
          title="终止当前终端及其子进程"
          onClick={() => void terminate()}
          disabled={busy || !current || current.exitCode !== undefined}
        >
          <Square size={12} />
        </button>
        <button
          className="icon-button"
          aria-label="重启当前终端"
          title="终止当前终端并创建新终端"
          onClick={() => void terminate(true)}
          disabled={busy || !current}
        >
          <RotateCcw size={14} />
        </button>
        <button
          className="icon-button"
          aria-label="隐藏终端面板"
          title="隐藏终端面板，保留运行中的命令"
          onClick={onClose}
        >
          <X size={15} />
        </button>
      </div>
      {tabs.length > 0 && (
        <div
          role="tablist"
          aria-label="终端标签"
          onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
            event.preventDefault()
            const index = tabs.findIndex((entry) => entry.id === active)
            const next =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? tabs.length - 1
                  : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
            setActive(tabs[next].id)
            document.getElementById(`terminal-tab-${tabs[next].id}`)?.focus()
          }}
          style={{
            display: 'flex',
            gap: 4,
            overflowX: 'auto',
            flexShrink: 0,
            padding: '3px 12px',
            borderBottom: '1px solid var(--border)',
          }}
        >
          {tabs.map((entry, index) => (
            <button
              key={entry.id}
              role="tab"
              id={`terminal-tab-${entry.id}`}
              aria-controls={`terminal-panel-${entry.id}`}
              tabIndex={entry.id === active ? 0 : -1}
              aria-selected={entry.id === active}
              onClick={() => {
                setActive(entry.id)
                setSearchResult('')
              }}
              className="button ghost"
              style={{
                padding: '3px 8px',
                whiteSpace: 'nowrap',
                fontSize: 11,
                background: entry.id === active ? 'var(--hover)' : undefined,
              }}
              title={`${entry.cwd}${entry.exitCode === undefined ? ' · 运行中' : ` · 已退出 ${entry.exitCode}`}`}
            >
              {entry.title} {index + 1}
              {entry.exitCode !== undefined ? ` · 已退出 ${entry.exitCode}` : ''}
            </button>
          ))}
        </div>
      )}
      {searching && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 12px' }}>
          <input
            ref={searchInput}
            className="input"
            aria-label="搜索终端内容"
            placeholder="搜索终端输出"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              find(false, event.target.value, true)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                find(event.shiftKey)
              }
              if (event.key === 'Escape') {
                setSearching(false)
                handles.current.get(active)?.search.clearDecorations()
                handles.current.get(active)?.terminal.focus()
              }
            }}
            style={{ flex: 1, minWidth: 80, padding: '4px 7px', fontSize: 11 }}
          />
          <span className="terminal-title" role="status">
            {searchResult}
          </span>
          <button
            className="icon-button"
            aria-label="上一个终端搜索结果"
            onClick={() => find(true)}
          >
            <ArrowUp size={13} />
          </button>
          <button className="icon-button" aria-label="下一个终端搜索结果" onClick={() => find()}>
            <ArrowDown size={13} />
          </button>
        </div>
      )}
      {error && (
        <div className="inline-error" role="alert" style={{ padding: '4px 12px', fontSize: 11 }}>
          {error}
          <button className="icon-button" aria-label="关闭终端错误" onClick={() => setError('')}>
            <X size={12} />
          </button>
        </div>
      )}
      {tabs.map((entry) => (
        <TerminalSession
          key={entry.id}
          descriptor={entry}
          visible={visible && active === entry.id}
          theme={theme}
          settings={settings}
          onError={report}
          onSearch={() => setSearching(true)}
          onExit={(id, code) =>
            setTabs((entries) =>
              entries.map((item) =>
                item.id === id && item.exitCode !== code ? { ...item, exitCode: code } : item,
              ),
            )
          }
          onReady={(id, handle) => {
            if (handle) handles.current.set(id, handle)
            else handles.current.delete(id)
          }}
        />
      ))}
      {!busy && !tabs.length && (
        <div className="terminal-title" style={{ padding: 14 }}>
          尚无终端。
          <button className="button ghost" onClick={() => void add()}>
            新建终端
          </button>
        </div>
      )}
    </section>
  )
}
