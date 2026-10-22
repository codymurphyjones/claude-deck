// Decide the semver bump for a release from the commit messages since the last one.
//
//   major  "type!: …" / "type(scope)!: …", a "BREAKING CHANGE:" footer, or a [major] / #major marker
//   minor  "feat: …", a [minor] / #minor marker, or a subject that adds something
//          ("add", "adding", "new", "feature", "implement", "introduce", "support for")
//   patch  everything else
//
// Major is only ever taken from explicit markers, never guessed from wording.

const RANK = { patch: 0, minor: 1, major: 2 }

/** Bump level implied by one full commit message, with the reason. */
export function classifyCommit(message) {
  const [subject = '', ...rest] = message.trim().split('\n')
  const body = rest.join('\n')
  // Strip a leading author tag like "CJ | ".
  const s = subject.replace(/^\s*[\w.-]{1,12}\s*\|\s*/, '').trim()
  if (/\[major\]|#major\b/i.test(message)) return { level: 'major', reason: '[major] marker' }
  if (/^\w+(\([^)]*\))?!:/.test(s)) return { level: 'major', reason: 'breaking "!" commit' }
  if (/^BREAKING[ -]CHANGE:/m.test(body)) return { level: 'major', reason: 'BREAKING CHANGE footer' }
  if (/\[minor\]|#minor\b/i.test(message)) return { level: 'minor', reason: '[minor] marker' }
  if (/\[patch\]|#patch\b/i.test(message)) return { level: 'patch', reason: '[patch] marker' }
  if (/^feat(\([^)]*\))?:/i.test(s)) return { level: 'minor', reason: 'feat commit' }
  if (/^\w+(\([^)]*\))?:/.test(s)) return { level: 'patch', reason: `${s.split(/[(:]/)[0]} commit` }
  if (/^(add|adds|added|adding|new|feature|implement|implements|implemented|implementing|introduce|introduces|introducing)\b|\bsupport for\b/i.test(s))
    return { level: 'minor', reason: 'adds functionality' }
  return { level: 'patch', reason: 'fix / change' }
}

/** Highest bump across all commits (release commits are ignored). */
export function decideBump(messages) {
  let level = 'patch'
  const decisive = []
  for (const m of messages) {
    if (/^Release v\d/.test(m.trim())) continue
    const c = classifyCommit(m)
    if (RANK[c.level] > RANK[level]) {
      level = c.level
      decisive.length = 0
    }
    if (c.level === level) decisive.push({ subject: m.trim().split('\n')[0], reason: c.reason })
  }
  return { level, decisive }
}

/** [maj, min, pat] bumped by `level`. */
export function bump([maj, min, pat], level) {
  if (level === 'major') return [maj + 1, 0, 0]
  if (level === 'minor') return [maj, min + 1, 0]
  return [maj, min, pat + 1]
}
