/**
 * How far along a long operation probably is: time elapsed against its expected duration, slowing
 * as it nears the end so an overrun creeps toward (never reaches) full until it's actually done.
 */
export function progressFraction(elapsedMs: number, expectedMs: number): number {
  const r = Math.max(0, elapsedMs) / Math.max(1, expectedMs)
  return r < 0.85 ? r : 0.85 + 0.14 * (1 - Math.exp(-(r - 0.85) * 2.5))
}

/**
 * What a running action's toast says, from the message it shows when done: "Pushed main" reads
 * "Pushing main…", "Copied 3 files" reads "Copying 3 files…". A message that doesn't start with a
 * past-tense verb ("Chat deleted", "main is now active") reads "Working…".
 */
export function runningLabel(doneText: string): string {
  const m = /^([A-Z][a-z]+)(\b.*)$/.exec(doneText.trim())
  if (!m) return 'Working…'
  const [, verb, rest] = m
  const lower = verb.toLowerCase()
  let ing: string | undefined
  if (lower.endsWith('ied')) ing = verb.slice(0, -3) + 'ying'
  else if (lower.endsWith('ed') && lower.length > 3 && !['need', 'feed', 'seed', 'speed', 'red', 'bed'].includes(lower)) ing = verb.slice(0, -2) + 'ing'
  return ing ? `${ing}${rest.replace(/[.!]$/, '')}…` : 'Working…'
}

/** The kind of action a done message describes, for learning its duration: names and numbers dropped. */
export function etaKey(doneText: string): string {
  return doneText
    .trim()
    .split(/\s+/)
    .filter((w) => /^[A-Za-z’'-]+[.!]?$/.test(w))
    .slice(0, 4)
    .join(' ')
    .toLowerCase()
}
