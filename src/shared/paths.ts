// Pure path helpers (no fs) so they can be unit-tested and shared.

export function normalizeKey(p: string, win32: boolean): string {
  let s = p.replace(/\\/g, '/')
  if (s.length > 1 && s.endsWith('/') && !/^[A-Za-z]:\/$/.test(s)) s = s.slice(0, -1)
  return win32 ? s.toLowerCase() : s
}

/** Claude Code stores transcripts under ~/.claude/projects/<encoded cwd>. */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

export function baseName(p: string): string {
  const parts = p.replace(/\\/g, '/').replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || p
}

/** Unique folders from resolved drop targets, preserving order. */
export function uniqueFolders(folders: string[], win32: boolean): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const f of folders) {
    const k = normalizeKey(f, win32)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(f)
  }
  return out
}

/** Relative path key used for claims, stable across worktrees of one repo. */
export function claimKey(filePath: string, root: string, win32: boolean): string {
  const f = normalizeKey(filePath, win32)
  const r = normalizeKey(root, win32)
  if (f === r) return '.'
  if (f.startsWith(r + '/')) return f.slice(r.length + 1)
  return f
}

/** Minimal gitignore-style glob → RegExp, used for .worktreeinclude. */
export function globToRegExp(pattern: string): RegExp {
  let p = pattern.trim().replace(/\\/g, '/')
  const anchored = p.startsWith('/')
  if (anchored) p = p.slice(1)
  const dirOnly = p.endsWith('/')
  if (dirOnly) p = p.slice(0, -1)
  let re = ''
  for (let i = 0; i < p.length; i++) {
    const c = p[i]
    if (c === '*') {
      if (p[i + 1] === '*') {
        re += '.*'
        i++
        if (p[i + 1] === '/') i++
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else if ('.+^${}()|[]'.includes(c)) re += '\\' + c
    else re += c
  }
  const prefix = anchored || p.includes('/') ? '^' : '(^|.*/)'
  return new RegExp(prefix + re + '(/.*)?$')
}
