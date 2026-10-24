import { useSyncExternalStore } from 'react'

// Some rendering code loads on demand (the full highlight.js language set, KaTeX). Output rendered
// before such a chunk arrives is a plain fallback; when it lands, the version bumps and components
// that render with it (markdown, tool cards) re-render with the real thing.

let version = 0
const listeners = new Set<() => void>()

/** Signal that more rendering code is available. */
export function bumpRenderVersion(): void {
  version++
  for (const l of listeners) l()
}

export function subscribeRenderVersion(cb: () => void): () => void {
  listeners.add(cb)
  return () => void listeners.delete(cb)
}

export const renderVersion = (): number => version

/** Re-render when on-demand rendering code (languages, math) finishes loading. */
export function useRenderVersion(): number {
  return useSyncExternalStore(subscribeRenderVersion, renderVersion)
}
