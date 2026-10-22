import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { failureReason, isOpenFailure, pickPm, plainLines, scriptCommand, scriptState, stripAnsi, type ProcessInfo } from '@shared/processes'
import { scanScripts } from '../src/main/processes/scan'

describe('project actions', () => {
  it('builds run commands per package manager', () => {
    expect(scriptCommand('npm', 'dev')).toBe('npm run dev')
    expect(scriptCommand('pnpm', 'build:web')).toBe('pnpm run build:web')
    expect(scriptCommand('yarn', 'test')).toBe('yarn test')
    expect(scriptCommand('bun', 'start')).toBe('bun run start')
    expect(scriptCommand('npm', 'odd name')).toBe('npm run "odd name"')
  })

  it('picks the package manager', () => {
    expect(pickPm('pnpm@9.1.0', ['package-lock.json'])).toBe('pnpm')
    expect(pickPm(undefined, ['yarn.lock'])).toBe('yarn')
    expect(pickPm('weird@1', ['bun.lockb'])).toBe('bun')
    expect(pickPm(undefined, [])).toBe('npm')
  })

  it('cleans terminal output', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m \x1b]0;title\x07ok')).toBe('red ok')
    expect(plainLines('a\r\nprogress 10%\rprogress 100%\n\n\x1b[1mb\x1b[0m')).toEqual(['a', 'progress 100%', 'b'])
    // ConPTY moves to a new line with a cursor position instead of \n.
    expect(plainLines('> bad\r\n> node x\x1b[5;1H\x1b[?25h\x1b[Kstarting\r\nboom\r\n')).toEqual(['> bad', '> node x', 'starting', 'boom'])
  })

  it('explains failures', () => {
    const npm = ['> app@1.0.0 build', '> tsc', "src/a.ts(3,1): error TS2304: Cannot find name 'x'.", 'npm ERR! code ELIFECYCLE', 'npm ERR! errno 2']
    expect(failureReason(npm, 2)).toBe("src/a.ts(3,1): error TS2304: Cannot find name 'x'.")
    expect(failureReason(['starting', 'boom: missing config'], 2)).toBe('boom: missing config')
    // The `> script` banner echoes the command (which may contain "error"); it is not the reason.
    expect(failureReason(['> bad', `> node -e "console.error('boom')"`, 'starting', 'boom'], 2)).toBe('boom')
    expect(failureReason(['working', 'all done?'], 1)).toBe('all done?')
    expect(failureReason([], 3)).toBe('Exited with code 3')
  })

  it('derives a script state from its runs', () => {
    const run = (status: ProcessInfo['status'], startedAt: number, extra: Partial<ProcessInfo> = {}): ProcessInfo => ({ id: `p${startedAt}`, projectId: 'x', cwd: '/r', rel: '', script: 's', command: 'npm run s', status, startedAt, ...extra })
    expect(scriptState([]).state).toBe('')
    expect(scriptState([run('success', 1)]).state).toBe('success')
    expect(scriptState([run('success', 1), run('failed', 2)])).toMatchObject({ state: 'failed', latest: { id: 'p2' } })
    // Running wins, even over a newer failure.
    expect(scriptState([run('running', 1), run('failed', 2)])).toMatchObject({ state: 'running', live: 1 })
    expect(scriptState([run('stopped', 3)]).state).toBe('')
    expect(isOpenFailure(run('failed', 1))).toBe(true)
    expect(isOpenFailure(run('failed', 1, { dismissed: true }))).toBe(false)
  })

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-scan-'))
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

  it('finds package.json scripts recursively', async () => {
    const write = (rel: string, data: unknown): void => {
      fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true })
      fs.writeFileSync(path.join(tmp, rel), typeof data === 'string' ? data : JSON.stringify(data))
    }
    write('package.json', { name: 'root', scripts: { build: 'tsc', test: 'vitest' } })
    write('pnpm-lock.yaml', '')
    write('packages/web/package.json', { name: '@x/web', scripts: { dev: 'vite' } })
    write('packages/empty/package.json', { name: 'empty' })
    write('packages/node_modules/dep/package.json', { scripts: { postinstall: 'x' } })
    write('node_modules/dep/package.json', { scripts: { postinstall: 'x' } })
    write('.cache/thing/package.json', { scripts: { x: 'x' } })
    write('tools/cli/package.json', { name: 'cli', packageManager: 'yarn@4.0.0', scripts: { start: 'node .' } })
    const found = await scanScripts(tmp)
    expect(found.map((p) => [p.rel, p.pm, Object.keys(p.scripts)])).toEqual([
      ['', 'pnpm', ['build', 'test']],
      ['packages/web', 'pnpm', ['dev']],
      ['tools/cli', 'yarn', ['start']]
    ])
    expect(found[1].dir).toBe(path.join(tmp, 'packages', 'web'))
  })
})
