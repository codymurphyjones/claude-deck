import { app, net } from 'electron'
import { spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { autoUpdater } from 'electron-updater'
import type { ReleaseInfo, UpdateState } from '@shared/types'
import { broadcast, settings, updateSettings } from './context'
import { runtime } from './runtime'
import { compareVersions } from '@shared/version'

/** "owner/repo" from package.json "repository" (set once for the GitHub project). */
function repoSlug(): string | undefined {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8'))
    const r = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
    const m = /github(?:\.com[/:]|:)([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(r ?? '')
    return m?.[1]
  } catch {
    return undefined
  }
}

let state: UpdateState = { status: 'idle', current: app.getVersion() }
let timer: NodeJS.Timeout | undefined

function setState(patch: Partial<UpdateState>): void {
  state = { ...state, ...patch, current: app.getVersion() }
  broadcast('update:state', state)
}

export const updateState = (): UpdateState => state

/** Configure the feed for the chosen channel. Master builds are GitHub pre-releases. */
function configure(): boolean {
  const repo = repoSlug()
  if (!repo || !app.isPackaged) {
    setState({ status: 'disabled', error: !repo ? 'No GitHub repository configured' : 'Updates only run in the installed app' })
    return false
  }
  const [owner, name] = repo.split('/')
  const u = settings().updates
  autoUpdater.setFeedURL({ provider: 'github', owner, repo: name })
  autoUpdater.allowPrerelease = u.channel === 'latest'
  autoUpdater.allowDowngrade = false
  autoUpdater.autoDownload = u.auto && !u.heldVersion
  autoUpdater.autoInstallOnAppQuit = u.auto && !u.heldVersion
  return true
}

export function initUpdater(): void {
  // Remember the version we came from, so "roll back to previous" has a target.
  const u = settings().updates
  const cur = app.getVersion()
  if (u.lastVersion && u.lastVersion !== cur) updateSettings({ updates: { ...u, previousVersion: u.lastVersion, lastVersion: cur } })
  else if (!u.lastVersion) updateSettings({ updates: { ...u, lastVersion: cur } })

  autoUpdater.logger = null
  autoUpdater.on('checking-for-update', () => setState({ status: 'checking', error: undefined }))
  autoUpdater.on('update-not-available', () => setState({ status: 'none', checkedAt: Date.now() }))
  autoUpdater.on('update-available', (i) => setState({ status: autoUpdater.autoDownload ? 'downloading' : 'available', available: i.version, checkedAt: Date.now(), progress: 0 }))
  autoUpdater.on('download-progress', (p) => setState({ status: 'downloading', progress: Math.round(p.percent) }))
  autoUpdater.on('update-downloaded', (i) => setState({ status: 'ready', available: i.version, progress: 100 }))
  autoUpdater.on('error', (e) => {
    const msg = String(e?.message ?? e)
    // A repo with no published releases yet isn't an error from the user's point of view.
    if (/No published versions|Unable to find latest version|releases\.atom[\s\S]*404/i.test(msg)) setState({ status: 'none', checkedAt: Date.now(), error: undefined })
    else setState({ status: 'error', error: msg.split('\n')[0].slice(0, 200) })
  })

  if (!configure()) return
  setTimeout(() => void checkForUpdates(), 8_000)
  timer = setInterval(() => void checkForUpdates(), 30 * 60_000)
}

export async function checkForUpdates(): Promise<UpdateState> {
  if (!configure()) return state
  if (settings().updates.heldVersion) {
    setState({ status: 'held' })
    return state
  }
  try {
    await autoUpdater.checkForUpdates()
  } catch {
    /* reported through the 'error' event */
  }
  return state
}

export async function downloadUpdate(): Promise<void> {
  if (!configure()) return
  await autoUpdater.downloadUpdate()
}

export function installUpdate(): void {
  autoUpdater.quitAndInstall(false, true)
}

export function settingsChanged(): void {
  if (configure()) void checkForUpdates()
}

export function stopUpdater(): void {
  if (timer) clearInterval(timer)
}

// ---------------------------------------------------------------- version manager

export async function listReleases(): Promise<ReleaseInfo[]> {
  const repo = repoSlug()
  if (!repo) throw new Error('No GitHub repository configured')
  const res = await net.fetch(`https://api.github.com/repos/${repo}/releases?per_page=60`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'claude-deck' } })
  if (!res.ok) throw new Error(`GitHub returned ${res.status}${res.status === 403 ? ' (rate limited — try again later)' : ''}`)
  const list = (await res.json()) as {
    tag_name: string
    name: string
    prerelease: boolean
    draft: boolean
    published_at: string
    body: string
    html_url: string
    assets: { name: string; browser_download_url: string; size: number }[]
  }[]
  return list
    .filter((r) => !r.draft)
    .map((r) => {
      const exe = r.assets.find((a) => /\.exe$/i.test(a.name))
      return {
        tag: r.tag_name,
        version: r.tag_name.replace(/^v/, ''),
        name: r.name || r.tag_name,
        prerelease: r.prerelease,
        publishedAt: r.published_at,
        notes: r.body ?? '',
        url: r.html_url,
        installerUrl: exe?.browser_download_url,
        size: exe?.size
      }
    })
    .filter((r) => r.installerUrl)
}

/**
 * Install a specific version (usually an older one). The installer runs after the app
 * quits; auto-update is held on that version so it isn't immediately replaced.
 */
export async function installVersion(rel: ReleaseInfo): Promise<void> {
  if (!rel.installerUrl) throw new Error('This release has no Windows installer')
  if (!app.isPackaged) throw new Error('Switching versions only works in the installed app')
  const file = path.join(runtime.tempDir, `Claude-Deck-Setup-${rel.version}.exe`)
  setState({ status: 'downloading', available: rel.version, progress: 0 })
  const res = await net.fetch(rel.installerUrl)
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`)
  const total = Number(res.headers.get('content-length')) || rel.size || 0
  const out = fs.createWriteStream(file)
  let got = 0
  const reader = res.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    got += value.length
    out.write(Buffer.from(value))
    if (total) setState({ progress: Math.round((got / total) * 100) })
  }
  await new Promise<void>((r) => out.end(r))
  const isUpgrade = compareVersions(rel.version, app.getVersion()) > 0
  const u = settings().updates
  updateSettings({ updates: { ...u, heldVersion: isUpgrade ? undefined : rel.version } })
  // Same flags electron-updater uses: silent install into the existing location, then relaunch.
  spawn(file, ['/S', '--force-run'], { detached: true, stdio: 'ignore' }).unref()
  setTimeout(() => app.quit(), 300)
}

export function releaseHold(): void {
  const u = settings().updates
  updateSettings({ updates: { ...u, heldVersion: undefined } })
  settingsChanged()
}
