// Last-known data for views that reload from git/GitHub (Review, Repository, Pull requests), so
// switching tabs shows the previous result at once while the refresh runs. In memory only.

const MAX = 60
const cache = new Map<string, unknown>()

export function cacheGet<T>(key: string): T | undefined {
  return cache.get(key) as T | undefined
}

export function cacheSet<T>(key: string, value: T): void {
  // Re-insert so the most recently used entries survive the size cap.
  cache.delete(key)
  cache.set(key, value)
  while (cache.size > MAX) cache.delete(cache.keys().next().value as string)
}
