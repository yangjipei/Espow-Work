import { contextBridge, ipcRenderer } from 'electron'
import { persistenceIpc } from '../src/persistence'
import { workspaceIpc, type EspowApi } from '../src/workspace'
import { modelIpc, type ModelStreamEvent } from '../src/model'
import { runtimeIpc } from '../src/runtime'
import { toolIpc } from '../src/tools'
import { tokenUsageIpc } from '../src/tokenUsage'
import { workContextIpc } from '../src/workContext'
import { diagnosticIpc } from '../src/diagnostic'
import { prototypeStyleIpc } from '../src/prototypeStyle'

const api: EspowApi = {
  platform: process.platform,
  workspace: {
    getRecent: () => ipcRenderer.invoke(workspaceIpc.getRecent),
    choose: () => ipcRenderer.invoke(workspaceIpc.choose),
    refresh: () => ipcRenderer.invoke(workspaceIpc.refresh),
    createRequirement: (input) => ipcRenderer.invoke(workspaceIpc.createRequirement, input),
    renameRequirement: (requirementId, name) => ipcRenderer.invoke(workspaceIpc.renameRequirement, requirementId, name),
    deleteRequirement: (requirementId) => ipcRenderer.invoke(workspaceIpc.deleteRequirement, requirementId),
    updateRequirementSystem: (requirementId, primarySystemId) => ipcRenderer.invoke(workspaceIpc.updateRequirementSystem, requirementId, primarySystemId),
    addRequirementInfo: (requirementId, content) => ipcRenderer.invoke(workspaceIpc.addRequirementInfo, requirementId, content),
    addSourceInputs: (requirementId) => ipcRenderer.invoke(workspaceIpc.addSourceInputs, requirementId),
    readArtifact: (requirementId, artifactId) => ipcRenderer.invoke(workspaceIpc.readArtifact, requirementId, artifactId)
  },
  persistence: {
    getSelection: (workspaceId) => ipcRenderer.invoke(persistenceIpc.getSelection, workspaceId),
    setActiveRequirement: (workspaceId, requirementId) => ipcRenderer.invoke(persistenceIpc.setActiveRequirement, workspaceId, requirementId),
    listThreads: (workspaceId, requirementId) => ipcRenderer.invoke(persistenceIpc.listThreads, workspaceId, requirementId),
    createThread: (workspaceId, requirementId, title) => ipcRenderer.invoke(persistenceIpc.createThread, workspaceId, requirementId, title),
    renameThread: (threadId, title) => ipcRenderer.invoke(persistenceIpc.renameThread, threadId, title),
    deleteThread: (threadId) => ipcRenderer.invoke(persistenceIpc.deleteThread, threadId),
    setActiveThread: (workspaceId, requirementId, threadId) => ipcRenderer.invoke(persistenceIpc.setActiveThread, workspaceId, requirementId, threadId),
    listMessages: (threadId) => ipcRenderer.invoke(persistenceIpc.listMessages, threadId),
    appendUserMessage: (workspaceId, requirementId, threadId, content) => ipcRenderer.invoke(persistenceIpc.appendUserMessage, workspaceId, requirementId, threadId, content),
    listRuns: (workspaceId) => ipcRenderer.invoke(persistenceIpc.listRuns, workspaceId),
    listRunEvents: (runId) => ipcRenderer.invoke(persistenceIpc.listRunEvents, runId)
  },
  model: {
    getConfigs: () => ipcRenderer.invoke(modelIpc.getConfigs),
    saveConfig: (config) => ipcRenderer.invoke(modelIpc.saveConfig, config),
    testConnection: (config) => ipcRenderer.invoke(modelIpc.testConnection, config),
    startChat: (request) => ipcRenderer.invoke(modelIpc.startChat, request),
    cancelChat: (runId) => ipcRenderer.invoke(modelIpc.cancelChat, runId),
    onEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, streamEvent: ModelStreamEvent) => listener(streamEvent)
      ipcRenderer.on(modelIpc.event, handler)
      return () => ipcRenderer.removeListener(modelIpc.event, handler)
    }
  },
  runtime: {
    getStatus: () => ipcRenderer.invoke(runtimeIpc.getStatus)
  },
  tools: {
    resolveApproval: (runId, approved) => ipcRenderer.invoke(toolIpc.resolveApproval, runId, approved)
  },
  tokenUsage: {
    listWorkspaces: () => ipcRenderer.invoke(tokenUsageIpc.listWorkspaces),
    getSummary: (workspaceId) => ipcRenderer.invoke(tokenUsageIpc.getSummary, workspaceId)
  },
  workContext: {
    get: () => ipcRenderer.invoke(workContextIpc.get),
    saveCompany: (company) => ipcRenderer.invoke(workContextIpc.saveCompany, company),
    saveSystem: (system) => ipcRenderer.invoke(workContextIpc.saveSystem, system),
    setSystemActive: (systemId, active) => ipcRenderer.invoke(workContextIpc.setSystemActive, systemId, active),
    deleteSystem: (systemId) => ipcRenderer.invoke(workContextIpc.deleteSystem, systemId),
    saveRelation: (relation) => ipcRenderer.invoke(workContextIpc.saveRelation, relation),
    deleteRelation: (relationId) => ipcRenderer.invoke(workContextIpc.deleteRelation, relationId)
  },
  prototypeStyle: {
    getState: () => ipcRenderer.invoke(prototypeStyleIpc.getState),
    startLearning: (input) => ipcRenderer.invoke(prototypeStyleIpc.startLearning, input),
    finishLearning: () => ipcRenderer.invoke(prototypeStyleIpc.finishLearning),
    stopLearning: () => ipcRenderer.invoke(prototypeStyleIpc.stopLearning),
    saveCandidate: () => ipcRenderer.invoke(prototypeStyleIpc.saveCandidate),
    discardCandidate: () => ipcRenderer.invoke(prototypeStyleIpc.discardCandidate),
    getPreview: () => ipcRenderer.invoke(prototypeStyleIpc.getPreview),
    openLearningBrowser: () => ipcRenderer.invoke(prototypeStyleIpc.openLearningBrowser)
  },
  diagnostic: {
    getSummary: () => ipcRenderer.invoke(diagnosticIpc.getSummary),
    setRemoteReporting: (enabled) => ipcRenderer.invoke(diagnosticIpc.setRemoteReporting, enabled),
    captureRendererError: (event) => ipcRenderer.invoke(diagnosticIpc.captureRendererError, event),
    addBreadcrumb: (action, status) => ipcRenderer.invoke(diagnosticIpc.addBreadcrumb, action, status),
    openLogs: () => ipcRenderer.invoke(diagnosticIpc.openLogs),
    exportBundle: () => ipcRenderer.invoke(diagnosticIpc.exportBundle)
  }
}

contextBridge.exposeInMainWorld('espow', api)
