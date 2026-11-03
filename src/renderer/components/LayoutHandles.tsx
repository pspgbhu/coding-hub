import { useEffect, useRef, useState } from 'react'
import type { Settings } from '../../shared/types'

type Panel = 'sidebarWidth' | 'workspaceWidth' | 'terminalHeight'
const panels: {
  key: Panel
  selector: string
  label: string
  vertical: boolean
  reverse: boolean
  min: number
  max: number
}[] = [
  {
    key: 'sidebarWidth',
    selector: '.sidebar',
    label: '调整侧栏宽度',
    vertical: false,
    reverse: false,
    min: 180,
    max: 420,
  },
  {
    key: 'workspaceWidth',
    selector: '.workspace',
    label: '调整代码工作区宽度',
    vertical: false,
    reverse: true,
    min: 350,
    max: 1400,
  },
  {
    key: 'terminalHeight',
    selector: '.terminal-panel',
    label: '调整终端高度',
    vertical: true,
    reverse: true,
    min: 140,
    max: 700,
  },
]
const variables: Record<Panel, string> = {
  sidebarWidth: '--sidebar-width',
  workspaceWidth: '--workspace-width',
  terminalHeight: '--terminal-height',
}
export default function LayoutHandles({
  settings,
  onChange,
}: {
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
}) {
  const [rects, setRects] = useState<Partial<Record<Panel, DOMRect>>>({})
  const changed = useRef(onChange)
  changed.current = onChange
  const dragging = useRef(false)
  const dragCleanup = useRef<(() => void) | undefined>(undefined)
  const requestUpdate = useRef<() => void>(() => {})
  useEffect(() => {
    let frame: number | undefined
    const update = () => {
      const next: Partial<Record<Panel, DOMRect>> = {}
      for (const panel of panels) {
        const element = [...document.querySelectorAll<HTMLElement>(panel.selector)].find(
          (el) => el.getClientRects().length > 0,
        )
        if (element) next[panel.key] = element.getBoundingClientRect()
      }
      setRects((previous) =>
        panels.every((panel) => {
          const a = previous[panel.key],
            b = next[panel.key]
          return (
            (!a && !b) ||
            Boolean(
              a &&
              b &&
              a.left === b.left &&
              a.top === b.top &&
              a.width === b.width &&
              a.height === b.height,
            )
          )
        })
          ? previous
          : next,
      )
    }
    const request = () => {
      if (frame !== undefined) return
      frame = requestAnimationFrame(() => {
        frame = undefined
        update()
      })
    }
    requestUpdate.current = request
    update()
    const observer = new ResizeObserver(request)
    observer.observe(document.body)
    const mutations = new MutationObserver(request)
    const app = document.querySelector('.app')
    if (app)
      mutations.observe(app, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['style', 'class'],
      })
    window.addEventListener('resize', request)
    return () => {
      observer.disconnect()
      mutations.disconnect()
      window.removeEventListener('resize', request)
      if (frame !== undefined) cancelAnimationFrame(frame)
      dragCleanup.current?.()
    }
  }, [])
  return (
    <>
      {panels.map((panel) => {
        const rect = rects[panel.key]
        if (!rect) return null
        const value = settings[panel.key] ?? (panel.vertical ? rect.height : rect.width)
        const commit = (next: number) =>
          changed.current({
            [panel.key]: Math.round(Math.max(panel.min, Math.min(panel.max, next))),
          })
        return (
          <div
            key={panel.key}
            role="separator"
            aria-label={panel.label}
            aria-orientation={panel.vertical ? 'horizontal' : 'vertical'}
            aria-valuemin={panel.min}
            aria-valuemax={panel.max}
            aria-valuenow={Math.round(value)}
            tabIndex={0}
            className={`layout-handle ${panel.vertical ? 'horizontal' : 'vertical'}`}
            style={
              panel.vertical
                ? { left: rect.left, top: rect.top - 3, width: rect.width }
                : {
                    left: (panel.reverse ? rect.left : rect.right) - 3,
                    top: rect.top,
                    height: rect.height,
                  }
            }
            onKeyDown={(event) => {
              const delta =
                event.key === 'ArrowRight' || event.key === 'ArrowDown'
                  ? 10
                  : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
                    ? -10
                    : 0
              if (delta) {
                event.preventDefault()
                commit(value + delta * (panel.reverse ? -1 : 1))
              }
            }}
            onPointerDown={(event) => {
              event.preventDefault()
              event.currentTarget.setPointerCapture(event.pointerId)
              dragging.current = true
              const origin = panel.vertical ? event.clientY : event.clientX
              let current = value
              const app = document.querySelector<HTMLElement>('.app')
              const move = (e: PointerEvent) => {
                current = Math.max(
                  panel.min,
                  Math.min(
                    panel.max,
                    value +
                      ((panel.vertical ? e.clientY : e.clientX) - origin) *
                        (panel.reverse ? -1 : 1),
                  ),
                )
                app?.style.setProperty(variables[panel.key], `${Math.round(current)}px`)
              }
              const cleanup = () => {
                dragging.current = false
                window.removeEventListener('pointermove', move)
                window.removeEventListener('pointerup', end)
                window.removeEventListener('pointercancel', end)
                dragCleanup.current = undefined
              }
              const end = () => {
                cleanup()
                requestUpdate.current()
                commit(current)
              }
              dragCleanup.current?.()
              dragCleanup.current = cleanup
              window.addEventListener('pointermove', move)
              window.addEventListener('pointerup', end, { once: true })
              window.addEventListener('pointercancel', end, { once: true })
            }}
          />
        )
      })}
    </>
  )
}
