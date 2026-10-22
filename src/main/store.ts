import * as fs from 'fs'
import * as path from 'path'
import { ensureDir } from './util'

/** Small JSON-file store with debounced, atomic writes. */
export class JsonStore<T extends object> {
  data: T
  private timer: NodeJS.Timeout | undefined

  constructor(
    private file: string,
    defaults: T
  ) {
    ensureDir(path.dirname(file))
    let loaded: Partial<T> = {}
    try {
      loaded = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      /* first run or corrupt file: fall back to defaults */
    }
    this.data = mergeDefaults(defaults, loaded)
  }

  update(fn: (d: T) => void): void {
    fn(this.data)
    this.scheduleSave()
  }

  scheduleSave(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.saveNow(), 300)
  }

  saveNow(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    const tmp = this.file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2))
    fs.renameSync(tmp, this.file)
  }
}

function mergeDefaults<T>(defaults: T, loaded: unknown): T {
  if (Array.isArray(defaults)) return (Array.isArray(loaded) ? loaded : defaults) as T
  if (defaults && typeof defaults === 'object') {
    const out: Record<string, unknown> = { ...(defaults as Record<string, unknown>) }
    if (loaded && typeof loaded === 'object') {
      for (const [k, v] of Object.entries(loaded as Record<string, unknown>)) {
        const d = (defaults as Record<string, unknown>)[k]
        out[k] = d && typeof d === 'object' && !Array.isArray(d) ? mergeDefaults(d, v) : v
      }
    }
    return out as T
  }
  return (loaded === undefined ? defaults : loaded) as T
}
