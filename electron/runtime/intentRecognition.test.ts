import assert from 'node:assert/strict'
import test from 'node:test'
import { IntentRecognitionService, validateRecognizedIntent } from './intentRecognition'

test('Intent Recognition 使用最小控制上下文并解析结构化输出', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  let requestBody = ''
  globalThis.fetch = async (_input, init) => {
    requestBody = String(init?.body)
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        intent: 'MODIFY_REQUIREMENT', target: '账号解绑逻辑', targetStage: 'requirement-analysis',
        pendingQuestionId: null, confidence: 0.96, needsReasoning: true
      }) } }],
      usage: { prompt_tokens: 80, completion_tokens: 24, total_tokens: 104 }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  const result = await new IntentRecognitionService().recognize({
    message: '确认这个方案方向，但账号解绑逻辑还要改。',
    currentStage: 'requirement-analysis',
    pendingQuestion: { id: 'Q66', question: '解绑后旧任务如何处理？' }
  }, { provider: 'openai', apiKey: 'secret', model: 'test', baseUrl: 'https://example.com/v1' })
  assert.equal(result.recognized.intent, 'MODIFY_REQUIREMENT')
  assert.equal(result.recognized.source, 'LLM')
  assert.equal(result.usage?.totalTokens, 104)
  const messages = (JSON.parse(requestBody) as { messages: Array<{ content: string }> }).messages
  assert.match(messages[1]?.content ?? '', /Q66/)
  assert.doesNotMatch(messages[1]?.content ?? '', /完整 Mainline|完整历史/)
})

test('低置信度或无效 Intent 必须安全回退为 UNKNOWN', () => {
  assert.equal(validateRecognizedIntent({ intent: 'CONFIRM_STAGE', confidence: 0.4 }).intent, 'UNKNOWN')
  assert.equal(validateRecognizedIntent({ intent: 'DELETE_EVERYTHING', confidence: 1 }).intent, 'UNKNOWN')
})
