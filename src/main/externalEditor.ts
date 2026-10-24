import { shell } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { run, which } from './util'

/** How a file was shown: in VS Code / Cursor, the OS default app, or selected in its folder. */
export type OpenedWith = 'editor' | 'default-app' | 'folder'

/**
 * Types the OS would run rather than open. Never handed to the default app: a repo file or an
 * agent's path must not become code execution. They're shown in their folder instead.
 */
const RUNNABLE = new Set(
  [
    ...(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC').split(';'),
    '.exe', '.com', '.bat', '.cmd', '.ps1', '.psm1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.hta', '.msc', '.msi', '.msp',
    '.scr', '.pif', '.cpl', '.lnk', '.url', '.reg', '.inf', '.jar', '.appref-ms', '.application', '.settingcontent-ms',
    '.app', '.command', '.sh', '.desktop', '.appimage'
  ].map((e) => e.toLowerCase())
)

/**
 * Open a file in the user's editor: VS Code / Cursor at `line` when installed, else the OS default
 * app (or, for runnable files, its folder). Throws if nothing could open it.
 */
export async function openInExternalEditor(p: string, line?: number): Promise<OpenedWith> {
  const target = line ? `${p}:${line}` : p
  for (const name of ['code', 'cursor']) {
    const cmd = editorCommand(name, ['-g', target])
    if (!cmd) continue
    const r = await run(cmd.file, cmd.args, { timeout: 15_000, env: cmd.env })
    if (r.code === 0) return 'editor'
  }
  if (RUNNABLE.has(path.extname(p).toLowerCase())) {
    shell.showItemInFolder(p)
    return 'folder'
  }
  const err = await shell.openPath(p)
  if (err) throw new Error(`Could not open ${p}: ${err}`)
  return 'default-app'
}

/**
 * The editor's CLI as a direct, shell-free invocation. On Windows `code`/`cursor` are .cmd shims,
 * which Node can only run through cmd.exe, where unquoted paths break on spaces and `&` in a file
 * name runs a command. The shim just runs `<App>.exe <cli.js> %*` with ELECTRON_RUN_AS_NODE=1, so
 * do that ourselves.
 */
function editorCommand(name: string, args: string[]): { file: string; args: string[]; env?: NodeJS.ProcessEnv } | undefined {
  const found = which(name)
  if (!found) return undefined
  if (process.platform !== 'win32' || !/\.(cmd|bat)$/i.test(found)) return { file: found, args }
  let shim: string
  try {
    shim = fs.readFileSync(found, 'utf8')
  } catch {
    return undefined
  }
  const m = /"%~dp0([^"]+\.exe)"\s+"%~dp0([^"]+\.js)"\s+%\*/i.exec(shim)
  if (!m) return undefined
  const dir = path.dirname(found)
  const exe = path.resolve(dir, m[1])
  const cli = path.resolve(dir, m[2])
  if (!fs.existsSync(exe) || !fs.existsSync(cli)) return undefined
  const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  delete env.VSCODE_DEV
  return { file: exe, args: [cli, ...args], env }
}
