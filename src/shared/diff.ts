import type { DiffFile, DiffHunk } from './types'

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/** Parse `git diff` unified output into files and hunks. */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = []
  const lines = text.split('\n')
  let file: DiffFile | null = null
  let hunk: DiffHunk | null = null

  const finishFile = (): void => {
    if (file) files.push(file)
    file = null
    hunk = null
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('diff --git ')) {
      finishFile()
      const m = /^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/.exec(line)
      file = {
        oldPath: m?.[1] ?? '',
        newPath: m?.[2] ?? '',
        headerLines: [line],
        hunks: [],
        binary: false,
        status: 'modified',
        additions: 0,
        deletions: 0
      }
      continue
    }
    if (!file) continue
    const f: DiffFile = file
    if (!hunk) {
      if (line.startsWith('@@')) {
        // fall through to hunk handling below
      } else {
        if (line.startsWith('new file mode')) f.status = 'added'
        else if (line.startsWith('deleted file mode')) f.status = 'deleted'
        else if (line.startsWith('rename from ')) {
          f.status = 'renamed'
          f.oldPath = line.slice('rename from '.length)
        } else if (line.startsWith('rename to ')) f.newPath = line.slice('rename to '.length)
        else if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) f.binary = true
        else if (line.startsWith('--- ')) {
          const p = line.slice(4)
          if (p !== '/dev/null') f.oldPath = stripPrefix(p)
        } else if (line.startsWith('+++ ')) {
          const p = line.slice(4)
          if (p !== '/dev/null') f.newPath = stripPrefix(p)
        }
        f.headerLines.push(line)
        continue
      }
    }
    const hm = HUNK_RE.exec(line)
    if (hm) {
      hunk = {
        header: line,
        oldStart: +hm[1],
        oldLines: hm[2] === undefined ? 1 : +hm[2],
        newStart: +hm[3],
        newLines: hm[4] === undefined ? 1 : +hm[4],
        lines: []
      }
      f.hunks.push(hunk)
      continue
    }
    if (hunk) {
      const h: DiffHunk = hunk
      if (line.startsWith('+')) {
        f.additions++
        h.lines.push(line)
      } else if (line.startsWith('-')) {
        f.deletions++
        h.lines.push(line)
      } else if (line.startsWith(' ') || line.startsWith('\\')) h.lines.push(line)
      else if (line === '' && i < lines.length - 1) h.lines.push(' ')
    }
  }
  finishFile()
  return files
}

function stripPrefix(p: string): string {
  const q = p.replace(/^"|"$/g, '')
  return q.startsWith('a/') || q.startsWith('b/') ? q.slice(2) : q
}

/** Build a patch containing only one hunk of a file, suitable for `git apply`. */
export function buildHunkPatch(file: DiffFile, hunkIndex: number): string {
  const header = file.headerLines.filter(
    (l) =>
      l.startsWith('diff --git') ||
      l.startsWith('--- ') ||
      l.startsWith('+++ ') ||
      l.startsWith('new file mode') ||
      l.startsWith('deleted file mode') ||
      l.startsWith('old mode') ||
      l.startsWith('new mode')
  )
  const h = file.hunks[hunkIndex]
  return [...header, h.header, ...h.lines].join('\n') + '\n'
}

/** Build a full patch for a file (all hunks). */
export function buildFilePatch(file: DiffFile): string {
  return [...file.headerLines, ...file.hunks.flatMap((h) => [h.header, ...h.lines])].join('\n') + '\n'
}

/** Line numbers for rendering: returns [oldNo, newNo] for each hunk line. */
export function numberHunkLines(h: DiffHunk): [number | null, number | null][] {
  let o = h.oldStart
  let n = h.newStart
  return h.lines.map((l) => {
    if (l.startsWith('+')) return [null, n++]
    if (l.startsWith('-')) return [o++, null]
    if (l.startsWith('\\')) return [null, null]
    return [o++, n++]
  })
}
