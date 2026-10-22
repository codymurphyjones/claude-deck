// Stamp the version for a CI build and print it.
//   node scripts/ci-version.mjs dev <runNumber>   -> X.Y.(Z+1)-dev.<run>  (master builds; sorts above the last release)
//   node scripts/ci-version.mjs tag <vX.Y.Z>      -> X.Y.Z                (tagged releases)
import { readFileSync, writeFileSync } from 'fs'

const [mode, arg] = process.argv.slice(2)
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
let version
if (mode === 'dev') {
  const [maj, min, pat] = pkg.version.split('-')[0].split('.').map(Number)
  version = `${maj}.${min}.${pat + 1}-dev.${Number(arg)}`
} else if (mode === 'tag') {
  version = String(arg).replace(/^refs\/tags\//, '').replace(/^v/, '')
  if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) throw new Error(`Tag "${arg}" is not a version like v1.2.3`)
} else throw new Error('usage: ci-version.mjs dev <run> | tag <vX.Y.Z>')
pkg.version = version
writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n')
console.log(version)
