// The open browser pane, as a handle the agent's open_browser tool can drive (agentRequests.ts).

export interface BrowserControl {
  /** Load a URL and resolve once it has finished loading (or failed, or timed out). */
  navigate: (url: string) => Promise<void>
  url: () => string
  /** The page's title and visible text. */
  text: () => Promise<string>
  /** Console messages since the last navigation. */
  console: () => string[]
  /** A screenshot of the visible page, saved to a file; returns its path. */
  screenshot: () => Promise<string>
}

let current: BrowserControl | null = null

export function registerBrowser(c: BrowserControl): () => void {
  current = c
  return () => {
    if (current === c) current = null
  }
}

export const browserControl = (): BrowserControl | null => current
