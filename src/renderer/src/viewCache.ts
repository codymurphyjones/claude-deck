// Last-known data for views that reload from git/GitHub (Review, Repository, Pull requests), so
// switching tabs shows the previous result at once while the refresh runs. In memory only.
//
// Bounded by entry count and by total weight (callers pass e.g. diff lines), so a few huge diffs
// can't pin hundreds of MB in the renderer. Least recently used entries go first.

const MAX_ENTRIES = 60
/** Total weight kept; for diffs, ~200k lines is roughly 20–40 MB of hunks. */
const MAX_WEIGHT = 200_000

const cache = new Map<string, { value: unknown; weight: number }>()
let total = 0

export function cacheGet<T>(key: string): T | undefined {
  const e = cache.get(key)
  if (!e) return undefined
  // Re-insert so recently read entries survive the caps too.
  cache.delete(key)
  cache.set(key, e)
  return e.value as T
}

/** Remember `value` under `key`. An entry heavier than a quarter of the budget isn't kept. */
export function cacheSet<T>(key: string, value: T, weight = 1): void {
  const old = cache.get(key)
  if (old) {
    cache.delete(key)
    total -= old.weight
  }
  if (weight > MAX_WEIGHT / 4) return
  cache.set(key, { value, weight })
  total += weight
  while (cache.size > MAX_ENTRIES || total > MAX_WEIGHT) {
    const [k, e] = cache.entries().next().value as [string, { weight: number }]
    cache.delete(k)
    total -= e.weight
  }
}
