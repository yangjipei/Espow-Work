import { create } from 'zustand'
import type { ContextTab, View } from './types'
import type { MessageRecord, RunRecord, ThreadRecord } from './persistence'
import type { ExecutionActivity, ModelSettings, ModelStreamEvent, RuntimeControlEvent } from './model'
import type { LifecycleStageId } from './lifecycleStageState'
import type { ArtifactContentResult, CreateRequirementInput, WorkspaceResult, WorkspaceSnapshot } from './workspace'

interface PersistedWorkspaceState {
  activeRequirementId: string | null
  activeThreadId: string | null
  threads: ThreadRecord[]
  messages: MessageRecord[]
  runs: RunRecord[]
}

interface AppState extends PersistedWorkspaceState {
  view: View
  contextTab: ContextTab
  workspace: WorkspaceSnapshot | null
  preview: ArtifactContentResult | null
  loading: boolean
  sending: boolean
  activeRunId: string | null
  streamingResponses: Record<string, { threadId: string; content: string }>
  executionActivities: Record<string, ExecutionActivity[]>
  messageExecutionActivities: Record<string, ExecutionActivity[]>
  modelSettings: ModelSettings | null
  previewLoading: boolean
  approvalBusy: boolean
  requirementDialogOpen: boolean
  creatingRequirement: boolean
  addingSourceInputs: boolean
  addingRequirementInfo: boolean
  error: string | null
  toast: string | null
  selectedRunId: string | null
  initializeWorkspace: () => Promise<void>
  loadModelSettings: () => Promise<void>
  chooseWorkspace: () => Promise<void>
  refreshWorkspace: () => Promise<void>
  openRequirementDialog: () => void
  closeRequirementDialog: () => void
  createRequirement: (input: CreateRequirementInput) => Promise<boolean>
  renameRequirement: (requirementId: string, name: string) => Promise<boolean>
  deleteRequirement: (requirementId: string) => Promise<boolean>
  updateRequirementSystem: (requirementId: string, primarySystemId: string | null) => Promise<void>
  addSourceInputs: () => Promise<void>
  addRequirementInfo: (content: string) => Promise<boolean>
  setView: (view: View) => void
  openRequirement: (requirementId: string) => Promise<void>
  createThread: (title: string) => Promise<boolean>
  openThread: (threadId: string) => Promise<void>
  renameThread: (threadId: string, title: string) => Promise<void>
  deleteThread: (threadId: string) => Promise<void>
  sendMessage: (content: string, replaceMessageId?: string, slotTarget?: { stageId: LifecycleStageId; slotId: string }, controlEvent?: RuntimeControlEvent) => Promise<boolean>
  sendControlEvent: (event: RuntimeControlEvent) => Promise<boolean>
  stopGeneration: () => Promise<void>
  handleModelEvent: (event: ModelStreamEvent) => void
  selectRun: (runId: string | null) => void
  setContextTab: (tab: ContextTab) => void
  openArtifact: (requirementId: string, artifactId: string) => Promise<void>
  closeArtifact: () => void
  resolveApproval: (runId: string, approved: boolean) => Promise<void>
  setToast: (message: string | null) => void
}

const emptyPersistedState: PersistedWorkspaceState = {
  activeRequirementId: null, activeThreadId: null, threads: [], messages: [], runs: []
}

