import assert from 'node:assert/strict'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { PersistenceService } from '../persistenceService'
import { MemoryManager } from './memoryManager'

test('MemoryManager compacts long thread history and keeps bounded recent messages', () => {
  const directory = mkdtempSync(join(tmpdir(), 'espow-memory-test-'))
  const persistence = new PersistenceService(join(directory, 'memory.sqlite'))
  try {
    persistence.saveWorkspace({ id: 'ws', path: join(directory, 'workspace'), name: 'Workspace' })
    const thread = persistence.createThread('ws', 'req', 'Thread')
    const config = { provider: 'deepseek' as const, apiKey: 'test', model: 'test', baseUrl: 'https://example.com' }
    for (let index = 0; index < 12; index += 1) {
      const started = persistence.startRun('ws', 'req', thread.id, `用户消息 ${index} ${'x'.repeat(100)}`, config)
      persistence.completeRun(started.run.id, `助手回复 ${index} ${'y'.repeat(100)}`)
    }
    const memory = new MemoryManager(persistence).buildThreadMemory(thread.id)
    assert.equal(memory.truncated, true)
    assert.ok(memory.messages.length <= 8)
    assert.ok(memory.summary)
    assert.ok(memory.compactedMessageCount > 0)
    assert.equal(persistence.getThreadMemory(thread.id)?.compactedMessageCount, memory.compactedMessageCount)
  } finally {
    persistence.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('MemoryManager retrieves Chinese requirement memory by relevant n-gram', () => {
  const directory = mkdtempSync(join(tmpdir(), 'espow-memory-search-'))
  const persistence = new PersistenceService(join(directory, 'memory.sqlite'))
  try {
    persistence.saveWorkspace({ id: 'ws', path: join(directory, 'workspace'), name: 'Workspace' })
    const thread = persistence.createThread('ws', 'req', 'Thread')
    const manager = new MemoryManager(persistence)
    manager.remember({
      scope: 'requirement', workspaceId: 'ws', requirementId: 'req', category: 'rule',
      content: '录音归档失败不重试，保留失败状态供人工排查。', importance: 4, source: 'test'
    })
    const matches = manager.retrieve({ workspaceId: 'ws', requirementId: 'req', threadId: thread.id, task: '录音归档失败怎么办？' })
    assert.equal(matches.length > 0, true)
    assert.match(matches[0].content, /录音归档/)
  } finally {
    persistence.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
