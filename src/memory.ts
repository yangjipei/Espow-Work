export type MemoryScope = 'thread' | 'requirement' | 'global'

export interface ThreadMemorySnapshot {
  threadId: string
  summary: string
  compactedMessageCount: number
  updatedAt: string
}

export interface MemoryItem {
  id: string
  scope: MemoryScope
  workspaceId: string | null
  requirementId: string | null
  threadId: string | null
  category: string
  content: string
  importance: number
  source: string
  createdAt: string
  updatedAt: string
}
