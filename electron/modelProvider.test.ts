import assert from 'node:assert/strict'
import test from 'node:test'
import { OpenAIProvider, parseSseStream, ProviderRequestError } from './modelProvider'

function chunkedStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    }
  })
}

test('SSE Parser 可处理跨分片、CRLF 与多个事件', async () => {
  const stream = chunkedStream([
    'data: {"choices":[{"delta":{"content":"你"}}]}\r',
    '\n\r\ndata: {"choices":[{"delta":{"content":"好"}}]}\n\n',
    'data: [DONE]\n\n'
  ])
  const events: string[] = []
  for await (const event of parseSseStream(stream)) events.push(event)
  assert.equal(JSON.parse(events[0] ?? '{}').choices[0].delta.content, '你')
  assert.equal(JSON.parse(events[1] ?? '{}').choices[0].delta.content, '好')
  assert.equal(events[2], '[DONE]')
})

test('OpenAI Provider 发送 Chat Completions 请求并转换 delta', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  let requestedUrl = ''
  let requestedBody = ''
  globalThis.fetch = async (input, init) => {
    requestedUrl = String(input)
    requestedBody = String(init?.body)
    return new Response(chunkedStream([
      'data: {"choices":[{"delta":{"content":"流"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"content":"式"},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n'
    ]), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  }
  const events = []
  const provider = new OpenAIProvider()
  for await (const event of provider.streamChat(
    { messages: [{ role: 'user', content: '测试' }] },
    { provider: 'openai', apiKey: 'secret', model: 'model-a', baseUrl: 'https://example.com/v1/' },
    new AbortController().signal
  )) events.push(event)
  assert.equal(requestedUrl, 'https://example.com/v1/chat/completions')
  assert.equal(JSON.parse(requestedBody).stream, true)
  assert.equal(JSON.parse(requestedBody).max_tokens, 1200)
  assert.deepEqual(events, [{ type: 'delta', delta: '流' }, { type: 'delta', delta: '式' }, { type: 'completed' }])
})

test('Provider 将鉴权错误转换为可理解信息', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'invalid key' } }), {
    status: 401, headers: { 'Content-Type': 'application/json' }
  })
  const provider = new OpenAIProvider()
  await assert.rejects(async () => {
    for await (const _event of provider.streamChat(
      { messages: [{ role: 'user', content: '测试' }] },
      { provider: 'openai', apiKey: 'secret', model: 'model-a', baseUrl: 'https://example.com/v1' },
      new AbortController().signal
    )) { /* consume */ }
  }, (error: unknown) => error instanceof ProviderRequestError && /API Key 无效/.test(error.message))
})
