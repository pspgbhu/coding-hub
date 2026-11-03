import { useEffect, useRef, useState, type ReactNode } from 'react'

/** Keep the existing sidebar scroller while mounting only its visible session rows. */
export default function WindowedSessionList<T extends { id: string }>({
  items,
  activeId,
  rowHeight,
  children,
}: {
  items: T[]
  activeId?: string
  rowHeight: number
  children: (item: T) => ReactNode
}) {
  const root = useRef<HTMLDivElement>(null)
  const [range, setRange] = useState({ start: 0, end: 25 })
  const updateRef = useRef<() => void>(() => {})
  useEffect(() => {
    const element = root.current
    const parent = element?.closest<HTMLElement>('.sidebar-scroll')
    if (!element || !parent) return
    const update = () => {
      const offset =
        element.getBoundingClientRect().top - parent.getBoundingClientRect().top + parent.scrollTop
      const top = Math.max(0, parent.scrollTop - offset)
      const start = Math.max(0, Math.floor(top / rowHeight) - 5)
      const end = Math.min(items.length, Math.ceil((top + parent.clientHeight) / rowHeight) + 5)
      setRange((previous) =>
        previous.start === start && previous.end === end ? previous : { start, end },
      )
    }
    updateRef.current = update
    const observer = new ResizeObserver(update)
    observer.observe(parent)
    parent.addEventListener('scroll', update, { passive: true })
    update()
    return () => {
      observer.disconnect()
      parent.removeEventListener('scroll', update)
    }
  }, [items.length, rowHeight])
  useEffect(() => {
    const element = root.current
    const parent = element?.closest<HTMLElement>('.sidebar-scroll')
    if (!element || !parent || !activeId) return
    const index = items.findIndex((item) => item.id === activeId)
    if (index < 0) return
    const offset =
      element.getBoundingClientRect().top - parent.getBoundingClientRect().top + parent.scrollTop
    const top = offset + index * rowHeight
    if (top < parent.scrollTop || top + rowHeight > parent.scrollTop + parent.clientHeight)
      parent.scrollTop = Math.max(0, top - parent.clientHeight / 2)
    updateRef.current()
  }, [activeId, rowHeight])
  return (
    <div
      ref={root}
      role="list"
      aria-label="会话列表"
      data-total-count={items.length}
      className="windowed-sessions"
      style={{ position: 'relative', height: items.length * rowHeight }}
      onKeyDown={(event) => {
        if (!(event.target instanceof HTMLElement) || !event.target.closest('.session-select'))
          return
        const current = Number(
          event.target.closest<HTMLElement>('[data-session-index]')?.dataset.sessionIndex,
        )
        const next =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? items.length - 1
              : event.key === 'ArrowDown'
                ? Math.min(items.length - 1, current + 1)
                : event.key === 'ArrowUp'
                  ? Math.max(0, current - 1)
                  : -1
        if (next < 0) return
        event.preventDefault()
        const element = root.current!
        const parent = element.closest<HTMLElement>('.sidebar-scroll')!
        const offset =
          element.getBoundingClientRect().top -
          parent.getBoundingClientRect().top +
          parent.scrollTop
        parent.scrollTop = Math.max(0, offset + next * rowHeight - parent.clientHeight / 2)
        updateRef.current()
        requestAnimationFrame(() =>
          element
            .querySelector<HTMLButtonElement>(`[data-session-index="${next}"] .session-select`)
            ?.focus(),
        )
      }}
    >
      {items.slice(range.start, range.end).map((item, relative) => {
        const index = range.start + relative
        return (
          <div
            key={item.id}
            role="listitem"
            aria-setsize={items.length}
            aria-posinset={index + 1}
            data-session-index={index}
            style={{
              position: 'absolute',
              top: index * rowHeight,
              left: 0,
              right: 0,
              height: rowHeight,
            }}
          >
            {children(item)}
          </div>
        )
      })}
    </div>
  )
}
