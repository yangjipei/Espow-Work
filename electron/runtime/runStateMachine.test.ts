import assert from 'node:assert/strict'
import test from 'node:test'
import { canBeginCancellation, canResolveApproval, isRunWritable, isTerminalRunStatus } from './runStateMachine.ts'

test('run state machine keeps terminal and writable boundaries explicit', () => {
  assert.equal(isRunWritable('Running'), true)
  assert.equal(isRunWritable('Cancelling'), false)
  assert.equal(isRunWritable('Interrupted'), false)
  assert.equal(isTerminalRunStatus('Completed'), true)
  assert.equal(isTerminalRunStatus('Interrupted'), true)
  assert.equal(isTerminalRunStatus('Cancelling'), false)
})

test('cancel and approval transitions do not share the same claim state', () => {
  assert.equal(canBeginCancellation('Running'), true)
  assert.equal(canBeginCancellation('WaitingConfirmation'), true)
  assert.equal(canBeginCancellation('Completed'), false)
  assert.equal(canResolveApproval('WaitingConfirmation'), true)
  assert.equal(canResolveApproval('Cancelling'), false)
  assert.equal(canResolveApproval('Cancelled'), false)
})
