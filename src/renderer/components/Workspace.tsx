import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import Editor, { DiffEditor, type OnMount } from '@monaco-editor/react'
import type { editor as MonacoEditor } from 'monaco-editor'
import {
  ChevronDown,
  ChevronRight,
  File,
  FileCode2,
  Folder,
  FolderOpen,
  GitBranch,
  RefreshCw,
  Save,
  X,
  Plus,
  Minus,
  Check,
  ArrowUpRight,
  AlertTriangle,
  Files,
  LoaderCircle,
  Search,
  FilePlus,
  Pencil,
  Trash2,
  Upload,
  Download,
} from 'lucide-react'
import type {
  EditorState,
  FileEntry,
  FileSearchResult,
  GitAction,
  GitCommit,
  GitDiff,
  GitStatus,
  Project,
  Settings,
} from '../../shared/types'
import { api, errorText } from '../lib/api'
import { registerCloseFlush } from '../lib/close-flush'
import '../lib/monaco'
type OpenFile = EditorState['files'][number]
type DiffView =
  | { kind: 'git'; diff: GitDiff }
  | { kind: 'conflict'; path: string; original: string; modified: string }
interface Props {
  visible: boolean
  onDirtyChange: (dirty: boolean) => void
  project: Project
  running: boolean
  theme: string
  settings?: Pick<Settings, 'fontSize' | 'tabSize'>
  onClose: () => void
  onError: (error: unknown) => void
  onContext: (path: string, content: string, startLine?: number, endLine?: number) => void
}

