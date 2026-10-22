import { dataRows, decodeJobCard, encodeJobCard, sameJob, writeDataStrip, type JobCard } from '@shared/jobCard'
import { uniqueId, type JobDef, type JobSource } from '@shared/jobs'
import { api, errMsg } from './api'
import { activeSession, get, loadJobs, loadRoutines, set, toast } from './store'

// Copy a routine or repo job to the clipboard as an image card, and paste one
// back with Ctrl+V anywhere outside a text field. See @shared/jobCard for the encoding.

const WIDTH = 560
const PAD = 22
const NOUN: Record<JobSource, string> = { routine: 'Routine', repo: 'Repo job' }

function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
}

/** Greedy word wrap to at most `max` lines, ellipsizing the last. */
function wrap(ctx: CanvasRenderingContext2D, text: string, width: number, max: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word
    if (ctx.measureText(next).width <= width || !line) line = next
    else {
      lines.push(line)
      line = word
    }
  }
  if (line) lines.push(line)
  const out = lines.slice(0, max)
  if (lines.length > max || (out.length && ctx.measureText(out[out.length - 1]).width > width)) {
    let last = out[out.length - 1]
    while (last && ctx.measureText(last + '…').width > width) last = last.slice(0, -1)
    out[out.length - 1] = last + '…'
  }
  return out
}

/** Draw the readable card and append the data strip; returns a PNG data URL. */
function renderCard(card: JobCard, bytes: Uint8Array): string {
  const { job } = card
  const font = cssVar('--ui-font', 'system-ui, sans-serif')
  const c = { bg: cssVar('--panel', '#1c1d21'), border: cssVar('--border', '#2e3036'), text: cssVar('--text', '#e6e6e9'), muted: cssVar('--muted', '#8d909a'), accent: cssVar('--accent', '#d97757') }
  const measure = document.createElement('canvas').getContext('2d')!
  measure.font = `13px ${font}`
  const desc = job.description.trim() ? wrap(measure, job.description.trim(), WIDTH - PAD * 2, 2) : []
  const shown = job.steps.slice(0, 6)
  const more = job.steps.length - shown.length
  const cardH = PAD + 16 + 30 + desc.length * 19 + (desc.length ? 10 : 0) + 14 + (shown.length + (more ? 1 : 0)) * 21 + 14 + 16 + PAD
  const rows = dataRows(bytes.length, WIDTH)

  const cv = document.createElement('canvas')
  cv.width = WIDTH
  cv.height = cardH + rows
  const ctx = cv.getContext('2d')!
  ctx.fillStyle = c.bg
  ctx.fillRect(0, 0, cv.width, cv.height)
  ctx.fillStyle = c.accent
  ctx.fillRect(0, 0, 4, cardH)
  ctx.textBaseline = 'top'

  let y = PAD
  ctx.fillStyle = c.accent
  ctx.font = `600 11px ${font}`
  ctx.fillText(`${NOUN[card.kind].toUpperCase()} · ${job.steps.length} STEP${job.steps.length === 1 ? '' : 'S'}`, PAD, y)
  y += 16
  ctx.fillStyle = c.text
  ctx.font = `600 20px ${font}`
  ctx.fillText(wrap(ctx, job.name, WIDTH - PAD * 2, 1)[0] ?? '', PAD, y)
  y += 30
  ctx.font = `13px ${font}`
  ctx.fillStyle = c.muted
  for (const l of desc) {
    ctx.fillText(l, PAD, y)
    y += 19
  }
  if (desc.length) y += 10
  ctx.fillStyle = c.border
  ctx.fillRect(PAD, y, WIDTH - PAD * 2, 1)
  y += 14
  ctx.font = `13px ${font}`
  shown.forEach((s, i) => {
    ctx.fillStyle = c.accent
    ctx.fillText(`${i + 1}`, PAD, y)
    ctx.fillStyle = c.text
    ctx.fillText(wrap(ctx, s.title, WIDTH - PAD * 2 - 24, 1)[0] ?? '', PAD + 24, y)
    y += 21
  })
  if (more) {
    ctx.fillStyle = c.muted
    ctx.fillText(`+ ${more} more step${more === 1 ? '' : 's'}`, PAD + 24, y)
    y += 21
  }
  y += 14
  ctx.fillStyle = c.muted
  ctx.font = `11px ${font}`
  ctx.fillText('Claude Deck · copy this image, then press Ctrl+V in Claude Deck to import it', PAD, y)

  const img = ctx.getImageData(0, cardH, WIDTH, rows)
  writeDataStrip(bytes, img.data, WIDTH, 0)
  ctx.putImageData(img, 0, cardH)
  return cv.toDataURL('image/png')
}

export async function copyJobCard(kind: JobSource, job: JobDef): Promise<void> {
  try {
    const card: JobCard = { kind, job }
    await api.clipboard.writeImage(renderCard(card, await encodeJobCard(card)))
    toast(`${NOUN[kind]} “${job.name}” copied as an image — paste it anywhere`, 'success')
  } catch (e) {
    toast(`Couldn't copy: ${errMsg(e)}`, 'error')
  }
}

