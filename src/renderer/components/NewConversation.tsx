import { useEffect, useState } from 'react'
import { AlertCircle, FolderOpen, LoaderCircle } from 'lucide-react'
import type {
  ContextItem,
  NewSessionDraft,
  Project,
  ProviderInfo,
  Session,
  Settings,
  Workspace,
} from '../../shared/types'
import { api } from '../lib/api'
import Composer from './Composer'
import { ComposerSelectors, ProjectPicker } from './ComposerSelectors'

interface Props {
  project?: Project
  projects: Project[]
  providers: ProviderInfo[]
  checking: boolean
  workspaces: Workspace[]
  settings: Settings
  disabled: boolean
  focusRequest: number
  context?: ContextItem
  clearContext: () => void
  onChooseProject: (id: string) => void
  onAddProject: () => void
  onConfigure: () => void
  onRemember: (selection: NonNullable<Settings['newSessionDefaults']>[string]) => void
  beforeCreate: () => Promise<void>
  onPrepared: (session: Session) => void
  onCreated: (session: Session) => void
  onError: (error: unknown) => void
}

export default function NewConversation(props: Props) {
  const { project } = props
  const [canIsolate, setCanIsolate] = useState(false)
  const [checkingWorkspace, setCheckingWorkspace] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  useEffect(() => {
    setCanIsolate(false)
    setCheckingWorkspace(false)
    if (!project?.trusted) return
    let stale = false
    setCheckingWorkspace(true)
    void api
      .inspectWorkspace(project.id)
      .then(
        (identity) => {
          if (!stale) setCanIsolate(identity.hasHead)
        },
        () => {},
      )
      .finally(() => {
        if (!stale) setCheckingWorkspace(false)
      })
    return () => {
      stale = true
    }
  }, [project?.id, project?.trusted])

  return (
    <section className="new-conversation" aria-label="新会话">
      <div className="new-conversation-content">
        <h1>{project ? '开始新会话' : '打开项目'}</h1>
        <p className="new-conversation-description">
          {project ? '你想从哪里开始？' : '选择本地项目，开始你的下一项任务。'}
        </p>
        <ProjectPicker
          projects={props.projects}
          projectId={project?.id}
          disabled={submitting}
          onChoose={props.onChooseProject}
          onAdd={props.onAddProject}
        />
        {project ? (
          <Composer<NewSessionDraft>
            key={project.id}
            draftKey={'new:' + project.id}
            loadDraft={() => api.getNewSessionDraft(project.id)}
            saveDraft={(draft) => api.saveNewSessionDraft(project.id, draft)}
            onSend={async (input, draft) => {
              setSubmitting(true)
              let created: Session | undefined
              try {
                await props.beforeCreate()
                created = await api.createSessionFromDraft(project.id, draft.id)
                props.onPrepared(created)
                await api.sendMessage(created.id, input, {
                  firstMessage: true,
                  draftUpdatedAt: draft.updatedAt,
                })
              } finally {
                if (created) props.onCreated(created)
                setSubmitting(false)
              }
            }}
            clearOnSend={false}
            onError={props.onError}
            getProvider={(draft) => props.providers.find((info) => info.id === draft.provider)}
            disabled={props.disabled || !project.trusted || props.checking}
            canSend={(draft) =>
              Boolean(props.providers.find((info) => info.id === draft.provider)?.available) &&
              (draft.workspace.kind !== 'isolated' || (canIsolate && !checkingWorkspace))
            }
            context={props.context}
            clearContext={props.clearContext}
            settings={props.settings}
            focusRequest={props.focusRequest}
            renderControls={(draft, update, busy) => (
              <ComposerSelectors
                providers={props.providers}
                provider={draft.provider}
                model={draft.model}
                reasoningOption={draft.reasoningOption}
                onChange={(selection) => {
                  update({
                    provider: selection.provider,
                    model: selection.model,
                    reasoningOption: selection.reasoningOption,
                  })
                  props.onRemember(selection)
                }}
                onConfigure={props.onConfigure}
                disabled={busy || props.checking}
                workspace={draft.workspace}
                workspaces={props.workspaces.filter(
                  (workspace) => workspace.projectId === project.id && !workspace.deletedAt,
                )}
                canIsolate={canIsolate}
                workspaceChecking={checkingWorkspace}
                onWorkspaceChange={(workspace) => update({ workspace })}
              />
            )}
          />
        ) : (
          <button className="button primary home-action" onClick={props.onAddProject}>
            <FolderOpen size={16} />
            打开项目
          </button>
        )}
        {props.checking ? (
          <p className="new-conversation-status" role="status">
            <LoaderCircle size={13} className="spin" />
            正在检测本机 Agent…
          </p>
        ) : !props.providers.some((provider) => provider.available) && project ? (
          <div className="new-conversation-status">
            <AlertCircle size={14} />
            <span>配置本机 Agent 后即可发送任务。</span>
            <button onClick={props.onConfigure}>配置 Agent</button>
          </div>
        ) : null}
      </div>
    </section>
  )
}
