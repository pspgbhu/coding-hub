import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Plus, TerminalSquare, X, LoaderCircle } from 'lucide-react'
import '@xterm/xterm/css/xterm.css'
import { api, errorText } from '../lib/api'
import type { Project, TerminalOutput } from '../../shared/types'
export default function TerminalPanel({
  project,
  visible,
  onClose,
  theme,
}: {
  project: Project
  visible: boolean
  onClose: () => void
  theme: string
}) {
  const container = useRef<HTMLDivElement>(null)
  const [generation, setGeneration] = useState(0)
  const [state, setState] = useState('连接终端…')
  const terminalRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const idRef = useRef<string | undefined>(undefined)
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  useEffect(() => {
    if (!container.current) return
    let disposed = false
    let terminalId: string | undefined
    const buffered: TerminalOutput[] = []
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
      fontSize: 12,
      lineHeight: 1.35,
      scrollback: 5000,
      convertEol: false,
      theme: {
        background: getComputedStyle(document.documentElement)
          .getPropertyValue('--terminal-bg')
          .trim(),
        foreground: getComputedStyle(document.documentElement).getPropertyValue('--text').trim(),
      },
    })
    terminalRef.current = terminal
    const fit = new FitAddon()
    fitRef.current = fit
    terminal.loadAddon(fit)
    terminal.open(container.current)
    fit.fit()
    const output = (event: TerminalOutput) => {
      if (disposed) return
      if (!terminalId) {
        buffered.push(event)
        return
      }
      if (event.id !== terminalId) return
      if (event.data)
        terminal.write(event.data, () => {
          if (!disposed)
            void api
              .terminalAck(event.id, new TextEncoder().encode(event.data).length)
              .catch(() => {})
        })
      if (event.exitCode !== undefined) {
        setState(`已退出 · ${event.exitCode}`)
        terminal.write(`\r\n\x1b[90m[终端已退出，代码 ${event.exitCode}]\x1b[0m\r\n`)
      }
    }
    const unsubscribe = api.onTerminal(output)
    const input = terminal.onData((data) => {
      if (terminalId) void api.terminalWrite(terminalId, data).catch(() => {})
    })
    const resize = new ResizeObserver(() => {
      if (disposed || !visibleRef.current) return
      fit.fit()
      if (terminalId)
        void api.terminalResize(terminalId, terminal.cols, terminal.rows).catch(() => {})
    })
    resize.observe(container.current)
    void api
      .terminalCreate(project.id, terminal.cols, terminal.rows)
      .then((id) => {
        if (disposed) {
          void api.terminalClose(id)
          return
        }
        terminalId = id
        idRef.current = id
        setState(project.name)
        buffered.splice(0).forEach(output)
        if (visibleRef.current) terminal.focus()
      })
      .catch((error) => {
        if (!disposed) {
          setState('连接失败')
          terminal.write(`\x1b[31m${errorText(error)}\x1b[0m\r\n`)
        }
      })
    return () => {
      disposed = true
      unsubscribe()
      resize.disconnect()
      input.dispose()
      terminal.dispose()
      terminalRef.current = null
      fitRef.current = null
      idRef.current = undefined
      if (terminalId) void api.terminalClose(terminalId).catch(() => {})
    }
  }, [project.id, generation])
  useEffect(() => {
    if (!visible) return
    const frame = requestAnimationFrame(() => {
      const terminal = terminalRef.current
      if (!terminal) return
      fitRef.current?.fit()
      if (idRef.current)
        void api.terminalResize(idRef.current, terminal.cols, terminal.rows).catch(() => {})
      terminal.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [visible, generation])
  useEffect(() => {
    if (terminalRef.current)
      terminalRef.current.options.theme = {
        background: getComputedStyle(document.documentElement)
          .getPropertyValue('--terminal-bg')
          .trim(),
        foreground: getComputedStyle(document.documentElement).getPropertyValue('--text').trim(),
        cursor: getComputedStyle(document.documentElement).getPropertyValue('--text').trim(),
      }
  }, [theme])
  return (
    <section className="terminal-panel" style={{ display: visible ? undefined : 'none' }}>
      <div className="terminal-toolbar">
        <span className="panel-label">
          <TerminalSquare size={13} />
          终端
        </span>
        <span className="terminal-title">
          {state === '连接终端…' && <LoaderCircle size={12} className="spin" />}
          {state}
        </span>
        <div className="flex-spacer" />
        <button
          className="icon-button"
          title="重启终端"
          onClick={() => setGeneration((value) => value + 1)}
        >
          <Plus size={15} />
        </button>
        <button className="icon-button" title="关闭终端" onClick={onClose}>
          <X size={15} />
        </button>
      </div>
      <div className="terminal-container" ref={container} />
    </section>
  )
}
