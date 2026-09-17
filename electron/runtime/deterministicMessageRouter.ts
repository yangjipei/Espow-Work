export type DeterministicQuery = 'status' | 'stage' | 'goal' | 'conclusion'

export function parseDeterministicQuery(task: string): DeterministicQuery | null {
  const normalized = task.trim().replace(/[？?。！!\s]+$/g, '')
  if (/^(?:当前|现在)?(?:需求)?状态(?:是什么|如何|怎样|是啥)$/.test(normalized)) return 'status'
  if (/^(?:当前|现在)?(?:需求)?阶段(?:是什么|到了哪里|到哪了|是啥)$/.test(normalized)) return 'stage'
  if (/^(?:当前|现在)?(?:需求)?到哪一阶段了$/.test(normalized)) return 'stage'
  if (/^(?:当前|现在)?(?:需求)?目标(?:是什么|是啥)$/.test(normalized)) return 'goal'
  if (/^(?:所以)?(?:结论|分析结论)(?:呢|是什么|是啥)?$/.test(normalized)) return 'conclusion'
  return null
}
