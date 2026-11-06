import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import {
  Check,
  ChevronDown,
  Cpu,
  Folder,
  FolderOpen,
  Gauge,
  GitBranch,
  Plus,
  Search,
  Settings2,
} from 'lucide-react'
import {
  PROVIDERS,
  type Model,
  type NewSessionDraft,
  type Project,
  type ProviderId,
  type ProviderInfo,
  type Workspace,
} from '../../shared/types'
import './composer-selectors.css'

type PickerEntry =
  | { key: string; heading: string }
  | { key: string; note: string }
  | {
      key: string
      label: string
      description?: string
      badge?: string
      selected?: boolean
      disabled?: boolean
      icon?: ReactNode
      onChoose: () => void
    }

function isChoice(entry: PickerEntry): entry is Extract<PickerEntry, { label: string }> {
  return 'label' in entry
}

/** A shared, portal-backed picker keeps composer menus inside the visible window. */
function Picker({
  label,
  value,
  icon,
  entries,
  disabled,
  title,
  searchPlaceholder,
  search,
  onSearch,
  wide = false,
}: {
  label: string
  value: string
  icon: ReactNode
  entries: PickerEntry[]
  disabled?: boolean
  title?: string
  searchPlaceholder?: string
  search?: string
  onSearch?: (value: string) => void
  wide?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState('')
  const [position, setPosition] = useState({ left: 8, top: 8, width: 320, maxHeight: 420 })
  const trigger = useRef<HTMLButtonElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const id = useId()
  const reasonId = `${id}-reason`
  const choices = entries.filter(isChoice).filter((entry) => !entry.disabled)
  const choicesRef = useRef(choices)
  choicesRef.current = choices

  function close(restoreFocus = true) {
    setOpen(false)
    onSearch?.('')
    if (restoreFocus) trigger.current?.focus({ preventScroll: true })
  }

  useEffect(() => {
    if (disabled && open) close()
  }, [disabled, open])

  useLayoutEffect(() => {
    if (!open) return
    function positionPopup() {
      const anchor = trigger.current?.getBoundingClientRect()
      const panel = popup.current
      if (!anchor || !panel) return
      const margin = 8
      const gap = 6
      const width = Math.max(160, Math.min(wide ? 360 : 304, window.innerWidth - margin * 2))
      const below = window.innerHeight - anchor.bottom - gap - margin
      const above = anchor.top - gap - margin
      const hiddenListHeight = list.current
        ? list.current.scrollHeight - list.current.clientHeight
        : 0
      const naturalHeight = Math.min(panel.scrollHeight + hiddenListHeight, 420)
      const useAbove = below < naturalHeight && above > below
      const maxHeight = Math.max(64, Math.min(420, useAbove ? above : below))
      const height = Math.min(naturalHeight, maxHeight)
      setPosition({
        left: Math.max(margin, Math.min(anchor.left, window.innerWidth - width - margin)),
        top: useAbove
          ? Math.max(margin, anchor.top - gap - height)
          : Math.max(margin, Math.min(anchor.bottom + gap, window.innerHeight - height - margin)),
        width,
        maxHeight,
      })
    }
    positionPopup()
    window.addEventListener('resize', positionPopup)
    window.addEventListener('scroll', positionPopup, true)
    return () => {
      window.removeEventListener('resize', positionPopup)
      window.removeEventListener('scroll', positionPopup, true)
    }
  }, [open, entries, wide])

  useEffect(() => {
    if (!open) return
    setActive((previous) => {
      const currentChoices = choicesRef.current
      if (search && currentChoices.some((entry) => entry.key === previous)) return previous
      return currentChoices.find((entry) => entry.selected)?.key ?? currentChoices[0]?.key ?? ''
    })
  }, [open, search, entries])

  useLayoutEffect(() => {
    if (!open) return
    if (onSearch) input.current?.focus({ preventScroll: true })
    else list.current?.focus({ preventScroll: true })
  }, [open, onSearch])

  useEffect(() => {
    if (!open) return
    function outside(event: PointerEvent) {
      const target = event.target as Node
      if (!popup.current?.contains(target) && !trigger.current?.contains(target)) close()
    }
    function focusOutside(event: FocusEvent) {
      const target = event.target as Node
      if (!popup.current?.contains(target) && !trigger.current?.contains(target)) close(false)
    }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('focusin', focusOutside)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('focusin', focusOutside)
    }
  }, [open])

  useEffect(() => {
    if (!open || !active) return
    document
      .getElementById(`${id}-option-${encodeURIComponent(active)}`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [active, id, open])

  function choose(entry: Extract<PickerEntry, { label: string }>) {
    close()
    entry.onChoose()
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const current = choices.findIndex((entry) => entry.key === active)
      const direction = event.key === 'ArrowDown' ? 1 : -1
      const next = current < 0 ? (direction === 1 ? 0 : choices.length - 1) : current + direction
      setActive(choices[(next + choices.length) % choices.length]?.key ?? '')
    } else if (event.key === 'Enter') {
      const entry = choices.find((choice) => choice.key === active)
      if (entry) {
        event.preventDefault()
        choose(entry)
      }
    } else if (event.key === 'Tab') {
      // The pickers are transient controls, so Tab returns to the normal page flow.
      close()
    }
  }

  return (
    <span className="composer-selector" title={title}>
      <button
        ref={trigger}
        type="button"
        className="composer-selector-trigger"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-describedby={title ? reasonId : undefined}
        disabled={disabled}
        onClick={() => (open ? close() : setOpen(true))}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            setOpen(true)
          }
        }}
      >
        {icon}
        <span className="composer-selector-value">{value}</span>
        <ChevronDown size={12} />
      </button>
      {title && (
        <span id={reasonId} className="composer-selector-sr-only">
          {title}
        </span>
      )}
      {open &&
        createPortal(
          <div
            id={id}
            ref={popup}
            role="dialog"
            aria-label={`${label}选项`}
            className="composer-selector-popup"
            style={position}
            tabIndex={-1}
            onKeyDown={onKeyDown}
          >
            {onSearch && (
              <div className="composer-selector-search">
                <Search size={15} />
                <input
                  ref={input}
                  role="combobox"
                  aria-expanded="true"
                  aria-autocomplete="list"
                  aria-label={searchPlaceholder}
                  placeholder={searchPlaceholder}
                  value={search ?? ''}
                  onChange={(event) => onSearch(event.target.value)}
                  aria-controls={`${id}-list`}
                  aria-activedescendant={
                    active ? `${id}-option-${encodeURIComponent(active)}` : undefined
                  }
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
            )}
            <div
              id={`${id}-list`}
              ref={list}
              className="composer-selector-list"
              role="listbox"
              tabIndex={onSearch ? -1 : 0}
              aria-label={`${label}列表`}
              aria-activedescendant={
                active ? `${id}-option-${encodeURIComponent(active)}` : undefined
              }
            >
              {entries.map((entry) => {
                if ('heading' in entry) {
                  return (
                    <div key={entry.key} className="composer-selector-heading" role="presentation">
                      {entry.heading}
                    </div>
                  )
                }
                if ('note' in entry) {
                  return (
                    <div key={entry.key} className="composer-selector-note" role="presentation">
                      {entry.note}
                    </div>
                  )
                }
                return (
                  <button
                    key={entry.key}
                    id={`${id}-option-${encodeURIComponent(entry.key)}`}
                    type="button"
                    role="option"
                    aria-selected={Boolean(entry.selected)}
                    aria-label={entry.label}
                    title={entry.description}
                    disabled={entry.disabled}
                    className={`composer-selector-option${active === entry.key ? ' is-active' : ''}`}
                    tabIndex={-1}
                    onMouseMove={() => {
                      if (!entry.disabled) setActive(entry.key)
                    }}
                    onClick={() => choose(entry)}
                  >
                    {entry.icon && (
                      <span className="composer-selector-option-icon">{entry.icon}</span>
                    )}
                    <span className="composer-selector-option-copy">
                      <span className="composer-selector-option-title">
                        <span>{entry.label}</span>
                        {entry.badge && (
                          <span className="composer-selector-badge">{entry.badge}</span>
                        )}
                      </span>
                      {entry.description && (
                        <span className="composer-selector-option-description">
                          {entry.description}
                        </span>
                      )}
                    </span>
                    <span className="composer-selector-check">
                      {entry.selected && <Check size={15} />}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>,
          document.body,
        )}
    </span>
  )
}

export function ProjectPicker({
  projects,
  projectId,
  disabled,
  onChoose,
  onAdd,
}: {
  projects: Project[]
  projectId?: string
  disabled?: boolean
  onChoose: (id: string) => void
  onAdd: () => void
}) {
  const [search, setSearch] = useState('')
  const selected = projects.find((project) => project.id === projectId)
  const query = search.trim().toLocaleLowerCase()
  const matching = projects.filter(
    (project) =>
      !project.removedAt && `${project.name} ${project.path}`.toLocaleLowerCase().includes(query),
  )
  const entries: PickerEntry[] = matching.map((project) => ({
    key: project.id,
    label: project.name,
    description: project.path,
    selected: project.id === projectId,
    icon: <Folder size={16} />,
    onChoose: () => onChoose(project.id),
  }))
  if (!matching.length) entries.push({ key: 'empty', note: '没有匹配的项目' })
  entries.push(
    { key: 'open-heading', heading: '' },
    {
      key: 'open-project',
      label: '打开项目',
      icon: <Plus size={16} />,
      onChoose: onAdd,
    },
  )
  return (
    <Picker
      label="选择项目"
      value={selected?.name ?? '选择项目'}
      title={selected?.path}
      icon={<FolderOpen size={15} />}
      disabled={disabled}
      entries={entries}
      search={search}
      onSearch={setSearch}
      searchPlaceholder="搜索项目名称或路径"
      wide
    />
  )
}

interface Selection {
  provider: ProviderId
  model?: string
  reasoningOption?: string
}

function nextReasoning(provider: ProviderId, model: Model | undefined, current?: string) {
  const reasoning = model?.reasoning
  if (current && reasoning?.options.some((option) => option.value === current)) return current
  if (
    provider === 'codex' &&
    reasoning?.default &&
    reasoning.options.some((option) => option.value === reasoning.default)
  )
    return reasoning.default
  return undefined
}

export function ComposerSelectors({
  providers,
  provider,
  model,
  reasoningOption,
  onChange,
  onConfigure,
  disabled,
  fixedProvider,
  workspace,
  workspaces = [],
  canIsolate,
  workspaceChecking,
  onWorkspaceChange,
}: {
  providers: ProviderInfo[]
  provider: ProviderId
  model?: string
  reasoningOption?: string
  onChange: (selection: Selection) => void
  onConfigure: () => void
  disabled?: boolean
  fixedProvider?: boolean
  workspace?: NewSessionDraft['workspace']
  workspaces?: Workspace[]
  canIsolate?: boolean
  workspaceChecking?: boolean
  onWorkspaceChange?: (choice: NewSessionDraft['workspace']) => void
}) {
  const [search, setSearch] = useState('')
  const selectedProvider = providers.find((entry) => entry.id === provider)
  const selectedModel = selectedProvider?.models.find((entry) => entry.id === model)
  const query = search.trim()
  const normalized = query.toLocaleLowerCase()
  const modelEntries = useMemo(() => {
    const entries: PickerEntry[] = []
    const order: ProviderId[] = ['codex', 'claude', 'opencode']
    for (const id of order) {
      if (fixedProvider && id !== provider) continue
      const info = providers.find((entry) => entry.id === id)
      const name = PROVIDERS[id].name
      const providerMatches = name.toLocaleLowerCase().includes(normalized)
      const models = (info?.models ?? []).filter(
        (entry) =>
          providerMatches || `${entry.name} ${entry.id}`.toLocaleLowerCase().includes(normalized),
      )
      entries.push({ key: `${id}-heading`, heading: name })
      if (!info?.available) {
        entries.push({
          key: `${id}-configure`,
          label: `配置 ${name}`,
          description: info?.error ?? '尚未检测到可用的 CLI',
          icon: <Settings2 size={15} />,
          onChoose: onConfigure,
        })
        continue
      }
      if (!fixedProvider && (!query || providerMatches || 'cli 默认'.includes(normalized))) {
        entries.push({
          key: `${id}-default`,
          label: 'CLI 默认',
          description: `跟随 ${name} 的本地模型和思考配置`,
          selected: provider === id && !model,
          onChoose: () => onChange({ provider: id }),
        })
      }
      for (const entry of models) {
        entries.push({
          key: `${id}-model-${entry.id}`,
          label: entry.name,
          description: [entry.name !== entry.id ? entry.id : '', entry.description]
            .filter(Boolean)
            .join(' · '),
          badge: entry.isDefault ? '默认' : undefined,
          selected: provider === id && model === entry.id,
          onChoose: () =>
            onChange({
              provider: id,
              model: entry.id,
              reasoningOption: nextReasoning(
                id,
                entry,
                provider === id ? reasoningOption : undefined,
              ),
            }),
        })
      }
      if (query && !info.models.some((entry) => entry.id === query)) {
        entries.push({
          key: `${id}-custom`,
          label: `使用自定义模型 ${query}（${name}）`,
          description: '使用 CLI 支持的模型 ID',
          selected: provider === id && model === query,
          onChoose: () => onChange({ provider: id, model: query }),
        })
      } else if (!models.length) {
        entries.push({
          key: `${id}-empty`,
          note: query ? '没有匹配的模型' : '模型列表暂不可用，输入模型 ID 可手动选择',
        })
      }
    }
    if (!query) entries.push({ key: 'manual-hint', note: '搜索名称，或输入模型 ID 手动选择' })
    return entries
  }, [
    fixedProvider,
    provider,
    providers,
    query,
    normalized,
    model,
    reasoningOption,
    onChange,
    onConfigure,
  ])

  const reasoning = selectedModel?.reasoning
  const reasoningAvailable = Boolean(model && reasoning?.options.length)
  const defaultValue = provider === 'codex' ? reasoning?.default : undefined
  // A missing value in a restored session still follows its native configuration.
  // Only selecting a model/default writes an explicit Codex default effort.
  const effectiveReasoning = reasoningOption
  const selectedReasoning = reasoning?.options.find((option) => option.value === effectiveReasoning)
  const reasoningEntries: PickerEntry[] = []
  if (provider !== 'codex' || !defaultValue) {
    if (provider !== 'codex')
      reasoningEntries.push({
        key: 'native',
        label: '跟随原生配置',
        description: '使用 CLI 的默认思考配置',
        selected: !reasoningOption,
        onChoose: () => onChange({ provider, model }),
      })
  } else {
    const defaultOption = reasoning?.options.find((option) => option.value === defaultValue)
    if (defaultOption)
      reasoningEntries.push({
        key: 'model-default',
        label: '模型默认',
        description: `${defaultOption.label}${defaultOption.description ? ` · ${defaultOption.description}` : ''}`,
        selected: effectiveReasoning === defaultValue,
        onChoose: () => onChange({ provider, model, reasoningOption: defaultValue }),
      })
  }
  for (const option of reasoning?.options ?? []) {
    if (provider === 'codex' && option.value === defaultValue) continue
    reasoningEntries.push({
      key: `reasoning-${option.value}`,
      label: option.label,
      description: option.description,
      selected: effectiveReasoning === option.value,
      onChoose: () => onChange({ provider, model, reasoningOption: option.value }),
    })
  }
  const reasoningTitle = !model
    ? '选择明确的模型后可设置思考强度；CLI 默认会沿用本地配置'
    : !reasoningAvailable
      ? '此模型未提供可用的思考强度选项'
      : undefined

  const existingWorkspace =
    workspace?.kind === 'existing'
      ? workspaces.find((entry) => entry.id === workspace.id)
      : undefined
  const workspaceEntries: PickerEntry[] = [
    {
      key: 'shared',
      label: '本地共享目录',
      description: '在项目目录中工作',
      selected: !workspace || workspace.kind === 'shared',
      icon: <Folder size={16} />,
      onChoose: () => onWorkspaceChange?.({ kind: 'shared' }),
    },
    {
      key: 'isolated',
      label: '新建独立工作区',
      description: workspaceChecking
        ? '正在检查 Git 提交…'
        : !canIsolate
          ? '需要 Git 仓库至少有一次提交'
          : '创建 Git worktree，隔离本次改动',
      selected: workspace?.kind === 'isolated',
      disabled: workspaceChecking || !canIsolate,
      icon: <GitBranch size={16} />,
      onChoose: () => onWorkspaceChange?.({ kind: 'isolated' }),
    },
  ]
  const availableWorkspaces = workspaces.filter(
    (entry) => entry.kind === 'worktree' && !entry.deletedAt,
  )
  if (availableWorkspaces.length) {
    workspaceEntries.push({ key: 'existing-heading', heading: '已有工作区' })
    workspaceEntries.push(
      ...availableWorkspaces.map((entry) => ({
        key: entry.id,
        label: entry.name,
        description: [entry.branch, entry.cwd].filter(Boolean).join(' · '),
        selected: workspace?.kind === 'existing' && workspace.id === entry.id,
        icon: <GitBranch size={16} />,
        onChoose: () => onWorkspaceChange?.({ kind: 'existing', id: entry.id }),
      })),
    )
  }

  return (
    <div className="composer-selectors">
      {onWorkspaceChange && (
        <Picker
          label="选择工作区"
          value={
            workspace?.kind === 'isolated' ? '独立工作区' : (existingWorkspace?.name ?? '本地')
          }
          icon={
            workspace?.kind === 'shared' || !workspace ? (
              <Folder size={14} />
            ) : (
              <GitBranch size={14} />
            )
          }
          entries={workspaceEntries}
          disabled={disabled}
          wide
        />
      )}
      <Picker
        label="选择模型"
        value={`${PROVIDERS[provider].name} · ${selectedModel?.name ?? model ?? 'CLI 默认'}`}
        icon={<Cpu size={14} />}
        entries={modelEntries}
        disabled={disabled}
        search={search}
        onSearch={setSearch}
        searchPlaceholder="搜索模型或输入模型 ID"
        wide
      />
      <Picker
        label="选择思考强度"
        value={selectedReasoning?.label ?? (reasoningOption || '思考强度')}
        icon={<Gauge size={14} />}
        entries={reasoningEntries}
        disabled={disabled || !reasoningAvailable}
        title={reasoningTitle}
      />
    </div>
  )
}
