import type { DiagnosticBreadcrumb } from '../../src/diagnostic'
import type { DiagnosticCaptureInput, DiagnosticService } from './diagnosticService'

let service: DiagnosticService | null = null

export function setDiagnosticService(value: DiagnosticService): void { service = value }
export function reportDiagnostic(input: DiagnosticCaptureInput): void { service?.capture(input) }
export function reportDiagnosticError(error: unknown, input: Parameters<DiagnosticService['captureError']>[1]): void { service?.captureError(error, input) }
export function addDiagnosticBreadcrumb(input: Omit<DiagnosticBreadcrumb, 'timestamp' | 'workspaceIdHash'> & { timestamp?: string; workspaceId?: string }): void { service?.addBreadcrumb(input) }
