import { rrulestr } from 'rrule'
import type { Automation } from './types'

export function nextRunAfter(a: Automation, after: number): number | undefined {
  if (a.status !== 'active') return undefined
  const sch = a.schedule
  if (sch.type === 'interval') return Math.max(after, (a.lastRun ?? a.createdAt) + Math.max(1, sch.minutes) * 60_000)
  if (sch.type === 'rrule') {
    try {
      const rule = rrulestr(sch.rule, { dtstart: new Date(a.createdAt) })
      return rule.after(new Date(after))?.getTime()
    } catch {
      return undefined
    }
  }
  if (sch.type === 'github') return after + 5 * 60_000
  return undefined
}
