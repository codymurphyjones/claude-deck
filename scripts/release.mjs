// Cut a stable release: bump the patch version, commit, tag vX.Y.Z and push both.
// The tag push triggers .github/workflows/release.yml, which builds and publishes it.
//   npm run release              -> next patch after the latest stable tag
//   npm run release -- --dry-run -> print what would happen, change nothing
import { execSync } from 'child_process'
import { readFileSync, writeFileSync } from 'fs'

const dryRun = process.argv.includes('--dry-run')
const git = (args) => execSync(`git ${args}`, { encoding: 'utf8' }).trim()
const parse = (v) => v.replace(/^v/, '').split('.').map(Number)
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]

if (git('status --porcelain') && !dryRun) throw new Error('Working tree is not clean; commit or stash first.')
const branch = git('rev-parse --abbrev-ref HEAD')
if (branch !== 'master') throw new Error(`Releases are cut from master (on "${branch}").`)

git('fetch origin master --tags --quiet')
if (git('rev-list --count HEAD..origin/master') !== '0') throw new Error('master is behind origin; pull first.')

// Latest stable tag (no pre-release suffix), bumped by one patch. If package.json was already
// bumped by hand past that (and not yet tagged), release that version instead of skipping it.
const tags = git('tag -l v*').split('\n').filter((t) => /^v\d+\.\d+\.\d+$/.test(t)).map(parse)
const latest = tags.sort(cmp).at(-1) ?? [0, 0, 0]
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
let next = [latest[0], latest[1], latest[2] + 1]
if (cmp(parse(pkg.version.split('-')[0]), next) > 0) next = parse(pkg.version.split('-')[0])
const version = next.join('.')
const tag = `v${version}`

console.log(`Latest release v${latest.join('.')} -> ${tag}`)
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
git(`push origin master ${tag}`)
console.log(`Pushed ${tag}; the Release workflow will build and publish it.`)
