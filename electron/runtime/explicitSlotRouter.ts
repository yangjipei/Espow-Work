import { routeExplicitSlotHeadings, type SlotRoute } from './slotRouter'

export type ExplicitSlotUpdate = SlotRoute

export function parseExplicitSlotUpdate(task: string): ExplicitSlotUpdate | null {
  return routeExplicitSlotHeadings(task)
}
