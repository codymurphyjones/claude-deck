import { describe, expect, it } from 'vitest'
import { buildCommand, defaultValues, monoActions, packageManagerActions, validateValues, type ActionDef, type MonoFile } from '@shared/actions'

// Actions with inputs: .mono command files (as in a real project) and package-manager commands,
// turned into the command lines their tools expect.

const deploy: MonoFile = {
  name: 'Deploy Infrastructure Stacks',
  actions: ['yarn mono infra cdk deploy -c owner=${arg} -c region=${region}'],
  preactions: ['cp .env apps/deployment/.env'],
  argument: { type: 'string', description: 'Set environment to stage', default: 'dev' },
  options: {
    type: { description: 'Build to target specific platform', default: 'backend', options: ['data', 'core', 'region', 'backend', 'all', 'migrate'], type: 'string' },
    dev: { description: 'Run in dev mode', shortcut: 'd' },
    fresh: { default: 'yes', options: ['yes', 'no'], type: 'string' },
    region: { shortcut: 'r', type: 'string', description: 'Set region', default: 'us-east-2' }
  },
  environments: { dev: { NEXT_PUBLIC_API_URL: '${ngrok_api}' }, prod: { NEXT_FORCE_PROD: 'true' } }
}
const envSync: MonoFile = { name: 'Sync Environment Config', actions: ['x ${arg}'], argument: { type: 'string', allowAll: true, default: 'app', options: ['app', 'deployment'] } }
const build: MonoFile = { argument: { default: 'development', options: ['development', 'preview', 'production'] }, options: { platform: { default: 'ios', options: ['ios', 'android'], type: 'string' }, profile: { type: 'string' } } }
const pass: MonoFile = { actions: ['x ${local} ${arg}'], argument: { default: 'dev' }, options: { local: { default: false, shortcut: 'l' } } }

const config = { prodFlag: 'live', workspace: { packageMaps: { web: 'next-app', ghost: 'missing-pkg' } } }
const workspaces = [{ name: 'next-app', scripts: ['dev', 'build'] }]
const mono = monoActions({ deploy, 'env-sync': envSync, build, pass }, config, ['yarn'], workspaces)
const def = (id: string, list: ActionDef[] = mono): ActionDef => list.find((d) => d.id === id)!
const run = (id: string, values: Record<string, string | boolean> = {}, list: ActionDef[] = mono): string => buildCommand(def(id, list), { ...defaultValues(def(id, list)), ...values })

describe('.mono commands', () => {
  it('map every field of the schema to an input', () => {
    const d = def('mono:deploy')
    expect(d.title).toBe('Deploy Infrastructure Stacks')
    expect(d.steps).toEqual({ pre: ['cp .env apps/deployment/.env'], main: ['yarn mono infra cdk deploy -c owner=${arg} -c region=${region}'] })
    expect(d.env?.prod).toEqual({ NEXT_FORCE_PROD: 'true' })
    const byKey = Object.fromEntries(d.inputs.map((i) => [i.key, i]))
    expect(byKey.arg).toMatchObject({ kind: 'text', default: 'dev', cli: { positional: true } })
    expect(byKey.type).toMatchObject({ kind: 'choice', default: 'backend', choices: ['data', 'core', 'region', 'backend', 'all', 'migrate'] })
    expect(byKey.dev).toMatchObject({ kind: 'flag', short: '-d', default: false })
    expect(byKey.region).toMatchObject({ kind: 'text', short: '-r', default: 'us-east-2' })
    // The config's prodFlag picks the prod environment.
    expect(byKey.__prod).toMatchObject({ kind: 'flag', cli: { flag: '--live' } })
    // allowAll adds "all" to an argument's choices.
    expect(def('mono:env-sync').inputs[0].choices).toEqual(['app', 'deployment', 'all'])
  })

  it('build the command the mono CLI parses: argument, then options; defaults left to mono', () => {
    expect(run('mono:deploy')).toBe('yarn mono deploy dev')
    expect(run('mono:deploy', { arg: 'stage', type: 'core', dev: true, region: 'eu-west-1', __prod: true })).toBe('yarn mono deploy stage --type core --dev --region eu-west-1 --live')
    expect(run('mono:build', { arg: 'production', platform: 'android', profile: 'store' })).toBe('yarn mono build production --platform android --profile store')
    expect(run('mono:pass', { local: true })).toBe('yarn mono pass dev --local')
    expect(run('mono:env-sync', { arg: 'all' })).toBe('yarn mono env-sync all')
    expect(validateValues(def('mono:build'), { arg: 'staging' })).toMatch(/one of/)
  })

  it('include workspace aliases (when the workspace exists) and the built-in tools', () => {
    expect(run('mono-ws:web', { script: 'build' })).toBe('yarn mono web build')
    expect(mono.some((d) => d.id === 'mono-ws:ghost')).toBe(false)
    expect(def('mono-tools:prune').base.join(' ')).toBe('yarn mono tools prune')
  })
})

