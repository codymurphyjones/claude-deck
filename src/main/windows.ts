import { app, BrowserWindow, Menu, nativeImage, nativeTheme, screen, shell, Tray } from 'electron'
import * as path from 'path'
import { BUILTIN_THEMES } from '@shared/themes'
import { broadcast, settings } from './context'
import type { SessionService } from './sessions/sessionService'
import { run } from './util'

type DeckWindow = BrowserWindow & { deckMain?: boolean }

const preload = path.join(__dirname, '../preload/index.js')

function rendererUrl(page: 'index' | 'buddy', query = ''): { url?: string; file?: string; query?: Record<string, string> } {
  const q = Object.fromEntries(new URLSearchParams(query))
  if (process.env.ELECTRON_RENDERER_URL) return { url: `${process.env.ELECTRON_RENDERER_URL}/${page}.html${query ? '?' + query : ''}` }
  return { file: path.join(__dirname, `../renderer/${page}.html`), query: q }
}

function load(win: BrowserWindow, page: 'index' | 'buddy', query = ''): void {
  const r = rendererUrl(page, query)
  if (r.url) void win.loadURL(r.url)
  else void win.loadFile(r.file!, { query: r.query })
}

export function currentTheme() {
  const s = settings()
  const all = [...BUILTIN_THEMES, ...s.customThemes]
  const dark = s.themeMode === 'dark' || (s.themeMode === 'system' && nativeTheme.shouldUseDarkColors)
  return all.find((t) => t.id === (dark ? s.darkTheme : s.lightTheme)) ?? BUILTIN_THEMES[0]
}

export class WindowManager {
  main: DeckWindow | undefined
  private buddy: BrowserWindow | undefined
  private popouts = new Map<string, BrowserWindow>()
  private tray: Tray | undefined
  quitting = false
  hasBackgroundWork: () => boolean = () => false

  constructor(private sessions: SessionService) {}

