import { useEffect, useRef, useState } from 'react'
import Editor, { DiffEditor, type OnMount } from '@monaco-editor/react'
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
} from 'lucide-react'
import type { FileContent, FileEntry, GitDiff, GitStatus, Project } from '../../shared/types'
import { api } from '../lib/api'
import '../lib/monaco'
type OpenFile = FileContent & { edited: string; external?: FileContent }
type DiffView =
  | { kind: 'git'; diff: GitDiff }
  | { kind: 'conflict'; path: string; original: string; modified: string }
interface Props {
  visible: boolean
  onDirtyChange: (dirty: boolean) => void
  project: Project
  running: boolean
  theme: string
  onClose: () => void
  onError: (error: unknown) => void
  onContext: (path: string, content: string) => void
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
    <div>
      {error && <div className="tree-error">{error}</div>}
      {files.map((file) => (
        <div key={file.path}>
          <button
            className={`file-entry ${active === file.path ? 'selected' : ''}`}
            style={{ paddingLeft: depth * 13 + 11 }}
            title={file.path}
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
  const filesRef = useRef(files)
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null)
  const selected = files.find((file) => file.path === active)
  const dirty = selected && selected.edited !== selected.content
  filesRef.current = files
  useEffect(() => {
    onDirtyChange(files.some((file) => file.edited !== file.content))
  }, [files, onDirtyChange])
  useEffect(() => () => onDirtyChange(false), [onDirtyChange])
  const loadGit = async () => {
    try {
      setGit(await api.gitStatus(project.id))
    } catch (e) {
      onError(e)
    }
  }
  useEffect(() => {
    setFiles([])
    setActive('')
    setDiff(null)
    setGit(undefined)
    setRefresh((value) => value + 1)
    void loadGit()
  }, [project.id])
  useEffect(() => {
    let alive = true
    const timer = setInterval(() => {
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
                item.path !== file.path
                  ? item
                  : item.edited === item.content
                    ? { ...current, edited: current.content }
                    : { ...item, external: current },
              ),
            )
          })
          .catch(() => {})
      setRefresh((value) => value + 1)
      void api
        .gitStatus(project.id)
        .then((value) => {
          if (alive) setGit(value)
        })
        .catch(() => {})
    }, 4500)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [project.id])
  async function openFile(entry: FileEntry) {
    setDiff(null)
    if (files.some((file) => file.path === entry.path)) {
      setActive(entry.path)
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
  async function save(overwrite = false) {
    if (!selected || !dirty) return
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
          file.path === saved.path ? { ...saved, edited: saved.content } : file,
        ),
      )
      setDiff(null)
      void loadGit()
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
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void save()
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  })
  async function gitAction(action: 'stage' | 'unstage' | 'commit' | 'checkout', value: string) {
    setBusy(true)
    try {
      await api.gitAction(project.id, action, value)
      if (action === 'commit') setCommit('')
      await loadGit()
    } catch (e) {
      onError(e)
    } finally {
      setBusy(false)
    }
  }
  async function showDiff(path: string, staged: boolean) {
    setBusy(true)
    try {
      setDiff({ kind: 'git', diff: await api.gitDiff(project.id, path, staged) })
    } catch (e) {
      onError(e)
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
  return (
    <aside className="workspace" style={{ display: visible ? undefined : 'none' }}>
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
          title="刷新工作区"
          onClick={() => {
            setRefresh((value) => value + 1)
            void loadGit()
          }}
        >
          <RefreshCw size={13} />
        </button>
        <button className="icon-button" title="关闭工作区" onClick={onClose}>
          <X size={15} />
        </button>
      </div>
      <div className="workspace-body">
        <div className="workspace-explorer">
          {mode === 'files' ? (
            <>
              <div className="explorer-heading">
                <span>{project.name}</span>
                <button
                  className="icon-button"
                  title="在文件管理器中打开"
                  onClick={() => void api.revealProject(project.id).catch(onError)}
                >
                  <ArrowUpRight size={12} />
                </button>
              </div>
              <div className="tree-scroll">
                <FileTree
                  projectId={project.id}
                  depth={0}
                  active={active}
                  onOpen={(entry) => void openFile(entry)}
                  refresh={refresh}
                />
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
              </div>
              {git?.isRepo ? (
                <>
                  <div className="git-commit">
                    <textarea
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
                        !changeFiles.some((file) => file.index !== ' ' && file.index !== '?')
                      }
                      title={running ? '任务运行时不能提交' : '提交暂存的修改'}
                      onClick={() => void gitAction('commit', commit)}
                    >
                      <Check size={13} />
                      提交暂存修改
                    </button>
                    {running && <small>任务运行时暂停提交与分支切换</small>}
                  </div>
                  <div className="git-section-title">
                    工作区变更 <span>{changeFiles.length}</span>
                  </div>
                  {changeFiles.length === 0 && (
                    <div className="git-clean">
                      <Check size={21} />
                      <p>工作区很干净</p>
                      <small>文件修改后将显示在这里</small>
                    </div>
                  )}
                  {changeFiles.map((file) => (
                    <div key={file.path} className="git-file">
                      <button
                        onClick={() => void showDiff(file.path, file.working === ' ')}
                        title={file.path}
                      >
                        <File size={13} />
                        <span>{file.path}</span>
                        <b className={file.index === '?' ? 'git-added' : ''}>
                          {file.working.trim() || file.index.trim()}
                        </b>
                      </button>
                      {file.index !== ' ' && file.index !== '?' && (
                        <button
                          className="icon-button"
                          title="取消暂存"
                          disabled={busy}
                          onClick={() => void gitAction('unstage', file.path)}
                        >
                          <Minus size={12} />
                        </button>
                      )}
                      {file.working !== ' ' && (
                        <button
                          className="icon-button"
                          title="暂存修改"
                          disabled={busy}
                          onClick={() => void gitAction('stage', file.path)}
                        >
                          <Plus size={12} />
                        </button>
                      )}
                    </div>
                  ))}
                </>
              ) : (
                <div className="git-clean">
                  <GitBranch size={25} />
                  <p>此目录不是 Git 仓库</p>
                  <small>可以在终端运行 git init</small>
                </div>
              )}
            </>
          )}
        </div>
        <div className="editor-pane">
          <div className="editor-tabs">
            {files.map((file) => (
              <button
                className={`editor-tab ${active === file.path && !diff ? 'active' : ''}`}
                key={file.path}
                onClick={() => {
                  setActive(file.path)
                  setDiff(null)
                }}
                title={file.path}
              >
                <FileCode2 size={12} />
                <span>{file.path.split(/[\\/]/).pop()}</span>
                {file.edited !== file.content && <i className="dirty-dot" />}
                <span
                  role="button"
                  tabIndex={0}
                  aria-label="关闭文件"
                  className="tab-close"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.stopPropagation()
                      closeFile(file)
                    }
                  }}
                  onClick={(e) => {
                    e.stopPropagation()
                    closeFile(file)
                  }}
                >
                  <X size={11} />
                </span>
              </button>
            ))}
            {diff && (
              <button className="editor-tab active">
                <GitBranch size={12} />
                <span>
                  {(diff.kind === 'git' ? diff.diff.path : diff.path).split(/[\\/]/).pop()} ·{' '}
                  {diff.kind === 'conflict' ? '保存冲突' : 'Diff'}
                </span>
                <span role="button" className="tab-close" onClick={() => setDiff(null)}>
                  <X size={11} />
                </span>
              </button>
            )}
          </div>
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
                        ? { ...selected.external!, edited: selected.external!.content }
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
          {diff ? (
            <DiffEditor
              key={diff.kind + (diff.kind === 'git' ? diff.diff.path : diff.path)}
              original={diff.kind === 'git' ? diff.diff.original : diff.original}
              modified={diff.kind === 'git' ? diff.diff.modified : diff.modified}
              language={selected?.language || 'plaintext'}
              theme={theme === 'dark' ? 'vs-dark' : 'light'}
              options={{
                readOnly: true,
                automaticLayout: true,
                minimap: { enabled: false },
                fontSize: 12,
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
                    onContext(selected.path, text)
                  }}
                >
                  引用到对话
                </button>
                <button
                  disabled={!dirty || busy || !!selected.external}
                  title="保存 · ⌘/Ctrl + S"
                  onClick={() => void save()}
                >
                  <Save size={12} />
                  保存
                </button>
              </div>
              <Editor
                path={project.id + '/' + selected.path}
                language={selected.language}
                value={selected.edited}
                theme={theme === 'dark' ? 'vs-dark' : 'light'}
                onMount={(editor) => {
                  editorRef.current = editor
                }}
                onChange={(value) =>
                  setFiles((previous) =>
                    previous.map((file) =>
                      file.path === active ? { ...file, edited: value || '' } : file,
                    ),
                  )
                }
                options={{
                  automaticLayout: true,
                  fontSize: 12,
                  fontFamily: '"SFMono-Regular", Consolas, monospace',
                  minimap: { enabled: false },
                  scrollBeyondLastLine: false,
                  padding: { top: 14 },
                  tabSize: 2,
                  wordWrap: 'on',
                  renderLineHighlight: 'gutter',
                  lineNumbersMinChars: 3,
                }}
              />
            </>
          ) : (
            <div className="editor-empty">
              <FileCode2 size={32} strokeWidth={1} />
              <strong>代码，就在手边</strong>
              <span>从左侧选择文件以查看和编辑</span>
              <small>选中文件或代码片段，可以引用到对话</small>
            </div>
          )}
        </div>
      </div>
    </aside>
  )
}
