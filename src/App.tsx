import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Activity, AlertCircle, ArrowLeft, Bot, CheckCircle2, ChevronLeft, ChevronRight, FileCode2, FileText, FolderKanban,
  BarChart3, Eye, EyeOff, Home, KeyRound, Layers3, ListChecks, LoaderCircle, MessageSquare, MoreHorizontal, Plus,
  Download, FolderOpen, PanelRightClose, PanelRightOpen, Paperclip, Pencil, RefreshCw, Send, Settings, ShieldCheck,
  Square, SquareStack, Trash2, Workflow, X
} from 'lucide-react'
import { useAppStore } from './store'
import officialLogo from '../references/logo.png'
import type { DeliveredQuestion, RunEventRecord, RunRecord, ThreadRecord } from './persistence'
import type { ExecutionActivity, ModelConfigDraft, ModelProviderId } from './model'
import type { RuntimeStatus } from './runtime'
import type { View } from './types'
import type { WorkspaceArtifact, WorkspaceRequirement } from './workspace'
import type { TokenStageId, TokenUsageSummary, TokenUsageWorkspace } from './tokenUsage'
import type { LifecycleStageId } from './lifecycleStageState'
import { slotsForStage } from './slotRegistry'
import { relationTypeLabels, type SaveRelationInput, type SaveSystemInput, type WorkContextCompany, type WorkContextSnapshot, type WorkContextSystem, type WorkContextSystemRelation } from './workContext'
import type { DiagnosticSummary } from './diagnostic'
import type { PrototypeStyleState } from './prototypeStyle'

function EmptyState({ title, detail, action, onAction }: { title: string; detail: string; action?: string; onAction?: () => void }) {
  return <div className="empty-state"><FolderKanban size={28} /><h3>{title}</h3><p>{detail}</p>{action && onAction && <button className="primary-button" onClick={onAction}>{action}</button>}</div>
}

function requestThreadTitle(initial = ''): string | null {
  const value = window.prompt(initial ? '输入新的 Thread 标题' : '输入 Thread 标题', initial)
  return value?.trim() || null
}

function Sidebar({ collapsed, onToggle, onResizeStart, onOpenSettings }: { collapsed: boolean; onToggle: () => void; onResizeStart: (event: React.MouseEvent<HTMLDivElement>) => void; onOpenSettings: () => void }) {
  const state = useAppStore()
  const [expandedRequirementId, setExpandedRequirementId] = useState<string | null>(state.activeRequirementId)
  const [expandedThreads, setExpandedThreads] = useState<ThreadRecord[]>(state.threads)
  const [creatingForRequirementId, setCreatingForRequirementId] = useState<string | null>(null)
  const [conversationTitle, setConversationTitle] = useState('')
  const [creatingConversation, setCreatingConversation] = useState(false)
  const [actionRequirement, setActionRequirement] = useState<WorkspaceRequirement | null>(null)
  const [requirementAction, setRequirementAction] = useState<'rename' | 'delete' | null>(null)
  const [requirementMenuPosition, setRequirementMenuPosition] = useState<{ top: number; left: number } | null>(null)
  const [requirementName, setRequirementName] = useState('')
  const [requirementActionBusy, setRequirementActionBusy] = useState(false)
  const [accountOpen, setAccountOpen] = useState(false)
  const accountRef = useRef<HTMLDivElement>(null)
  const requirementMenuRef = useRef<HTMLDivElement>(null)
  const requirementMenuPopupRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!accountOpen) return
    const closeOutside = (event: MouseEvent) => {
      if (!accountRef.current?.contains(event.target as Node)) setAccountOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAccountOpen(false)
    }
    document.addEventListener('mousedown', closeOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [accountOpen])
  useEffect(() => {
    if (!actionRequirement || requirementAction) return
    const closeOutside = (event: MouseEvent) => {
      if (!requirementMenuRef.current?.contains(event.target as Node) && !requirementMenuPopupRef.current?.contains(event.target as Node)) setActionRequirement(null)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setActionRequirement(null)
    }
    const closeOnViewportChange = () => setActionRequirement(null)
    document.addEventListener('mousedown', closeOutside)
    document.addEventListener('keydown', closeOnEscape)
    window.addEventListener('resize', closeOnViewportChange)
    window.addEventListener('scroll', closeOnViewportChange, true)
    return () => {
      document.removeEventListener('mousedown', closeOutside)
      document.removeEventListener('keydown', closeOnEscape)
      window.removeEventListener('resize', closeOnViewportChange)
      window.removeEventListener('scroll', closeOnViewportChange, true)
    }
  }, [actionRequirement, requirementAction])
  useEffect(() => {
    if (state.view === 'workspace' && state.activeRequirementId) {
      setExpandedRequirementId(state.activeRequirementId)
      setExpandedThreads(state.threads)
    }
  }, [state.view, state.activeRequirementId, state.threads])
  const toggleRequirement = async (requirementId: string) => {
    if (expandedRequirementId === requirementId) {
      setExpandedRequirementId(null)
      setExpandedThreads([])
      return
    }
    setExpandedRequirementId(requirementId)
    if (!state.workspace) return
    if (state.activeRequirementId === requirementId) {
      setExpandedThreads(state.threads)
      return
    }
    setExpandedThreads(await window.espow.persistence.listThreads(state.workspace.id, requirementId))
  }
  const openConversation = async (requirementId: string, threadId: string) => {
    if (state.activeRequirementId !== requirementId) await state.openRequirement(requirementId)
    await useAppStore.getState().openThread(threadId)
    useAppStore.getState().setView('workspace')
  }
  const createConversation = async (requirementId: string, title: string) => {
    setCreatingConversation(true)
    if (state.activeRequirementId !== requirementId) await state.openRequirement(requirementId)
    else state.setView('workspace')
    const created = await useAppStore.getState().createThread(title)
    setCreatingConversation(false)
    if (created) {
      setExpandedRequirementId(requirementId)
      setExpandedThreads(useAppStore.getState().threads)
      setCreatingForRequirementId(null)
      setConversationTitle('')
    }
  }
  const renameConversation = async (requirementId: string, thread: ThreadRecord) => {
    const title = requestThreadTitle(thread.title)
    if (!title || title === thread.title) return
    if (state.activeRequirementId === requirementId) {
      await state.renameThread(thread.id, title)
      setExpandedThreads(useAppStore.getState().threads)
      return
    }
    const renamed = await window.espow.persistence.renameThread(thread.id, title)
    setExpandedThreads((threads) => threads.map((item) => item.id === renamed.id ? renamed : item))
  }
  const deleteConversation = async (requirementId: string, thread: ThreadRecord) => {
    if (!window.confirm(`确认删除 Thread“${thread.title}”？消息会被删除，历史 Run 保留。`)) return
    if (state.activeRequirementId === requirementId) {
      await state.deleteThread(thread.id)
      setExpandedThreads(useAppStore.getState().threads)
      return
    }
    await window.espow.persistence.deleteThread(thread.id)
    setExpandedThreads((threads) => threads.filter((item) => item.id !== thread.id))
  }
  const submitRequirementRename = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!actionRequirement || !requirementName.trim() || requirementActionBusy) return
    setRequirementActionBusy(true)
    const renamed = await state.renameRequirement(actionRequirement.id, requirementName)
    setRequirementActionBusy(false)
    if (renamed) { setRequirementAction(null); setActionRequirement(null) }
  }
  const confirmRequirementDelete = async () => {
    if (!actionRequirement || requirementActionBusy) return
    setRequirementActionBusy(true)
    const deleted = await state.deleteRequirement(actionRequirement.id)
    setRequirementActionBusy(false)
    if (deleted) {
      if (expandedRequirementId === actionRequirement.id) { setExpandedRequirementId(null); setExpandedThreads([]) }
      setRequirementAction(null)
      setActionRequirement(null)
    }
  }
  const nav: { id: View; label: string; icon: typeof Home }[] = [
    { id: 'dashboard', label: '工作台', icon: Home },
    { id: 'todo', label: '待我处理', icon: ListChecks },
    { id: 'runs', label: 'Agent Runs', icon: Activity }
  ]
  return <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
    <div className="brand-block">
      <div className="brand-row"><div className="brand-mark"><img src={officialLogo} alt="" /></div><div className="brand-copy"><strong>ESPow Work</strong><span>易思智作 · PM Workspace</span></div></div>
      <div className="brand-actions">
        <button className="new-requirement" onClick={() => void state.chooseWorkspace()} disabled={state.loading}><FolderKanban size={15} />{state.workspace ? '切换工作区' : '选择工作区'}</button>
      </div>
    </div>
    <nav className="global-nav"><p className="section-label">工作台</p>{nav.map(({ id, label, icon: Icon }) => <button title={collapsed ? label : undefined} key={id} className={state.view === id ? 'active' : ''} onClick={() => state.setView(id)}><Icon size={16} /><span>{label}</span></button>)}</nav>
    <div className="requirement-nav">
      <div className="section-label-row"><p className="section-label">需求工作区</p>{state.workspace && <div className="section-actions"><button title="新增需求" onClick={state.openRequirementDialog} disabled={state.loading}><Plus size={14} /></button><button title="刷新 Workspace" onClick={() => void state.refreshWorkspace()} disabled={state.loading}><RefreshCw className={state.loading ? 'spin' : ''} size={14} /></button></div>}</div>
      {!state.workspace && !state.loading && <p className="sidebar-empty">尚未选择本地 Workspace</p>}
      {state.workspace && !state.workspace.requirements.length && <button className="sidebar-create-requirement" onClick={state.openRequirementDialog}><Plus size={13} />新增需求</button>}
      {state.workspace?.requirements.map((requirement) => {
        const expanded = expandedRequirementId === requirement.id
        const active = state.view === 'workspace' && state.activeRequirementId === requirement.id
        return <div className={`requirement-group ${expanded ? 'expanded' : ''}`} key={requirement.id}>
          <div className={`requirement-item ${active ? 'active' : ''}`}>
          <button className="requirement-select" aria-expanded={expanded} onClick={() => void toggleRequirement(requirement.id)}>
            <span className="requirement-chevron"><ChevronRight size={14} /></span><span className="req-copy"><strong title={requirement.title}>{requirement.title}</strong><small>{requirement.stageLabel}<em>{requirement.artifacts.filter((artifact) => !isSourceArtifact(artifact)).length} 个产物</em></small></span>
          </button><div className="requirement-menu-anchor" ref={actionRequirement?.id === requirement.id ? requirementMenuRef : undefined}><button className="requirement-more" title="需求操作" aria-label={`${requirement.title} 操作`} aria-expanded={actionRequirement?.id === requirement.id && !requirementAction} onClick={(event) => { event.stopPropagation(); setRequirementAction(null); if (actionRequirement?.id === requirement.id) { setActionRequirement(null); setRequirementMenuPosition(null) } else { const rect = event.currentTarget.getBoundingClientRect(); setRequirementMenuPosition({ top: rect.bottom + 4, left: rect.right - 132 }); setActionRequirement(requirement) } }}><MoreHorizontal size={16} /></button></div>
          </div>
          {expanded && <div className="sidebar-conversations">
            {expandedThreads.map((thread) => <div className="conversation-row" key={thread.id}><button className={`conversation-item ${active && state.activeThreadId === thread.id ? 'active' : ''}`} onClick={() => void openConversation(requirement.id, thread.id)}><span /><strong>{thread.title}</strong></button><div className="conversation-actions"><button title="重命名 Thread" onClick={() => void renameConversation(requirement.id, thread)}><Pencil size={12} /></button><button title="删除 Thread" onClick={() => void deleteConversation(requirement.id, thread)}><Trash2 size={12} /></button></div></div>)}
            <button className="sidebar-new-conversation" onClick={() => { setCreatingForRequirementId(requirement.id); setConversationTitle('') }}><Plus size={13} />新建对话</button>
          </div>}
        </div>
      })}
    </div>
    <div className="sidebar-footer"><button className="sidebar-toggle" title={collapsed ? '展开侧栏' : '收起侧栏'} onClick={onToggle}>{collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}<span>{collapsed ? '' : '收起侧栏'}</span></button><div className="account-area" ref={accountRef}>
      {accountOpen && <div className="account-popover" role="menu"><div className="account-popover-head"><strong>本地用户</strong><span>ESPow Work 本地账户</span></div><button role="menuitem" onClick={() => { setAccountOpen(false); onOpenSettings() }}><Settings size={16} /><span>设置</span></button></div>}
      <button className={`account-trigger ${accountOpen ? 'active' : ''}`} aria-expanded={accountOpen} title={collapsed ? '本地用户' : undefined} onClick={() => setAccountOpen((open) => !open)}><span className="account-avatar">MY</span><span className="account-copy"><strong>本地用户</strong><small>个人工作区</small></span><ChevronRight className="account-chevron" size={14} /></button>
    </div></div>
    {!collapsed && <div className="sidebar-resize-handle" role="separator" aria-orientation="vertical" aria-label="调整侧栏宽度" onMouseDown={onResizeStart} />}
    {actionRequirement && !requirementAction && requirementMenuPosition && createPortal(<div ref={requirementMenuPopupRef} className="requirement-menu requirement-menu-floating" role="menu" style={requirementMenuPosition}><button role="menuitem" onClick={() => { setRequirementName(actionRequirement.title); setRequirementAction('rename') }}>重命名</button><button className="danger" role="menuitem" onClick={() => setRequirementAction('delete')}>删除需求</button></div>, document.body)}
    {creatingForRequirementId && <div className="modal-mask" onMouseDown={(event) => { if (event.target === event.currentTarget && !creatingConversation) setCreatingForRequirementId(null) }}><form className="modal requirement-dialog" onSubmit={(event) => { event.preventDefault(); if (conversationTitle.trim()) void createConversation(creatingForRequirementId, conversationTitle.trim()) }}>
      <div className="modal-head"><h2>新建对话</h2><button type="button" className="icon-button" disabled={creatingConversation} onClick={() => setCreatingForRequirementId(null)}><X size={18} /></button></div>
      <div className="modal-body"><label>对话名称 <em>必填</em><input autoFocus maxLength={120} value={conversationTitle} placeholder="例如：梳理业务流程" onChange={(event) => setConversationTitle(event.target.value)} /></label></div>
      <div className="modal-actions"><button type="button" className="secondary-button" disabled={creatingConversation} onClick={() => setCreatingForRequirementId(null)}>取消</button><button className="primary-button" disabled={creatingConversation || !conversationTitle.trim()}>{creatingConversation && <LoaderCircle className="spin" size={12} />}创建对话</button></div>
    </form></div>}
    {actionRequirement && requirementAction === 'rename' && <div className="modal-mask" onMouseDown={(event) => { if (event.target === event.currentTarget && !requirementActionBusy) { setRequirementAction(null); setActionRequirement(null) } }}><form className="modal requirement-action-dialog" onSubmit={submitRequirementRename}>
      <div className="modal-head"><h2>重命名需求</h2><button type="button" className="icon-button" disabled={requirementActionBusy} onClick={() => { setRequirementAction(null); setActionRequirement(null) }}><X size={18} /></button></div>
      <div className="modal-body"><label>需求名称 <em>必填</em><input autoFocus maxLength={120} value={requirementName} onChange={(event) => setRequirementName(event.target.value)} /></label></div>
      <div className="modal-actions"><button type="button" className="secondary-button" disabled={requirementActionBusy} onClick={() => { setRequirementAction(null); setActionRequirement(null) }}>取消</button><button className="primary-button" disabled={requirementActionBusy || !requirementName.trim()}>{requirementActionBusy && <LoaderCircle className="spin" size={12} />}保存</button></div>
    </form></div>}
    {actionRequirement && requirementAction === 'delete' && <div className="modal-mask" onMouseDown={(event) => { if (event.target === event.currentTarget && !requirementActionBusy) { setRequirementAction(null); setActionRequirement(null) } }}><section className="modal requirement-action-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-requirement-title">
      <div className="modal-head"><h2 id="delete-requirement-title">删除需求</h2><button type="button" className="icon-button" disabled={requirementActionBusy} onClick={() => { setRequirementAction(null); setActionRequirement(null) }}><X size={18} /></button></div>
      <div className="modal-body"><p className="delete-requirement-warning">删除后将彻底删除该需求的所有对话、产物、生命周期状态、运行记录和 Token 使用记录，且无法恢复。</p><dl className="delete-requirement-name"><dt>需求</dt><dd>{actionRequirement.title}</dd></dl></div>
      <div className="modal-actions"><button autoFocus type="button" className="secondary-button" disabled={requirementActionBusy} onClick={() => { setRequirementAction(null); setActionRequirement(null) }}>取消</button><button type="button" className="danger-button" disabled={requirementActionBusy} onClick={() => void confirmRequirementDelete()}>{requirementActionBusy && <LoaderCircle className="spin" size={12} />}删除需求</button></div>
    </section></div>}
  </aside>
}

function ArtifactIcon({ artifact }: { artifact: WorkspaceArtifact }) {
  const icon = artifact.kind === 'Business Flow' ? <Workflow size={15} /> : artifact.format === 'html' ? <FileCode2 size={15} /> : <FileText size={15} />
  const color = artifact.format === 'html' || artifact.format === 'image' ? 'green' : artifact.kind === 'Business Flow' ? 'purple' : 'blue'
  return <span className={`artifact-icon ${color}`}>{icon}</span>
}