  createMain(): BrowserWindow {
    const theme = currentTheme()
    const s = settings()
    const win: DeckWindow = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 720,
      minHeight: 420,
      show: false,
      title: 'Claude Deck',
      backgroundColor: s.translucentSidebar && process.platform === 'win32' ? '#00000000' : theme.ui.bg,
      ...(s.translucentSidebar && process.platform === 'win32' ? { backgroundMaterial: 'mica' as const } : {}),
      titleBarStyle: 'hidden',
      titleBarOverlay: process.platform === 'darwin' ? true : { color: '#00000000', symbolColor: theme.ui.text, height: 40 },
      alwaysOnTop: s.alwaysOnTop,
      webPreferences: { preload, sandbox: false, contextIsolation: true, webviewTag: true, spellcheck: false, plugins: true }
    })
    win.deckMain = true
    this.main = win
    win.once('ready-to-show', () => win.show())
    win.on('focus', () => win.flashFrame(false))
    win.on('close', (e) => {
      if (!this.quitting && this.hasBackgroundWork()) {
        e.preventDefault()
        win.hide()
        this.ensureTray()
      }
    })
    win.on('closed', () => {
      this.main = undefined
      if (!this.quitting) app.quit()
    })
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    win.webContents.on('will-navigate', (e, url) => {
      if (!url.startsWith(process.env.ELECTRON_RENDERER_URL ?? 'file:')) e.preventDefault()
    })
    load(win, 'index')
    return win
  }

  private ensureTray(): void {
    if (this.tray) return
    const icon = nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAOElEQVR4nGNgGAWjYBSMAgYGBob/DAwM/xkYGBgYmRgYGBgYGBj+MzAw/GdgYGBgZGJgYGBgAACqUQUHkAZf8wAAAABJRU5ErkJggg=='
    )
    this.tray = new Tray(icon)
    this.tray.setToolTip('Claude Deck — scheduled tasks keep running')
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Show Claude Deck', click: () => this.focusMain() },
        { type: 'separator' },
        {
          label: 'Quit',
          click: () => {
            this.quitting = true
            app.quit()
          }
        }
      ])
    )
    this.tray.on('click', () => this.focusMain())
  }

  focusMain(): void {
    if (!this.main) {
      this.createMain()
      return
    }
    if (this.main.isMinimized()) this.main.restore()
    this.main.show()
    this.main.focus()
  }

  setOverlay(webContentsId: number, color: string, symbolColor: string): void {
    const win = BrowserWindow.getAllWindows().find((w) => w.webContents.id === webContentsId)
    if (!win || process.platform === 'darwin') return
    try {
      win.setTitleBarOverlay({ color, symbolColor, height: 40 })
    } catch {
      /* window without overlay */
    }
  }

  applySettings(): void {
    const s = settings()
    for (const w of BrowserWindow.getAllWindows()) {
      if ((w as DeckWindow).deckMain) {
        w.setAlwaysOnTop(s.alwaysOnTop)
        if (process.platform === 'win32') {
          try {
            w.setBackgroundMaterial(s.translucentSidebar ? 'mica' : 'none')
            w.setBackgroundColor(s.translucentSidebar ? '#00000000' : currentTheme().ui.bg)
          } catch {
            /* older Windows */
          }
        }
      }
    }
    this.toggleBuddy(s.buddy)
  }

  /** Move a session's terminal into its own window. */
  popOut(sessionId: string): void {
    const s = this.sessions.sessions.get(sessionId)
    if (!s) return
    const theme = currentTheme()
    const win = new BrowserWindow({
      width: 960,
      height: 640,
      title: s.name,
      backgroundColor: theme.ui.bg,
      titleBarStyle: 'hidden',
      titleBarOverlay: process.platform === 'darwin' ? true : { color: theme.ui.panel, symbolColor: theme.ui.text, height: 40 },
      webPreferences: { preload, sandbox: false, contextIsolation: true, spellcheck: false }
    })
    this.popouts.get(sessionId)?.close()
    this.popouts.set(sessionId, win)
    const prevHost = s.hostWindow
    s.hostWindow = win.webContents.id
    broadcast('session:update', { ...s })
    win.on('closed', () => {
      if (this.popouts.get(sessionId) === win) this.popouts.delete(sessionId)
      const cur = this.sessions.sessions.get(sessionId)
      if (cur && cur.hostWindow !== prevHost) {
        cur.hostWindow = this.main?.webContents.id ?? prevHost
        broadcast('session:update', { ...cur })
      }
    })
    load(win, 'index', `popout=${encodeURIComponent(sessionId)}`)
  }

  popIn(sessionId: string): void {
    this.popouts.get(sessionId)?.close()
  }

  toggleBuddy(show: boolean): void {
    if (!show) {
      this.buddy?.close()
      this.buddy = undefined
      return
    }
    if (this.buddy && !this.buddy.isDestroyed()) return
    const area = screen.getPrimaryDisplay().workArea
    this.buddy = new BrowserWindow({
      width: 260,
      height: 320,
      x: area.x + area.width - 280,
      y: area.y + area.height - 340,
      frame: false,
      transparent: true,
      resizable: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      webPreferences: { preload, sandbox: false, contextIsolation: true }
    })
    this.buddy.setAlwaysOnTop(true, 'floating')
    this.buddy.on('closed', () => (this.buddy = undefined))
    load(this.buddy, 'buddy')
  }

  /** Windows Explorer "Open in Claude Deck" context-menu entries (HKCU, no admin needed). */
  async registerExplorerMenu(on: boolean): Promise<void> {
    if (process.platform !== 'win32') throw new Error('Only available on Windows')
    const exe = process.execPath
    const appArg = app.isPackaged ? '' : ` "${app.getAppPath()}"`
    const keys = [
      ['HKCU\\Software\\Classes\\Directory\\shell\\ClaudeDeck', '%1'],
      ['HKCU\\Software\\Classes\\Directory\\Background\\shell\\ClaudeDeck', '%V'],
      ['HKCU\\Software\\Classes\\*\\shell\\ClaudeDeck', '%1']
    ]
    for (const [key, arg] of keys) {
      if (!on) {
        await run('reg', ['delete', key, '/f'])
        continue
      }
      await run('reg', ['add', key, '/ve', '/d', 'Open in Claude Deck', '/f'])
      await run('reg', ['add', key, '/v', 'Icon', '/d', exe, '/f'])
      await run('reg', ['add', `${key}\\command`, '/ve', '/d', `"${exe}"${appArg} "${arg}"`, '/f'])
    }
  }
}
