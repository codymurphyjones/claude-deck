// Prettier check for *new* files only (added since HEAD, or untracked). Most existing files predate
// .prettierrc.json and differ from it in places; formatting them wholesale would bury real changes in
// a reformat diff, so the rule is: new files start clean, old files keep their current shape.
//   node scripts/format-check.mjs            check new files
//   node scripts/format-check.mjs --changed  also check modified files (expect noise in old ones)
//   node scripts/format-check.mjs --write    format new files in place
import { execFileSync, spawnSync } from 'child_process'

const args = process.argv.slice(2)
const git = (...a) =>
  execFileSync('git', a, { encoding: 'utf8' })
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
const files = new Set([...git('diff', '--name-only', '--diff-filter=A', 'HEAD'), ...git('ls-files', '--others', '--exclude-standard')])
if (args.includes('--changed')) for (const f of git('diff', '--name-only', '--diff-filter=M', 'HEAD')) files.add(f)
const targets = [...files].filter((f) => /\.(c|m)?(t|j)sx?$|\.(css|json|html)$/.test(f))
if (!targets.length) {
  console.log('No new files to check.')
  process.exit(0)
}
const r = spawnSync('npx', ['prettier', args.includes('--write') ? '--write' : '--check', '--ignore-unknown', ...targets], { stdio: 'inherit', shell: process.platform === 'win32' })
process.exit(r.status ?? 1)