describe('package-manager commands', () => {
  it('put options where each tool reads them', () => {
    const berry = packageManagerActions('yarn', { yarnBerry: true })
    expect(run('yarn:add', { packages: 'react  lodash@^4', dev: true, workspace: 'next-app' }, berry)).toBe('yarn workspace next-app add react "lodash@^4" --dev')
    expect(run('yarn:foreach', { script: 'build', parallel: true, exclude: 'next-app' }, berry)).toBe('yarn workspaces foreach --all --parallel --exclude next-app run build')
    expect(run('yarn:foreach', { script: 'test', all: false, __extra: '--watch' }, berry)).toBe('yarn workspaces foreach run test --watch')
    const classic = packageManagerActions('yarn')
    expect(run('yarn1:version', { bump: 'minor' }, classic)).toBe('yarn version --minor')
    const pnpm = packageManagerActions('pnpm')
    // Options before the script: pnpm passes anything after it to the script.
    expect(run('pnpm:run-all', { script: 'build', parallel: true, filter: 'web', __extra: '--watch' }, pnpm)).toBe('pnpm --filter web -r run --parallel build --watch')
    const npm = packageManagerActions('npm')
    expect(run('npm:run-in', { script: 'test', workspace: 'api', __extra: '--coverage' }, npm)).toBe('npm run test -w api -- --coverage')
    expect(run('npm:version', {}, npm)).toBe('npm version patch')
    const bun = packageManagerActions('bun')
    expect(run('bun:run-in', { filter: 'api', script: 'dev' }, bun)).toBe('bun --filter api run dev')
  })

  it('refuse values that could break out of the command', () => {
    const npm = packageManagerActions('npm')
    expect(() => run('npm:add', { packages: 'a" & calc "' }, npm)).toThrow(/quotes/)
    expect(validateValues(def('npm:add', npm), {})).toMatch(/required/)
  })
})

describe('finding a project’s command folders', () => {
  it('reads .mono (commands, config, workspace aliases) and picks yarn 2+ commands from packageManager', async () => {
    const fs = await import('fs')
    const os = await import('os')
    const path = await import('path')
    const { scanTools } = await import('../src/main/processes/tools')
    const { scanScripts } = await import('../src/main/processes/scan')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-tools-'))
    const write = (f: string, data: unknown): void => {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true })
      fs.writeFileSync(path.join(dir, f), typeof data === 'string' ? data : JSON.stringify(data))
    }
    write('package.json', { name: 'game', packageManager: 'yarn@4.5.0', scripts: { test: 'vitest' }, devDependencies: { '@mono-labs/cli': '^0.1.0' } })
    write('apps/web/package.json', { name: 'next-app', scripts: { dev: 'next dev', build: 'next build' } })
    write('.mono/config.json', { prodFlag: 'live', workspace: { packageMaps: { web: 'next-app' } } })
    write('.mono/deploy.json', deploy)
    write('.mono/broken.json', '{ not json')
    const sets = await scanTools(dir, await scanScripts(dir))
    const mono = sets.find((s) => s.kind === 'mono')!
    expect(mono.title).toBe('.mono')
    expect(mono.actions.map((a) => a.id)).toEqual(['mono:deploy', 'mono-ws:web', 'mono-tools:prune'])
    expect(mono.notes?.[0]).toMatch(/broken\.json/)
    expect(buildCommand(mono.actions[0], { ...defaultValues(mono.actions[0]), __prod: true })).toBe('yarn mono deploy dev --live')
    const yarn = sets.find((s) => s.kind === 'yarn')!
    expect(yarn.title).toBe('yarn 4.5.0')
    expect(yarn.actions.some((a) => a.id === 'yarn:foreach')).toBe(true)
    expect(yarn.context.workspaces.map((w) => w.name)).toEqual(['next-app'])
    expect(yarn.context.dependencies).toContain('@mono-labs/cli')
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