function MarkdownMessage({ content }: { content: string }) {
  return <ReactMarkdown
    remarkPlugins={[remarkGfm]}
    components={{
      table: ({ node: _node, ...props }) => <div className="markdown-table-scroll"><table {...props} /></div>,
      a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />
    }}
  >{content}</ReactMarkdown>
}

function DeliveredQuestions({ questions }: { questions: DeliveredQuestion[] }) {
  if (!questions.length) return null
  return <section className="delivered-questions" aria-label={`待确认问题，共 ${questions.length} 个`}>
    <div className="delivered-questions-head"><strong>待你确认</strong><span>{questions.length}</span></div>
    <div className="delivered-question-list">{questions.map((question) => <article className="delivered-question" key={`${question.id}:${question.content}`}>
      <div><code>{question.id}</code>{question.blocking && <span>Blocking</span>}</div>
      <p>{question.content}</p>
    </article>)}</div>
  </section>
}

function ExecutionActivityList({ items }: { items: ExecutionActivity[] }) {
  const [expanded, setExpanded] = useState(false)
  if (!items.length) return null
  const visible = expanded ? items : items.slice(-5)
  const kindLabel: Record<ExecutionActivity['kind'], string> = {
    model: 'AI', tool: '工具', script: '脚本', state: '状态', artifact: '产物'
  }
  return <div className="execution-activity-panel">
    <div className="execution-activity-head"><span><Activity size={12} />执行过程</span>{items.length > 5 && <button type="button" onClick={() => setExpanded((value) => !value)}>{expanded ? '收起' : `查看全部 ${items.length}`}</button>}</div>
    <div className="execution-activity-list">{visible.map((item) => <div className={`execution-activity-row ${item.status}`} key={item.id}>
      <span className="execution-activity-icon">{item.status === 'running' ? <LoaderCircle className="spin" size={12} /> : item.status === 'failed' ? <AlertCircle size={12} /> : <CheckCircle2 size={12} />}</span>
      <span className="execution-activity-kind">{kindLabel[item.kind]}</span>
      <span className="execution-activity-label">{item.label}</span>
      <span className="execution-activity-meta">{item.kind === 'model' && item.inputTokens !== undefined ? `${(item.inputTokens / 1000).toFixed(item.inputTokens >= 1000 ? 1 : 2)}K in` : item.kind === 'script' ? '0 Token' : item.durationMs !== null && item.durationMs !== undefined ? `${item.durationMs}ms` : ''}</span>
    </div>)}</div>
  </div>
}


function isSourceArtifact(artifact: WorkspaceArtifact): boolean {
  return artifact.kind === 'Source Input' || artifact.relativePath.startsWith('source/')
}

function fileTypeLabel(artifact: WorkspaceArtifact): string {
  return artifact.format === 'markdown' ? 'Markdown' : artifact.format === 'html' ? 'HTML'
    : artifact.format === 'json' ? 'JSON' : artifact.format === 'image' ? '图片' : 'Text'
}

function artifactStageLabel(artifact: WorkspaceArtifact): string {
  const labels: Record<string, string> = {
    Analysis: '需求分析', 'Business Flow': '业务流程', Solution: '方案设计', Interaction: '交互设计',
    Prototype: '页面原型', PRD: 'PRD', Review: '需求评审', Decision: '关键决策', 'Open Issue': '未决问题'
  }
  return labels[artifact.kind] ?? (artifact.relativePath === 'overview.md' ? '需求概览' : '工作产物')
}

function sourceTitle(artifact: WorkspaceArtifact): string {
  return /^source\/initial-request\.[^/]+$/i.test(artifact.relativePath) ? '原始需求' : artifact.title
}

function sourceTypeLabel(artifact: WorkspaceArtifact): string {
  if (/^source\/initial-request\.[^/]+$/i.test(artifact.relativePath)) return '需求输入'
  if (/^source\/requirement-info(?:-\d+)?\.md$/i.test(artifact.relativePath)) return '补充需求信息'
  if (/(?:历史|已上线|需求|prd)/i.test(artifact.title)) return '参考需求'
  return artifact.format === 'html' ? '网页资料' : '参考资料'
}

function Dashboard() {
  const { workspace, loading, chooseWorkspace, openRequirement, openArtifact, openRequirementDialog, runs } = useAppStore()
  const latestArtifacts = useMemo(() => workspace?.requirements.flatMap((requirement) => requirement.artifacts.map((artifact) => ({ artifact, requirement }))).sort((a, b) => b.artifact.updatedAt.localeCompare(a.artifact.updatedAt, 'zh-CN')).slice(0, 5) ?? [], [workspace])
  if (loading) return <div className="page-scroll"><EmptyState title="正在读取 Workspace" detail="扫描本地 Requirement 与 Artifact…" /></div>
  if (!workspace) return <WelcomePage onChoose={() => void chooseWorkspace()} />
  if (!workspace.requirements.length) return <div className="page-scroll"><EmptyState title="还没有需求" detail="创建第一个 Requirement，开始你的产品工作。" action="新增需求" onAction={openRequirementDialog} /></div>
  const issues = workspace.requirements.flatMap((requirement) => requirement.openIssues.map((issue) => ({ issue, requirement })))
  const pending = runs.filter((run) => run.status === 'WaitingConfirmation')
  const attention = workspace.requirements.flatMap((requirement) => requirement.lifecycle.attention.map((item) => ({ item, requirement })))
  const recentRuns = runs.slice(0, 5)
  const artifactCount = workspace.requirements.reduce((sum, item) => sum + item.artifacts.length, 0)
  return <div className="page-scroll dashboard-page">
    <section className="hero-card"><div><span className="hero-kicker"><Layers3 size={13} /> {workspace.name}</span><h2>{workspace.rootPath}</h2><p>Requirement 来源：{workspace.requirementsDirectory} · 最近扫描 {new Date(workspace.scannedAt).toLocaleString('zh-CN')}</p></div></section>
    <section className="metric-grid"><Metric value={String(workspace.requirements.length)} label="Requirement" note="来自本地目录" color="blue" /><Metric value={String(pending.length)} label="等待确认" note="需要产品经理决策" color="orange" /><Metric value={String(attention.length)} label="Needs Attention" note="问题、过期或 Blocker" color="purple" /><Metric value={String(runs.length)} label="Agent Runs" note="本地持久化" color="green" /></section>
    <section className="dashboard-grid">
      <Panel title="最近 Requirement" action="真实 Workspace 状态"><div className="requirement-table"><div className="table-head"><span>REQUIREMENT</span><span>状态</span><span>阶段</span><span>最近更新</span></div>{workspace.requirements.slice(0, 6).map((requirement) => <button className="table-row" key={requirement.id} onClick={() => void openRequirement(requirement.id)}><span><strong>{requirement.title}</strong><small>{requirement.directoryName}</small></span><span><em>{requirement.lifecycle.status}</em></span><span>{requirement.stageLabel}</span><span>{requirement.updatedAt || '—'}<ChevronRight size={14} /></span></button>)}</div></Panel>
      <Panel title="Needs Attention" action={`${attention.length + pending.length} 项`}>{attention.length || pending.length ? <div className="stack-list">{pending.slice(0, 3).map((run) => { const requirement = workspace.requirements.find((item) => item.id === run.requirementId); return <button className="attention-item" key={run.id} onClick={() => requirement && void openRequirement(requirement.id)}><span className="attention-icon"><CheckCircle2 size={15} /></span><span><strong>等待确认 · {run.skill ?? 'Artifact'}</strong><small>{requirement?.title ?? run.requirementId}</small></span><ChevronRight size={14} /></button> })}{attention.slice(0, 5).map(({ item, requirement }) => <button className="attention-item" key={`${requirement.id}-${item.kind}`} onClick={() => void openRequirement(requirement.id)}><span className="attention-icon"><AlertCircle size={15} /></span><span><strong>{item.label}</strong><small>{requirement.title}</small></span><ChevronRight size={14} /></button>)}</div> : <InlineEmpty text="当前没有需要处理的事项。" />}</Panel>
      <Panel title="最近 Artifact" action={`${artifactCount} 个文件`}>{latestArtifacts.length ? <div className="stack-list">{latestArtifacts.map(({ artifact, requirement }) => <button className="artifact-summary" key={`${requirement.id}-${artifact.id}`} onClick={() => void openArtifact(requirement.id, artifact.id)}><ArtifactIcon artifact={artifact} /><span><strong>{requirement.title} · {artifact.title}</strong><small>{artifact.relativePath} · {artifact.updatedAt}</small></span><ChevronRight size={14} /></button>)}</div> : <InlineEmpty text="没有发现 Markdown、Text、JSON 或 HTML Artifact。" />}</Panel>
      <Panel title="最近 Agent Runs" action={`${runs.length} 次`}>{recentRuns.length ? <div className="stack-list">{recentRuns.map((run) => <button className="artifact-summary" key={run.id} onClick={() => { useAppStore.getState().selectRun(run.id); useAppStore.getState().setView('runs') }}><span className="artifact-icon purple"><Activity size={15} /></span><span><strong>{run.task}</strong><small>{run.skill ?? '普通问答'} · {run.status}</small></span><ChevronRight size={14} /></button>)}</div> : <InlineEmpty text="暂无 Agent Run。" />}</Panel>
    </section>
  </div>
}

function WelcomePage({ onChoose }: { onChoose: () => void }) {
  return <div className="page-scroll welcome-page"><div className="welcome-content"><p className="eyebrow">ESPOW WORK · LOCAL WORKSPACE</p><h2>从真实工作成果开始</h2><p>选择一个本地 Workspace，查看 Requirement 与 Artifact，并在本机保存独立的 Thread、Message 和 Run。</p><button className="primary-button welcome-action" onClick={onChoose}><FolderKanban size={16} />选择本地 Workspace</button><small>正式 Artifact 只读 · App 状态仅保存在本机</small></div></div>
}

function Metric({ value, label, note, color }: { value: string; label: string; note: string; color: string }) { return <div className="metric-card"><span className={`metric-icon ${color}`}><SquareStack size={17} /></span><div><strong>{value}</strong><span>{label}</span><small>{note}</small></div></div> }
function Panel({ title, action, children }: { title: string; action: string; children: React.ReactNode }) { return <div className="panel"><div className="panel-heading"><h3>{title}</h3><span className="panel-label">{action}</span></div>{children}</div> }
function InlineEmpty({ text }: { text: string }) { return <div className="inline-empty">{text}</div> }

function isReviewStale(result: NonNullable<RunRecord['requirementReviewResult']>, requirement: WorkspaceRequirement): boolean {
  return result.reviewStatus === 'CONFIRMED' && requirement.lifecycle.artifacts.find((item) => item.id === 'review')?.status === 'STALE'
}

function TodoPage() {
  const { workspace, openRequirement, runs } = useAppStore()
  const issues = workspace?.requirements.flatMap((requirement) => requirement.openIssues.map((issue) => ({ issue, requirement }))) ?? []
  const lifecycleAttention = workspace?.requirements.flatMap((requirement) => requirement.lifecycle.attention.filter((item) => item.kind !== 'OPEN_ISSUES').map((item) => ({ item, requirement }))) ?? []
  const pending = runs.filter((run) => run.status === 'WaitingConfirmation')
  return <div className="page-scroll standard-page">{issues.length || lifecycleAttention.length || pending.length ? <div className="large-list">{pending.map((run) => { const requirement = workspace?.requirements.find((item) => item.id === run.requirementId); return <div className="large-row" key={run.id}><span className="large-icon blue"><CheckCircle2 /></span><div className="large-copy"><div><code>CONFIRM</code><span className="tag">WaitingConfirmation</span></div><h3>{run.skill ?? 'Artifact'} 等待确认</h3><p>{run.task}</p><small>{requirement?.title ?? run.requirementId}</small></div>{requirement && <button className="secondary-button" onClick={() => void openRequirement(requirement.id)}>进入 Requirement <ChevronRight size={14} /></button>}</div> })}{lifecycleAttention.map(({ item, requirement }) => <div className="large-row" key={`${requirement.id}-${item.kind}`}><span className="large-icon orange"><AlertCircle /></span><div className="large-copy"><div><code>{item.kind}</code><span className="tag">Needs Attention</span></div><h3>{item.label}</h3><p>{requirement.title} 当前阶段：{requirement.stageLabel}</p></div><button className="secondary-button" onClick={() => void openRequirement(requirement.id)}>进入 Requirement <ChevronRight size={14} /></button></div>)}{issues.map(({ issue, requirement }) => <div className="large-row" key={`${requirement.id}-${issue.id}`}><span className="large-icon orange"><AlertCircle /></span><div className="large-copy"><div><code>{issue.id}</code><span className="tag">{issue.status || 'OPEN'}</span></div><h3>{issue.title}</h3><p>{issue.detail || '没有补充说明。'}</p><small>{requirement.title} · Owner：{issue.owner || '未标注'}</small></div><button className="secondary-button" onClick={() => void openRequirement(requirement.id)}>进入 Requirement <ChevronRight size={14} /></button></div>)}</div> : <EmptyState title="没有待处理事项" detail={workspace ? '当前没有等待确认、Open Issue、过期 Review 或 Blocker。' : '请先选择 Workspace。'} />}</div>
}

function Composer({ inputRef, content, setContent, onAddSource, stageId }: { inputRef?: React.RefObject<HTMLTextAreaElement | null>; content: string; setContent: (value: string) => void; onAddSource: () => void; stageId: LifecycleStageId }) {
  const { activeThreadId, sending, sendMessage, stopGeneration } = useAppStore()
  const [slotEditorOpen, setSlotEditorOpen] = useState(false)
  const [slotId, setSlotId] = useState(() => slotsForStage(stageId)[0]?.slotId ?? '')
  const stageSlots = slotsForStage(stageId)
  useEffect(() => { setSlotId(slotsForStage(stageId)[0]?.slotId ?? '') }, [stageId])
  const submit = async () => {
    const task = content.trim()
    if (!task) return
    const target = slotEditorOpen && slotId ? { stageId, slotId } : undefined
    const saved = await sendMessage(task, undefined, target)
    if (task && saved) setContent('')
  }
  return <div className={`composer-wrap ${slotEditorOpen ? 'slot-editor-active' : ''}`}>
    {slotEditorOpen && <div className="slot-editor-bar"><strong>明确槽位</strong><select aria-label="选择编辑槽位" value={slotId} onChange={(event) => setSlotId(event.target.value)}>{stageSlots.map((slot) => <option key={slot.slotId} value={slot.slotId}>{slot.label}{slot.required ? ' *' : ''}</option>)}</select><span>保存走 Script · 0 Token</span></div>}
    <div className="composer"><textarea ref={inputRef} value={content} disabled={!activeThreadId || sending} placeholder={activeThreadId ? slotEditorOpen ? `填写${stageSlots.find((slot) => slot.slotId === slotId)?.label ?? '槽位'}内容，每行一项` : '告诉 ESPow Work 你想继续做什么…' : '请先新建对话'} onChange={(event) => setContent(event.target.value)} /><div className="composer-footer"><div className="composer-tools"><button className={slotEditorOpen ? 'active' : ''} disabled={!activeThreadId || sending} onClick={() => setSlotEditorOpen((value) => !value)}><Layers3 size={12} />槽位编辑</button><button disabled={!activeThreadId || sending} onClick={onAddSource}><Paperclip size={12} />添加资料</button><span className="shortcut">点击发送按钮发送</span></div>{sending ? <button className="stop-button" onClick={() => void stopGeneration()}><Square size={11} />停止生成</button> : <button className="send-button" aria-label="发送" title="发送" disabled={!activeThreadId || !content.trim()} onClick={() => void submit()}>{slotEditorOpen ? '保存槽位' : '发送'} <Send size={13} /></button>}</div></div>
  </div>
}

const workspaceCapabilities = [
  { stage: 'ANALYSIS', label: '需求分析', detail: '理解业务场景、明确问题与需求边界', prompt: '重新分析当前需求，重点检查业务场景、目标、边界和遗漏。' },
  { stage: 'BUSINESS_FLOW', label: '业务流程', detail: '主流程 / 分支 / 异常', prompt: '基于当前需求生成完整业务流程，并标出判断分支、异常和回退。' },
  { stage: 'SOLUTION', label: '方案设计', detail: '能力 / 规则 / 状态', prompt: '基于当前需求和业务流程完成方案设计，明确能力、规则、状态与关键决策。' },
  { stage: 'INTERACTION', label: '交互设计', detail: '页面 / 路径 / 状态', prompt: '基于当前方案完成交互设计，明确页面、用户路径、交互和页面状态。' },
  { stage: 'PROTOTYPE', label: '页面原型', detail: '页面 / 字段 / 交互', prompt: '基于当前交互设计生成 HTML 页面原型，并创建新的版本。' },
  { stage: 'PRODUCT_SPEC', label: '产品需求文档', detail: '结构化产品文档', prompt: '基于当前已确认的产物生成或更新产品需求文档，只修改受影响部分。' },
  { stage: 'REVIEW', label: '需求评审', detail: '缺口 / 风险 / 冲突', prompt: '评审当前需求，重点检查完整性、一致性、可开发性和遗漏。' }
]

const lifecycleStageByWorkspaceStage: Record<WorkspaceRequirement['stage'], LifecycleStageId> = {
  ANALYSIS: 'requirement-analysis', BUSINESS_FLOW: 'business-flow', SOLUTION: 'solution-design',
  INTERACTION: 'interaction-design', PROTOTYPE: 'prototype', PRODUCT_SPEC: 'product-spec',
  REVIEW: 'requirement-review', READY: 'requirement-review'
}

