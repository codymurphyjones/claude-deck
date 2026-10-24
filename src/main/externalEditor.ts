import { shell } from 'electron'
import { run, which } from './util'

/** Open a file in the user's editor: VS Code / Cursor at `line` when installed, else the OS default app. */
export async function openInExternalEditor(p: string, line?: number): Promise<void> {
  const code = which('code') ?? which('cursor')
  if (code) {
    await run(code, ['-g', line ? `${p}:${line}` : p], { timeout: 15_000 })
    return
  }
  await shell.openPath(p)
}
