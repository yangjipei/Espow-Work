import type { RunStatus } from '../../src/persistence'

export const terminalRunStatuses = new Set<RunStatus>(['Completed', 'Failed', 'Cancelled', 'Interrupted'])

export function isTerminalRunStatus(status: RunStatus): boolean {
  return terminalRunStatuses.has(status)
}

export function isRunWritable(status: RunStatus): boolean {
  return status === 'Running'
}

export function canBeginCancellation(status: RunStatus): boolean {
  return status === 'Running' || status === 'WaitingConfirmation'
}

export function canResolveApproval(status: RunStatus): boolean {
  return status === 'WaitingConfirmation'
}

export function assertRunWritableStatus(status: RunStatus): void {
  if (!isRunWritable(status)) throw new Error(`RUN_NOT_WRITABLE:${status}`)
}