function StageControlActions({ stageId }: { stageId: LifecycleStageId }) {
  const { sending, sendControlEvent } = useAppStore()
  return <div className="message-stage-actions"><button className="secondary-button" disabled={sending} onClick={() => void sendControlEvent({ type: 'REJECT_STAGE', stageId })}>重新调整</button><button className="primary-button" disabled={sending} onClick={() => void sendControlEvent({ type: 'CONFIRM_STAGE', stageId })}>确认阶段</button></div>
}

function WorkspacePage({ requirement }: { requirement: WorkspaceRequirement }) {
  const state = useAppStore()
  const thread = state.threads.find((item) => item.id === state.activeThreadId)
  const streaming = (Object.entries(state.streamingResponses) as Array<[string, { threadId: string; content: string }]>)
    .filter(([, item]) => item.threadId === thread?.id)
  const pendingFlow = state.runs.find((run) => run.threadId === thread?.id && run.status === 'WaitingConfirmation' && run.flowResult?.flowStatus === 'READY_FOR_CONFIRMATION')
  const pendingAnalysis = state.runs.find((run) => run.threadId === thread?.id && run.status === 'WaitingConfirmation' && run.analysisResult?.analysisStatus === 'ReadyForConfirmation')
  const pendingSolution = state.runs.find((run) => run.threadId === thread?.id && run.status === 'WaitingConfirmation' && run.solutionResult?.solutionStatus === 'READY_FOR_CONFIRMATION')
  const pendingInteraction = state.runs.find((run) => run.threadId === thread?.id && run.status === 'WaitingConfirmation' && run.interactionResult?.interactionStatus === 'READY_FOR_CONFIRMATION')
  const pendingPrototype = state.runs.find((run) => run.threadId === thread?.id && run.status === 'WaitingConfirmation' && run.prototypeResult?.prototypeStatus === 'READY_FOR_CONFIRMATION')
  const pendingProductSpec = state.runs.find((run) => run.threadId === thread?.id && run.status === 'WaitingConfirmation' && run.productSpecResult?.productSpecStatus === 'READY_FOR_CONFIRMATION')
  const pendingRequirementReview = state.runs.find((run) => run.threadId === thread?.id && run.status === 'WaitingConfirmation' && run.requirementReviewResult?.reviewStatus === 'READY_FOR_CONFIRMATION')
  const chatRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const messageEditRef = useRef<HTMLTextAreaElement>(null)
  const [composerContent, setComposerContent] = useState('')
  const [requirementInfoOpen, setRequirementInfoOpen] = useState(false)
  const [requirementInfo, setRequirementInfo] = useState('')
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null)
  const [editingMessageContent, setEditingMessageContent] = useState('')
  const [dismissedGuideKey, setDismissedGuideKey] = useState<string | null>(null)
  const [contextOpen, setContextOpen] = useState(() => window.localStorage.getItem('espow.context.open') !== 'false')
  const [contextWidth, setContextWidth] = useState(() => {
    const stored = Number(window.localStorage.getItem('espow.context.width'))
    return Number.isFinite(stored) && stored >= 260 && stored <= 420 ? stored : 300
  })
  const hasThreadRun = state.runs.some((run) => run.threadId === thread?.id && !['Failed', 'Cancelled'].includes(run.status))
  const firstGuideKey = thread ? `${requirement.id}:${thread.id}` : null
  const firstGuideAvailable = Boolean(thread && !hasThreadRun && !streaming.length && !state.sending)
  const firstGuideDismissed = firstGuideKey !== null && (dismissedGuideKey === firstGuideKey || window.sessionStorage.getItem(`analysis-guide:${firstGuideKey}`) === 'dismissed')
  const showFirstGuide = firstGuideAvailable && !firstGuideDismissed
  useEffect(() => {
    const element = chatRef.current
    if (element) element.scrollTop = element.scrollHeight
  }, [state.messages.length, streaming.map(([, item]) => item.content).join(''), streaming.map(([runId]) => state.executionActivities[runId]?.length ?? 0).join(',')])
  const create = () => { const title = requestThreadTitle(); if (title) void state.createThread(title) }
  const chooseCapability = (prompt: string) => {
    setEditingMessageId(null)
    setComposerContent(prompt)
    window.setTimeout(() => composerRef.current?.focus(), 0)
  }
  const editMessage = (messageId: string, content: string) => {
    setEditingMessageId(messageId)
    setEditingMessageContent(content)
    window.setTimeout(() => {
      messageEditRef.current?.focus()
      messageEditRef.current?.setSelectionRange(content.length, content.length)
    }, 0)
  }
  const cancelMessageEdit = () => {
    setEditingMessageId(null)
    setEditingMessageContent('')
  }
  const submitMessageEdit = async () => {
    const content = editingMessageContent.trim()
    if (!editingMessageId || !content || state.sending) return
    if (await state.sendMessage(content, editingMessageId)) cancelMessageEdit()
  }
  const submitRequirementInfo = async (event: React.FormEvent) => {
    event.preventDefault()
    if (await state.addRequirementInfo(requirementInfo)) {
      setRequirementInfo('')
      setRequirementInfoOpen(false)
    }
  }
  useEffect(() => {
    setEditingMessageId(null)
    setEditingMessageContent('')
    setComposerContent('')
  }, [thread?.id])
  const currentCapability = workspaceCapabilities.find((item) => item.stage === requirement.stage) ?? workspaceCapabilities.at(-1)!
  const currentStageIndex = requirement.stage === 'READY' ? workspaceCapabilities.length : workspaceCapabilities.findIndex((item) => item.stage === currentCapability.stage)
  const toggleContext = () => setContextOpen((open) => {
    window.localStorage.setItem('espow.context.open', String(!open))
    return !open
  })
  const resizeContext = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = contextWidth
    let nextWidth = startWidth
    document.body.classList.add('is-resizing')
    const move = (moveEvent: MouseEvent) => {
      nextWidth = Math.min(420, Math.max(260, startWidth + startX - moveEvent.clientX))
      setContextWidth(nextWidth)
    }
    const stop = () => {
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', stop)
      document.body.classList.remove('is-resizing')
      window.localStorage.setItem('espow.context.width', String(nextWidth))
    }
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', stop)
  }
  return <div className={`workspace-shell ${contextOpen ? '' : 'context-collapsed'}`} style={{ '--context-width': `${contextWidth}px` } as React.CSSProperties}>
    <main className="work-center">
      <div className="workspace-head"><div className="workspace-heading"><button className="requirement-back" title="返回工作台" onClick={() => state.setView('dashboard')}><ArrowLeft size={15} /><span title={requirement.title}>{requirement.title}</span></button><h2>{currentCapability.label}</h2><p>{currentCapability.detail.replaceAll(' / ', '、')}</p></div><div className="thread-actions"><button className={`context-toggle ${contextOpen ? 'active' : ''}`} aria-controls="requirement-context" aria-expanded={contextOpen} aria-label={contextOpen ? '收起上下文面板' : '展开上下文面板'} title={contextOpen ? '收起上下文面板' : '展开上下文面板'} onClick={toggleContext}>{contextOpen ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}</button></div></div>
      <div className="capability-strip" aria-label="需求生命周期">{workspaceCapabilities.map(({ stage, label, prompt }, index) => { const artifactStatus = requirement.lifecycle.artifacts[index]?.status; const current = index === currentStageIndex; const completed = artifactStatus === 'CONFIRMED' || artifactStatus === 'NOT_APPLICABLE'; const locked = index > currentStageIndex; return <div className={`capability-step ${current ? 'current' : completed ? 'completed' : 'upcoming'}`} key={label}><button aria-current={current ? 'step' : undefined} title={locked ? `请先完成${currentCapability.label}` : undefined} disabled={!thread || state.sending || locked} onClick={() => chooseCapability(prompt)}><span className="step-state">{completed ? <CheckCircle2 size={15} /> : current ? '●' : '○'}</span><strong>{stage === 'PRODUCT_SPEC' ? 'PRD' : label}</strong></button>{index < workspaceCapabilities.length - 1 && <ChevronRight className="step-connector" size={13} />}</div> })}</div>
      <div className={`chat-area ${showFirstGuide ? 'onboarding' : ''}`} ref={chatRef}>
        {!thread && <div className="empty-thread"><MessageSquare size={28} /><h3>这个 Requirement 还没有 Thread</h3><p>创建 Thread 后即可发送任务；每个 Thread 的消息历史互相独立。</p><button className="primary-button" onClick={create}><Plus size={13} />新建 Thread</button></div>}
        {showFirstGuide && <section className="analysis-welcome"><div className="analysis-welcome-top"><div className="analysis-welcome-status"><span className="analysis-welcome-icon"><CheckCircle2 size={16} /></span><p className="eyebrow">需求已创建</p></div><button className="analysis-welcome-close" title="关闭引导" aria-label="关闭引导" onClick={() => { if (firstGuideKey) window.sessionStorage.setItem(`analysis-guide:${firstGuideKey}`, 'dismissed'); setDismissedGuideKey(firstGuideKey) }}><X size={16} /></button></div><h3>接下来完成需求分析</h3><p className="analysis-welcome-detail">可以继续补充需求信息或添加相关附件；确认资料完整后再开始分析。</p><div className="analysis-welcome-actions"><button className="primary-button" disabled={state.sending} onClick={() => void state.sendMessage('开始分析当前需求')}><Bot size={14} />开始分析当前需求</button></div><div className="analysis-secondary-actions"><button onClick={() => setRequirementInfoOpen(true)}>继续新增需求信息</button><button disabled={state.addingSourceInputs} onClick={() => void state.addSourceInputs()}>{state.addingSourceInputs ? <LoaderCircle className="spin" size={13} /> : null}添加参考资料</button></div></section>}
        {thread && !firstGuideAvailable && state.messages.length === 0 && !streaming.length && <div className="empty-thread"><Bot size={28} /><h3>需求分析</h3><p>当前会话已有分析状态，可以继续补充需求信息。</p></div>}
        {state.messages.map((message) => <div className={`message ${message.role}`} key={message.id}><span className="message-avatar">{message.role === 'user' ? 'MY' : message.role === 'system' ? 'SYS' : 'AI'}</span><div className="message-content"><strong className="message-author">{message.role === 'user' ? '用户' : message.role === 'system' ? '系统' : 'ESPow Agent'}</strong>{message.role === 'assistant' && <ExecutionActivityList items={state.messageExecutionActivities[message.id] ?? []} />}<div className={`message-bubble-wrap ${editingMessageId === message.id ? 'editing' : ''}`}>{editingMessageId === message.id ? <div className="message-inline-editor"><textarea ref={messageEditRef} value={editingMessageContent} disabled={state.sending} aria-label="编辑消息内容" onChange={(event) => setEditingMessageContent(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') cancelMessageEdit() }} /><div className="message-inline-actions"><span>重新发送后，将覆盖这条消息之后的记录</span><button type="button" disabled={state.sending} onClick={cancelMessageEdit}>取消</button><button type="button" className="primary" disabled={state.sending || !editingMessageContent.trim()} onClick={() => void submitMessageEdit()}>重新发送</button></div></div> : <><div className={`message-bubble ${message.role === 'assistant' ? 'markdown-body' : ''}`}>{message.role === 'assistant' ? <MarkdownMessage content={message.content} /> : message.content}</div>{message.role === 'assistant' && <DeliveredQuestions questions={message.questions ?? []} />}{message.role === 'user' && hasThreadRun && <button className="message-edit-button" title="编辑并重新发送" aria-label="编辑并重新发送" disabled={state.sending} onClick={() => editMessage(message.id, message.content)}><Pencil size={13} /></button>}</>}</div><small>{new Date(message.createdAt).toLocaleString('zh-CN')}</small></div></div>)}
        {pendingAnalysis?.analysisResult && <div className="message assistant"><span className="message-avatar">AI</span><div><div className="message-bubble"><strong>Requirement Analysis 已就绪</strong><p>{pendingAnalysis.analysisResult.problemDefinition}</p><StageControlActions stageId="requirement-analysis" /></div><small>READY_FOR_CONFIRMATION · 尚未写入 Workspace</small></div></div>}
        {pendingFlow?.flowResult && <div className="message assistant"><span className="message-avatar">FLOW</span><div><div className="message-bubble"><strong>Business Flow HTML Preview 已就绪</strong><p>{pendingFlow.flowResult.flow.scope.goal}</p><button className="secondary-button" onClick={() => { state.selectRun(pendingFlow.id); state.setView('runs') }}>查看流程与 Validator</button><StageControlActions stageId="business-flow" /></div><small>READY_FOR_CONFIRMATION · 尚未写入 Workspace</small></div></div>}
        {pendingSolution?.solutionResult && <div className="message assistant"><span className="message-avatar">SOL</span><div><div className="message-bubble"><strong>Solution Design 已就绪</strong><p>{pendingSolution.solutionResult.solution.overview}</p><button className="secondary-button" onClick={() => { state.selectRun(pendingSolution.id); state.setView('runs') }}>查看能力与 Validator</button><StageControlActions stageId="solution-design" /></div><small>READY_FOR_CONFIRMATION · 尚未写入 Workspace</small></div></div>}
        {pendingInteraction?.interactionResult && <div className="message assistant"><span className="message-avatar">IXD</span><div><div className="message-bubble"><strong>Interaction Design 已就绪</strong><p>{pendingInteraction.interactionResult.interaction.overview}</p><button className="secondary-button" onClick={() => { state.selectRun(pendingInteraction.id); state.setView('runs') }}>查看页面、路径与 Validator</button><StageControlActions stageId="interaction-design" /></div><small>READY_FOR_CONFIRMATION · 尚未写入 Workspace · 不包含 Prototype</small></div></div>}
        {pendingPrototype?.prototypeResult && <div className="message assistant"><span className="message-avatar">HTML</span><div><div className="message-bubble"><strong>Prototype Candidate 已就绪</strong><p>{pendingPrototype.prototypeResult.prototype.name} · {pendingPrototype.prototypeResult.prototype.mode === 'delta' ? 'Existing UI 局部修改' : '全新页面'}</p><button className="secondary-button" onClick={() => { state.selectRun(pendingPrototype.id); state.setView('runs') }}>预览原型与 Validator</button><StageControlActions stageId="prototype" /></div><small>READY_FOR_CONFIRMATION · {pendingPrototype.prototypeResult.htmlPath} · 尚未写入 Workspace</small></div></div>}
        {pendingProductSpec?.productSpecResult && <div className="message assistant"><span className="message-avatar">PRD</span><div><div className="message-bubble"><strong>Product Spec Candidate 已就绪</strong><p>{pendingProductSpec.productSpecResult.productSpec.name} · {pendingProductSpec.productSpecResult.productSpec.capabilities.length} 项功能规格</p><button className="secondary-button" onClick={() => { state.selectRun(pendingProductSpec.id); state.setView('runs') }}>查看 PRD 与 Validator</button><StageControlActions stageId="product-spec" /></div><small>READY_FOR_CONFIRMATION · V{pendingProductSpec.productSpecResult.artifactVersion} · 尚未写入 Workspace</small></div></div>}
        {pendingRequirementReview?.requirementReviewResult && <div className="message assistant"><span className="message-avatar">REV</span><div><div className="message-bubble"><strong>Requirement Review 已完成</strong><p>{pendingRequirementReview.requirementReviewResult.conclusion} · Blockers {pendingRequirementReview.requirementReviewResult.blockerCount} · Warnings {pendingRequirementReview.requirementReviewResult.warningCount} · Info {pendingRequirementReview.requirementReviewResult.infoCount}</p><button className="secondary-button" onClick={() => { state.selectRun(pendingRequirementReview.id); state.setView('runs') }}>查看评审问题与证据</button><StageControlActions stageId="requirement-review" /></div><small>READY_FOR_CONFIRMATION · Review V{pendingRequirementReview.requirementReviewResult.reviewVersion} · 未修改上游 Artifact</small></div></div>}
        {streaming.map(([runId, item]) => <div className="message assistant streaming" key={runId}><span className="message-avatar">AI</span><div className="message-content"><strong className="message-author">ESPow Agent</strong><ExecutionActivityList items={state.executionActivities[runId] ?? []} /><div className={`message-bubble ${item.content ? 'markdown-body' : ''}`}>{item.content ? <MarkdownMessage content={item.content} /> : <span className="streaming-placeholder"><LoaderCircle className="spin" size={12} />Agent 正在处理……</span>}</div><small>Streaming · 正在生成</small></div></div>)}
      </div>
      <Composer inputRef={composerRef} content={composerContent} setContent={setComposerContent} onAddSource={() => void state.addSourceInputs()} stageId={lifecycleStageByWorkspaceStage[requirement.stage]} />
    </main>
    <div className="context-resize-handle" role="separator" aria-orientation="vertical" aria-label="调整上下文宽度" onMouseDown={resizeContext} />
    <RequirementContext requirement={requirement} />
    {requirementInfoOpen && <div className="modal-mask" onMouseDown={(event) => { if (event.target === event.currentTarget && !state.addingRequirementInfo) setRequirementInfoOpen(false) }}><form className="modal requirement-dialog" onSubmit={submitRequirementInfo}><div className="modal-head"><h2>继续新增需求信息</h2><button type="button" className="icon-button" disabled={state.addingRequirementInfo} onClick={() => setRequirementInfoOpen(false)}><X size={18} /></button></div><div className="modal-body"><label>补充内容 <em>必填</em><small>内容将直接保存为需求参考资料，不会调用模型。</small><textarea autoFocus rows={7} value={requirementInfo} placeholder="继续补充业务背景、规则、范围或其他需求信息…" onChange={(event) => setRequirementInfo(event.target.value)} /></label></div><div className="modal-actions"><span>本次操作 0 Token</span><button type="button" className="secondary-button" disabled={state.addingRequirementInfo} onClick={() => setRequirementInfoOpen(false)}>取消</button><button className="primary-button" disabled={state.addingRequirementInfo || !requirementInfo.trim()}>{state.addingRequirementInfo && <LoaderCircle className="spin" size={12} />}保存信息</button></div></form></div>}
  </div>
}

function RequirementContext({ requirement }: { requirement: WorkspaceRequirement }) {
  const { contextTab, setContextTab, openArtifact, runs, updateRequirementSystem } = useAppStore()
  const [availableSystems, setAvailableSystems] = useState<WorkContextSystem[]>([])
  useEffect(() => { void window.espow.workContext.get().then((value) => setAvailableSystems(value.systems.filter((system) => system.active))) }, [])
  const review = runs.find((run) => run.requirementId === requirement.id && run.requirementReviewResult)?.requirementReviewResult ?? null
  const reviewStale = review ? isReviewStale(review, requirement) : false
  const sources = requirement.artifacts.filter(isSourceArtifact)
  const artifacts = requirement.artifacts.filter((artifact) => !isSourceArtifact(artifact))
  return <aside className="context-panel" id="requirement-context">
    <div className="context-summary">
      <div className="context-title"><strong>上下文</strong><small><span className={requirement.error ? 'offline-dot' : 'online-dot'} />自动同步</small></div>
      <label className="requirement-system-binding">所属产品 / 系统<select value={requirement.primarySystemId ?? ''} onChange={(event) => void updateRequirementSystem(requirement.id, event.target.value || null)}><option value="">未设置</option>{availableSystems.map((system) => <option value={system.id} key={system.id}>{system.name}</option>)}</select></label>
      {(requirement.decisions.length > 0 || requirement.openIssues.length > 0) && <div className="context-highlights">{requirement.decisions.length > 0 && <section><strong>已确认</strong>{requirement.decisions.slice(0, 3).map((decision) => <p key={decision.id}>• {decision.title}</p>)}</section>}{requirement.openIssues.length > 0 && <section><strong>待确认</strong>{requirement.openIssues.slice(0, 3).map((issue) => <p key={issue.id}>• {issue.title}</p>)}</section>}</div>}
      {requirement.lifecycle.attention.length > 0 && <div className="lifecycle-attention">{requirement.lifecycle.attention.map((item) => <span key={item.kind}><AlertCircle size={11} />{item.label}</span>)}</div>}
    </div>
    <div className="context-tabs"><button className={contextTab === 'artifacts' ? 'active' : ''} onClick={() => setContextTab('artifacts')}>产物 <em>{artifacts.length}</em></button><button className={contextTab === 'sources' ? 'active' : ''} onClick={() => setContextTab('sources')}>参考资料 <em>{sources.length}</em></button><button className={contextTab === 'issues' ? 'active' : ''} onClick={() => setContextTab('issues')}>未决问题 <em>{requirement.openIssues.length}</em></button><button className={contextTab === 'decisions' ? 'active' : ''} onClick={() => setContextTab('decisions')}>关键决策 <em>{requirement.decisions.length}</em></button><button className={contextTab === 'review' ? 'active' : ''} onClick={() => setContextTab('review')}>评审 <em>{review ? 1 : 0}</em></button></div><div className="context-content">
    {contextTab === 'artifacts' && (artifacts.length ? artifacts.map((artifact) => <button className="context-card" title={artifact.relativePath} key={artifact.id} onClick={() => void openArtifact(requirement.id, artifact.id)}><ArtifactIcon artifact={artifact} /><span><strong>{artifact.title}</strong><small>{artifactStageLabel(artifact)} · {fileTypeLabel(artifact)}</small><em>{artifact.updatedAt}</em></span><ChevronRight size={14} /></button>) : <InlineEmpty text="没有产物。" />)}
    {contextTab === 'sources' && (sources.length ? sources.map((artifact) => <button className="context-card" title={artifact.relativePath} key={artifact.id} onClick={() => void openArtifact(requirement.id, artifact.id)}><ArtifactIcon artifact={artifact} /><span><strong>{sourceTitle(artifact)}</strong><small>{sourceTypeLabel(artifact)} · {fileTypeLabel(artifact)}</small><em>{artifact.updatedAt}</em></span><ChevronRight size={14} /></button>) : <InlineEmpty text="没有参考资料。" />)}
    {contextTab === 'issues' && (requirement.openIssues.length ? requirement.openIssues.map((issue) => <div className="context-card issue" key={issue.id}><AlertCircle size={16} /><span><strong>{issue.id} · {issue.title}</strong><small>{issue.detail || '没有补充说明。'}</small><em>{issue.owner || 'Owner 未标注'}</em></span></div>) : <InlineEmpty text="没有 Open Issue。" />)}
    {contextTab === 'decisions' && (requirement.decisions.length ? requirement.decisions.map((decision) => <div className="context-card decision" key={decision.id}><CheckCircle2 size={16} /><span><strong>{decision.id} · {decision.title}</strong><small>{decision.detail || '没有补充说明。'}</small><em>{decision.date || '日期未标注'}</em></span></div>) : <InlineEmpty text="没有 Decision。" />)}
    {contextTab === 'review' && (review ? <><div className="context-card"><ListChecks size={16} /><span><strong>{reviewStale ? '已过期' : review.conclusion}</strong><small>{reviewStale ? '依赖产物已变化，需要重新评审；旧结论已失效。' : `阻断 ${review.blockerCount} · 警告 ${review.warningCount} · 提示 ${review.infoCount}`}</small><em>{reviewStale ? '已过期' : review.reviewStatus} · V{review.reviewVersion}</em></span></div>{review.review.issues.map((issue) => <div className={`context-card issue review-${issue.severity.toLowerCase()}`} key={issue.id}><AlertCircle size={16} /><span><strong>{issue.id} · {issue.title}</strong><small>{issue.impact}</small><em>{issue.severity} · → {issue.recommendedStage}</em></span></div>)}</> : <InlineEmpty text="尚未执行需求评审。" />)}
    </div>
  </aside>
}

function StatusBadge({ status }: { status: RunRecord['status'] }) { return <span className={`status-badge status-${status.toLowerCase()}`}>{status}</span> }

function FlowResultPanel({ flow }: { flow: NonNullable<RunRecord['flowResult']> }) {
  const [previewOpen, setPreviewOpen] = useState(false)
  const diff = flow.diff
  return <><div className="change-result"><strong>Business Flow</strong><dl><div><dt>Status</dt><dd>{flow.flowStatus}</dd></div><div><dt>Input</dt><dd>{flow.prerequisite}</dd></div><div><dt>Actors</dt><dd>{flow.flow.actors.map((item) => item.name).join('、') || '—'}</dd></div><div><dt>Flow Scope</dt><dd>{flow.flow.scope.goal}</dd></div><div><dt>Open Questions</dt><dd>{flow.flow.openQuestions.join('、') || '—'}</dd></div><div><dt>Validator</dt><dd>{flow.readiness.deterministicPassed && flow.readiness.semanticReady ? 'Passed' : flow.readiness.missing.join('、') || 'Semantic review required'}</dd></div><div><dt>Flow Diff</dt><dd>+Node {diff.addedNodes.length} / -Node {diff.removedNodes.length} / ΔNode {diff.changedNodes.length} · +Edge {diff.addedEdges.length} / -Edge {diff.removedEdges.length} / ΔEdge {diff.changedEdges.length}</dd></div><div><dt>Artifact</dt><dd>{flow.flowStatus === 'CONFIRMED' ? `${flow.modelPath} · ${flow.htmlPath}` : '等待确认'}</dd></div></dl><button className="secondary-button" onClick={() => setPreviewOpen(true)}>预览 HTML 流程</button></div>{previewOpen && <Modal title="Business Flow Preview" onClose={() => setPreviewOpen(false)}><iframe className="html-preview" sandbox="allow-scripts" srcDoc={flow.htmlCandidate} title={flow.flow.name} /><div className="modal-actions"><span>{flow.flowStatus === 'CONFIRMED' ? 'Confirmed Business Flow' : 'Candidate Preview · 尚未写入 Workspace'}</span><button className="secondary-button" onClick={() => setPreviewOpen(false)}>关闭</button></div></Modal>}</>
}

function SolutionResultPanel({ solution }: { solution: NonNullable<RunRecord['solutionResult']> }) {
  return <div className="change-result"><strong>Solution Design</strong><dl>
    <div><dt>Status</dt><dd>{solution.solutionStatus}</dd></div>
    <div><dt>Input</dt><dd>{solution.prerequisite}</dd></div>
    <div><dt>Capabilities</dt><dd>{solution.solution.capabilities.map((item) => `${item.id} · ${item.name}`).join('、') || '—'}</dd></div>
    <div><dt>Rules</dt><dd>{solution.solution.rules.map((item) => item.description).join('、') || '—'}</dd></div>
    <div><dt>States</dt><dd>{solution.solution.states.map((item) => item.name).join('、') || '—'}</dd></div>
    <div><dt>Decisions</dt><dd>{solution.solution.decisions.map((item) => item.question).join('、') || '—'}</dd></div>
    <div><dt>Open Questions</dt><dd>{solution.solution.openQuestions.join('、') || '—'}</dd></div>
    <div><dt>Flow Conflicts</dt><dd>{solution.solution.flowConflicts.join('、') || '—'}</dd></div>
    <div><dt>Coverage</dt><dd>{solution.readiness.coverage.passed ? 'Passed' : solution.readiness.coverage.missing.join('、')}</dd></div>
    <div><dt>Overdesign</dt><dd>{solution.readiness.overdesign.passed ? 'Passed' : solution.readiness.overdesign.missing.join('、')}</dd></div>
    <div><dt>Artifact</dt><dd>{solution.solutionStatus === 'CONFIRMED' ? `${solution.modelPath} · ${solution.markdownPath}` : '等待确认'}</dd></div>
  </dl></div>
}

function InteractionResultPanel({ interaction }: { interaction: NonNullable<RunRecord['interactionResult']> }) {
  return <div className="change-result"><strong>Interaction Design</strong><dl>
    <div><dt>Status</dt><dd>{interaction.interactionStatus}</dd></div>
    <div><dt>Input</dt><dd>{interaction.prerequisite}</dd></div>
    <div><dt>Product Surfaces</dt><dd>{interaction.interaction.surfaces.map((item) => item.name).join('、') || '—'}</dd></div>
    <div><dt>Pages</dt><dd>{interaction.interaction.pages.map((item) => item.name).join('、') || '—'}</dd></div>
    <div><dt>Main User Paths</dt><dd>{interaction.interaction.userPaths.map((item) => item.name).join('、') || '—'}</dd></div>
    <div><dt>States</dt><dd>{interaction.interaction.states.map((item) => item.name).join('、') || '—'}</dd></div>
    <div><dt>Decisions</dt><dd>{interaction.interaction.decisions.map((item) => item.question).join('、') || '—'}</dd></div>
    <div><dt>Open Questions</dt><dd>{interaction.interaction.openQuestions.join('、') || '—'}</dd></div>
    <div><dt>Conflicts</dt><dd>{[...interaction.interaction.solutionConflicts, ...interaction.interaction.flowConflicts].join('、') || '—'}</dd></div>
    <div><dt>Validator</dt><dd>{interaction.readiness.deterministicPassed && interaction.readiness.semanticReady ? 'Passed' : interaction.readiness.missing.join('、') || 'Semantic review required'}</dd></div>
    <div><dt>Artifact</dt><dd>{interaction.interactionStatus === 'CONFIRMED' ? `${interaction.modelPath} · ${interaction.markdownPath}` : '等待确认'}</dd></div>
  </dl></div>
}

function PrototypeResultPanel({ prototype }: { prototype: NonNullable<RunRecord['prototypeResult']> }) {
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewKey, setPreviewKey] = useState(0)
  const value = prototype.prototype
  return <><div className="change-result"><strong>Prototype</strong><dl>
    <div><dt>Status</dt><dd>{prototype.prototypeStatus}</dd></div>
    <div><dt>Mode</dt><dd>{value.mode === 'delta' ? 'Delta / Existing UI First' : 'Create'}</dd></div>
    <div><dt>Input</dt><dd>{prototype.prerequisite}</dd></div>
    <div><dt>UI Reference</dt><dd>{value.existingPrototypePath ?? (value.uiReferencePaths.join('、') || 'ESPow Default Baseline')}</dd></div>
    <div><dt>Output Version</dt><dd>V{value.version}</dd></div>
    <div><dt>Changed</dt><dd>{value.changedComponents.join('、') || '—'}</dd></div>
    <div><dt>Added</dt><dd>{value.addedComponents.join('、') || '—'}</dd></div>
    <div><dt>Removed</dt><dd>{value.removedComponents.join('、') || '—'}</dd></div>
    <div><dt>Interaction / State</dt><dd>{[...value.interactionChanges, ...value.stateChanges].join('、') || '—'}</dd></div>
    <div><dt>Validation</dt><dd>{prototype.readiness.deterministicPassed && prototype.readiness.semanticReady ? 'Ready' : prototype.readiness.missing.join('、') || 'Issues'}</dd></div>
    <div><dt>Artifact</dt><dd>{prototype.htmlPath}</dd></div>
  </dl><details className="prototype-diff"><summary>查看 HTML Diff</summary><pre>{prototype.diff}</pre></details><button className="secondary-button" onClick={() => setPreviewOpen(true)}>打开 Prototype</button></div>{previewOpen && <Modal title={`Prototype Preview · V${value.version}`} onClose={() => setPreviewOpen(false)}><iframe key={previewKey} className="html-preview" sandbox="allow-scripts" srcDoc={prototype.htmlCandidate} title={value.name} /><div className="modal-actions"><span>{prototype.prototypeStatus === 'CONFIRMED' ? 'Confirmed Prototype' : 'Candidate Preview · 尚未写入 Workspace'}</span><button className="secondary-button" onClick={() => setPreviewKey((current) => current + 1)}><RefreshCw size={13} />刷新</button><button className="secondary-button" onClick={() => setPreviewOpen(false)}>关闭</button></div></Modal>}</>
}

function ProductSpecResultPanel({ result }: { result: NonNullable<RunRecord['productSpecResult']> }) {
  const spec = result.productSpec
  const sections = spec.changedSections.length ? spec.changedSections : [
    '文档信息', '业务背景', '目标与价值', '需求范围', '角色与场景', '业务流程', '产品方案', '功能需求',
    ...(spec.pageBehaviors.length ? ['页面与交互'] : []), '业务规则', ...(spec.states.length ? ['状态与状态转换'] : []),
    ...(spec.fields.length ? ['数据 / 字段定义'] : []), ...(spec.failures.length ? ['异常与失败处理'] : []),
    ...(spec.recoveries.length ? ['补偿 / 恢复机制'] : []), ...(spec.permissions.length ? ['权限与操作边界'] : []),
    ...(spec.externalDependencies.length ? ['外部依赖'] : []), 'Open Issues', '验收标准'
  ]
  return <div className="change-result"><strong>Product Spec / PRD</strong><dl>
    <div><dt>Status</dt><dd>{result.productSpecStatus}</dd></div>
    <div><dt>Input</dt><dd>{result.prerequisite}</dd></div>
    <div><dt>Sections Generated</dt><dd>{sections.join('、')}</dd></div>
    <div><dt>Rules</dt><dd>{spec.rules.map((item) => item.id).join('、') || '—'}</dd></div>
    <div><dt>States</dt><dd>{spec.states.map((item) => item.name).join('、') || '—'}</dd></div>
    <div><dt>Open Issues</dt><dd>{spec.openIssues.map((item) => item.id).join('、') || '—'}</dd></div>
    <div><dt>Consistency Issues</dt><dd>{spec.conflicts.map((item) => `${item.id} ${item.type}`).join('、') || '—'}</dd></div>
    <div><dt>Acceptance Criteria</dt><dd>{spec.acceptanceCriteria.map((item) => item.id).join('、') || '—'}</dd></div>
    <div><dt>Validator</dt><dd>{result.readiness.prdReady ? 'Passed' : [...result.readiness.missing, ...result.readiness.warnings].join('、') || 'Issues'}</dd></div>
    <div><dt>Artifact Version</dt><dd>V{result.artifactVersion}</dd></div>
    <div><dt>Artifact</dt><dd>{result.productSpecStatus === 'CONFIRMED' ? `${result.modelPath} · ${result.markdownPath}` : result.markdownPath}</dd></div>
  </dl><details className="prototype-diff"><summary>查看 Markdown Candidate</summary><pre>{result.markdownCandidate}</pre></details></div>
}

function RequirementReviewResultPanel({ result, stale = false }: { result: NonNullable<RunRecord['requirementReviewResult']>; stale?: boolean }) {
  return <div className="change-result"><strong>Requirement Review</strong><dl>
    <div><dt>Result</dt><dd>{stale ? '—（旧结论已失效）' : result.conclusion}</dd></div>
    <div><dt>Status</dt><dd>{stale ? 'STALE' : result.reviewStatus}</dd></div>
    <div><dt>Counts</dt><dd>Blockers {result.blockerCount} · Warnings {result.warningCount} · Info {result.infoCount}</dd></div>
    <div><dt>Artifacts Reviewed</dt><dd>{result.artifactsReviewed.map((path) => <code key={path}>{path}</code>)}</dd></div>
    <div><dt>Open Issues</dt><dd>{result.review.openIssues.join('、') || '—'}</dd></div>
    <div><dt>Review Version</dt><dd>V{result.reviewVersion}</dd></div>
    <div><dt>Gate</dt><dd>{result.readiness.deterministicPassed ? 'Passed' : result.readiness.missing.join('、')}</dd></div>
  </dl>{result.review.issues.map((issue) => <details className="prototype-diff" key={issue.id}><summary>{issue.severity} · {issue.id} · {issue.title}</summary><p>{issue.description}</p><p>影响：{issue.impact}</p><p>建议阶段：{issue.recommendedStage}</p><pre>{issue.evidence.map((item) => `${item.artifactPath} · ${item.reference}\n${item.excerpt}`).join('\n\n')}</pre></details>)}<details className="prototype-diff"><summary>查看 Requirement Review Artifact</summary><pre>{result.markdownCandidate}</pre></details></div>
}

function RunsPage() {
  const { workspace, runs, selectedRunId, selectRun, threads } = useAppStore()
  const selected = runs.find((run) => run.id === selectedRunId) ?? null
  const nameOfRequirement = (id: string) => workspace?.requirements.find((item) => item.id === id)?.title ?? id
  return <div className="page-scroll standard-page">{!workspace ? <EmptyState title="尚未选择 Workspace" detail="选择 Workspace 后可查看本机保存的 Run。" /> : !runs.length ? <EmptyState title="没有执行 Run" detail="在任意 Thread 中发送消息后，会产生真实的 Script 或模型执行 Run。" /> : <div className="runs-layout"><div className="large-list">{runs.map((run) => <button className={`run-row ${selected?.id === run.id ? 'active' : ''}`} key={run.id} onClick={() => selectRun(run.id)}><span className="large-icon blue"><Activity /></span><div className="large-copy"><div className="run-top"><code>{run.id.slice(0, 8)}</code><StatusBadge status={run.status} /></div><h3>{run.task}</h3><p>{nameOfRequirement(run.requirementId)} · {run.threadTitle ?? threads.find((item) => item.id === run.threadId)?.title ?? run.threadId}</p><small>{run.provider ?? 'Script / Runtime'} · {run.model ?? '0 Token'} · 开始 {new Date(run.startedAt).toLocaleString('zh-CN')} · 完成 {run.finishedAt ? new Date(run.finishedAt).toLocaleString('zh-CN') : '—'}</small></div></button>)}</div>{selected && <RunDetail run={selected} requirement={nameOfRequirement(selected.requirementId)} onClose={() => selectRun(null)} />}</div>}</div>
}

function RunDetail({ run, requirement, onClose }: { run: RunRecord; requirement: string; onClose: () => void }) {
  const requirementRecord = useAppStore((state) => state.workspace?.requirements.find((item) => item.id === run.requirementId))
  const [runtimeEvents, setRuntimeEvents] = useState<RunEventRecord[]>([])
  useEffect(() => {
    let active = true
    void window.espow.persistence.listRunEvents(run.id).then((events) => {
      if (active) setRuntimeEvents(events)
    }).catch(() => { if (active) setRuntimeEvents([]) })
    return () => { active = false }
  }, [run.id])
  const skillLabel = run.skill === 'requirement-change' ? '需求变更 (requirement-change)'
    : run.skill === 'requirement-analysis' ? '需求分析 (requirement-analysis)'
      : run.skill === 'business-flow' ? '业务流程 (business-flow)'
        : run.skill === 'solution-design' ? '方案设计 (solution-design)'
          : run.skill === 'interaction-design' ? '交互设计 (interaction-design)'
            : run.skill === 'prototype' ? '页面原型 (prototype)'
              : run.skill === 'product-spec' ? '产品需求文档 (product-spec)'
                : run.skill === 'requirement-review' ? '需求评审 (requirement-review)' : run.skill
  const facts: [string, React.ReactNode][] = [['Status', <StatusBadge status={run.status} />], ['Runtime', run.runtimeType === 'espow-runtime' ? 'ESPow Runtime' : '—'], ['Turn ID', run.turnId ?? '—'], ['Runtime Events', run.runtimeEvents.length ? run.runtimeEvents.join(' → ') : '—'], ['Provider', run.provider ?? '—'], ['Model', run.model ?? '—'], ['Requirement', requirement], ['Thread', run.threadTitle ?? run.threadId], ['Task', run.task], ['Skill', skillLabel ? `${skillLabel} @ ${run.skillVersion ?? '未记录'}` : '—'], ['Tools', run.tools.length ? run.tools.map((item) => <code key={item}>{item}</code>) : '—'], ['Read Files', run.readFiles.length ? run.readFiles.map((item) => <code key={item}>{item}</code>) : '—'], ['Changed Files', run.changedFiles.length ? run.changedFiles.map((item) => <code key={item}>{item}</code>) : '—'], ['Error', run.error ?? '—']]
  const result = run.changeResult
  const analysis = run.analysisResult
  const flow = run.flowResult
  const solution = run.solutionResult
  const interaction = run.interactionResult
  const prototype = run.prototypeResult
  const productSpec = run.productSpecResult
  const review = run.requirementReviewResult
  const context = run.context
  if (context?.workContext) facts.push(['Work Context', <>{context.workContext.used ? 'Yes' : 'No'} · {context.workContext.reason}{context.workContext.sources.length ? <small>{context.workContext.sources.join('、')} · Relations {context.workContext.relationCount}</small> : null}</>])
  if (runtimeEvents.length) facts.push(['Event Store', <div className="event-store-list">{runtimeEvents.map((event) => <span key={event.id}><code>{event.eventType}</code><small>{new Date(event.createdAt).toLocaleTimeString('zh-CN')}</small></span>)}</div>])
  if (productSpec) facts.push(['Product Spec', <ProductSpecResultPanel result={productSpec} />])
  if (review) facts.push(['Requirement Review', <RequirementReviewResultPanel result={review} stale={requirementRecord ? isReviewStale(review, requirementRecord) : false} />])
  return <aside className="detail-drawer"><div className="drawer-head"><div><span>RUN DETAIL</span><h2>{run.id.slice(0, 8)}</h2></div><button className="icon-button" onClick={onClose}><X size={14} /></button></div><dl className="run-facts">{facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>{context && <section className="run-context"><strong>Context</strong><dl><div><dt>Level</dt><dd><span className={`context-level level-${context.level.toLowerCase()}`}>{context.level}</span></dd></div><div><dt>Snapshot</dt><dd>{context.snapshot ? <>{context.snapshot.name}<small>{context.snapshot.refreshedForRun ? '本次已刷新' : '复用有效快照'} · {new Date(context.snapshot.refreshedAt).toLocaleString('zh-CN')}</small></> : '—'}</dd></div><div><dt>Artifacts Read</dt><dd>{context.artifacts.length ? context.artifacts.map((item) => <code key={`${item.path}-${item.section ?? ''}`}>{item.path}{item.section ? ` # ${item.section}` : ''}</code>) : '—'}</dd></div><div><dt>Decisions</dt><dd>{context.decisions.map((item) => item.id).join('、') || '—'}</dd></div><div><dt>Open Issues</dt><dd>{context.openIssues.map((item) => item.id).join('、') || '—'}</dd></div><div><dt>Skill</dt><dd>{context.skill ? `${context.skill.id} @ ${context.skill.version}` : '—'}</dd></div></dl></section>}{analysis && <div className="change-result"><strong>Requirement Analysis</strong><dl><div><dt>Status</dt><dd>{analysis.analysisStatus}</dd></div><div><dt>Problem</dt><dd>{analysis.problemDefinition}</dd></div><div><dt>Actors</dt><dd>{analysis.actors.map((item) => item.name).join('、') || '—'}</dd></div><div><dt>Scenarios</dt><dd>{analysis.scenarios.length}</dd></div><div><dt>Blockers</dt><dd>{analysis.blockers.map((item) => item.description).join('、') || '—'}</dd></div><div><dt>Open Questions</dt><dd>{analysis.openQuestions.join('、') || '—'}</dd></div><div><dt>Ready Gate</dt><dd>{analysis.readiness.deterministicPassed && analysis.readiness.semanticReady ? 'Passed' : analysis.readiness.missing.join('、') || 'Semantic review required'}</dd></div><div><dt>Artifact</dt><dd>{analysis.analysisStatus === 'Confirmed' ? analysis.artifactPath : '等待确认'}</dd></div></dl></div>}{flow && <FlowResultPanel flow={flow} />}{solution && <SolutionResultPanel solution={solution} />}{interaction && <InteractionResultPanel interaction={interaction} />}{prototype && <PrototypeResultPanel prototype={prototype} />}{result && <div className="change-result"><strong>Change Result</strong><dl><div><dt>Result</dt><dd>{result.status}</dd></div><div><dt>Change</dt><dd>{result.changeSummary}</dd></div><div><dt>Impact</dt><dd>{result.impactAssessment}</dd></div><div><dt>Affected</dt><dd>{result.affectedArtifacts.length ? result.affectedArtifacts.map((item) => item.path ?? item.type).join('、') : '—'}</dd></div><div><dt>Checked / Unchanged</dt><dd>{result.unaffectedArtifacts.length ? result.unaffectedArtifacts.map((item) => item.path ?? item.type).join('、') : '—'}</dd></div><div><dt>Open Questions</dt><dd>{result.openQuestions.join('、') || '—'}</dd></div><div><dt>Decisions Affected</dt><dd>{result.decisionsAffected.map((item) => `${item.id}${item.conflict ? ' (Conflict)' : ''}`).join('、') || '—'}</dd></div><div><dt>Candidate Changes</dt><dd>{result.candidateChanges.map((item) => item.path).join('、') || '—'}</dd></div><div><dt>Final Changes</dt><dd>{result.finalChanges.join('、') || '—'}</dd></div><div><dt>Validation</dt><dd>{result.validationResult ?? '—'}</dd></div></dl></div>}{run.toolCalls.length > 0 && <div className="tool-call-list"><strong>真实 Tool Calls</strong>{run.toolCalls.map((call) => <div key={call.id}><span>{call.status === 'Completed' ? '✓' : call.status === 'Failed' ? '×' : '○'} <code>{call.name}</code></span><em>{call.status}</em>{call.error && <small>{call.error}</small>}</div>)}</div>}{run.approval && <div className="run-approval-summary"><strong>Artifact Diff</strong><code>{run.approval.sourcePath}</code><span>{run.approval.status}</span></div>}</aside>
}

function ModelSettingsPage() {
  const { modelSettings, loadModelSettings } = useAppStore()
  const [provider, setProvider] = useState<ModelProviderId>('openai')
  const [draft, setDraft] = useState<ModelConfigDraft>({ provider: 'openai', apiKey: '', model: '', baseUrl: '' })
  const [showKey, setShowKey] = useState(false)
  const [busy, setBusy] = useState<'test' | 'save' | null>(null)
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null)

  useEffect(() => { if (modelSettings) setProvider(modelSettings.activeProvider) }, [modelSettings?.activeProvider])
  useEffect(() => {
    const config = modelSettings?.configs[provider]
    if (config) setDraft({ provider, apiKey: '', model: config.model, baseUrl: config.baseUrl })
  }, [provider, modelSettings?.configs])
  const update = (field: 'apiKey' | 'model' | 'baseUrl', value: string) =>
    setDraft((current) => ({ ...current, [field]: value }))
  const test = async () => {
    setBusy('test')
    setResult(null)
    try {
      setResult(await window.espow.model.testConnection(draft))
    } catch (error) {
      setResult({ success: false, message: error instanceof Error ? error.message : '连接测试失败。' })
    } finally {
      setBusy(null)
    }
  }
  const save = async () => {
    setBusy('save')
    setResult(null)
    try {
      await window.espow.model.saveConfig(draft)
      await loadModelSettings()
      setDraft((current) => ({ ...current, apiKey: '' }))
      setResult({ success: true, message: '配置已保存到本机。' })
    } catch (error) {
      setResult({ success: false, message: error instanceof Error ? error.message : '保存模型配置失败。' })
    } finally {
      setBusy(null)
    }
  }
  const activeConfig = modelSettings?.configs[provider]
  return <div className="settings-content-stack"><section className="settings-card">
    <div className="settings-heading"><span className="metric-icon blue"><KeyRound size={17} /></span><div><h2>Agent 模型配置</h2><p>配置 Agent 使用的模型 Provider；密钥仅保存在 Desktop 本地应用数据中。</p></div></div>
    <div className="provider-switch">{(['openai', 'deepseek'] as const).map((id) => <button className={provider === id ? 'active' : ''} key={id} onClick={() => { setProvider(id); setResult(null) }}>{id === 'openai' ? 'OpenAI' : 'DeepSeek'}</button>)}</div>
    <label>API Key<div className="secret-input"><input type={showKey ? 'text' : 'password'} value={draft.apiKey} autoComplete="off" placeholder={activeConfig?.apiKeyPreview ?? '输入 API Key'} onChange={(event) => update('apiKey', event.target.value)} /><button type="button" title={showKey ? '隐藏 API Key' : '显示 API Key'} onClick={() => setShowKey((value) => !value)}>{showKey ? <EyeOff size={14} /> : <Eye size={14} />}</button></div><small>{activeConfig?.apiKeyConfigured ? '已配置密钥；留空将继续使用当前密钥。' : 'BYOK：使用你自己的 Provider 账号与额度。'}</small></label>
    <label>Model<input value={draft.model} onChange={(event) => update('model', event.target.value)} placeholder="输入模型名称" /><small>模型名称可手工填写，不由业务逻辑写死。</small></label>
    <label>Base URL<input value={draft.baseUrl} onChange={(event) => update('baseUrl', event.target.value)} placeholder="https://…" /></label>
    {result && <div className={`connection-result ${result.success ? 'success' : 'failure'}`}>{result.success ? <CheckCircle2 size={15} /> : <AlertCircle size={15} />}<span>{result.message}</span></div>}
    <div className="settings-actions"><button className="secondary-button" disabled={Boolean(busy)} onClick={() => void test()}>{busy === 'test' && <LoaderCircle className="spin" size={12} />}测试连接</button><button className="primary-button" disabled={Boolean(busy)} onClick={() => void save()}>{busy === 'save' && <LoaderCircle className="spin" size={12} />}保存配置</button></div>
  </section></div>
}

function AgentRuntimePage() {
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus | null>(null)

  useEffect(() => { void window.espow.runtime.getStatus().then(setRuntimeStatus) }, [])

  return <div className="settings-content-stack"><section className="settings-card">
    <div className="settings-heading"><span className="metric-icon green"><Bot size={17} /></span><div><h2>Agent Runtime 版本</h2><p>查看本机 Agent Runtime 的版本、运行状态与当前执行信息。</p></div></div>
    <dl className="run-facts runtime-facts">
      <div><dt>Runtime</dt><dd>{runtimeStatus?.label ?? 'ESPow Runtime'}</dd></div>
      <div><dt>Status</dt><dd><span className={runtimeStatus?.status === 'running' ? 'online-dot' : 'offline-dot'} /> {runtimeStatus?.status ?? 'stopped'}</dd></div>
      <div><dt>Version</dt><dd>{runtimeStatus?.version ?? '0.1.0'}</dd></div>
      <div><dt>Active Run</dt><dd>{runtimeStatus?.activeRunId ?? '—'}</dd></div>
      {runtimeStatus?.error && <div><dt>Error</dt><dd>{runtimeStatus.error}</dd></div>}
    </dl>
  </section></div>
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1).replace(/\.0$/, '')}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1).replace(/\.0$/, '')}K`
  return value.toLocaleString('zh-CN')
}

const tokenSourceLabels: Record<import('./tokenUsage').ContextSource, string> = {
  system: 'System', tools: 'Tools', skill: 'Skill', workspace: 'Workspace', stage_slot: 'Stage Slot', mainline: 'Mainline', working: 'Working',
  artifact: 'Artifact', history: 'History', user: 'User', other: 'Other'
}

function TokenConsumptionPage({ currentWorkspaceId }: { currentWorkspaceId: string | null }) {
  const [workspaces, setWorkspaces] = useState<TokenUsageWorkspace[]>([])
  const [workspaceId, setWorkspaceId] = useState(currentWorkspaceId ?? '')
  const [summary, setSummary] = useState<TokenUsageSummary | null>(null)
  const [selectedStage, setSelectedStage] = useState<TokenStageId | null>(null)
  const [selectedTurnId, setSelectedTurnId] = useState<string | null>(null)
  const [selectedCallId, setSelectedCallId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.espow.tokenUsage.listWorkspaces().then((items) => {
      setWorkspaces(items)
      setWorkspaceId((current) => items.some((item) => item.id === current) ? current : items[0]?.id ?? '')
    }).catch((loadError: unknown) => {
      setError(loadError instanceof Error ? loadError.message : '无法读取 Workspace 列表。')
      setLoading(false)
    })
  }, [])
  useEffect(() => {
    if (!workspaceId) {
      setSummary(null)
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    void window.espow.tokenUsage.getSummary(workspaceId).then((next) => {
      setSummary(next)
      setSelectedStage((current) => next.stages.some((stage) => stage.stage === current) ? current : next.stages[0]?.stage ?? null)
      setSelectedTurnId((current) => next.observability.turns.some((turn) => turn.id === current) ? current : next.observability.turns[0]?.id ?? null)
      setSelectedCallId(null)
    }).catch((loadError: unknown) => {
      setError(loadError instanceof Error ? loadError.message : '无法读取 Token 消耗数据。')
      setSummary(null)
    }).finally(() => setLoading(false))
  }, [workspaceId])

  const detail = summary?.stages.find((stage) => stage.stage === selectedStage) ?? null
  const stageTurns = useMemo(() => {
    if (!detail) return []
    const groups = new Map<string, typeof detail.calls>()
    for (const call of detail.calls) {
      const key = call.turnId ?? call.originalRunId ?? call.runId ?? call.id
      groups.set(key, [...(groups.get(key) ?? []), call])
    }
    const turns = [...groups.entries()].map(([runId, calls]) => {
      const ordered = [...calls].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      const firstInput = ordered[0]?.inputTokens ?? 0
      const lastInput = ordered.at(-1)?.inputTokens ?? 0
      const totalInput = ordered.reduce((sum, call) => sum + call.inputTokens, 0)
      const maxInput = Math.max(...ordered.map((call) => call.inputTokens), 0)
      return {
        runId, calls: ordered.length, totalInput, maxInput,
        avgInput: ordered.length ? Math.round(totalInput / ordered.length) : 0,
        growth: firstInput ? lastInput / firstInput : 0,
        historyTokens: ordered[0]?.historyTokens ?? 0,
        historyGrowth: ordered[0]?.historyGrowth ?? 0,
        createdAt: ordered[0]?.createdAt ?? ''
      }
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    return turns.slice(0, 8)
  }, [detail])
  const selectedTurn = summary?.observability.turns.find((turn) => turn.id === selectedTurnId) ?? null
  const selectedCall = detail?.calls.find((call) => call.id === selectedCallId) ?? null
  const selectedCallTurn = selectedCall ? summary?.observability.turns.find((turn) => turn.calls.some((call) => call.id === selectedCall.id)) ?? null : null
  const selectFirstTurn = (predicate: (turn: TokenUsageSummary['observability']['turns'][number]) => boolean): void => {
    const turn = summary?.observability.turns.find(predicate)
    if (turn) setSelectedTurnId(turn.id)
  }
  const selectedWorkspace = workspaces.find((workspace) => workspace.id === workspaceId)
  return <div className="token-page">
    <div className="token-page-head"><div><h2>Token 统计看板</h2><p>查看当前工作区不同执行阶段的 Token 使用与确定性执行比例。</p></div><label>Workspace<select value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}>{workspaces.map((workspace) => <option value={workspace.id} key={workspace.id}>{workspace.name}</option>)}</select></label></div>
    {selectedWorkspace && <div className="token-workspace-path" title={selectedWorkspace.path}><FolderKanban size={13} />{selectedWorkspace.path}</div>}
    {loading ? <div className="token-loading"><LoaderCircle className="spin" size={20} />正在读取本地 Token 记录…</div> : error ? <div className="token-error"><AlertCircle size={18} />{error}</div> : !summary || (!summary.callCount && !summary.observability.turnCount) ? <div className="token-empty"><BarChart3 size={28} /><h3>暂无执行数据</h3><p>执行 Agent 任务后，这里会自动记录 Runtime Trace 与 Token 使用情况。</p></div> : <>
      <section className="token-metrics"><div><span>总 Token</span><strong>{formatTokens(summary.totalTokens)}</strong></div><div><span>Input Token</span><strong>{formatTokens(summary.inputTokens)}</strong></div><div><span>Output Token</span><strong>{formatTokens(summary.outputTokens)}</strong></div><div><span>模型调用</span><strong>{summary.callCount.toLocaleString('zh-CN')} <small>次</small></strong></div><div><span>脚本执行</span><strong>{summary.scriptRunCount.toLocaleString('zh-CN')} <small>次 · 0 Token</small></strong></div><div><span>确定性执行率</span><strong>{summary.deterministicExecutionRate.toFixed(0)}<small>%</small></strong></div></section>
      <section className="token-section"><div className="token-section-head"><div><h3>阶段消耗</h3><p>按 ESPow Work 实际执行流程统计</p></div></div><div className="stage-bars">{summary.stages.map((stage) => <button className={selectedStage === stage.stage ? 'active' : ''} key={stage.stage} onClick={() => setSelectedStage(stage.stage)} title={`Input ${formatTokens(stage.inputTokens)} · Output ${formatTokens(stage.outputTokens)} · ${stage.callCount} 次调用`}><strong>{stage.label}</strong><span className="stage-track"><i style={{ width: `${Math.max(stage.percentage, 1)}%` }} /></span><em>{formatTokens(stage.totalTokens)}</em><small>{Math.round(stage.percentage)}%</small></button>)}</div></section>
      <section className="token-section runtime-overview"><div className="token-section-head"><div><h3>Agent Runtime 概览</h3><p>直接聚合 Event Store；未知字段不在界面推断</p></div></div><div className="runtime-overview-grid">
        <div className="runtime-card"><strong>Router</strong>{summary.observability.router.map((item) => <button key={item.key} onClick={() => selectFirstTurn((turn) => turn.executionPath === item.key)}><span>{item.key}</span><b>{item.count} Turn</b><em>{item.percentage.toFixed(0)}%</em></button>)}</div>
        <div className="runtime-card runtime-context-card"><strong>Context Mode</strong>{summary.observability.contextModes.map((item) => <button key={item.key} onClick={() => selectFirstTurn((turn) => turn.contextMode === item.key)}><span>{item.key}</span><b>{item.count} · {formatTokens(item.inputTokens ?? 0)} in</b><em>Avg {formatTokens(item.averageInputTokens ?? 0)}</em></button>)}</div>
        <div className="runtime-card"><strong>Skill Mode</strong>{summary.observability.skillModes.map((item) => <button key={item.key} onClick={() => selectFirstTurn((turn) => turn.skillMode === item.key)}><span>{item.key}</span><b>{item.count} Turn</b><em>{item.percentage.toFixed(0)}%</em></button>)}<button onClick={() => selectFirstTurn((turn) => Boolean(turn.skillFallbackReason))}><span>Full Fallback</span><b>{summary.observability.turns.filter((turn) => Boolean(turn.skillFallbackReason)).length} Turn</b><em>Event</em></button></div>
        <div className="runtime-card"><strong>Follow-up · {summary.observability.followupRate.toFixed(0)}%</strong>{summary.observability.followupReasons.length ? summary.observability.followupReasons.map((item) => <button key={item.key} onClick={() => selectFirstTurn((turn) => turn.followups.some((followup) => followup.reason === item.key))}><span>{item.key}</span><b>{item.count}</b><em>{item.percentage.toFixed(0)}%</em></button>) : <p>暂无 Follow-up Decision</p>}</div>
        <div className="runtime-card"><strong>LLM Calls / User Turn</strong>{summary.observability.callsPerTurn.map((item) => <button className={item.key === '2' || item.key === '3+' ? 'warn' : ''} key={item.key} onClick={() => selectFirstTurn((turn) => (item.key === '3+' ? turn.llmCalls >= 3 : turn.llmCalls === Number(item.key)))}><span>{item.key} Call</span><b>{item.count} Turn</b><em>{item.percentage.toFixed(0)}%</em></button>)}</div>
      </div></section>
      <section className="token-section turn-observability"><div className="token-section-head"><div><h3>Turn 诊断</h3><p>快速定位执行路径、Context、Skill、Tools 与 Follow-up</p></div></div><div className="turn-observability-layout"><div className="turn-list">{summary.observability.turns.map((turn) => <button className={selectedTurnId === turn.id ? 'active' : ''} key={turn.id} onClick={() => setSelectedTurnId(turn.id)}><code>{turn.id.slice(0, 8)}</code><span className={`path path-${turn.executionPath.toLowerCase()}`}>{turn.executionPath}</span><span>{turn.llmCalls} LLM · {turn.scriptCalls} Script</span><span>{turn.contextMode} · {turn.skillMode}</span><strong>{formatTokens(turn.inputTokens + turn.outputTokens)}</strong></button>)}</div>
        {selectedTurn && <div className="turn-detail"><div className="turn-core-facts"><div><span>Execution Path</span><strong>{selectedTurn.executionPath}</strong></div><div><span>Router Reason</span><strong title={selectedTurn.routerReason ?? ''}>{selectedTurn.routerReason ?? '未记录'}</strong></div><div><span>Stage / Intent</span><strong>{selectedTurn.stage ?? '—'} · {selectedTurn.intent ?? '—'}</strong></div><div><span>LLM / Script</span><strong>{selectedTurn.llmCalls} / {selectedTurn.scriptCalls}</strong></div><div><span>Context Mode</span><strong>{selectedTurn.contextMode}{selectedTurn.contextLevel ? ` · ${selectedTurn.contextLevel}` : ''}</strong></div><div><span>Skill Mode</span><strong>{selectedTurn.skillMode}{selectedTurn.skill ? ` · ${selectedTurn.skill}` : ''}{selectedTurn.skillFallbackReason ? ` · ${selectedTurn.skillFallbackReason}` : ''}</strong></div><div><span>Tools Injected</span><strong>{selectedTurn.toolsInjected.join('、') || 'None / 未记录'}</strong></div><div><span>Follow-up</span><strong>{selectedTurn.followups.some((item) => item.required) ? 'Yes' : 'No'} · {selectedTurn.followups.map((item) => item.reason).join('、') || '未记录'}</strong></div></div>
          <div className="loaded-sections"><strong>Loaded Sections</strong><p>{selectedTurn.contextSources.join(' · ') || 'Event Store 未记录'}</p>{selectedTurn.contextExpansion.length > 0 && <p className="context-expansion">Context Expansion · {selectedTurn.contextExpansion.join(' → ')}</p>}</div>
          <details className="execution-trace" open><summary>Agent Execution Trace</summary><div>{selectedTurn.trace.map((step) => <div className={`trace-step trace-${step.kind}`} key={step.id}><i /><span><strong>{step.label}</strong><small>{step.detail || '—'}</small></span></div>)}</div></details>
        </div>}
      </div></section>
      {detail && <section className="token-section token-detail">
        <div className="token-detail-title"><div><h3>{detail.label}</h3><strong>{formatTokens(detail.totalTokens)} Token</strong></div><dl><div><dt>Input</dt><dd>{formatTokens(detail.inputTokens)}</dd></div><div><dt>Output</dt><dd>{formatTokens(detail.outputTokens)}</dd></div><div><dt>调用次数</dt><dd>{detail.callCount}</dd></div><div><dt>平均每次</dt><dd>{formatTokens(Math.round(detail.totalTokens / detail.callCount))}</dd></div></dl></div>
        {stageTurns.length > 0 && <div className="analysis-token-turns"><div className="analysis-token-turns-head"><strong>Token 趋势</strong><span>History Growth 比较上一有效 LLM Turn，自动跳过 Script Turn</span></div>{stageTurns.map((turn) => <div className="analysis-token-turn" key={turn.runId}><code>{turn.runId.slice(0, 8)}</code><span>{turn.calls} Call</span><span>Input {formatTokens(turn.totalInput)}</span><span>Avg {formatTokens(turn.avgInput)}</span><span>Max {formatTokens(turn.maxInput)}</span><span>Growth {turn.growth ? `${turn.growth.toFixed(2)}×` : '—'}</span><span>History {formatTokens(turn.historyTokens)}</span><strong className={turn.historyGrowth > 1.5 ? 'warn' : ''}>History Growth {turn.historyGrowth ? `${turn.historyGrowth.toFixed(2)}×` : '—'}</strong></div>)}</div>}
        <div className="token-call-table"><div className="token-call-head"><span>时间</span><span>Call / Reason</span><span>Input</span><span>Output</span><span>Total</span></div>{detail.calls.map((call) => <button className={`token-call-row ${selectedCallId === call.id ? 'active' : ''}`} key={call.id} onClick={() => setSelectedCallId((current) => current === call.id ? null : call.id)}><time title={new Date(call.createdAt).toLocaleString('zh-CN')}>{new Date(call.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}</time><span title={`${call.executionContent} · ${call.provider}/${call.model}`}>Call #{call.callIndex} · {call.callReason}</span><em>{formatTokens(call.inputTokens)}</em><em>{formatTokens(call.outputTokens)}</em><strong>{formatTokens(call.totalTokens)}</strong></button>)}</div>
        {selectedCall && <div className="token-call-detail"><div className="token-call-facts"><div><span>Call</span><strong>#{selectedCall.callIndex}</strong></div><div><span>Reason</span><strong>{selectedCall.callReason}</strong></div><div><span>Execution Path</span><strong>{selectedCallTurn?.executionPath ?? selectedCall.routeType.toUpperCase()}</strong></div><div><span>Context Mode</span><strong>{selectedCallTurn?.contextMode ?? '未记录'}</strong></div><div><span>Skill Mode</span><strong>{selectedCallTurn?.skillMode ?? '未记录'}</strong></div><div><span>Tools Injected</span><strong>{selectedCallTurn?.toolsInjected.join('、') || '未记录'}</strong></div><div><span>Triggered By</span><strong>{selectedCall.callReason === 'tool_followup' ? selectedCallTurn?.followups.find((item) => item.required)?.tool ?? 'Tool' : '—'}</strong></div><div><span>Follow-up Source</span><strong>{selectedCall.callReason === 'tool_followup' ? selectedCallTurn?.followups.find((item) => item.required)?.reason ?? '未记录' : '—'}</strong></div><div><span>Model</span><strong>{selectedCall.provider}/{selectedCall.model}</strong></div><div><span>Input</span><strong>{selectedCall.inputTokens.toLocaleString('zh-CN')}</strong></div><div><span>Output</span><strong>{selectedCall.outputTokens.toLocaleString('zh-CN')}</strong></div><div><span>History</span><strong>{selectedCall.historyTokens.toLocaleString('zh-CN')}</strong></div><div><span>Duration</span><strong>{selectedCall.durationMs === null ? '—' : `${selectedCall.durationMs.toLocaleString('zh-CN')} ms`}</strong></div></div>{selectedCallTurn && <div className="loaded-sections compact"><strong>Loaded Sections</strong><p>{selectedCallTurn.contextSources.join(' · ') || 'Event Store 未记录'}</p></div>}<div className="token-breakdown-head"><strong>Input Breakdown · Estimated</strong><span>本地确定性估算 {formatTokens(selectedCall.estimatedInputTokens)}；Provider Input {formatTokens(selectedCall.inputTokens)}</span></div>{selectedCall.inputBreakdown.length ? <div className="token-breakdown">{selectedCall.inputBreakdown.map((item) => <div key={item.source}><span>{tokenSourceLabels[item.source]}</span><i><b style={{ width: `${Math.max(item.percentage, item.tokens ? 1 : 0)}%` }} /></i><em>{formatTokens(item.tokens)}</em><strong>{item.percentage.toFixed(1)}%</strong></div>)}</div> : <p className="token-breakdown-empty">历史记录无 Breakdown；新产生的模型调用将自动记录。</p>}</div>}
      </section>}
    </>}
  </div>
}

const emptyCompanyDraft: Omit<WorkContextCompany, 'updatedAt'> = {
  name: '', industry: '', description: '', coreBusiness: [], regions: [], terms: [], rawContext: ''
}

const emptySystemDraft: SaveSystemInput = {
  name: '', alias: '', type: 'internal', positioning: '', coreUsers: [], coreCapabilities: [], boundary: '', notes: '', active: true
}

function splitItems(value: string): string[] {
  return value.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean)
}

function WorkContextPage() {
  const [section, setSection] = useState<'company' | 'systems' | 'relations'>('company')
  const [data, setData] = useState<WorkContextSnapshot | null>(null)
  const [company, setCompany] = useState(emptyCompanyDraft)
  const [systemDraft, setSystemDraft] = useState<SaveSystemInput | null>(null)
  const [relationDraft, setRelationDraft] = useState<SaveRelationInput | null>(null)
  const [quickCreateSide, setQuickCreateSide] = useState<'source' | 'target' | null>(null)
  const [filterSystemId, setFilterSystemId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.espow.workContext.get().then((snapshot) => {
      setData(snapshot)
      const { updatedAt: _updatedAt, ...draft } = snapshot.company
      setCompany(draft)
    }).catch((loadError: unknown) => setError(loadError instanceof Error ? loadError.message : '无法读取工作上下文。'))
  }, [])
  const run = async (action: () => Promise<WorkContextSnapshot>) => {
    setBusy(true); setError(null)
    try { setData(await action()) } catch (actionError) { setError(actionError instanceof Error ? actionError.message : '操作失败。') }
    finally { setBusy(false) }
  }
  if (!data) return <div className="token-loading"><LoaderCircle className="spin" size={20} />正在读取工作上下文…</div>
  const systemName = (id: string) => data.systems.find((system) => system.id === id)?.name ?? '未知系统'
  const relations = filterSystemId ? data.relations.filter((relation) => relation.sourceSystemId === filterSystemId || relation.targetSystemId === filterSystemId) : data.relations
  const incomingRelations = systemDraft?.id ? data.relations.filter((relation) => relation.targetSystemId === systemDraft.id) : []
  const outgoingRelations = systemDraft?.id ? data.relations.filter((relation) => relation.sourceSystemId === systemDraft.id) : []
  const editSystem = (system: WorkContextSystem) => {
    const { createdAt: _createdAt, updatedAt: _updatedAt, ...draft } = system
    setSystemDraft(draft); setSection('systems')
  }
  const editRelation = (relation: WorkContextSystemRelation) => {
    const { createdAt: _createdAt, updatedAt: _updatedAt, ...draft } = relation
    setRelationDraft(draft)
  }
  return <div className="work-context-page">
    <div className="settings-heading"><span className="metric-icon blue"><Layers3 size={17} /></span><div><h2>业务与系统配置</h2><p>长期保存公司业务、产品 / 系统及上下游关系；Runtime 仅在任务相关时按需注入。</p></div></div>
    <div className="work-context-tabs"><button className={section === 'company' ? 'active' : ''} onClick={() => setSection('company')}>公司信息</button><button className={section === 'systems' ? 'active' : ''} onClick={() => setSection('systems')}>产品 / 系统</button><button className={section === 'relations' ? 'active' : ''} onClick={() => setSection('relations')}>系统关系</button></div>
    {error && <div className="connection-result failure"><AlertCircle size={15} />{error}</div>}
    {section === 'company' && <section className="settings-card work-context-card"><div className="work-context-form-grid">
      <label>公司名称<input value={company.name} onChange={(event) => setCompany({ ...company, name: event.target.value })} /></label>
      <label>所属行业<input value={company.industry} onChange={(event) => setCompany({ ...company, industry: event.target.value })} /></label>
      <label className="wide">公司 / 业务简介<textarea rows={3} value={company.description} onChange={(event) => setCompany({ ...company, description: event.target.value })} /></label>
      <label>核心业务<small>用逗号分隔</small><input value={company.coreBusiness.join('，')} onChange={(event) => setCompany({ ...company, coreBusiness: splitItems(event.target.value) })} /></label>
      <label>业务地区<small>用逗号分隔</small><input value={company.regions.join('，')} onChange={(event) => setCompany({ ...company, regions: splitItems(event.target.value) })} /></label>
      <label className="wide">常用业务术语<small>每行填写“术语：说明”</small><textarea rows={4} value={company.terms.map((item) => `${item.term}：${item.description}`).join('\n')} onChange={(event) => setCompany({ ...company, terms: event.target.value.split(/\n/).map((line) => { const [term, ...description] = line.split(/[：:]/); return { term: term.trim(), description: description.join('：').trim() } }).filter((item) => item.term) })} /></label>
      <label className="wide">补充原始上下文<textarea rows={4} value={company.rawContext} onChange={(event) => setCompany({ ...company, rawContext: event.target.value })} /></label>
    </div><div className="settings-actions"><button className="primary-button" disabled={busy} onClick={() => void run(() => window.espow.workContext.saveCompany(company))}>保存公司信息</button></div></section>}
    {section === 'systems' && <section className="settings-card work-context-card">
      <div className="work-context-toolbar"><div><strong>产品 / 系统</strong><small>{data.systems.length} 个记录</small></div><button className="primary-button" onClick={() => setSystemDraft(emptySystemDraft)}><Plus size={14} />新增系统</button></div>
      <div className="work-context-table system-table"><div className="head"><span>名称</span><span>类型</span><span>定位 / 主要职责</span><span>状态</span><span>操作</span></div>{data.systems.map((system) => <div className="row" key={system.id}><span><strong>{system.name}</strong><small>{system.alias || '—'}</small></span><span>{system.type === 'internal' ? '内部系统' : '外部系统'}</span><span>{system.positioning || '—'}</span><span>{system.active ? '启用' : '停用'}</span><span className="row-actions"><button onClick={() => editSystem(system)}>编辑</button><button onClick={() => void run(() => window.espow.workContext.setSystemActive(system.id, !system.active))}>{system.active ? '停用' : '启用'}</button><button className="danger" onClick={() => { if (window.confirm(`确认删除“${system.name}”？`)) void run(() => window.espow.workContext.deleteSystem(system.id)) }}>删除</button></span></div>)}</div>
      {systemDraft && <div className="work-context-editor"><h3>{systemDraft.id && !quickCreateSide ? '编辑系统' : '新增系统'}</h3><div className="work-context-form-grid"><label>系统名称 *<input value={systemDraft.name} onChange={(event) => setSystemDraft({ ...systemDraft, name: event.target.value })} /></label><label>英文名 / 简称<input value={systemDraft.alias} onChange={(event) => setSystemDraft({ ...systemDraft, alias: event.target.value })} /></label><label>系统类型<select value={systemDraft.type} onChange={(event) => setSystemDraft({ ...systemDraft, type: event.target.value as SaveSystemInput['type'] })}><option value="internal">内部系统</option><option value="external">外部系统</option></select></label><label>产品 / 系统定位<input value={systemDraft.positioning} onChange={(event) => setSystemDraft({ ...systemDraft, positioning: event.target.value })} /></label><label>核心用户<input value={systemDraft.coreUsers.join('，')} onChange={(event) => setSystemDraft({ ...systemDraft, coreUsers: splitItems(event.target.value) })} /></label><label>核心能力<input value={systemDraft.coreCapabilities.join('，')} onChange={(event) => setSystemDraft({ ...systemDraft, coreCapabilities: splitItems(event.target.value) })} /></label><label className="wide">系统边界<textarea rows={2} value={systemDraft.boundary} onChange={(event) => setSystemDraft({ ...systemDraft, boundary: event.target.value })} /></label><label className="wide">补充说明<textarea rows={2} value={systemDraft.notes} onChange={(event) => setSystemDraft({ ...systemDraft, notes: event.target.value })} /></label></div>{systemDraft.id && !quickCreateSide && <div className="system-relation-summary"><strong>与本系统相关的关系</strong><section><span>进入本系统</span>{incomingRelations.length ? incomingRelations.map((relation) => <p key={relation.id}>{systemName(relation.sourceSystemId)} → {relation.relationType === 'OTHER' ? relation.customRelationName : relationTypeLabels[relation.relationType]} → {systemDraft.name}</p>) : <p>暂无</p>}</section><section><span>从本系统出去</span>{outgoingRelations.length ? outgoingRelations.map((relation) => <p key={relation.id}>{systemDraft.name} → {relation.relationType === 'OTHER' ? relation.customRelationName : relationTypeLabels[relation.relationType]} → {systemName(relation.targetSystemId)}</p>) : <p>暂无</p>}</section><button className="secondary-button" onClick={() => { setFilterSystemId(systemDraft.id ?? ''); setRelationDraft({ sourceSystemId: systemDraft.id ?? '', relationType: 'PROVIDE_DATA', customRelationName: '', targetSystemId: data.systems.find((system) => system.active && system.id !== systemDraft.id)?.id ?? '', description: '' }); setSystemDraft(null); setSection('relations') }}><Plus size={13} />新增关系</button></div>}<div className="settings-actions"><button className="secondary-button" onClick={() => { setSystemDraft(null); if (quickCreateSide) setSection('relations'); setQuickCreateSide(null) }}>取消</button><button className="primary-button" disabled={busy || !systemDraft.name.trim()} onClick={() => void run(async () => { const next = await window.espow.workContext.saveSystem(systemDraft); if (quickCreateSide && systemDraft.id) setRelationDraft((current) => current ? { ...current, [quickCreateSide === 'source' ? 'sourceSystemId' : 'targetSystemId']: systemDraft.id! } : current); setSystemDraft(null); if (quickCreateSide) setSection('relations'); setQuickCreateSide(null); return next })}>{quickCreateSide ? '保存并选择' : '保存'}</button></div></div>}
    </section>}
    {section === 'relations' && <section className="settings-card work-context-card">
      <div className="work-context-toolbar"><div><strong>系统关系</strong><small>底层事实始终为 source → relation → target</small></div><div className="toolbar-actions"><select value={filterSystemId} onChange={(event) => setFilterSystemId(event.target.value)}><option value="">全部系统</option>{data.systems.map((system) => <option value={system.id} key={system.id}>{system.name}</option>)}</select><button className="primary-button" disabled={data.systems.length < 2} onClick={() => setRelationDraft({ sourceSystemId: data.systems[0]?.id ?? '', relationType: 'PROVIDE_DATA', customRelationName: '', targetSystemId: data.systems[1]?.id ?? '', description: '' })}><Plus size={14} />新增关系</button></div></div>
      <div className="work-context-table relation-table"><div className="head"><span>来源系统</span><span>关系类型</span><span>目标系统</span><span>说明</span><span>操作</span></div>{relations.map((relation) => <div className="row" key={relation.id}><span>{systemName(relation.sourceSystemId)}</span><span>{relation.relationType === 'OTHER' ? relation.customRelationName : relationTypeLabels[relation.relationType]} →</span><span>{systemName(relation.targetSystemId)}</span><span>{relation.description || '—'}</span><span className="row-actions"><button onClick={() => editRelation(relation)}>编辑</button><button className="danger" onClick={() => { if (window.confirm('确认删除这条系统关系？')) void run(() => window.espow.workContext.deleteRelation(relation.id)) }}>删除</button></span></div>)}</div>
      {!data.systems.length && <div className="modal-note">请先新增至少两个产品 / 系统。关系编辑器支持直接跳转新增系统。</div>}
      {relationDraft && <div className="work-context-editor"><h3>{relationDraft.id ? '编辑系统关系' : '新增系统关系'}</h3><div className="work-context-form-grid"><label>来源系统 *<select value={relationDraft.sourceSystemId} onChange={(event) => setRelationDraft({ ...relationDraft, sourceSystemId: event.target.value })}>{data.systems.filter((system) => system.active).map((system) => <option value={system.id} key={system.id}>{system.name}</option>)}</select></label><label>关系类型 *<select value={relationDraft.relationType} onChange={(event) => setRelationDraft({ ...relationDraft, relationType: event.target.value as SaveRelationInput['relationType'] })}>{Object.entries(relationTypeLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><label>目标系统 *<select value={relationDraft.targetSystemId} onChange={(event) => setRelationDraft({ ...relationDraft, targetSystemId: event.target.value })}>{data.systems.filter((system) => system.active).map((system) => <option value={system.id} key={system.id}>{system.name}</option>)}</select></label>{relationDraft.relationType === 'OTHER' && <label>自定义关系名称 *<input value={relationDraft.customRelationName} onChange={(event) => setRelationDraft({ ...relationDraft, customRelationName: event.target.value })} /></label>}<label className="wide">关系说明<textarea rows={2} value={relationDraft.description} onChange={(event) => setRelationDraft({ ...relationDraft, description: event.target.value })} /></label></div><div className="settings-actions"><button className="secondary-button" onClick={() => { setQuickCreateSide('source'); setSystemDraft({ ...emptySystemDraft, id: `system-${crypto.randomUUID()}` }); setSection('systems') }}>+ 新增来源系统</button><button className="secondary-button" onClick={() => { setQuickCreateSide('target'); setSystemDraft({ ...emptySystemDraft, id: `system-${crypto.randomUUID()}` }); setSection('systems') }}>+ 新增目标系统</button><button className="secondary-button" onClick={() => setRelationDraft(null)}>取消</button><button className="primary-button" disabled={busy || relationDraft.sourceSystemId === relationDraft.targetSystemId || (relationDraft.relationType === 'OTHER' && !relationDraft.customRelationName.trim())} onClick={() => void run(async () => { const next = await window.espow.workContext.saveRelation(relationDraft); setRelationDraft(null); return next })}>保存</button></div></div>}
    </section>}
  </div>
}


function ProductDocumentTemplatePage() {
  return <div className="settings-content-stack"><section className="settings-card">
    <div className="settings-heading"><span className="metric-icon blue"><FileText size={17} /></span><div><h2>产品文档模板</h2><p>统一管理产品文档输出入口；当前版本继续复用既有 Product Spec / PRD 生命周期模板，不复制另一套文档链路。</p></div></div>
    <div className="template-summary-grid"><div><span>默认模板</span><strong>ESPow Product Spec / PRD</strong></div><div><span>使用范围</span><strong>Requirement Workspace</strong></div><div><span>版本策略</span><strong>沿用现有版本化 Artifact</strong></div></div>
    <div className="modal-note">本次改造仅统一设置入口名称与顺序；不改变现有 Product Spec Skill、PRD 版本规则和 Requirement 生命周期。</div>
  </section></div>
}

const pagePatternLabels: Record<string, string> = { list: '列表', detail: '详情', form: '表单', dashboard: 'Dashboard', modal: '弹窗', drawer: '抽屉' }
const componentLabels: Record<string, string> = { button: 'Button', input: 'Input', select: 'Select', search: 'Search / Filter', table: 'Table', pagination: 'Pagination', tabs: 'Tabs', tag: 'Tag / Status', form: 'Form', modal: 'Modal', drawer: 'Drawer', card: 'Card', header: 'Header', sidebar: 'Sidebar / Navigation' }

function PrototypeStylePage() {
  const [state, setState] = useState<PrototypeStyleState | null>(null)
  const [url, setUrl] = useState('')
  const [name, setName] = useState('公司后台默认样式')
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [preview, setPreview] = useState<string | null>(null)

  const refresh = async () => {
    const next = await window.espow.prototypeStyle.getState()
    setState(next)
    if (!url && next.learning.sourceUrl) setUrl(next.learning.sourceUrl)
    if (next.baseline.name) setName(next.baseline.name)
    return next
  }
  useEffect(() => { void refresh() }, [])
  useEffect(() => {
    if (state?.learning.status !== 'learning') return
    const timer = window.setInterval(() => { void refresh() }, 2200)
    return () => window.clearInterval(timer)
  }, [state?.learning.status])
  const run = async (key: string, action: () => Promise<PrototypeStyleState>) => {
    setBusy(key); setMessage(null)
    try { setState(await action()) }
    catch (error) { setMessage(error instanceof Error ? error.message : '操作失败。') }
    finally { setBusy(null) }
  }
  const showPreview = async () => {
    setBusy('preview'); setMessage(null)
    try {
      const result = await window.espow.prototypeStyle.getPreview()
      if (!result.html) setMessage(result.error ?? '暂无可预览内容。')
      else setPreview(result.html)
    } catch (error) { setMessage(error instanceof Error ? error.message : '预览失败。') }
    finally { setBusy(null) }
  }
  if (!state) return <div className="token-loading"><LoaderCircle className="spin" size={20} />正在读取原型样式配置…</div>
  const coverage = state.learning.coverage
  const learnedPatterns = Object.entries(coverage.pagePatterns).filter(([, covered]) => covered)
  const missingPatterns = Object.entries(coverage.pagePatterns).filter(([, covered]) => !covered)
  const learnedComponents = Object.entries(coverage.components).filter(([, covered]) => covered)
  const learningActive = state.learning.status === 'learning'
  const canResume = Boolean(state.learning.sourceUrl) && ['interrupted', 'candidate-ready'].includes(state.learning.status)
  return <div className="settings-content-stack prototype-style-page">
    <section className="settings-card">
      <div className="settings-heading"><span className="metric-icon blue"><SquareStack size={17} /></span><div><h2>原型样式配置</h2><p>通过浏览公司现有后台系统自动学习 UI 风格，保存为后续 HTML Prototype 的默认 UI Baseline。</p></div></div>
      <div className="prototype-summary-grid">
        <div><span>当前样式</span><strong>{state.baseline.name ?? '未配置'}</strong></div>
        <div><span>配置状态</span><strong>{state.baseline.configured ? '已配置' : '未配置'}</strong></div>
        <div><span>已学习页面</span><strong>{state.baseline.learnedPageCount}</strong></div>
        <div><span>页面模式</span><strong>{state.baseline.patternCount}</strong></div>
        <div><span>组件类型</span><strong>{state.baseline.componentCount}</strong></div>
        <div><span>最后更新</span><strong>{state.baseline.updatedAt ? new Date(state.baseline.updatedAt).toLocaleString('zh-CN') : '—'}</strong></div>
      </div>
      <div className="settings-actions"><button className="secondary-button" disabled={!state.baseline.configured || busy === 'preview'} onClick={() => void showPreview()}><Eye size={13} />预览效果</button><button className="primary-button" onClick={() => document.getElementById('ui-learning-entry')?.scrollIntoView({ behavior: 'smooth' })}>{state.baseline.configured ? '重新学习' : '学习现有系统'}</button></div>
    </section>

    <section className="settings-card" id="ui-learning-entry">
      <div className="settings-heading"><span className="metric-icon green"><Eye size={17} /></span><div><h2>学习现有系统</h2><p>ESPow 指路，你正常浏览。登录、验证码、MFA、SSO 都在目标系统自己的页面完成。</p></div></div>
      <div className="ui-learning-security">不提供账号密码输入框；不读取 Authorization Header、接口 Request/Response Body 或完整网络日志。登录态仅保存在本机独立浏览器分区。</div>
      {!learningActive && <div className="ui-learning-form"><label>样式名称<input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：催收后台默认样式" /></label><label>内部系统地址<input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://internal.example.com" /></label><div className="settings-actions">{canResume && <button className="secondary-button" disabled={Boolean(busy)} onClick={() => void run('resume', () => window.espow.prototypeStyle.openLearningBrowser())}>继续上次学习</button>}<button className="primary-button" disabled={Boolean(busy) || !url.trim()} onClick={() => void run('start', () => window.espow.prototypeStyle.startLearning({ url, name }))}>{busy === 'start' && <LoaderCircle className="spin" size={12} />}开始学习</button></div></div>}
      {learningActive && <div className="ui-learning-active"><div><span className="learning-live"><i />正在自动学习</span><strong>{state.learning.learnedPageCount} 个页面样本</strong><p>{state.learning.message ?? '请像平时一样浏览几个常用页面。'}</p></div><div className="settings-actions"><button className="secondary-button" disabled={Boolean(busy)} onClick={() => void run('open', () => window.espow.prototypeStyle.openLearningBrowser())}>打开学习浏览器</button><button className="secondary-button" disabled={Boolean(busy)} onClick={() => void run('stop', () => window.espow.prototypeStyle.stopLearning())}>暂停</button><button className="primary-button" disabled={Boolean(busy) || state.learning.learnedPageCount === 0} onClick={() => void run('finish', () => window.espow.prototypeStyle.finishLearning())}>{busy === 'finish' && <LoaderCircle className="spin" size={12} />}现在完成</button></div></div>}
      {state.learning.learnedPageCount > 0 && <div className="coverage-panel"><div className="coverage-head"><div><strong>{coverage.summary}</strong><span>已学习：{learnedPatterns.map(([id]) => pagePatternLabels[id] ?? id).join('、') || '—'}</span></div>{coverage.nextSuggestion && <p>{coverage.nextSuggestion}</p>}</div><div className="coverage-chips">{learnedPatterns.map(([id]) => <span className="done" key={id}>✓ {pagePatternLabels[id] ?? id}</span>)}{missingPatterns.slice(0, 3).map(([id]) => <span key={id}>○ {pagePatternLabels[id] ?? id}</span>)}</div><details><summary>查看高级信息</summary><div className="coverage-components">{Object.entries(componentLabels).map(([id, label]) => <span className={coverage.components[id as keyof typeof coverage.components] ? 'done' : ''} key={id}>{coverage.components[id as keyof typeof coverage.components] ? '✓' : '○'} {label}</span>)}</div><p>采集只保留结构化样式统计、布局边界与脱敏参考截图，不保存整页 DOM 或网络业务数据。</p></details></div>}
    </section>

    {state.candidate && <section className="settings-card candidate-card"><div className="settings-heading"><span className="metric-icon green"><CheckCircle2 size={17} /></span><div><h2>UI Baseline 候选已生成</h2><p>{state.candidate.learnedPageCount} 个页面 · {state.candidate.patternCount} 种页面模式 · {state.candidate.componentCount} 类组件</p></div></div><div className="settings-actions"><button className="secondary-button" disabled={Boolean(busy)} onClick={() => void run('resume', () => window.espow.prototypeStyle.openLearningBrowser())}>返回继续采集</button><button className="secondary-button" disabled={busy === 'preview'} onClick={() => void showPreview()}><Eye size={13} />预览效果</button><button className="primary-button" disabled={Boolean(busy)} onClick={() => void run('save', () => window.espow.prototypeStyle.saveCandidate())}>{busy === 'save' && <LoaderCircle className="spin" size={12} />}保存为当前原型样式</button></div></section>}
    {message && <div className="connection-result failure"><AlertCircle size={15} />{message}</div>}
    {preview && <Modal title="UI Baseline Preview" onClose={() => setPreview(null)}><iframe className="html-preview ui-baseline-preview" sandbox="" srcDoc={preview} title="UI Baseline Preview" /><div className="modal-actions"><span>预览使用示例数据，不展示内部系统真实业务数据。</span><button className="secondary-button" onClick={() => setPreview(null)}>关闭</button></div></Modal>}
  </div>
}

function DiagnosticPage() {
  const [summary, setSummary] = useState<DiagnosticSummary | null>(null)
  const [busy, setBusy] = useState<'remote' | 'export' | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  useEffect(() => { void window.espow.diagnostic.getSummary().then(setSummary) }, [])
  if (!summary) return <div className="token-loading"><LoaderCircle className="spin" size={20} />正在读取诊断状态…</div>
  const toggleRemote = async (enabled: boolean) => {
    setBusy('remote'); setMessage(null)
    try { setSummary(await window.espow.diagnostic.setRemoteReporting(enabled)) }
    catch (error) { setMessage(error instanceof Error ? error.message : '无法更新远程上报设置。') }
    finally { setBusy(null) }
  }
  const exportBundle = async () => {
    setBusy('export'); setMessage(null)
    try {
      const result = await window.espow.diagnostic.exportBundle()
      if (result.error) setMessage(`导出失败：${result.error}`)
      else if (!result.canceled) setMessage(`诊断包已导出：${result.path}`)
    } finally { setBusy(null) }
  }
  return <div className="settings-content-stack"><section className="settings-card diagnostic-card">
    <div className="settings-heading"><span className="metric-icon blue"><ShieldCheck size={17} /></span><div><h2>系统运行诊断</h2><p>仅记录技术诊断信息，不包含 Prompt、聊天正文、附件内容或 API Key。</p></div></div>
    <div className="diagnostic-grid">
      <div><span>App Version</span><strong>{summary.appVersion}</strong></div><div><span>Runtime Version</span><strong>{summary.runtimeVersion}</strong></div>
      <div><span>OS</span><strong>{summary.os}</strong></div><div><span>Architecture</span><strong>{summary.arch}</strong></div>
      <div><span>Database Status</span><strong>{summary.databaseStatus}</strong></div><div><span>Runtime Status</span><strong>{summary.runtimeStatus}</strong></div>
      <div><span>Local Logging</span><strong>{summary.localLogging ? '已启用' : '已关闭'}</strong></div><div><span>Remote Reporter</span><strong>{summary.remoteReporterConfigured ? '已配置' : '未配置'}</strong></div>
    </div>
    <label className="diagnostic-toggle"><input type="checkbox" checked={summary.remoteReporting} disabled={!summary.remoteReporterConfigured || busy === 'remote'} onChange={(event) => void toggleRemote(event.target.checked)} /><span>自动发送匿名崩溃报告<small>{summary.remoteReporterConfigured ? '仅错误与最近动作；开启后才会发送。' : '当前构建未配置 Sentry DSN，远程上报不可用。'}</small></span></label>
    <div className="diagnostic-last"><strong>最近错误</strong>{summary.lastError ? <p><code>{summary.lastError.errorCode ?? 'UNCLASSIFIED'}</code> {summary.lastError.errorMessage}<small>{new Date(summary.lastError.timestamp).toLocaleString('zh-CN')} · {summary.lastError.layer}</small></p> : <p>本次启动后暂无错误。</p>}</div>
    {message && <div className="connection-result success">{message}</div>}
    <div className="settings-actions"><button className="secondary-button" onClick={() => void window.espow.diagnostic.openLogs()}><FolderOpen size={13} />打开日志目录</button><button className="primary-button" disabled={busy === 'export'} onClick={() => void exportBundle()}>{busy === 'export' ? <LoaderCircle className="spin" size={13} /> : <Download size={13} />}导出诊断包</button></div>
  </section></div>
}

function SettingsModal({ onClose, currentWorkspaceId }: { onClose: () => void; currentWorkspaceId: string | null }) {
  const [tab, setTab] = useState<'model' | 'work-context' | 'prototype-style' | 'document-template' | 'diagnostic' | 'token' | 'runtime'>('model')
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', close)
    return () => document.removeEventListener('keydown', close)
  }, [onClose])
  return <div className="modal-mask settings-mask" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section className="modal settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title"><div className="modal-head"><h2 id="settings-title">设置</h2><button className="icon-button" title="关闭设置" onClick={onClose}><X size={18} /></button></div><div className="settings-layout"><nav className="settings-nav" aria-label="设置菜单">
    <button className={tab === 'model' ? 'active' : ''} onClick={() => setTab('model')}><KeyRound size={16} />Agent 模型配置</button>
    <button className={tab === 'work-context' ? 'active' : ''} onClick={() => setTab('work-context')}><Layers3 size={16} />业务与系统配置</button>
    <button className={tab === 'prototype-style' ? 'active' : ''} onClick={() => setTab('prototype-style')}><SquareStack size={16} />原型样式配置</button>
    <button className={tab === 'document-template' ? 'active' : ''} onClick={() => setTab('document-template')}><FileText size={16} />产品文档模板</button>
    <button className={tab === 'diagnostic' ? 'active' : ''} onClick={() => setTab('diagnostic')}><ShieldCheck size={16} />系统运行诊断</button>
    <button className={tab === 'token' ? 'active' : ''} onClick={() => setTab('token')}><BarChart3 size={16} />Token 统计看板</button>
    <button className={tab === 'runtime' ? 'active' : ''} onClick={() => setTab('runtime')}><Bot size={16} />Agent Runtime 版本</button>
  </nav><main className="settings-main">{tab === 'model' ? <ModelSettingsPage /> : tab === 'work-context' ? <WorkContextPage /> : tab === 'prototype-style' ? <PrototypeStylePage /> : tab === 'document-template' ? <ProductDocumentTemplatePage /> : tab === 'diagnostic' ? <DiagnosticPage /> : tab === 'token' ? <TokenConsumptionPage currentWorkspaceId={currentWorkspaceId} /> : <AgentRuntimePage />}</main></div></section></div>
}
function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) { return <div className="modal-mask" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><div className="modal artifact-modal"><div className="modal-head"><h2>{title}</h2><button className="icon-button" onClick={onClose}><X size={18} /></button></div>{children}</div></div> }

function RequirementDialog() {
  const { requirementDialogOpen, creatingRequirement, closeRequirementDialog, createRequirement } = useAppStore()
  const [name, setName] = useState('')
  const [initialRequest, setInitialRequest] = useState('')
  const [primarySystemId, setPrimarySystemId] = useState('')
  const [systems, setSystems] = useState<WorkContextSystem[]>([])
  useEffect(() => {
    if (requirementDialogOpen) {
      setName(''); setInitialRequest(''); setPrimarySystemId('')
      void window.espow.workContext.get().then((value) => setSystems(value.systems.filter((system) => system.active)))
    }
  }, [requirementDialogOpen])
  if (!requirementDialogOpen) return null
  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    if (name.trim()) void createRequirement({ name, initialRequest, primarySystemId: primarySystemId || null })
  }
  return <div className="modal-mask" onMouseDown={(event) => { if (event.target === event.currentTarget) closeRequirementDialog() }}><form className="modal requirement-dialog" onSubmit={submit}>
    <div className="modal-head"><h2>新增需求</h2><button type="button" className="icon-button" disabled={creatingRequirement} onClick={closeRequirementDialog}><X size={18} /></button></div>
    <div className="modal-body">
      <label>需求名称 <em>必填</em><input autoFocus maxLength={120} value={name} placeholder="例如：多国催收 DeviceConnect Voice 能力" onChange={(event) => setName(event.target.value)} /></label>
      <label>所属产品 / 系统 <small>可选，后续可修改。</small><select value={primarySystemId} onChange={(event) => setPrimarySystemId(event.target.value)}><option value="">未设置</option>{systems.map((system) => <option value={system.id} key={system.id}>{system.name}</option>)}</select></label>
      <label>原始需求描述 <small>可选，仅作为 Initial Request / Source Input 保存，不代表已确认的需求分析。</small><textarea rows={6} value={initialRequest} placeholder="输入最初的业务背景、问题或想法…" onChange={(event) => setInitialRequest(event.target.value)} /></label>
      <div className="modal-note">系统将初始化最小 Requirement Workspace，并创建默认 Thread“需求分析”。不会自动调用模型或生成 PRD。</div>
    </div>
    <div className="modal-actions"><button type="button" className="secondary-button" disabled={creatingRequirement} onClick={closeRequirementDialog}>取消</button><button className="primary-button" disabled={creatingRequirement || !name.trim()}>{creatingRequirement && <LoaderCircle className="spin" size={12} />}创建需求</button></div>
  </form></div>
}

function ArtifactPreview() {
  const { preview, previewLoading, closeArtifact } = useAppStore()
  const [previewKey, setPreviewKey] = useState(0)
  if (previewLoading) return <Modal title="Artifact Preview" onClose={closeArtifact}><div className="preview-loading"><LoaderCircle className="spin" size={22} />正在读取真实文件…</div></Modal>
  if (!preview) return null
  if (!preview.artifact || preview.content === null) return <Modal title="Artifact Preview" onClose={closeArtifact}><div className="preview-error"><AlertCircle size={20} />{preview.error ?? 'Artifact 无法读取。'}</div></Modal>
  const artifact = preview.artifact
  const trustedInteractiveHtml = /^flows\/business-flow-v\d+\.html$/i.test(artifact.relativePath)
    || /^prototype\/.+-v\d+\.html$/i.test(artifact.relativePath)
  return <Modal title="Artifact Preview" onClose={closeArtifact}><div className="artifact-preview-head"><ArtifactIcon artifact={artifact} /><div><h3>{artifact.title}</h3><code>{artifact.relativePath}</code></div><span>Read only</span></div>{artifact.format === 'html' ? <iframe key={previewKey} className="html-preview" sandbox={trustedInteractiveHtml ? 'allow-scripts' : ''} srcDoc={preview.content} title={artifact.title} /> : artifact.format === 'image' ? <div className="image-preview"><img src={preview.content} alt={artifact.title} /></div> : <pre className="artifact-preview markdown-document">{preview.content}</pre>}<div className="modal-actions"><span>最后更新：{artifact.updatedAt}</span>{artifact.format === 'html' && <button className="secondary-button" onClick={() => setPreviewKey((current) => current + 1)}><RefreshCw size={13} />刷新</button>}<button className="secondary-button" onClick={closeArtifact}>关闭</button></div></Modal>
}

function ApprovalModal({ run }: { run: RunRecord }) {
  const { resolveApproval, approvalBusy } = useAppStore()
  const approval = run.approval
  if (!approval || approval.status !== 'Pending') return null
  return <Modal title="确认 Artifact 候选修改" onClose={() => undefined}>
    <div className="diff-meta"><span><FileText size={15} />{approval.sourcePath}</span><em>WaitingConfirmation</em></div>
    <div className="approval-sections">变更章节：{approval.diff.changedSections.join('、') || '未识别'}</div>
    <pre className="approval-diff">{approval.diff.diff}</pre>
    <div className="modal-actions"><span>确认后将{approval.writeMode === 'overwrite' ? '覆盖原文件' : '创建新版本'}、原子写入并校验；取消不会改变 Workspace。</span><button className="secondary-button danger" disabled={approvalBusy} onClick={() => void resolveApproval(run.id, false)}>取消修改</button><button className="primary-button" disabled={approvalBusy} onClick={() => void resolveApproval(run.id, true)}>{approvalBusy && <LoaderCircle className="spin" size={12} />}确认修改</button></div>
  </Modal>
}

function Toast() { const { toast, setToast } = useAppStore(); useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(null), 2200); return () => window.clearTimeout(timer) }, [toast, setToast]); return toast ? <div className="toast"><CheckCircle2 size={16} />{toast}</div> : null }

export default function App() {
  const state = useAppStore()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => window.localStorage.getItem('espow.sidebar.collapsed') === 'true')
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const stored = Number(window.localStorage.getItem('espow.sidebar.width'))
    return Number.isFinite(stored) && stored >= 220 && stored <= 360 ? stored : 260
  })
  useEffect(() => {
    void state.initializeWorkspace()
    void state.loadModelSettings()
    return window.espow.model.onEvent((event) => useAppStore.getState().handleModelEvent(event))
  }, [])
  const requirement = state.workspace?.requirements.find((item) => item.id === state.activeRequirementId)
  const approvalRun = state.runs.find((run) => run.status === 'WaitingConfirmation' && run.approval?.status === 'Pending')
  const pageTitle = state.view === 'workspace' ? requirement?.title ?? 'Requirement' : ({
    dashboard: '工作台',
    todo: '待我处理',
    runs: 'Agent Runs'
  } as const)[state.view as 'dashboard' | 'todo' | 'runs']
  const toggleSidebar = () => setSidebarCollapsed((collapsed) => {
    window.localStorage.setItem('espow.sidebar.collapsed', String(!collapsed))
    return !collapsed
  })
  const resizeSidebar = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = sidebarWidth
    let nextWidth = startWidth
    document.body.classList.add('is-resizing')
    const move = (moveEvent: MouseEvent) => {
      nextWidth = Math.min(360, Math.max(220, startWidth + moveEvent.clientX - startX))
      setSidebarWidth(nextWidth)
    }
    const stop = () => {
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', stop)
      document.body.classList.remove('is-resizing')
      window.localStorage.setItem('espow.sidebar.width', String(nextWidth))
    }
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', stop)
  }
  const visiblePageTitle = state.view === 'workspace' ? '需求工作区' : pageTitle
  return <div className="app-shell"><div className="titlebar"><strong className="titlebar-page">{visiblePageTitle}</strong><span className="titlebar-workspace" title={state.workspace?.rootPath}><span className={state.workspace ? 'online-dot' : 'offline-dot'} />{state.workspace?.name ?? 'No Workspace'}</span></div><div className={`app-frame ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`} style={{ '--sidebar-width': `${sidebarWidth}px` } as React.CSSProperties}><Sidebar collapsed={sidebarCollapsed} onToggle={toggleSidebar} onResizeStart={resizeSidebar} onOpenSettings={() => setSettingsOpen(true)} /><section className={`main-shell ${state.error ? 'has-error' : ''}`}>{state.error && <div className="global-error"><AlertCircle size={14} />{state.error}</div>}{state.view === 'dashboard' && <Dashboard />}{state.view === 'todo' && <TodoPage />}{state.view === 'runs' && <RunsPage />}{state.view === 'workspace' && (requirement ? <WorkspacePage requirement={requirement} /> : <EmptyState title="Requirement 不存在" detail="它可能已被移动或删除，请刷新 Workspace。" />)}</section></div>{settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} currentWorkspaceId={state.workspace?.id ?? null} />}{(state.preview || state.previewLoading) && <ArtifactPreview />}{approvalRun && <ApprovalModal run={approvalRun} />}<RequirementDialog /><Toast /></div>
}
