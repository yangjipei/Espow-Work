import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DiagnosticService } from './diagnostics/diagnosticService'
import { normalizeError } from './diagnostics/errorNormalizer'
import type { RemoteReporter } from './diagnostics/remoteReporter'
import { sanitizeDiagnosticEvent } from './diagnostics/sanitizer'
import { validateDiagnosticEvent } from './diagnostics/schema'
import { createZip } from './diagnostics/zip'

test('sanitizer removes sensitive metadata and secret patterns', () => {
  const event = sanitizeDiagnosticEvent({
    timestamp: new Date().toISOString(), level: 'error', layer: 'model',
    errorMessage: 'Bearer abc.def.ghi email user@example.com sk-secretsecretsecret',
    metadata: { apiKey: 'secret', prompt: 'private', duration: 42, provider: 'openai' }
  })
  assert.equal(event.metadata?.apiKey, undefined)
  assert.equal(event.metadata?.prompt, undefined)
  assert.equal(event.metadata?.duration, 42)
  assert.doesNotMatch(event.errorMessage ?? '', /user@example\.com|sk-secret|Bearer abc/)
})

test('error normalization produces stable codes', () => {
  assert.equal(normalizeError(new Error('database is not open'), 'persistence').errorCode, 'DB_NOT_OPEN')
  assert.equal(normalizeError(new Error('model returned no content'), 'model').errorCode, 'MODEL_EMPTY_RESPONSE')
})

test('diagnostic schema rejects unknown layers', () => {
  assert.equal(validateDiagnosticEvent({ timestamp: new Date().toISOString(), level: 'info', layer: 'runtime' }), true)
  assert.equal(validateDiagnosticEvent({ timestamp: new Date().toISOString(), level: 'info', layer: 'unknown' as 'runtime' }), false)
})

test('zip builder creates a valid ZIP container', () => {
  const zip = createZip([{ name: 'diagnostic/environment.json', data: Buffer.from('{}') }])
  assert.equal(zip.readUInt32LE(0), 0x04034b50)
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50)
  assert.ok(zip.includes(Buffer.from('diagnostic/environment.json')))
})

test('remote reporter failure never rejects capture and export is sanitized', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'espow-diagnostic-'))
  const reporter: RemoteReporter = { configured: true, capture: async () => { throw new Error('offline') } }
  const service = new DiagnosticService(directory, '1.0.0', () => '1.0.0', () => 'connected', () => 'running', reporter)
  await service.initialize()
  await service.setRemoteReporting(true)
  service.capture({ level: 'error', layer: 'model', errorCode: 'MODEL_REQUEST_FAILED', errorMessage: 'Bearer very-secret-token', metadata: { prompt: 'private text' } })
  const destination = join(directory, 'bundle.zip')
  await service.exportBundle(destination)
  assert.ok((await stat(destination)).size > 100)
  const contents = await readFile(destination)
  assert.doesNotMatch(contents.toString('utf8'), /very-secret-token|private text/)
})

test('local logger rotates files larger than ten megabytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'espow-rotation-'))
  await writeFile(join(directory, 'app.log'), Buffer.alloc(10 * 1024 * 1024, 32))
  const reporter: RemoteReporter = { configured: false, capture: async () => undefined }
  const service = new DiagnosticService(directory, '1.0.0', () => '1.0.0', () => 'connected', () => 'running', reporter)
  await service.initialize()
  service.capture({ level: 'info', layer: 'electron-main', operation: 'rotation-test' })
  await service.exportBundle(join(directory, 'bundle.zip'))
  const entries = await import('node:fs/promises').then(({ readdir }) => readdir(directory))
  assert.ok(entries.some((name) => /^app\.log\.\d+$/.test(name)))
})
