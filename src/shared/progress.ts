/**
 * How far along a long operation probably is: time elapsed against its expected duration, slowing
 * as it nears the end so an overrun creeps toward (never reaches) full until it's actually done.
 */
export function progressFraction(elapsedMs: number, expectedMs: number): number {
  const r = Math.max(0, elapsedMs) / Math.max(1, expectedMs)
  return r < 0.85 ? r : 0.85 + 0.14 * (1 - Math.exp(-(r - 0.85) * 2.5))
}
