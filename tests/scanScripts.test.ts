import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Finding a project's package.json scripts: only code that's part of the project, as git sees it.

vi.setConfig({ testTimeout: 60_000 })

let tmp = ''
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

const write = (rel: string, data: string | object): void => {
  fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true })
  fs.writeFileSync(path.join(tmp, rel), typeof data === 'string' ? data : JSON.stringify(data))
}
const pkg = (name: string): object => ({ name, scripts: { build: 'echo build' } })

describe('package.json scripts', () => {
  it('in a git repo: leaves out whatever .gitignore (root or nested) or info/exclude ignores, keeps new unignored packages', async () => {
    const { scanScripts } = await import('../src/main/processes/scan')
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-scan-'))
    execFileSync('git', ['init', '-q'], { cwd: tmp })
    write('package.json', pkg('root'))
    write('packages/app/package.json', pkg('app'))
    write('.gitignore', 'scratch/\n')
    write('scratch/old-copy/package.json', pkg('old-copy'))
    write('packages/.gitignore', 'generated/\n')
    write('packages/generated/package.json', pkg('generated'))
    write('.git/info/exclude', 'local-only/\n')
    write('local-only/package.json', pkg('local-only'))
    execFileSync('git', ['add', '.'], { cwd: tmp })
    // Not committed yet, not ignored: part of the project.
    write('packages/new/package.json', pkg('new'))
    // Never offered, even if not ignored.
    write('node_modules/dep/package.json', pkg('dep'))

    const names = (await scanScripts(tmp)).map((p) => p.name)
    expect(names).toEqual(['root', 'app', 'new'])
  })

  it('outside git: walks the folder, skipping dependency and build folders', async () => {
    const { scanScripts } = await import('../src/main/processes/scan')
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-scan-'))
    write('package.json', pkg('root'))
    write('tools/cli/package.json', pkg('cli'))
    write('dist/package.json', pkg('dist'))
    write('node_modules/dep/package.json', pkg('dep'))
    expect((await scanScripts(tmp)).map((p) => p.name)).toEqual(['root', 'cli'])
  })
})
