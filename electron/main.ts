import { app, BrowserWindow, crashReporter, dialog, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import appIcon from '../resources/icon.png?asset'
import { PersistenceService } from './persistenceService'
import { LocalWorkspaceService } from './workspaceService'
import { persistenceIpc } from '../src/persistence'
import { workspaceIpc, type WorkspaceResult } from '../src/workspace'
import { modelIpc, type ModelConfigDraft, type StartChatRequest } from '../src/model'
import { ModelService } from './modelService'
import { AgentTaskService } from './agentTaskService'
import { RuntimeService } from './runtime/runtimeService'
import { runtimeIpc } from '../src/runtime'
import { toolIpc } from '../src/tools'
import { EspowToolService } from './tools/toolService'
import { EspowToolBridge } from './tools/toolBridge'
import { SkillRegistry } from './skills/skillRegistry'
import { ContextManager } from './runtime/contextManager'
import { MemoryManager } from './runtime/memoryManager'
import { LifecycleEngine } from './runtime/lifecycleEngine'
import { IntentRecognitionService } from './runtime/intentRecognition'
import { RequirementService } from './requirementService'
import { tokenUsageIpc } from '../src/tokenUsage'
import { workContextIpc, type SaveRelationInput, type SaveSystemInput, type WorkContextCompany } from '../src/workContext'
import { diagnosticIpc, type DiagnosticBreadcrumb, type RendererDiagnosticInput } from '../src/diagnostic'
import { DiagnosticService } from './diagnostics/diagnosticService'
import { SentryReporter } from './diagnostics/remoteReporter'
import { addDiagnosticBreadcrumb, reportDiagnosticError, setDiagnosticService } from './diagnostics/diagnosticBridge'
import { prototypeStyleIpc, type StartUiLearningInput } from '../src/prototypeStyle'
import { PrototypeStyleService } from './prototypeStyleService'

const workspaceService = new LocalWorkspaceService()
let persistenceService: PersistenceService
let modelService: ModelService
let agentTaskService: AgentTaskService
let runtimeService: RuntimeService
let requirementService: RequirementService
let diagnosticService: DiagnosticService
let prototypeStyleService: PrototypeStyleService
let currentWorkspacePath: string | null = null
let quitting = false

async function scanWorkspace(path: string): Promise<WorkspaceResult> {
  try {
    const workspace = await workspaceService.scan(path)
    currentWorkspacePath = workspace.rootPath
    persistenceService.saveWorkspace({ id: workspace.id, path: workspace.rootPath, name: workspace.name })
    for (const requirement of workspace.requirements) {
      try { persistenceService.syncRequirementSystemBinding(workspace.id, requirement.id, requirement.primarySystemId ?? null) }
      catch { /* A removed external system must not prevent opening a historical Workspace. */ }
    }
    return { workspace }
  } catch (error) {
    return { workspace: null, error: error instanceof Error ? error.message : '无法读取 Workspace。' }
  }
}

function registerWorkspaceIpc(): void {
  ipcMain.handle(workspaceIpc.getRecent, async (): Promise<WorkspaceResult> => {
    const recent = persistenceService.getRecentWorkspace()
    if (!recent) return { workspace: null }
    const result = await scanWorkspace(recent.path)
    return result.workspace ? result : { ...result, error: `最近 Workspace 不可用（${recent.path}）：${result.error ?? '路径不存在。'}` }
  })
  ipcMain.handle(workspaceIpc.choose, async (event): Promise<WorkspaceResult> => {
    const parentWindow = BrowserWindow.fromWebContents(event.sender)
    if (!parentWindow || parentWindow.isDestroyed()) return { workspace: null, error: '无法找到当前 Desktop 窗口。' }
    if (process.platform === 'darwin') app.focus({ steal: true })
    parentWindow.focus()
    const result = await dialog.showOpenDialog(parentWindow, {
      title: '选择 ESPow Workspace',
      defaultPath: currentWorkspacePath ?? undefined,
      properties: ['openDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return { workspace: null, canceled: true }
    return scanWorkspace(result.filePaths[0])
  })
  ipcMain.handle(workspaceIpc.refresh, async (): Promise<WorkspaceResult> => {
    const path = currentWorkspacePath ?? persistenceService.getRecentWorkspace()?.path
    return path ? scanWorkspace(path) : { workspace: null, error: '尚未选择 Workspace。' }
  })
  ipcMain.handle(workspaceIpc.createRequirement, async (_event, input) => requirementService.create(input))
  ipcMain.handle(workspaceIpc.renameRequirement, async (_event, requirementId: string, name: string) =>
    requirementService.rename(requirementId, name))
  ipcMain.handle(workspaceIpc.deleteRequirement, async (_event, requirementId: string) => requirementService.delete(requirementId))
  ipcMain.handle(workspaceIpc.updateRequirementSystem, async (_event, requirementId: string, primarySystemId: string | null) => {
    if (primarySystemId && !persistenceService.getWorkContext().systems.some((system) => system.id === primarySystemId && system.active)) {
      throw new Error('选择的产品 / 系统不存在或已停用。')
    }
    const workspace = await workspaceService.updateRequirementSystem(requirementId, primarySystemId)
    persistenceService.syncRequirementSystemBinding(workspace.id, requirementId, primarySystemId)
    return workspace
  })
  ipcMain.handle(workspaceIpc.addRequirementInfo, async (_event, requirementId: string, content: string) =>
    workspaceService.addRequirementInfo(requirementId, content))
  ipcMain.handle(workspaceIpc.addSourceInputs, async (event, requirementId: string) => {
    const parentWindow = BrowserWindow.fromWebContents(event.sender)
    if (!parentWindow || parentWindow.isDestroyed()) throw new Error('无法找到当前 Desktop 窗口。')
    const selected = await dialog.showOpenDialog(parentWindow, {
      title: '添加参考资料',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '参考资料', extensions: ['md', 'txt', 'json', 'html', 'htm', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'] }]
    })
    if (selected.canceled || !selected.filePaths.length) return { workspace: null, added: [], canceled: true }
    return workspaceService.addSourceInputs(requirementId, selected.filePaths)
  })
  ipcMain.handle(workspaceIpc.readArtifact, (_event, requirementId: string, artifactId: string) =>
    workspaceService.readArtifact(requirementId, artifactId))
}

function registerPersistenceIpc(): void {
  ipcMain.handle(persistenceIpc.getSelection, (_event, workspaceId: string) => persistenceService.getSelection(workspaceId))
  ipcMain.handle(persistenceIpc.setActiveRequirement, (_event, workspaceId: string, requirementId: string) =>
    persistenceService.setActiveRequirement(workspaceId, requirementId))
  ipcMain.handle(persistenceIpc.listThreads, (_event, workspaceId: string, requirementId: string) =>
    persistenceService.listThreads(workspaceId, requirementId))
  ipcMain.handle(persistenceIpc.createThread, (_event, workspaceId: string, requirementId: string, title: string) =>
    persistenceService.createThread(workspaceId, requirementId, title))
  ipcMain.handle(persistenceIpc.renameThread, (_event, threadId: string, title: string) =>
    persistenceService.renameThread(threadId, title))
  ipcMain.handle(persistenceIpc.deleteThread, (_event, threadId: string) => persistenceService.deleteThread(threadId))
  ipcMain.handle(persistenceIpc.setActiveThread, (_event, workspaceId: string, requirementId: string, threadId: string) =>
    persistenceService.setActiveThread(workspaceId, requirementId, threadId))
  ipcMain.handle(persistenceIpc.listMessages, (_event, threadId: string) => persistenceService.listMessages(threadId))
  ipcMain.handle(persistenceIpc.appendUserMessage, (_event, workspaceId: string, requirementId: string, threadId: string, content: string) =>
    persistenceService.appendUserMessage(workspaceId, requirementId, threadId, content))
  ipcMain.handle(persistenceIpc.listRuns, (_event, workspaceId: string) => persistenceService.listRuns(workspaceId))
  ipcMain.handle(persistenceIpc.listRunEvents, (_event, runId: string) => persistenceService.listRunEvents(runId))
  ipcMain.handle(tokenUsageIpc.listWorkspaces, () => persistenceService.listTokenUsageWorkspaces())
  ipcMain.handle(tokenUsageIpc.getSummary, (_event, workspaceId: string) => persistenceService.getTokenUsageSummary(workspaceId))
  ipcMain.handle(workContextIpc.get, () => persistenceService.getWorkContext())
  ipcMain.handle(workContextIpc.saveCompany, (_event, company: Omit<WorkContextCompany, 'updatedAt'>) => persistenceService.saveWorkContextCompany(company))
  ipcMain.handle(workContextIpc.saveSystem, (_event, system: SaveSystemInput) => persistenceService.saveWorkContextSystem(system))
  ipcMain.handle(workContextIpc.setSystemActive, (_event, systemId: string, active: boolean) => persistenceService.setWorkContextSystemActive(systemId, active))
  ipcMain.handle(workContextIpc.deleteSystem, (_event, systemId: string) => persistenceService.deleteWorkContextSystem(systemId))
  ipcMain.handle(workContextIpc.saveRelation, (_event, relation: SaveRelationInput) => persistenceService.saveWorkContextRelation(relation))
  ipcMain.handle(workContextIpc.deleteRelation, (_event, relationId: string) => persistenceService.deleteWorkContextRelation(relationId))
}

function registerModelIpc(): void {
  ipcMain.handle(modelIpc.getConfigs, () => persistenceService.getModelSettings())
  ipcMain.handle(modelIpc.saveConfig, (_event, config: ModelConfigDraft) => persistenceService.saveModelConfig(config))
  ipcMain.handle(modelIpc.testConnection, (_event, config: ModelConfigDraft) => modelService.testConnection(config))
  ipcMain.handle(modelIpc.startChat, (event, request: StartChatRequest) => agentTaskService.startChat(event.sender, request))
  ipcMain.handle(modelIpc.cancelChat, (_event, runId: string) => agentTaskService.cancelChat(runId))
  ipcMain.handle(toolIpc.resolveApproval, (_event, runId: string, approved: boolean) =>
    agentTaskService.resolveApproval(runId, approved))
  ipcMain.handle(runtimeIpc.getStatus, () => runtimeService.getStatus())
}


function registerPrototypeStyleIpc(): void {
  ipcMain.handle(prototypeStyleIpc.getState, () => prototypeStyleService.getState())
  ipcMain.handle(prototypeStyleIpc.startLearning, (_event, input: StartUiLearningInput) => prototypeStyleService.startLearning(input))
  ipcMain.handle(prototypeStyleIpc.finishLearning, () => prototypeStyleService.finishLearning())
  ipcMain.handle(prototypeStyleIpc.stopLearning, () => prototypeStyleService.stopLearning())
  ipcMain.handle(prototypeStyleIpc.saveCandidate, () => prototypeStyleService.saveCandidate())
  ipcMain.handle(prototypeStyleIpc.discardCandidate, () => prototypeStyleService.discardCandidate())
  ipcMain.handle(prototypeStyleIpc.getPreview, () => prototypeStyleService.getPreview())
  ipcMain.handle(prototypeStyleIpc.openLearningBrowser, () => prototypeStyleService.openLearningBrowser())
}

function registerDiagnosticIpc(): void {
  ipcMain.handle(diagnosticIpc.getSummary, () => diagnosticService.getSummary())
  ipcMain.handle(diagnosticIpc.setRemoteReporting, (_event, enabled: boolean) => diagnosticService.setRemoteReporting(enabled === true))
  ipcMain.handle(diagnosticIpc.captureRendererError, (_event, input: RendererDiagnosticInput) => diagnosticService.captureRenderer(input))
  ipcMain.handle(diagnosticIpc.addBreadcrumb, (_event, action: string, status: DiagnosticBreadcrumb['status'] = 'info') => {
    diagnosticService.addBreadcrumb({ layer: 'renderer', action: action.slice(0, 120), status })
  })
  ipcMain.handle(diagnosticIpc.openLogs, async () => {
    const error = await shell.openPath(diagnosticService.logDirectory)
    return error || null
  })
  ipcMain.handle(diagnosticIpc.exportBundle, async (event) => {
    const parentWindow = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
    const options = { title: '导出诊断包', defaultPath: `espow-diagnostic-${stamp}.zip`, filters: [{ name: 'ZIP', extensions: ['zip'] }] }
    const result = parentWindow ? await dialog.showSaveDialog(parentWindow, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return { canceled: true }
    try {
      await diagnosticService.exportBundle(result.filePath)
      return { canceled: false, path: result.filePath }
    } catch (error) {
      diagnosticService.captureError(error, { layer: 'electron-main', module: 'DiagnosticService', operation: 'exportBundle', errorCode: 'DIAGNOSTIC_EXPORT_FAILED' })
      return { canceled: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}

function createWindow(): void {
  const window = new BrowserWindow({
    icon: appIcon,
    width: 1440,
    height: 920,
    minWidth: 1120,
    minHeight: 700,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 11 },
    backgroundColor: '#eef1f5',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true
    }
  })

  window.webContents.on('render-process-gone', (_event, details) => {
    diagnosticService.capture({ level: 'fatal', layer: 'renderer', module: 'BrowserWindow', operation: 'render-process-gone', errorCode: 'RENDERER_PROCESS_GONE', errorMessage: details.reason, metadata: { exitCode: details.exitCode, reason: details.reason } })
  })
  window.on('unresponsive', () => diagnosticService.capture({ level: 'error', layer: 'renderer', module: 'BrowserWindow', operation: 'unresponsive', errorCode: 'RENDERER_UNRESPONSIVE', errorMessage: 'Renderer became unresponsive' }))

  window.once('ready-to-show', () => {
    window.maximize()
    window.show()
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock?.setIcon(appIcon)
  crashReporter.start({ uploadToServer: false, compress: true })
  diagnosticService = new DiagnosticService(
    join(app.getPath('userData'), 'logs'), app.getVersion(),
    () => runtimeService?.getStatus().version ?? 'unavailable',
    () => persistenceService?.isOpen() ? 'connected' : 'unavailable',
    () => runtimeService?.getStatus().status ?? 'stopped',
    new SentryReporter()
  )
  setDiagnosticService(diagnosticService)
  await diagnosticService.initialize()
  persistenceService = new PersistenceService(join(app.getPath('userData'), 'espow-work.sqlite'))
  requirementService = new RequirementService(workspaceService, persistenceService)
  modelService = new ModelService(persistenceService)
  const toolService = new EspowToolService(workspaceService, persistenceService)
  const toolBridge = new EspowToolBridge(toolService)
  runtimeService = new RuntimeService(app.getAppPath(), toolBridge)
  prototypeStyleService = new PrototypeStyleService(join(app.getPath('userData'), 'ui-baseline'), runtimeService)
  await prototypeStyleService.initialize()
  const skillRegistry = new SkillRegistry(join(app.getAppPath(), 'skills'))
  const memoryManager = new MemoryManager(persistenceService)
  const lifecycleEngine = new LifecycleEngine()
  const contextManager = new ContextManager(workspaceService, persistenceService, memoryManager, prototypeStyleService)
  agentTaskService = new AgentTaskService(
    persistenceService, workspaceService, runtimeService, toolService, skillRegistry, contextManager, lifecycleEngine,
    new IntentRecognitionService()
  )
  try {
    await runtimeService.start()
  } catch (error) {
    console.error('[runtime] ESPow Runtime startup failed', error instanceof Error ? error.message : String(error))
    reportDiagnosticError(error, { layer: 'runtime', module: 'RuntimeService', operation: 'start', errorCode: 'RUNTIME_START_FAILED' })
  }
  registerWorkspaceIpc()
  registerPersistenceIpc()
  registerModelIpc()
  registerDiagnosticIpc()
  registerPrototypeStyleIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}).catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error)
  console.error('[startup] ESPow Work initialization failed:', message)
  reportDiagnosticError(error, { layer: 'electron-main', module: 'AppStartup', operation: 'initialize', errorCode: 'APP_STARTUP_FAILED' })
  if (app.isReady()) {
    void dialog.showMessageBox({
      type: 'error',
      title: 'ESPow Work 启动失败',
      message: '应用初始化失败。',
      detail: error instanceof Error ? error.message : String(error)
    }).finally(() => app.quit())
  } else {
    app.quit()
  }
})

process.on('uncaughtExceptionMonitor', (error) => {
  reportDiagnosticError(error, { layer: 'electron-main', module: 'Process', operation: 'uncaughtException', errorCode: 'MAIN_UNCAUGHT_EXCEPTION' })
})

process.on('unhandledRejection', (reason) => {
  reportDiagnosticError(reason, { layer: 'electron-main', module: 'Process', operation: 'unhandledRejection', errorCode: 'MAIN_UNHANDLED_REJECTION' })
})

app.on('before-quit', (event) => {
  if (quitting) return
  event.preventDefault()
  quitting = true
  const runtimeShutdown = (async () => {
    // UI learning owns a Rust Playwright context inside the Runtime, so stop it before shutting down the Runtime process.
    if (prototypeStyleService) await prototypeStyleService.close().catch(() => undefined)
    if (runtimeService) await runtimeService.close()
  })()
  void runtimeShutdown.catch((error: unknown) => {
    console.error('[runtime] Graceful shutdown failed', error instanceof Error ? error.message : String(error))
    reportDiagnosticError(error, { layer: 'runtime', module: 'RuntimeService', operation: 'shutdown', errorCode: 'RUNTIME_SHUTDOWN_FAILED' })
  }).finally(() => {
    app.quit()
  })
})

app.on('will-quit', () => {
  persistenceService?.close()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
