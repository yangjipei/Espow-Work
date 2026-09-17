import type { MessageRecord } from '../../src/persistence'
import type { MemoryItem } from '../../src/memory'
import type { PersistenceService } from '../persistenceService'

const recentMessageLimit = 8
const recentCharacterLimit = 6_000
const summaryCharacterLimit = 4_000
const summaryMessageLimit = 18

export interface BoundedThreadMemory {
  summary: string | null
  messages: MessageRecord[]
  truncated: boolean
  compactedMessageCount: number
}

function compactLine(message: MessageRecord): string {
  const role = message.role === 'user' ? 'User' : message.role === 'assistant' ? 'Assistant' : 'System'
  const normalized = message.content.replace(/\s+/g, ' ').trim()
  const clipped = normalized.length > 280 ? `${normalized.slice(0, 277)}…` : normalized
  return `- ${role}: ${clipped}`
}

function summarize(messages: MessageRecord[]): string {
  if (!messages.length) return ''
  const selected = messages.slice(-summaryMessageLimit)
  let value = `Earlier thread digest (${messages.length} messages compacted):\n${selected.map(compactLine).join('\n')}`
  if (value.length > summaryCharacterLimit) value = `${value.slice(0, summaryCharacterLimit - 1)}…`
  return value
}

export class MemoryManager {
  constructor(private readonly persistence: PersistenceService) {}

  buildThreadMemory(threadId: string): BoundedThreadMemory {
    const all = this.persistence.listMessages(threadId)
    const recent: MessageRecord[] = []
    let characters = 0
    for (const message of [...all].reverse()) {
      if (recent.length >= recentMessageLimit || characters + message.content.length > recentCharacterLimit) break
      recent.unshift(message)
      characters += message.content.length
    }
    const compacted = all.slice(0, all.length - recent.length)
    const summary = summarize(compacted)
    const stored = this.persistence.getThreadMemory(threadId)
    if (summary && (stored?.summary !== summary || stored.compactedMessageCount !== compacted.length)) {
      this.persistence.saveThreadMemory(threadId, summary, compacted.length)
    }
    return {
      summary: summary || stored?.summary || null,
      messages: recent,
      truncated: compacted.length > 0,
      compactedMessageCount: compacted.length
    }
  }

  retrieve(input: { workspaceId: string; requirementId: string; threadId: string; task: string; limit?: number }): MemoryItem[] {
    return this.persistence.searchMemory({
      workspaceId: input.workspaceId,
      requirementId: input.requirementId,
      threadId: input.threadId,
      query: input.task,
      limit: input.limit ?? 6
    })
  }

  remember(input: Parameters<PersistenceService['upsertMemory']>[0]): MemoryItem {
    return this.persistence.upsertMemory(input)
  }

  captureExplicitMemory(input: { workspaceId: string; requirementId: string; threadId: string; task: string }): MemoryItem | null {
    const value = input.task.trim()
    const patterns: Array<{ pattern: RegExp; scope: 'global' | 'requirement' | 'thread'; category: string }> = [
      { pattern: /^(?:长期记忆|以后记住|记住)[:：]\s*(.+)$/is, scope: 'global', category: 'user-preference' },
      { pattern: /^(?:本需求记住|需求记忆)[:：]\s*(.+)$/is, scope: 'requirement', category: 'requirement-memory' },
      { pattern: /^(?:本线程记住|线程记忆)[:：]\s*(.+)$/is, scope: 'thread', category: 'thread-memory' }
    ]
    for (const item of patterns) {
      const matched = value.match(item.pattern)
      const content = matched?.[1]?.trim()
      if (!content) continue
      return this.remember({
        scope: item.scope,
        workspaceId: item.scope === 'global' ? null : input.workspaceId,
        requirementId: item.scope === 'requirement' ? input.requirementId : null,
        threadId: item.scope === 'thread' ? input.threadId : null,
        category: item.category,
        content,
        importance: item.scope === 'global' ? 4 : 3,
        source: 'explicit-user-message'
      })
    }
    return null
  }
}
