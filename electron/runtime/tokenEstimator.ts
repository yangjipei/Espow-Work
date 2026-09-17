export function estimateTokens(value: string): number {
  let units = 0
  for (const character of value) units += character.charCodeAt(0) > 0x7f ? 1 : 0.25
  return Math.max(1, Math.ceil(units))
}
