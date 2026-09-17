export const prototypeStyleIpc = {
  getState: 'prototype-style:get-state',
  startLearning: 'prototype-style:start-learning',
  finishLearning: 'prototype-style:finish-learning',
  stopLearning: 'prototype-style:stop-learning',
  saveCandidate: 'prototype-style:save-candidate',
  discardCandidate: 'prototype-style:discard-candidate',
  getPreview: 'prototype-style:get-preview',
  openLearningBrowser: 'prototype-style:open-learning-browser'
} as const

export type UiPagePattern = 'list' | 'detail' | 'form' | 'dashboard' | 'modal' | 'drawer'
export type UiComponentType = 'button' | 'input' | 'select' | 'search' | 'table' | 'pagination' | 'tabs' | 'tag' | 'form' | 'modal' | 'drawer' | 'card' | 'header' | 'sidebar'
export type UiLearningStatus = 'idle' | 'learning' | 'interrupted' | 'candidate-ready'

export interface UiCoverageState {
  pagePatterns: Record<UiPagePattern, boolean>
  components: Record<UiComponentType, boolean>
  summary: string
  nextSuggestion: string | null
}

export interface UiBaselineSummary {
  configured: boolean
  name: string | null
  learnedPageCount: number
  patternCount: number
  componentCount: number
  updatedAt: string | null
  version: number | null
}

export interface UiLearningState {
  status: UiLearningStatus
  sessionId: string | null
  sourceUrl: string | null
  startedAt: string | null
  updatedAt: string | null
  learnedPageCount: number
  coverage: UiCoverageState
  message: string | null
}

export interface UiBaselineCandidateSummary {
  id: string
  name: string
  sourceUrl: string
  createdAt: string
  learnedPageCount: number
  patternCount: number
  componentCount: number
}

export interface PrototypeStyleState {
  baseline: UiBaselineSummary
  learning: UiLearningState
  candidate: UiBaselineCandidateSummary | null
}

export interface StartUiLearningInput {
  url: string
  name?: string
}

export interface UiBaselinePreviewResult {
  html: string | null
  candidate: UiBaselineCandidateSummary | null
  error?: string
}

export interface UiBaselineContext {
  version: number
  name: string
  updatedAt: string
  globals: Record<string, unknown>
  pattern: Record<string, unknown>
  components: Record<string, unknown>
  loadedKeys: string[]
}

export interface PrototypeStyleApi {
  getState: () => Promise<PrototypeStyleState>
  startLearning: (input: StartUiLearningInput) => Promise<PrototypeStyleState>
  finishLearning: () => Promise<PrototypeStyleState>
  stopLearning: () => Promise<PrototypeStyleState>
  saveCandidate: () => Promise<PrototypeStyleState>
  discardCandidate: () => Promise<PrototypeStyleState>
  getPreview: () => Promise<UiBaselinePreviewResult>
  openLearningBrowser: () => Promise<PrototypeStyleState>
}