async function loadPersistedState(workspace: WorkspaceSnapshot): Promise<PersistedWorkspaceState> {
  const selection = await window.espow.persistence.getSelection(workspace.id)
  const requirementId = workspace.requirements.some((item) => item.id === selection.requirementId)
    ? selection.requirementId : workspace.requirements[0]?.id ?? null
  const runs = await window.espow.persistence.listRuns(workspace.id)
  if (!requirementId) return { ...emptyPersistedState, runs }
  const threads = await window.espow.persistence.listThreads(workspace.id, requirementId)
  const activeThreadId = threads.some((item) => item.id === selection.threadId) ? selection.threadId : threads[0]?.id ?? null
  const messages = activeThreadId ? await window.espow.persistence.listMessages(activeThreadId) : []
  await window.espow.persistence.setActiveRequirement(workspace.id, requirementId)
  if (activeThreadId) await window.espow.persistence.setActiveThread(workspace.id, requirementId, activeThreadId)
  return { activeRequirementId: requirementId, activeThreadId, threads, messages, runs }
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

export const useAppStore = create<AppState>((set, get) => ({
  view: 'dashboard', contextTab: 'artifacts', workspace: null, ...emptyPersistedState,
  preview: null, loading: true, sending: false, activeRunId: null, streamingResponses: {}, executionActivities: {}, messageExecutionActivities: {}, modelSettings: null,
  previewLoading: false, approvalBusy: false, error: null, toast: null, selectedRunId: null,
  requirementDialogOpen: false, creatingRequirement: false, addingSourceInputs: false, addingRequirementInfo: false,
  initializeWorkspace: async () => {
    set({ loading: true, error: null })
    try {
      const result = await window.espow.workspace.getRecent()
      if (!result.workspace) {
        set({ workspace: null, ...emptyPersistedState, loading: false, error: result.error ?? null })
        return
      }
      const persisted = await loadPersistedState(result.workspace)
      set({ workspace: result.workspace, ...persisted, loading: false, error: result.error ?? null })
    } catch (error) {
      set({ loading: false, error: errorMessage(error, '无法恢复最近 Workspace。') })
    }
  },
  loadModelSettings: async () => {
    try {
      set({ modelSettings: await window.espow.model.getConfigs() })
    } catch (error) {
      set({ error: errorMessage(error, '无法读取模型配置。') })
    }
  },
  chooseWorkspace: async () => {
    set({ loading: true, error: null })
    try {
      const result = await window.espow.workspace.choose()
      if (result.canceled) return set({ loading: false })
      if (!result.workspace) {
        set({ workspace: null, ...emptyPersistedState, loading: false, error: result.error ?? null })
        return
      }
      const persisted = await loadPersistedState(result.workspace)
      set({ workspace: result.workspace, ...persisted, loading: false, view: 'dashboard', preview: null, selectedRunId: null })
    } catch (error) {
      set({ loading: false, error: errorMessage(error, '无法选择 Workspace。') })
    }
  },
  refreshWorkspace: async () => {
    set({ loading: true, error: null })
    try {
      const result: WorkspaceResult = await window.espow.workspace.refresh()
      if (!result.workspace) return set({ loading: false, error: result.error ?? null })
      const persisted = await loadPersistedState(result.workspace)
      set({ workspace: result.workspace, ...persisted, loading: false, toast: 'Workspace 已刷新' })
    } catch (error) {
      set({ loading: false, error: errorMessage(error, '无法刷新 Workspace。') })
    }
  },
  openRequirementDialog: () => {
    if (get().workspace) set({ requirementDialogOpen: true, error: null })
  },
  closeRequirementDialog: () => {
    if (!get().creatingRequirement) set({ requirementDialogOpen: false })
  },
  createRequirement: async (input) => {
    if (!get().workspace || get().creatingRequirement) return false
    set({ creatingRequirement: true, error: null })
    try {
      const result = await window.espow.workspace.createRequirement(input)
      set({
        workspace: result.workspace,
        activeRequirementId: result.requirement.id,
        activeThreadId: result.thread.id,
        threads: [result.thread],
        messages: [],
        view: 'workspace',
        contextTab: 'artifacts',
        preview: null,
        selectedRunId: null,
        requirementDialogOpen: false,
        creatingRequirement: false,
        toast: 'Requirement 已创建'
      })
      return true
    } catch (error) {
      set({ creatingRequirement: false, error: errorMessage(error, '无法创建 Requirement。') })
      return false
    }
  },
  renameRequirement: async (requirementId, name) => {
    try {
      const result = await window.espow.workspace.renameRequirement(requirementId, name)
      set({ workspace: result.workspace, toast: 'Requirement 已重命名', error: null })
      return true
    } catch (error) {
      set({ error: errorMessage(error, '无法重命名 Requirement。') })
      return false
    }
  },
  deleteRequirement: async (requirementId) => {
    try {
      const result = await window.espow.workspace.deleteRequirement(requirementId)
      const deletingActive = get().activeRequirementId === requirementId
      const runs = await window.espow.persistence.listRuns(result.workspace.id)
      set({
        workspace: result.workspace,
        runs,
        ...(deletingActive ? {
          ...emptyPersistedState,
          runs,
          view: 'dashboard' as const,
          contextTab: 'artifacts' as const,
          preview: null,
          selectedRunId: null,
          sending: false,
          activeRunId: null,
          streamingResponses: {},
          executionActivities: {},
          messageExecutionActivities: {}
        } : {}),
        toast: 'Requirement 已彻底删除',
        error: null
      })
      return true
    } catch (error) {
      set({ error: errorMessage(error, '无法删除 Requirement。') })
      return false
    }
  },
  updateRequirementSystem: async (requirementId, primarySystemId) => {
    try {
      const workspace = await window.espow.workspace.updateRequirementSystem(requirementId, primarySystemId)
      set({ workspace, toast: '所属产品 / 系统已更新', error: null })
    } catch (error) {
      set({ error: errorMessage(error, '无法更新所属产品 / 系统。') })
    }
  },
  addSourceInputs: async () => {
    const requirementId = get().activeRequirementId
    if (!requirementId || get().addingSourceInputs) return
    set({ addingSourceInputs: true, error: null })
    try {
      const result = await window.espow.workspace.addSourceInputs(requirementId)
      if (result.canceled) return set({ addingSourceInputs: false })
      set({
        workspace: result.workspace ?? get().workspace,
        addingSourceInputs: false,
        contextTab: 'sources',
        toast: `已添加 ${result.added.length} 份参考资料`
      })
    } catch (error) {
      set({ addingSourceInputs: false, error: errorMessage(error, '无法添加参考资料。') })
    }
  },
  addRequirementInfo: async (content) => {
    const requirementId = get().activeRequirementId
    if (!requirementId || get().addingRequirementInfo || !content.trim()) return false
    set({ addingRequirementInfo: true, error: null })
    try {
      const result = await window.espow.workspace.addRequirementInfo(requirementId, content)
      set({ workspace: result.workspace, addingRequirementInfo: false, contextTab: 'sources', toast: '需求信息已补充' })
      return true
    } catch (error) {
      set({ addingRequirementInfo: false, error: errorMessage(error, '无法补充需求信息。') })
      return false
    }
  },
  setView: (view) => set({ view, selectedRunId: view === 'runs' ? get().selectedRunId : null }),
  openRequirement: async (activeRequirementId) => {
    const workspace = get().workspace
    if (!workspace) return
    set({ activeRequirementId, activeThreadId: null, threads: [], messages: [], view: 'workspace', contextTab: 'artifacts', preview: null, error: null })
    try {
      await window.espow.persistence.setActiveRequirement(workspace.id, activeRequirementId)
      const threads = await window.espow.persistence.listThreads(workspace.id, activeRequirementId)
      const selection = await window.espow.persistence.getSelection(workspace.id)
      const activeThreadId = threads.some((item) => item.id === selection.threadId) ? selection.threadId : threads[0]?.id ?? null
      const messages = activeThreadId ? await window.espow.persistence.listMessages(activeThreadId) : []
      if (activeThreadId) await window.espow.persistence.setActiveThread(workspace.id, activeRequirementId, activeThreadId)
      set({ threads, activeThreadId, messages })
    } catch (error) {
      set({ error: errorMessage(error, '无法读取 Thread。') })
    }
  },
  createThread: async (title) => {
    const { workspace, activeRequirementId } = get()
    if (!workspace || !activeRequirementId) return false
    try {
      const thread = await window.espow.persistence.createThread(workspace.id, activeRequirementId, title)
      set({ threads: [thread, ...get().threads], activeThreadId: thread.id, messages: [], toast: 'Thread 已创建' })
      return true
    } catch (error) {
      set({ error: errorMessage(error, '无法创建 Thread。') })
      return false
    }
  },
  openThread: async (activeThreadId) => {
    const { workspace, activeRequirementId } = get()
    if (!workspace || !activeRequirementId) return
    set({ activeThreadId, messages: [], error: null })
    try {
      await window.espow.persistence.setActiveThread(workspace.id, activeRequirementId, activeThreadId)
      set({ messages: await window.espow.persistence.listMessages(activeThreadId) })
    } catch (error) {
      set({ error: errorMessage(error, '无法读取消息历史。') })
    }
  },
  renameThread: async (threadId, title) => {
    try {
      const thread = await window.espow.persistence.renameThread(threadId, title)
      set({ threads: get().threads.map((item) => item.id === thread.id ? thread : item), toast: 'Thread 已重命名' })
    } catch (error) {
      set({ error: errorMessage(error, '无法重命名 Thread。') })
    }
  },
  deleteThread: async (threadId) => {
    try {
      await window.espow.persistence.deleteThread(threadId)
      const threads = get().threads.filter((item) => item.id !== threadId)
      const activeThreadId = get().activeThreadId === threadId ? threads[0]?.id ?? null : get().activeThreadId
      const messages = activeThreadId ? await window.espow.persistence.listMessages(activeThreadId) : []
      const { workspace, activeRequirementId } = get()
      if (workspace && activeRequirementId && activeThreadId) await window.espow.persistence.setActiveThread(workspace.id, activeRequirementId, activeThreadId)
      set({ threads, activeThreadId, messages, toast: 'Thread 已删除' })
    } catch (error) {
      set({ error: errorMessage(error, '无法删除 Thread。') })
    }
  },
  sendMessage: async (content, replaceMessageId, slotTarget, controlEvent) => {
    const { workspace, activeRequirementId, activeThreadId } = get()
    if (!workspace || !activeRequirementId || !activeThreadId || get().sending) return false
    set({ sending: true, error: null })
    try {
      const started = await window.espow.model.startChat({
        workspaceId: workspace.id, requirementId: activeRequirementId, threadId: activeThreadId, content, replaceMessageId, slotTarget, controlEvent
      })
      const refreshed = replaceMessageId ? await Promise.all([
        window.espow.persistence.listMessages(activeThreadId),
        window.espow.persistence.listRuns(workspace.id)
      ]) : null
      set((state) => {
        const existingRun = state.runs.find((run) => run.id === started.run.id)
        const alreadyFinished = started.run.status !== 'Running'
        return {
          messages: refreshed ? refreshed[0] : state.activeThreadId === activeThreadId && !state.messages.some((message) => message.id === started.message.id)
            ? [...state.messages, started.message] : state.messages,
          runs: refreshed ? refreshed[1] : existingRun ? state.runs.map((run) => run.id === started.run.id ? started.run : run) : [started.run, ...state.runs],
          sending: alreadyFinished ? false : state.sending,
          activeRunId: alreadyFinished ? null : started.run.id,
          streamingResponses: alreadyFinished ? state.streamingResponses : {
            ...state.streamingResponses,
            [started.run.id]: state.streamingResponses[started.run.id] ?? { threadId: activeThreadId, content: '' }
          },
          executionActivities: alreadyFinished ? state.executionActivities : { [started.run.id]: [] }
        }
      })
      return true
    } catch (error) {
      set({ sending: false, activeRunId: null, error: errorMessage(error, '模型调用失败。') })
      return false
    }
  },
  sendControlEvent: async (event) => {
    const labels: Record<RuntimeControlEvent['type'], string> = {
      CONFIRM_STAGE: '确认当前阶段', REJECT_STAGE: '重新调整当前阶段', CONTINUE_STAGE: '继续下一阶段'
    }
    return get().sendMessage(labels[event.type], undefined, undefined, event)
  },
  stopGeneration: async () => {
    const runId = get().activeRunId
    if (!runId) return
    try {
      await window.espow.model.cancelChat(runId)
    } catch (error) {
      set({ error: errorMessage(error, '无法停止当前回复。') })
    }
  },
  handleModelEvent: (event) => {
    set((state) => {
    if (event.type === 'activity') {
      const existing = state.executionActivities[event.runId] ?? []
      const index = existing.findIndex((item) => item.id === event.activity.id)
      const next = index >= 0
        ? existing.map((item, itemIndex) => itemIndex === index ? { ...item, ...event.activity } : item)
        : [...existing, event.activity]
      return { executionActivities: { ...state.executionActivities, [event.runId]: next.slice(-24) } }
    }
    if (event.type === 'delta') {
      const current = state.streamingResponses[event.runId] ?? { threadId: event.threadId, content: '' }
      return { streamingResponses: { ...state.streamingResponses, [event.runId]: { ...current, content: current.content + event.delta } } }
    }
    if (event.type === 'run_updated') {
      return {
        runs: state.runs.some((run) => run.id === event.run.id)
          ? state.runs.map((run) => run.id === event.run.id ? event.run : run)
          : [event.run, ...state.runs]
      }
    }
    const streamingResponses = { ...state.streamingResponses }
    delete streamingResponses[event.runId]
    const isActiveRun = state.activeRunId === event.runId
    if (event.type === 'completed' || event.type === 'approval_required') {
      return {
        streamingResponses,
        sending: isActiveRun ? false : state.sending,
        activeRunId: isActiveRun ? null : state.activeRunId,
        messages: state.activeThreadId === event.threadId && !state.messages.some((message) => message.id === event.message.id)
          ? [...state.messages, event.message] : state.messages,
        runs: state.runs.some((run) => run.id === event.run.id)
          ? state.runs.map((run) => run.id === event.run.id ? event.run : run)
          : [event.run, ...state.runs],
        threads: state.threads.map((thread) => thread.id === event.threadId
          ? { ...thread, updatedAt: event.run.finishedAt ?? thread.updatedAt } : thread),
        messageExecutionActivities: {
          ...state.messageExecutionActivities,
          [event.message.id]: state.executionActivities[event.runId] ?? []
        }
      }
    }
    return {
      streamingResponses,
      sending: isActiveRun ? false : state.sending,
      activeRunId: isActiveRun ? null : state.activeRunId,
      runs: state.runs.some((run) => run.id === event.run.id)
        ? state.runs.map((run) => run.id === event.run.id ? event.run : run)
        : [event.run, ...state.runs],
      error: event.type === 'error' ? event.error : state.error,
      toast: event.type === 'cancelled' ? '已停止生成' : state.toast
    }
    })
    if (event.type === 'completed') {
      void window.espow.workspace.refresh().then((result) => {
        if (result.workspace) set({ workspace: result.workspace })
      }).catch(() => undefined)
    }
  },
  selectRun: (selectedRunId) => set({ selectedRunId }),
  setContextTab: (contextTab) => set({ contextTab }),
  openArtifact: async (requirementId, artifactId) => {
    set({ previewLoading: true, preview: null })
    try {
      set({ preview: await window.espow.workspace.readArtifact(requirementId, artifactId), previewLoading: false })
    } catch (error) {
      set({ previewLoading: false, preview: { artifact: null, content: null, error: errorMessage(error, '读取 Artifact 失败。') } })
    }
  },
  closeArtifact: () => set({ preview: null, previewLoading: false }),
  resolveApproval: async (runId, approved) => {
    if (get().approvalBusy) return
    set({ approvalBusy: true, error: null })
    try {
      const resolution = await window.espow.tools.resolveApproval(runId, approved)
      let workspace = get().workspace
      if (approved) {
        const refreshed = await window.espow.workspace.refresh()
        if (refreshed.workspace) workspace = refreshed.workspace
      }
      set((state) => ({
        workspace,
        runs: state.runs.map((run) => run.id === resolution.run.id ? resolution.run : run),
        approvalBusy: false,
        toast: approved && resolution.run.status === 'Completed' ? 'Artifact 新版本已写入并通过验证' : approved ? 'Artifact 写入失败' : '已取消候选修改',
        error: resolution.run.status === 'Failed' ? resolution.run.error : null
      }))
    } catch (error) {
      set({ approvalBusy: false, error: errorMessage(error, '无法处理 Approval。') })
    }
  },
  setToast: (toast) => set({ toast })
}))
