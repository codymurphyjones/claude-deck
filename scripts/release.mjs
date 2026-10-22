// Cut a stable release: work out the next version, commit it, tag vX.Y.Z and push both.
// The tag push triggers .github/workflows/release.yml, which builds and publishes it.
//   npm run release                  -> bump decided from commits since the latest stable tag
//   npm run release -- minor         -> force major | minor | patch
//   npm run release -- --dry-run     -> print the decision, change nothing
// See scripts/release-bump.mjs for how commits map to major / minor / patch.
import { execSync } from 'child_process'
import { readFileSync, writeFileSync } from 'fs'
import { bump, decideBump } from './release-bump.mjs'

const fail = (msg) => {
  console.error(`release: ${msg}`)
  process.exit(1)
}

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const forced = args.find((a) => ['major', 'minor', 'patch'].includes(a))
const unknown = args.filter((a) => a !== '--dry-run' && a !== forced)
if (unknown.length) fail(`Unknown argument(s): ${unknown.join(' ')}. Usage: npm run release -- [major|minor|patch] [--dry-run]`)

const git = (a) => execSync(`git ${a}`, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim()
const parse = (v) => v.replace(/^v/, '').split('.').map(Number)
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]

if (git('status --porcelain') && !dryRun) fail('Working tree is not clean; commit or stash first.')
const branch = git('rev-parse --abbrev-ref HEAD')
if (branch !== 'master') fail(`Releases are cut from master (on "${branch}").`)

git('fetch origin master --tags --quiet')
if (git('rev-list --count HEAD..origin/master') !== '0') fail('master is behind origin; pull first.')

// Latest stable tag (no pre-release suffix).
const stable = git('tag -l v*')
  .split('\n')
  .filter((t) => /^v\d+\.\d+\.\d+$/.test(t))
  .sort((a, b) => cmp(parse(a), parse(b)))
const latestTag = stable.at(-1)
const latest = latestTag ? parse(latestTag) : [0, 0, 0]

// Full commit messages since that tag, so BREAKING CHANGE footers are seen.
const log = git(`log --format=%B%x1e ${latestTag ? `${latestTag}..HEAD` : 'HEAD'}`)
const messages = log.split('\x1e').map((m) => m.trim()).filter(Boolean)
const releasable = messages.filter((m) => !/^Release v\d/.test(m))
if (!releasable.length && !forced) fail(`No commits since ${latestTag ?? 'the beginning'}; nothing to release.`)

const auto = decideBump(messages)
const level = forced ?? auto.level
let next = bump(latest, level)
// If package.json was already bumped by hand past that (and not yet tagged), release that version.
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const pkgVersion = parse(pkg.version.split('-')[0])
if (cmp(pkgVersion, next) > 0) next = pkgVersion
const version = next.join('.')
const tag = `v${version}`
if (stable.includes(tag)) fail(`${tag} already exists.`)

console.log(`${releasable.length} commit(s) since ${latestTag ?? 'the first commit'}`)
if (forced) console.log(`Bump: ${level} (forced; commits suggest ${auto.level})`)
else {
  console.log(`Bump: ${level}, because of:`)
  for (const d of auto.decisive.slice(0, 8)) console.log(`  - ${d.subject}  [${d.reason}]`)
  if (auto.decisive.length > 8) console.log(`  … and ${auto.decisive.length - 8} more`)
}
console.log(`${latestTag ?? 'v0.0.0'} -> ${tag}`)
if (dryRun) process.exit(0)

pkg.version = version
writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n')
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'))
lock.version = version
if (lock.packages?.['']) lock.packages[''].version = version
writeFileSync('package-lock.json', JSON.stringify(lock, null, 2) + '\n')
if (git('status --porcelain')) {
  git('add package.json package-lock.json')
  git(`commit -m "Release ${tag}"`)
}
git(`tag -a ${tag} -m "Release ${tag}"`)
git(`push --atomic origin master ${tag}`)
console.log(`Pushed ${tag}; the Release workflow will build and publish it.`)