function WorkspaceDialog({
  open,
  onOpenChange,
  title,
  children,
}: {
  open: boolean
  onOpenChange: (value: boolean) => void
  title: string
  children: React.ReactNode
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content workspace-dialog">
          <div className="dialog-header">
            <div>
              <Dialog.Title>{title}</Dialog.Title>
              <Dialog.Description>当前工作区的文件与 Git 操作</Dialog.Description>
            </div>
            <Dialog.Close className="icon-button" aria-label="关闭">
              <X size={16} />
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function SafeDiffEditor(props: React.ComponentProps<typeof DiffEditor>) {
  const instance = useRef<MonacoEditor.IStandaloneDiffEditor | null>(null)
  const id = useId()
  useLayoutEffect(
    () => () => {
      const editor = instance.current
      if (!editor) return
      const models = editor.getModel()
      // Detach before disposing: Monaco's asynchronous diff worker may still reference its models.
      // This layout cleanup runs before @monaco-editor/react's passive unmount cleanup.
      editor.setModel(null)
      if (models?.original && !models.original.isDisposed()) models.original.dispose()
      if (models?.modified && !models.modified.isDisposed()) models.modified.dispose()
      instance.current = null
    },
    [],
  )
  return (
    <DiffEditor
      {...props}
      originalModelPath={`inmemory://coding-hub/${encodeURIComponent(id)}/original`}
      modifiedModelPath={`inmemory://coding-hub/${encodeURIComponent(id)}/modified`}
      keepCurrentOriginalModel
      keepCurrentModifiedModel
      onMount={(editor, monaco) => {
        instance.current = editor
        props.onMount?.(editor, monaco)
      }}
    />
  )
}
function FileTree({
  projectId,
  path,
  depth,
  active,
  onOpen,
  refresh,
}: {
  projectId: string
  path?: string
  depth: number
  active?: string
  onOpen: (entry: FileEntry) => void
  refresh: number
}) {
  const [files, setFiles] = useState<FileEntry[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [error, setError] = useState('')
  useEffect(() => {
    let ignore = false
    void api
      .listFiles(projectId, path)
      .then((value) => {
        if (!ignore) {
          setFiles(value)
          setError('')
        }
      })
      .catch((e) => {
        if (!ignore) setError(String(e).replace(/^Error: /, ''))
      })
    return () => {
      ignore = true
    }
  }, [projectId, path, refresh])
  return (
    <div role={depth > 0 ? 'group' : undefined}>
      {error && <div className="tree-error">{error}</div>}
      {files.map((file) => (
        <div className="tree-node" key={file.path}>
          <button
            role="treeitem"
            aria-level={depth + 1}
            aria-selected={active === file.path}
            aria-expanded={file.directory ? expanded.has(file.path) : undefined}
            className={`file-entry ${active === file.path ? 'selected' : ''}`}
            style={{ paddingLeft: depth * 13 + 11 }}
            title={file.path}
            onKeyDown={(event) => {
              const tree = event.currentTarget.closest('[role="tree"]')
              const items = Array.from(
                tree?.querySelectorAll<HTMLButtonElement>('[role="treeitem"]') || [],
              )
              const index = items.indexOf(event.currentTarget)
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                items[index + (event.key === 'ArrowDown' ? 1 : -1)]?.focus()
              } else if (event.key === 'Home' || event.key === 'End') {
                event.preventDefault()
                items[event.key === 'Home' ? 0 : items.length - 1]?.focus()
              } else if (event.key === 'ArrowRight' && file.directory) {
                event.preventDefault()
                if (expanded.has(file.path)) items[index + 1]?.focus()
                else setExpanded((previous) => new Set([...previous, file.path]))
              } else if (event.key === 'ArrowLeft') {
                event.preventDefault()
                if (file.directory && expanded.has(file.path))
                  setExpanded(
                    (previous) => new Set([...previous].filter((value) => value !== file.path)),
                  )
                else
                  event.currentTarget
                    .closest('.tree-node')
                    ?.parentElement?.closest('.tree-node')
                    ?.querySelector<HTMLButtonElement>('[role="treeitem"]')
                    ?.focus()
              }
            }}
            onClick={() => {
              if (file.directory)
                setExpanded((previous) => {
                  const next = new Set(previous)
                  if (next.has(file.path)) next.delete(file.path)
                  else next.add(file.path)
                  return next
                })
              else onOpen(file)
            }}
          >
            {file.directory ? (
              <>
                {expanded.has(file.path) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                {expanded.has(file.path) ? (
                  <FolderOpen size={14} className="folder-icon" />
                ) : (
                  <Folder size={14} className="folder-icon" />
                )}
              </>
            ) : (
              <>
                <span className="tree-spacer" />
                <FileCode2 size={14} className="file-icon" />
              </>
            )}
            <span>{file.name}</span>
          </button>
          {file.directory && expanded.has(file.path) && (
            <FileTree
              projectId={projectId}
              path={file.path}
              depth={depth + 1}
              active={active}
              onOpen={onOpen}
              refresh={refresh}
            />
          )}
        </div>
      ))}
    </div>
  )
}
export default function Workspace({
  visible,
  onDirtyChange,
  project,
  running,
  theme,
  settings,
  onClose,
  onError,
  onContext,
}: Props) {
  const [mode, setMode] = useState<'files' | 'git'>('files')
  const [files, setFiles] = useState<OpenFile[]>([])
  const [active, setActive] = useState('')
  const [diff, setDiff] = useState<DiffView | null>(null)
  const [git, setGit] = useState<GitStatus>()
  const [refresh, setRefresh] = useState(0)
  const [busy, setBusy] = useState(false)
  const [commit, setCommit] = useState('')
  const [hydrated, setHydrated] = useState(false)
  const [backgroundError, setBackgroundError] = useState('')
  const [query, setQuery] = useState('')
  const [contentSearch, setContentSearch] = useState(false)
  const [searchResults, setSearchResults] = useState<FileSearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [fileOperation, setFileOperation] = useState<'create' | 'rename' | 'branch'>()
  const [pathDraft, setPathDraft] = useState('')
  const [commitOpen, setCommitOpen] = useState(false)
  const [commitDiff, setCommitDiff] = useState<GitDiff>()
  const [history, setHistory] = useState<GitCommit[]>([])
  const [historyOpen, setHistoryOpen] = useState(false)
  const filesRef = useRef(files)
  const editorStateRef = useRef<EditorState>({
    files: [],
    active: '',
    mode: 'files',
    updatedAt: Date.now(),
  })
  const searchRef = useRef<HTMLInputElement>(null)
  const pendingLine = useRef<number | undefined>(undefined)
  const commitIndex = useRef<string | undefined>(undefined)
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null)
  const selected = files.find((file) => file.path === active)
  const dirty = selected && selected.edited !== selected.content
  filesRef.current = files
  editorStateRef.current = { files, active, mode, updatedAt: Date.now() }
  const showBackgroundError = useCallback((error: unknown) => {
    const message = errorText(error)
    setBackgroundError(message)
  }, [])
  const captureViewState = useCallback(() => {
    const viewState = editorRef.current?.saveViewState()
    if (!viewState || !active) return
    setFiles((previous) =>
      previous.map((file) => (file.path === active ? { ...file, viewState } : file)),
    )
    editorStateRef.current = {
      ...editorStateRef.current,
      files: editorStateRef.current.files.map((file) =>
        file.path === active ? { ...file, viewState } : file,
      ),
    }
  }, [active])
  useEffect(() => {
    onDirtyChange(files.some((file) => file.edited !== file.content))
  }, [files, onDirtyChange])
  useEffect(() => {
    if (!selected || diff) editorRef.current = null
  }, [selected?.path, diff])
  useEffect(() => () => onDirtyChange(false), [onDirtyChange])
  const loadGit = async () => {
    if (project.trusted === false) {
      setGit(undefined)
      return
    }
    try {
      setGit(await api.gitStatus(project.id))
    } catch (e) {
      onError(e)
    }
  }
  useEffect(() => {
    if (project.trusted !== false) void loadGit()
    else setGit(undefined)
  }, [project.trusted])
  useEffect(() => {
    let alive = true
    setHydrated(false)
    setFiles([])
    setActive('')
    setDiff(null)
    setGit(undefined)
    setQuery('')
    setBackgroundError('')
    void api
      .getEditorState(project.id)
      .then((stored) => {
        if (!alive) return
        if (stored) {
          setFiles(stored.files)
          setActive(stored.active)
          setMode(stored.mode)
        }
        setHydrated(true)
      })
      .catch((error) => {
        if (!alive) return
        showBackgroundError(error)
        // Failed restoration must not overwrite the saved recovery state with an empty editor.
      })
    setRefresh((value) => value + 1)
    void loadGit()
    return () => {
      alive = false
    }
  }, [project.id, showBackgroundError])
  useEffect(() => {
    if (!hydrated) return
    const id = project.id
    const timer = setTimeout(() => {
      void api.saveEditorState(id, editorStateRef.current).catch(showBackgroundError)
    }, 150)
    return () => clearTimeout(timer)
  }, [files, active, mode, hydrated, project.id, showBackgroundError])
  useEffect(() => {
    if (!hydrated) return
    const flush = async () => {
      const viewState = editorRef.current?.saveViewState()
      const edited = editorRef.current?.getValue()
      const state = editorStateRef.current
      const snapshot = {
        ...state,
        updatedAt: Date.now(),
        files: state.files.map((file) =>
          file.path === state.active
            ? {
                ...file,
                ...(edited !== undefined ? { edited } : {}),
                ...(viewState ? { viewState } : {}),
              }
            : file,
        ),
      }
      editorStateRef.current = snapshot
      await api.saveEditorState(project.id, snapshot)
    }
    const unregister = registerCloseFlush(flush)
    const backgroundFlush = () => void flush().catch(showBackgroundError)
    window.addEventListener('blur', backgroundFlush)
    window.addEventListener('beforeunload', backgroundFlush)
    return () => {
      unregister()
      backgroundFlush()
      window.removeEventListener('blur', backgroundFlush)
      window.removeEventListener('beforeunload', backgroundFlush)
    }
  }, [project.id, hydrated, showBackgroundError])
  useEffect(() => {
    if (visible) return
    setFileOperation(undefined)
    setCommitOpen(false)
    setHistoryOpen(false)
  }, [visible])
  useEffect(() => {
    if (!hydrated || !visible || (!query && !contentSearch)) {
      setSearchResults([])
      setSearching(false)
      return
    }
    let alive = true
    setSearching(true)
    const timer = setTimeout(() => {
      void api
        .searchFiles(project.id, query, contentSearch)
        .then((results) => {
          if (alive) setSearchResults(results)
        })
        .catch((error) => {
          if (alive) showBackgroundError(error)
        })
        .finally(() => {
          if (alive) setSearching(false)
        })
    }, 200)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [project.id, query, contentSearch, hydrated, visible, showBackgroundError])
  useEffect(() => {
    if (!hydrated || !visible) return
    let alive = true
    const update = () => {
      for (const file of filesRef.current)
        void api
          .readFile(project.id, file.path)
          .then((current) => {
            if (
              !alive ||
              current.fingerprint === file.fingerprint ||
              current.fingerprint === file.external?.fingerprint
            )
              return
            setFiles((previous) =>
              previous.map((item) =>
                item.path !== file.path || item.fingerprint !== file.fingerprint
                  ? item
                  : item.edited === item.content
                    ? { ...item, ...current, edited: current.content, external: undefined }
                    : { ...item, external: current },
              ),
            )
          })
          .catch((error) => {
            if (alive) showBackgroundError(`${file.path}: ${errorText(error)}`)
          })
      setRefresh((value) => value + 1)
      if (project.trusted !== false)
        void api
          .gitStatus(project.id)
          .then((value) => {
            if (alive) setGit(value)
          })
          .catch((error) => {
            if (alive) showBackgroundError(error)
          })
    }
    update()
    const timer = setInterval(update, 4500)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [project.id, project.trusted, showBackgroundError, hydrated, visible])
  async function openFile(entry: FileEntry, line?: number) {
    if (!hydrated) return
    captureViewState()
    pendingLine.current = line
    setDiff(null)
    if (files.some((file) => file.path === entry.path)) {
      setActive(entry.path)
      if (line) {
        editorRef.current?.revealLineInCenter(line)
        editorRef.current?.setPosition({ lineNumber: line, column: 1 })
      }
      return
    }
    setBusy(true)
    try {
      const file = await api.readFile(project.id, entry.path)
      setFiles((previous) => [
        ...previous.filter((item) => item.path !== file.path),
        { ...file, edited: file.content },
      ])
      setActive(file.path)
    } catch (e) {
      onError(e)
    } finally {
      setBusy(false)
    }
  }
  async function save(overwrite = false, target = active) {
    if (project.trusted === false) {
      onError('请先在项目设置中信任此目录，再保存文件。')
      return false
    }
    const selected = filesRef.current.find((file) => file.path === target)
    if (!selected || selected.edited === selected.content) return true
    setBusy(true)
    try {
      const saved = await api.saveFile(
        project.id,
        selected.path,
        selected.edited,
        selected.fingerprint,
        overwrite,
      )
      setFiles((previous) =>
        previous.map((file) =>
          file.path === saved.path
            ? { ...file, ...saved, edited: saved.content, external: undefined }
            : file,
        ),
      )
      setDiff(null)
      void loadGit()
      return true
    } catch (error) {
      try {
        const latest = await api.readFile(project.id, selected.path)
        if (latest.fingerprint !== selected.fingerprint)
          setFiles((previous) =>
            previous.map((file) =>
              file.path === selected.path ? { ...file, external: latest } : file,
            ),
          )
      } catch {
        /* Save error carries actionable details. */
      }
      onError(error)
      return false
    } finally {
      setBusy(false)
    }
  }
  async function saveAll() {
    for (const file of filesRef.current.filter((file) => file.edited !== file.content))
      if (!(await save(false, file.path))) break
  }
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (!visible) return
      if (
        (event.metaKey || event.ctrlKey) &&
        ((event.key.toLowerCase() === 'p' && !event.shiftKey) ||
          (event.key.toLowerCase() === 'f' && event.shiftKey))
      ) {
        event.preventDefault()
        setMode('files')
        setContentSearch(event.key.toLowerCase() === 'f')
        searchRef.current?.focus()
        return
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        if (event.shiftKey) void saveAll()
        else void save()
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  })
  async function gitAction(action: GitAction, value: string) {
    setBusy(true)
    try {
      await api.gitAction(
        project.id,
        action,
        value,
        action === 'commit' ? commitIndex.current : undefined,
      )
      if (action === 'commit') setCommit('')
      await loadGit()
      return true
    } catch (e) {
      onError(e)
      return false
    } finally {
      setBusy(false)
    }
  }
  async function showDiff(path: string, staged: boolean) {
    captureViewState()
    setBusy(true)
    try {
      setDiff({ kind: 'git', diff: await api.gitDiff(project.id, path, staged) })
    } catch (e) {
      onError(e)
    } finally {
      setBusy(false)
    }
  }
  async function submitFileOperation() {
    const value = pathDraft.trim()
    if (!value) return
    setBusy(true)
    try {
      if (fileOperation === 'branch') {
        await api.gitAction(project.id, 'createBranch', value)
        await loadGit()
      } else if (fileOperation === 'create') {
        const file = await api.createFile(project.id, value)
        captureViewState()
        setFiles((previous) => [...previous, { ...file, edited: file.content }])
        setActive(file.path)
        setDiff(null)
      } else if (fileOperation === 'rename' && selected) {
        const renamed = await api.renameFile(project.id, selected.path, value)
        setFiles((previous) =>
          previous.map((file) =>
            file.path === selected.path ? { ...file, ...renamed, edited: file.edited } : file,
          ),
        )
        setActive(renamed.path)
        setDiff(null)
      }
      setFileOperation(undefined)
      setRefresh((value) => value + 1)
    } catch (error) {
      onError(error)
    } finally {
      setBusy(false)
    }
  }
  async function deleteSelected() {
    if (
      !selected ||
      !window.confirm(
        `永久删除「${selected.path}」？此操作不会移入回收站${dirty ? '，未保存内容也会丢失' : ''}。`,
      )
    )
      return
    setBusy(true)
    try {
      await api.deleteFile(project.id, selected.path, selected.fingerprint)
      const remaining = filesRef.current.filter((file) => file.path !== selected.path)
      setFiles(remaining)
      setActive(remaining.at(-1)?.path || '')
      setDiff(null)
      setRefresh((value) => value + 1)
      await loadGit()
    } catch (error) {
      onError(error)
    } finally {
      setBusy(false)
    }
  }
  async function beginCommit() {
    setBusy(true)
    commitIndex.current = undefined
    setCommitOpen(true)
    setCommitDiff(undefined)
    try {
      const status = await api.gitStatus(project.id)
      setGit(status)
      commitIndex.current = status.indexFingerprint
      const first = status.files.find((file) => file.index !== ' ' && file.index !== '?')
      if (first) setCommitDiff(await api.gitDiff(project.id, first.path, true))
    } catch (error) {
      onError(error)
    } finally {
      setBusy(false)
    }
  }
  async function showHistory() {
    setBusy(true)
    try {
      setHistory(await api.gitHistory(project.id))
      setHistoryOpen(true)
    } catch (error) {
      onError(error)
    } finally {
      setBusy(false)
    }
  }
  function closeFile(file: OpenFile) {
    if (
      file.edited !== file.content &&
      !window.confirm(`「${file.path}」有未保存的修改，确定放弃吗？`)
    )
      return
    const next = files.filter((item) => item.path !== file.path)
    setFiles(next)
    if (active === file.path) setActive(next[next.length - 1]?.path || '')
    setDiff(null)
  }
  const changeFiles = git?.files || []
  const stagedFiles = changeFiles.filter((file) => file.index !== ' ' && file.index !== '?')
  const workingFiles = changeFiles.filter((file) => file.working !== ' ')
  return (
    <aside
      className="workspace"
      aria-label={`${project.name} 代码工作区`}
      style={{ display: visible ? undefined : 'none' }}
    >
      <div className="workspace-toolbar">
        <div className="workspace-mode">
          <button className={mode === 'files' ? 'active' : ''} onClick={() => setMode('files')}>
            <Files size={14} />
            文件
          </button>
          <button
            className={mode === 'git' ? 'active' : ''}
            onClick={() => {
              setMode('git')
              void loadGit()
            }}
          >
            <GitBranch size={14} />
            变更{changeFiles.length > 0 && <span className="count">{changeFiles.length}</span>}
          </button>
        </div>
        <div className="flex-spacer" />
        {busy && <LoaderCircle size={13} className="spin muted" />}
        <button
          className="icon-button"
          title="保存全部 · ⌘/Ctrl + Shift + S"
          aria-label="保存全部文件"
          disabled={
            project.trusted === false || busy || !files.some((file) => file.edited !== file.content)
          }
          onClick={() => void saveAll()}
        >
          <Save size={13} />
        </button>
        <button
          className="icon-button"
          title="刷新工作区"
          onClick={() => {
            setRefresh((value) => value + 1)
            void loadGit()
          }}
        >
          <RefreshCw size={13} />
        </button>
        <button
          className="icon-button"
          title="关闭工作区"
          onClick={() => {
            captureViewState()
            onClose()
          }}
        >
          <X size={15} />
        </button>
      </div>
      {backgroundError && (
        <div className="workspace-error-banner" role="alert">
          <span>{backgroundError}</span>
          <button
            onClick={() => {
              setBackgroundError('')
              setRefresh((value) => value + 1)
              void loadGit()
              if (!hydrated)
                void api
                  .getEditorState(project.id)
                  .then((stored) => {
                    if (stored) {
                      setFiles(stored.files)
                      setActive(stored.active)
                      setMode(stored.mode)
                    }
                    setHydrated(true)
                  })
                  .catch(showBackgroundError)
            }}
          >
            重试
          </button>
        </div>
      )}
      <div className="workspace-body">
        <div className="workspace-explorer">
          {mode === 'files' ? (
            <>
              <div className="explorer-heading">
                <span>{project.name}</span>
                <button
                  className="icon-button"
                  title="新建文件"
                  aria-label="新建文件"
                  disabled={project.trusted === false || !hydrated || busy}
                  onClick={() => {
                    setPathDraft('')
                    setFileOperation('create')
                  }}
                >
                  <FilePlus size={13} />
                </button>
                <button
                  className="icon-button"
                  title="在文件管理器中打开"
                  onClick={() => void api.revealProject(project.id).catch(onError)}
                >
                  <ArrowUpRight size={12} />
                </button>
              </div>
              <div className="workspace-search">
                <label>
                  <Search size={12} />
                  <input
                    ref={searchRef}
                    aria-label={contentSearch ? '搜索文件内容' : '快速打开文件'}
                    placeholder={contentSearch ? '搜索内容…' : '快速打开 · ⌘/Ctrl P'}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </label>
                <button
                  title={contentSearch ? '切换为文件名搜索' : '切换为内容搜索'}
                  aria-pressed={contentSearch}
                  onClick={() => setContentSearch((value) => !value)}
                >
                  {contentSearch ? '内容' : '文件名'}
                </button>
              </div>
              {contentSearch && (
                <small className="workspace-search-limit">
                  正文最多扫描 20,000 个文件、显示 500 项；文件名快开覆盖全部候选。
                </small>
              )}
              <div
                className="tree-scroll"
                role={!query && !contentSearch ? 'tree' : undefined}
                aria-label="项目文件"
              >
                {query || contentSearch ? (
                  <div className="workspace-search-results">
                    {searching ? (
                      <p role="status">正在搜索…</p>
                    ) : searchResults.length ? (
                      searchResults.map((result, index) => (
                        <button
                          key={`${result.path}:${result.line || index}`}
                          className="workspace-search-result"
                          title={result.path}
                          onClick={() =>
                            void openFile(
                              {
                                name: result.path.split('/').pop() || result.path,
                                path: result.path,
                                directory: false,
                              },
                              result.line,
                            )
                          }
                        >
                          <span>
                            {result.path}
                            {result.line ? `:${result.line}` : ''}
                          </span>
                          {result.text && <small>{result.text}</small>}
                        </button>
                      ))
                    ) : (
                      <p>{query ? '没有匹配的文件' : '输入要搜索的内容'}</p>
                    )}
                    {searchResults.length >= 500 && <small>显示前 500 项，请缩小搜索范围。</small>}
                  </div>
                ) : (
                  <FileTree
                    projectId={project.id}
                    depth={0}
                    active={active}
                    onOpen={(entry) => void openFile(entry)}
                    refresh={refresh}
                  />
                )}
              </div>
            </>
          ) : (
            <>
              <div className="git-branch">
                <GitBranch size={13} />
                <select
                  aria-label="当前分支"
                  value={git?.branch || ''}
                  disabled={!git?.isRepo || busy || running}
                  title={running ? '任务运行时不能切换分支' : '切换分支'}
                  onChange={(event) => void gitAction('checkout', event.target.value)}
                >
                  {Array.from(new Set([git?.branch || '', ...(git?.branches || [])])).map(
                    (branch) => (
                      <option key={branch} value={branch}>
                        {branch || '无分支'}
                      </option>
                    ),
                  )}
                </select>
                <button
                  className="icon-button"
                  title="新建分支"
                  aria-label="新建分支"
                  disabled={!git?.isRepo || busy || running}
                  onClick={() => {
                    setPathDraft('')
                    setFileOperation('branch')
                  }}
                >
                  <Plus size={13} />
                </button>
              </div>
              {git?.isRepo ? (
                <>
                  <div className="git-remote-summary">
                    <span>
                      {git.remote || '未配置远程'} {git.upstream && `· ${git.upstream}`}
                    </span>
                    {git.upstream && (
                      <small>
                        待推送 {git.ahead || 0} · 待拉取 {git.behind || 0}
                      </small>
                    )}
                  </div>
                  <div className="git-remote-actions">
                    <button
                      title="获取远程状态"
                      disabled={busy || running}
                      onClick={() => void gitAction('fetch', '')}
                    >
                      <RefreshCw size={12} />
                      获取
                    </button>
                    <button
                      title="仅快进拉取；分叉时停止"
                      disabled={busy || running || !git.upstream}
                      onClick={() => void gitAction('pull', '')}
                    >
                      <Download size={12} />
                      拉取
                    </button>
                    <button
                      title="推送当前分支，不强制覆盖"
                      disabled={busy || running}
                      onClick={() => void gitAction('push', '')}
                    >
                      <Upload size={12} />
                      推送
                    </button>
                    <button disabled={busy} onClick={() => void showHistory()}>
                      历史
                    </button>
                  </div>
                  {!!git.conflicts?.length && (
                    <div className="tree-error" role="alert">
                      {git.conflicts.length} 个文件存在合并冲突，解决后再提交。
                    </div>
                  )}
                  <div className="git-commit">
                    <textarea
                      aria-label="提交说明"
                      placeholder="提交说明…"
                      value={commit}
                      onChange={(e) => setCommit(e.target.value)}
                      rows={2}
                    />
                    <button
                      className="button secondary"
                      disabled={
                        !commit.trim() ||
                        busy ||
                        running ||
                        !!git.conflicts?.length ||
                        !stagedFiles.length
                      }
                      title={running ? '任务运行时不能提交' : '提交暂存的修改'}
                      onClick={() => void beginCommit()}
                    >
                      <Check size={13} />
                      审阅并提交
                    </button>
                    {running && <small>任务运行时暂停提交与分支切换</small>}
                  </div>
                  {changeFiles.length === 0 && (
                    <div className="git-clean">
                      <Check size={21} />
                      <p>没有文件变更</p>
                    </div>
                  )}
                  {[
                    { label: '已暂存', staged: true, files: stagedFiles },
                    { label: '未暂存', staged: false, files: workingFiles },
                  ].map((group) => (
                    <div key={group.label} className="git-change-group">
                      <div className="git-section-title">
                        {group.label}
                        <span>{group.files.length}</span>
                        {!group.staged && !!group.files.length && (
                          <button
                            disabled={busy || running}
                            onClick={async () => {
                              setBusy(true)
                              try {
                                for (const file of group.files)
                                  await api.gitAction(project.id, 'stage', file.path)
                                await loadGit()
                              } catch (error) {
                                onError(error)
                              } finally {
                                setBusy(false)
                              }
                            }}
                          >
                            全部暂存
                          </button>
                        )}
                      </div>
                      {group.files.map((file) => (
                        <div key={file.path} className="git-file">
                          <button
                            onClick={() => void showDiff(file.path, group.staged)}
                            title={`${group.label} · ${file.path}`}
                          >
                            <File size={13} />
                            <span>{file.path}</span>
                            <b className={file.index === '?' ? 'git-added' : ''}>
                              {(group.staged ? file.index : file.working).trim()}
                            </b>
                          </button>
                          {group.staged ? (
                            <button
                              className="icon-button"
                              title="取消暂存"
                              aria-label={`取消暂存 ${file.path}`}
                              disabled={busy || running}
                              onClick={() => void gitAction('unstage', file.path)}
                            >
                              <Minus size={12} />
                            </button>
                          ) : (
                            <button
                              className="icon-button"
                              title="暂存修改"
                              aria-label={`暂存 ${file.path}`}
                              disabled={busy || running}
                              onClick={() => void gitAction('stage', file.path)}
                            >
                              <Plus size={12} />
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  ))}
                </>
              ) : (
                <div className="git-clean">
                  <GitBranch size={25} />
                  <p>{project.trusted === false ? '项目处于受限模式' : '此目录不是 Git 仓库'}</p>
                  <small>
                    {project.trusted === false
                      ? '在项目设置中信任目录后使用 Git。'
                      : '可以在终端运行 git init'}
                  </small>
                </div>
              )}
            </>
          )}
        </div>
        <div className="editor-pane">
          <div className="editor-tabs" role="tablist" aria-label="打开的文件">
            {files.map((file) => (
              <div
                className={`editor-tab ${active === file.path && !diff ? 'active' : ''}`}
                key={file.path}
              >
                <button
                  role="tab"
                  className="editor-tab-title"
                  aria-selected={active === file.path && !diff}
                  aria-controls={`${project.id}-editor`}
                  tabIndex={active === file.path && !diff ? 0 : -1}
                  onKeyDown={(event) => {
                    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
                    event.preventDefault()
                    const index = files.findIndex((item) => item.path === file.path)
                    const next =
                      event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? files.length - 1
                          : (index + (event.key === 'ArrowRight' ? 1 : -1) + files.length) %
                            files.length
                    captureViewState()
                    setActive(files[next].path)
                    setDiff(null)
                    event.currentTarget
                      .closest('[role="tablist"]')
                      ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
                      [next]?.focus()
                  }}
                  onClick={() => {
                    captureViewState()
                    setActive(file.path)
                    setDiff(null)
                  }}
                  title={file.path}
                >
                  <FileCode2 size={12} />
                  <span>{file.path.split(/[\\/]/).pop()}</span>
                  {file.edited !== file.content && <i className="dirty-dot" />}
                </button>
                <button
                  aria-label={`关闭文件 ${file.path}`}
                  className="tab-close"
                  onClick={(e) => {
                    e.stopPropagation()
                    closeFile(file)
                  }}
                >
                  <X size={11} />
                </button>
              </div>
            ))}
            {diff && (
              <div className="editor-tab active">
                <button role="tab" aria-selected="true" aria-controls={`${project.id}-editor`}>
                  <GitBranch size={12} />
                  <span>
                    {(diff.kind === 'git' ? diff.diff.path : diff.path).split(/[\\/]/).pop()} ·{' '}
                    {diff.kind === 'conflict'
                      ? '保存冲突'
                      : diff.diff.staged
                        ? '已暂存 Diff'
                        : '未暂存 Diff'}
                  </span>
                </button>
                <button
                  aria-label="关闭差异比较"
                  className="tab-close"
                  onClick={() => setDiff(null)}
                >
                  <X size={11} />
                </button>
              </div>
            )}
          </div>
          <div id={`${project.id}-editor`} role="tabpanel" className="workspace-editor-content">
            {selected?.external && (
              <div className="conflict-banner">
                <AlertTriangle size={15} />
                <span>磁盘文件已改变</span>
                <button
                  onClick={() =>
                    setDiff({
                      kind: 'conflict',
                      path: selected.path,
                      original: selected.external!.content,
                      modified: selected.edited,
                    })
                  }
                >
                  比较
                </button>
                <button
                  onClick={() => {
                    setFiles((previous) =>
                      previous.map((file) =>
                        file.path === selected.path
                          ? {
                              ...file,
                              ...selected.external!,
                              edited: selected.external!.content,
                              external: undefined,
                            }
                          : file,
                      ),
                    )
                    setDiff(null)
                  }}
                >
                  重新加载
                </button>
                <button
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm('确定用编辑器内容覆盖磁盘上的外部修改吗？')) void save(true)
                  }}
                >
                  覆盖保存
                </button>
              </div>
            )}
            {diff?.kind === 'git' && diff.diff.previewUnavailable ? (
              <div className="editor-empty">
                <strong>
                  {diff.diff.previewUnavailable === 'binary'
                    ? '此文件无法显示文本差异'
                    : '文件超过 2 MB 预览限制'}
                </strong>
                <span>文件仍保留在变更列表中，可以暂存与提交。</span>
                <button
                  className="button secondary"
                  onClick={() => void api.openInEditor(project.id, diff.diff.path).catch(onError)}
                >
                  在外部应用打开
                </button>
              </div>
            ) : diff ? (
              <SafeDiffEditor
                key={diff.kind + (diff.kind === 'git' ? diff.diff.path : diff.path)}
                original={diff.kind === 'git' ? diff.diff.original : diff.original}
                modified={diff.kind === 'git' ? diff.diff.modified : diff.modified}
                language={selected?.language || 'plaintext'}
                theme={theme === 'dark' ? 'vs-dark' : 'light'}
                options={{
                  readOnly: true,
                  automaticLayout: true,
                  minimap: { enabled: false },
                  fontSize: settings?.fontSize || 12,
                  renderSideBySide: false,
                  scrollBeyondLastLine: false,
                }}
              />
            ) : selected ? (
              <>
                <div className="editor-filebar">
                  <span title={selected.path}>{selected.path}</span>
                  <div className="flex-spacer" />
                  <button
                    title="将文件或选区加入对话"
                    onClick={() => {
                      const editor = editorRef.current
                      const selection = editor?.getSelection()
                      const text =
                        selection && !selection.isEmpty()
                          ? editor!.getModel()?.getValueInRange(selection) || selected.edited
                          : selected.edited
                      onContext(
                        selected.path,
                        text,
                        selection && !selection.isEmpty() ? selection.startLineNumber : undefined,
                        selection && !selection.isEmpty() ? selection.endLineNumber : undefined,
                      )
                    }}
                  >
                    引用到对话
                  </button>
                  <button
                    title="在外部编辑器打开"
                    aria-label="在外部编辑器打开当前文件"
                    disabled={project.trusted === false}
                    onClick={() => void api.openInEditor(project.id, selected.path).catch(onError)}
                  >
                    <ArrowUpRight size={12} />
                  </button>
                  <button
                    title="重命名文件"
                    aria-label="重命名当前文件"
                    disabled={project.trusted === false || busy || !!selected.external}
                    onClick={() => {
                      setPathDraft(selected.path)
                      setFileOperation('rename')
                    }}
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    title="永久删除文件"
                    aria-label="永久删除当前文件"
                    disabled={project.trusted === false || busy}
                    onClick={() => void deleteSelected()}
                  >
                    <Trash2 size={12} />
                  </button>
                  <button
                    disabled={project.trusted === false || !dirty || busy || !!selected.external}
                    title="保存 · ⌘/Ctrl + S"
                    onClick={() => void save()}
                  >
                    <Save size={12} />
                    保存
                  </button>
                </div>
                <Editor
                  key={project.id + '/' + selected.path}
                  path={project.id + '/' + selected.path}
                  language={selected.language}
                  value={selected.edited}
                  theme={theme === 'dark' ? 'vs-dark' : 'light'}
                  onMount={(editor) => {
                    editorRef.current = editor
                    const stored = filesRef.current.find((file) => file.path === selected.path)
                    if (stored?.viewState)
                      editor.restoreViewState(stored.viewState as MonacoEditor.ICodeEditorViewState)
                    if (pendingLine.current) {
                      editor.revealLineInCenter(pendingLine.current)
                      editor.setPosition({ lineNumber: pendingLine.current, column: 1 })
                      pendingLine.current = undefined
                    }
                  }}
                  onChange={(value) =>
                    setFiles((previous) =>
                      previous.map((file) =>
                        file.path === active ? { ...file, edited: value || '' } : file,
                      ),
                    )
                  }
                  options={{
                    readOnly: project.trusted === false,
                    automaticLayout: true,
                    fontSize: settings?.fontSize || 12,
                    fontFamily: '"SFMono-Regular", Consolas, monospace',
                    minimap: { enabled: false },
                    scrollBeyondLastLine: false,
                    padding: { top: 14 },
                    tabSize: settings?.tabSize || 2,
                    wordWrap: 'on',
                    renderLineHighlight: 'gutter',
                    lineNumbersMinChars: 3,
                  }}
                />
              </>
            ) : (
              <div className="editor-empty">
                <strong>未打开文件</strong>
                <span>从文件列表选择文件。</span>
                <small>选中文件或代码片段，可以引用到对话</small>
              </div>
            )}
          </div>
        </div>
      </div>
      <WorkspaceDialog
        open={!!fileOperation}
        onOpenChange={(open) => {
          if (!open) setFileOperation(undefined)
        }}
        title={
          fileOperation === 'branch'
            ? '新建分支'
            : fileOperation === 'rename'
              ? '重命名文件'
              : '新建文件'
        }
      >
        <form
          className="workspace-operation-form"
          onSubmit={(event) => {
            event.preventDefault()
            void submitFileOperation()
          }}
        >
          <label htmlFor={`${project.id}-path`}>
            {fileOperation === 'branch' ? '分支名称' : '相对项目的文件路径'}
          </label>
          <input
            id={`${project.id}-path`}
            autoFocus
            className="input mono"
            value={pathDraft}
            onChange={(event) => setPathDraft(event.target.value)}
            placeholder={fileOperation === 'branch' ? 'feature/task' : 'src/example.ts'}
          />
          <p className="field-hint">
            {fileOperation === 'branch'
              ? '从当前 HEAD 创建并切换到新分支。'
              : '父目录需要已存在；不会覆盖同名文件。'}
          </p>
          <button className="button primary" disabled={busy || !pathDraft.trim()} type="submit">
            {busy ? '处理中…' : '确认'}
          </button>
        </form>
      </WorkspaceDialog>
      <WorkspaceDialog open={commitOpen} onOpenChange={setCommitOpen} title="审阅暂存修改后提交">
        <div className="workspace-commit-review">
          <p>仅提交以下 {stagedFiles.length} 个已暂存文件。未暂存内容不会进入本次提交。</p>
          <button
            className="button secondary small"
            onClick={() => void beginCommit()}
            disabled={busy}
          >
            刷新提交预览
          </button>
          <div className="workspace-commit-files">
            {stagedFiles.map((file) => (
              <button
                key={file.path}
                className={commitDiff?.path === file.path ? 'active' : ''}
                onClick={() => {
                  void api.gitDiff(project.id, file.path, true).then(setCommitDiff).catch(onError)
                }}
              >
                {file.path}
              </button>
            ))}
          </div>
          <div className="workspace-commit-diff" style={{ height: 260 }}>
            {commitDiff?.previewUnavailable ? (
              <div className="editor-empty">
                <strong>
                  {commitDiff.previewUnavailable === 'binary'
                    ? '二进制文件或非文本内容'
                    : '文件超过 2 MB 预览限制'}
                </strong>
                <span>无法预览文本差异，暂存的完整文件仍会进入提交。</span>
              </div>
            ) : commitDiff ? (
              <SafeDiffEditor
                original={commitDiff.original}
                modified={commitDiff.modified}
                theme={theme === 'dark' ? 'vs-dark' : 'light'}
                options={{
                  readOnly: true,
                  automaticLayout: true,
                  minimap: { enabled: false },
                  renderSideBySide: false,
                  fontSize: settings?.fontSize || 12,
                  scrollBeyondLastLine: false,
                }}
              />
            ) : (
              <p>请选择文件查看暂存内容。</p>
            )}
          </div>
          <label htmlFor={`${project.id}-commit`}>提交说明</label>
          <textarea
            id={`${project.id}-commit`}
            className="input"
            value={commit}
            onChange={(event) => setCommit(event.target.value)}
            rows={2}
          />
          <button
            className="button primary"
            disabled={
              busy || running || !commit.trim() || !stagedFiles.length || !!git?.conflicts?.length
            }
            onClick={async () => {
              if (await gitAction('commit', commit)) setCommitOpen(false)
            }}
          >
            确认提交暂存修改
          </button>
        </div>
      </WorkspaceDialog>
      <WorkspaceDialog open={historyOpen} onOpenChange={setHistoryOpen} title="提交历史">
        <div className="workspace-history">
          {history.length ? (
            history.map((entry) => (
              <article key={entry.hash}>
                <strong>{entry.subject}</strong>
                <small>
                  <code>{entry.shortHash}</code> · {entry.author} ·{' '}
                  {new Date(entry.timestamp).toLocaleString()}
                </small>
              </article>
            ))
          ) : (
            <p>当前分支还没有提交。</p>
          )}
        </div>
      </WorkspaceDialog>
    </aside>
  )
}