async function readClipboardCard(): Promise<JobCard | undefined> {
  const url = await api.clipboard.readImage()
  const m = url && /^data:([^;]+);base64,/.exec(url)
  if (!url || !m) return undefined
  const bin = atob(url.slice(m[0].length))
  const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0))
  const bmp = await createImageBitmap(new Blob([bytes], { type: m[1] }), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })
  const cv = new OffscreenCanvas(bmp.width, bmp.height)
  const ctx = cv.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(bmp, 0, 0)
  bmp.close()
  return decodeJobCard(ctx.getImageData(0, 0, cv.width, cv.height).data, cv.width, cv.height)
}

function flash(kind: JobSource, slug: string): void {
  set({ flash: { kind, slug } })
  setTimeout(() => {
    if (get().flash?.slug === slug) set({ flash: undefined })
  }, 2600)
}

function showRoutine(slug: string): void {
  set({ sidebarOpen: true, sidebarView: 'routines' })
  flash('routine', slug)
}

function showJob(root: string, slug: string): void {
  set({ sidebarOpen: true, sidebarView: 'jobs', jobsRoot: root })
  flash('repo', slug)
}

/** The repository the focused chat works in (a worktree chat maps back to its main repo). */
function focusedRepo(): string | undefined {
  const s = activeSession()
  if (!s || s.kind === 'login') return undefined
  const wt = s.worktreeId ? get().library.worktrees.find((w) => w.id === s.worktreeId) : undefined
  return wt?.repoRoot ?? s.root
}

async function pasteRoutine(job: JobDef): Promise<void> {
  const existing = get().routineDefs ?? (await loadRoutines())
  const clash = existing.find((r) => r.slug === job.slug)
  let input = job
  if (clash) {
    if (sameJob(clash, job)) {
      toast(`Routine “${clash.name}” is already in your routines`)
      return showRoutine(clash.slug)
    }
    const c = await api.dialog.confirm(`A routine named "${clash.name}" already exists.`, 'Keep both, or replace the existing routine with the pasted one?', ['Keep both', 'Replace', 'Cancel'])
    if (c === 2 || c < 0) return
    if (c === 0) {
      const name = `${job.name} (copy)`
      input = { ...job, name, slug: uniqueId(name, existing.map((r) => r.slug)) }
    }
  }
  const saved = await api.routines.save(input).catch((e) => void toast(errMsg(e), 'error'))
  if (!saved) return
  await loadRoutines()
  toast(`Routine “${saved.name}” added`, 'success')
  showRoutine(saved.slug)
}

async function pasteRepoJob(job: JobDef): Promise<void> {
  const root = focusedRepo()
  if (!root) return toast('Focus a chat in a repository to paste a repo job into it', 'error')
  const repoName = root.split(/[\\/]/).pop()
  const existing = await loadJobs(root)
  const clash = existing.find((j) => j.slug === job.slug || j.name.trim().toLowerCase() === job.name.trim().toLowerCase())
  if (clash) {
    toast(`“${clash.name}” already exists in ${repoName}'s repo_jobs — nothing was added`, 'error')
    return showJob(root, clash.slug)
  }
  const saved = await api.jobs.save(root, job).catch((e) => void toast(errMsg(e), 'error'))
  if (!saved) return
  await loadJobs(root)
  toast(`Repo job “${saved.name}” added to ${repoName}`, 'success')
  showJob(root, saved.slug)
}

let pasting = false

/** Paste a job card from the clipboard, if there is one. Resolves false when the clipboard holds something else. */
export async function pasteJobCard(): Promise<boolean> {
  if (pasting) return true
  pasting = true
  try {
    const card = await readClipboardCard().catch(() => undefined)
    if (!card) return false
    if (card.kind === 'routine') await pasteRoutine(card.job)
    else await pasteRepoJob(card.job)
    return true
  } finally {
    pasting = false
  }
}

/** What Ctrl+C copies: the routine / job list item under the pointer, else the saved one open in the designer. */
function copyTarget(): JobCard | undefined {
  const s = get()
  const el = [...document.querySelectorAll<HTMLElement>('[data-card-slug]')].find((x) => x.matches(':hover'))
  const find = (kind: JobSource, slug?: string, root?: string): JobCard | undefined => {
    const job = (kind === 'routine' ? s.routineDefs : root ? s.jobDefs[root] : undefined)?.find((j) => j.slug === slug)
    return job && { kind, job }
  }
  if (el) return find(el.dataset.cardKind === 'routine' ? 'routine' : 'repo', el.dataset.cardSlug, el.dataset.cardRoot)
  if (s.routineEdit && s.routineEdit.slug) return find('routine', s.routineEdit.slug)
  if (s.jobEdit && s.jobEdit.slug) return find('repo', s.jobEdit.slug, s.jobEdit.root)
  return undefined
}

/** Ctrl+C outside text: copy the routine / job the user is pointing at. False when there is nothing to copy. */
export function copyPointedJobCard(): boolean {
  if (window.getSelection()?.toString()) return false
  const card = copyTarget()
  if (!card) return false
  void copyJobCard(card.kind, card.job)
  return true
}

/** Elements where Ctrl+V means "paste text": form fields, editors and terminals. */
export function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  if (!el?.closest) return false
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable || !!el.closest('.xterm, .cm-editor, .file-editor')
}
