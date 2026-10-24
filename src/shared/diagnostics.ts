export type DiagLevel = 'info' | 'warn' | 'error'

/** One diagnostics log line, as kept in memory and shown in Settings → Diagnostics. */
export interface DiagEntry {
  at: number
  level: DiagLevel
  /** Where it came from: `ipc:<channel>`, `main`, `renderer`… */
  source: string
  message: string
  stack?: string
}

/** The log file's text form of an entry: one header line, then the stack (if any) indented. */
export function formatDiagEntry(e: DiagEntry): string {
  const head = `${new Date(e.at).toISOString()} ${e.level.toUpperCase().padEnd(5)} [${e.source}] ${e.message}`
  return e.stack ? `${head}\n${e.stack.replace(/^/gm, '    ')}` : head
}
