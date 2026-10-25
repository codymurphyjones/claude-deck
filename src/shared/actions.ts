// Project actions beyond package.json scripts: commands with inputs, rendered as run forms.
//  - `.mono` command files (the @mono-labs/cli runner: `yarn mono <command> [argument] [--options]`),
//    every field of their schema mapped to a form input;
//  - a package manager's own commands (install, add, upgrade, audit, run across workspaces…) for
//    npm, yarn (classic and Berry), pnpm and bun.
// A definition plus the values chosen in its form build the exact command line (buildCommand); the
// main process rebuilds it from the definition, so nothing runs that isn't one of these.

import type { PackageManager } from './processes'

export type ActionValue = string | boolean
export type ActionValues = Record<string, ActionValue>

export interface ActionInput {
  key: string
  label: string
  description?: string
  /** flag: on/off; text: free value; choice: one of `choices`. */
  kind: 'flag' | 'text' | 'choice'
  choices?: string[]
  default?: ActionValue
  /** The tool applies `default` itself, so it's left off the command line when unchanged (.mono). */
  toolDefault?: boolean
  required?: boolean
  placeholder?: string
  /** Where suggestions for a text value come from. */
  suggest?: 'workspaces' | 'scripts' | 'dependencies'
  /**
   * How the value goes on the command line:
   *  - positional: as is, after the base command (`split`: space-separated words, each its own arg);
   *  - flag: `--name` for a flag input, `--name value` otherwise (`eq`: `--name=value`);
   *  - before: right after the program, e.g. `yarn workspace <value> add …`;
   *  - asFlag: a choice given as its own flag, e.g. `--patch`.
   */
  cli: { positional?: boolean; split?: boolean; flag?: string; eq?: boolean; before?: string[]; asFlag?: boolean }
  /** Shown next to the flag, e.g. "-d". */
  short?: string
}

export interface ActionDef {
  id: string
  /** Section within its folder ("Dependencies", "Workspaces"…). */
  group: string
  /** Short name shown in the list ("deploy", "add"). */
  name: string
  title: string
  description?: string
  /** The command before any inputs: program first. */
  base: string[]
  inputs: ActionInput[]
  /** A free "extra arguments" field, appended (after `--` when `dashdash`). */
  extraArgs?: 'plain' | 'dashdash'
  /** Options go before positionals (tools that pass anything after the script name to the script). */
  flagsFirst?: boolean
  /** What it runs (shown in the form): a .mono file's preactions and actions. */
  steps?: { pre: string[]; main: string[] }
  /** Environment variables per environment (.mono `environments`), and the flag that picks prod. */
  env?: { prodKey: string; dev: Record<string, string>; prod: Record<string, string> }
  /** Destructive (destroy, publish…): the form asks before running. */
  danger?: boolean
}

/** A folder of actions in the Actions view: a project's `.mono` commands, or its package manager's. */
export interface ToolSet {
  id: string
  kind: 'mono' | PackageManager
  /** ".mono", "yarn 4.5.0", "npm"… */
  title: string
  /** Folder it runs in. */
  dir: string
  rel: string
  actions: ActionDef[]
  /** For suggestions in the forms. */
  context: { workspaces: { name: string; rel: string; scripts: string[] }[]; scripts: string[]; dependencies: string[] }
  /** Notes about how it was read (e.g. a .mono file that couldn't be parsed). */
  notes?: string[]
}

// ------------------------------------------------------------------ building commands

/** The values a form starts with: each input's default. */
export function defaultValues(def: ActionDef): ActionValues {
  const v: ActionValues = {}
  for (const i of def.inputs) if (i.default !== undefined) v[i.key] = i.default
  return v
}

// (No ^ or %: cmd.exe treats them specially even in arguments, so values with them get quoted.)
const SAFE = /^[\w@+=:,./~*-]+$/

/** One argument, quoted for the shell when it needs it. Quotes and line breaks can't be passed. */
export function shellArg(s: string): string {
  if (/["\r\n]/.test(s)) throw new Error(`Values can't contain quotes or line breaks: ${s}`)
  return SAFE.test(s) ? s : `"${s}"`
}

/** Why the values can't run (a required input left empty, a value outside its choices), or undefined. */
export function validateValues(def: ActionDef, values: ActionValues): string | undefined {
  for (const i of def.inputs) {
    const v = values[i.key]
    const empty = v === undefined || v === '' || v === false
    if (i.required && empty && i.kind !== 'flag') return `${i.label} is required`
    if (i.kind === 'choice' && !empty && i.choices && !i.choices.includes(String(v))) return `${i.label} must be one of: ${i.choices.join(', ')}`
  }
  return undefined
}

/**
 * The command line for `def` with `values`. Empty and off inputs are left out, and so are inputs
 * left at a default the tool applies itself (`toolDefault`), keeping the command short.
 */
export function buildCommand(def: ActionDef, values: ActionValues): string {
  const bad = validateValues(def, values)
  if (bad) throw new Error(bad)
  const [program, ...rest] = def.base
  const before: string[] = []
  const positional: string[] = []
  const flags: string[] = []
  for (const i of def.inputs) {
    const v = values[i.key]
    if (v === undefined || v === '' || v === false) continue
    // Left at a default the tool applies itself (positionals are kept: order matters).
    if (i.toolDefault && v === i.default && !i.cli.positional && !i.cli.before) continue
    if (i.kind === 'flag') {
      if (v === true && i.cli.flag) flags.push(i.cli.flag)
      continue
    }
    const s = String(v).trim()
    if (!s) continue
    if (i.cli.asFlag) flags.push(`--${shellArg(s)}`)
    else if (i.cli.before) before.push(...i.cli.before, shellArg(s))
    else if (i.cli.positional) positional.push(...(i.cli.split ? s.split(/\s+/) : [s]).map(shellArg))
    else if (i.cli.flag) flags.push(...(i.cli.eq ? [`${i.cli.flag}=${shellArg(s)}`] : [i.cli.flag, shellArg(s)]))
  }
  const extra = typeof values.__extra === 'string' ? values.__extra.replace(/[\r\n]+/g, ' ').trim() : ''
  const tail = extra && def.extraArgs ? [...(def.extraArgs === 'dashdash' ? ['--'] : []), extra] : []
  return [program, ...before, ...rest, ...(def.flagsFirst ? [...flags, ...positional] : [...positional, ...flags]), ...tail].join(' ')
}

// ------------------------------------------------------------------ .mono (@mono-labs/cli)

interface MonoOption {
  type?: string
  shortcut?: string
  description?: string
  default?: unknown
  options?: unknown[]
  allowAll?: boolean
}
export interface MonoFile {
  name?: string
  description?: string
  argument?: { required?: boolean; type?: string; description?: string; default?: unknown; options?: unknown[]; allowAll?: boolean }
  options?: Record<string, MonoOption>
  environments?: Record<string, Record<string, unknown>>
  preactions?: unknown[]
  actions?: unknown[]
}
export interface MonoConfig {
  prodFlag?: string
  envMap?: string[]
  workspace?: { packageMaps?: Record<string, string>; preactions?: string[] }
}

const strList = (x: unknown): string[] => (Array.isArray(x) ? x.filter((v): v is string => typeof v === 'string') : [])
const strRecord = (x: unknown): Record<string, string> =>
  x && typeof x === 'object' ? Object.fromEntries(Object.entries(x as Record<string, unknown>).map(([k, v]) => [k, String(v)])) : {}
const choicesOf = (o: { options?: unknown[]; allowAll?: boolean }): string[] | undefined => {
  const list = Array.isArray(o.options) ? o.options.map(String) : undefined
  return list?.length ? [...list, ...(o.allowAll ? ['all'] : [])] : undefined
}

/**
 * The actions of a project's `.mono` folder, each field of its schema as a form input, run the way
 * the CLI expects: `<runner> mono <command> [argument] [--option value] [--flag] [--<prodFlag>]`.
 * Also its workspace aliases (`mono <alias> <script>`, from config.json) and built-in tools.
 */
export function monoActions(files: Record<string, MonoFile>, config: MonoConfig, runner: string[], workspaces: { name: string; scripts: string[] }[]): ActionDef[] {
  const prodFlag = config.prodFlag || 'prod'
  const out: ActionDef[] = []
  for (const [command, f] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    const inputs: ActionInput[] = []
    const a = f.argument
    if (a) {
      const choices = choicesOf(a)
      inputs.push({
        key: 'arg',
        label: 'Argument',
        description: a.description,
        kind: choices ? 'choice' : 'text',
        choices,
        default: a.default === undefined ? undefined : String(a.default),
        required: !!a.required,
        cli: { positional: true }
      })
    }
    for (const [key, o] of Object.entries(f.options ?? {})) {
      const isText = o.type === 'string'
      const choices = isText ? choicesOf(o) : undefined
      inputs.push({
        key,
        label: key,
        description: o.description,
        kind: isText ? (choices ? 'choice' : 'text') : 'flag',
        choices,
        default: isText ? (o.default === undefined ? undefined : String(o.default)) : o.default === true,
        // mono fills in option defaults itself.
        toolDefault: true,
        cli: { flag: `--${key}` },
        short: o.shortcut ? `-${o.shortcut}` : undefined
      })
    }
    const envs = f.environments ?? {}
    const hasEnv = Object.keys(envs).length > 0
    inputs.push({
      key: '__prod',
      label: 'Production environment',
      description: hasEnv ? `Uses the "prod" environment variables instead of "dev" (--${prodFlag}).` : `Runs in production mode (--${prodFlag}).`,
      kind: 'flag',
      default: false,
      cli: { flag: `--${prodFlag}` }
    })
    out.push({
      id: `mono:${command}`,
      group: 'Commands',
      name: command,
      title: f.name || command,
      description: f.description,
      base: [...runner, 'mono', command],
      inputs,
      steps: { pre: strList(f.preactions), main: strList(f.actions) },
      env: hasEnv ? { prodKey: '__prod', dev: strRecord(envs.dev), prod: strRecord(envs.prod) } : undefined,
      danger: /destroy|delete|drop|teardown/i.test(command)
    })
  }
  // Workspace aliases: `mono <alias> <script>` runs a script in the aliased workspace.
  for (const [alias, pkgName] of Object.entries(config.workspace?.packageMaps ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    const ws = workspaces.find((w) => w.name === pkgName)
    if (!ws || !ws.scripts.length) continue
    out.push({
      id: `mono-ws:${alias}`,
      group: 'Workspaces',
      name: alias,
      title: `${alias} → ${pkgName}`,
      description: `Runs a script of ${pkgName} through mono (yarn workspace ${pkgName} <script>), with mono's environment mapping.`,
      base: [...runner, 'mono', alias],
      inputs: [{ key: 'script', label: 'Script', kind: 'choice', choices: ws.scripts, required: true, default: ws.scripts.includes('dev') ? 'dev' : ws.scripts[0], cli: { positional: true } }],
      extraArgs: 'plain'
    })
  }
  out.push({
    id: 'mono-tools:prune',
    group: 'Tools',
    name: 'tools prune',
    title: 'Prune git branches',
    description: "mono's built-in: prunes unused branches in git.",
    base: [...runner, 'mono', 'tools', 'prune'],
    inputs: [],
    danger: true
  })
  return out
}

// ------------------------------------------------------------------ package managers

const flag = (key: string, label: string, f: string, description?: string, short?: string): ActionInput => ({ key, label, kind: 'flag', default: false, cli: { flag: f }, description, short })
const text = (key: string, label: string, cli: ActionInput['cli'], o: Partial<ActionInput> = {}): ActionInput => ({ key, label, kind: 'text', cli, ...o })
const choice = (key: string, label: string, choices: string[], cli: ActionInput['cli'], o: Partial<ActionInput> = {}): ActionInput => ({ key, label, kind: 'choice', choices, cli, ...o })
const pkgs = (required = true, label = 'Packages'): ActionInput => text('packages', label, { positional: true, split: true }, { required, placeholder: 'react lodash@^4 @types/node', suggest: 'dependencies' })
const script = (): ActionInput => text('script', 'Script', { positional: true }, { required: true, suggest: 'scripts' })
const act = (pm: string, group: string, name: string, title: string, base: string[], inputs: ActionInput[], o: Partial<ActionDef> = {}): ActionDef => ({ id: `${pm}:${name}`, group, name, title, base, inputs, ...o })

const SEMVER = ['patch', 'minor', 'major', 'prepatch', 'preminor', 'premajor', 'prerelease']

function npmActions(): ActionDef[] {
  const ws = (): ActionInput => text('workspace', 'Workspace', { flag: '-w' }, { suggest: 'workspaces', description: 'Only this workspace (npm -w).' })
  return [
    act('npm', 'Install', 'install', 'Install dependencies', ['npm', 'install'], [
      flag('legacyPeer', 'Legacy peer deps', '--legacy-peer-deps', 'Ignore peer dependency conflicts (npm 6 behaviour).'),
      flag('ignoreScripts', 'Skip install scripts', '--ignore-scripts'),
      flag('noAudit', 'Skip the audit', '--no-audit'),
      choice('omit', 'Omit', ['dev', 'optional', 'peer'], { flag: '--omit' }, { description: 'Leave out this kind of dependency.' })
    ]),
    act('npm', 'Install', 'ci', 'Clean install (from the lockfile)', ['npm', 'ci'], [flag('ignoreScripts', 'Skip install scripts', '--ignore-scripts'), flag('legacyPeer', 'Legacy peer deps', '--legacy-peer-deps')]),
    act('npm', 'Dependencies', 'add', 'Add packages', ['npm', 'install'], [
      pkgs(),
      flag('dev', 'Dev dependency', '--save-dev', undefined, '-D'),
      flag('exact', 'Exact version', '--save-exact', undefined, '-E'),
      flag('optional', 'Optional dependency', '--save-optional', undefined, '-O'),
      flag('peer', 'Peer dependency', '--save-peer'),
      ws()
    ]),
    act('npm', 'Dependencies', 'remove', 'Remove packages', ['npm', 'uninstall'], [pkgs(), ws()]),
    act('npm', 'Dependencies', 'update', 'Update packages (within their ranges)', ['npm', 'update'], [pkgs(false, 'Packages (all if empty)'), ws()]),
    act('npm', 'Dependencies', 'outdated', 'List outdated packages', ['npm', 'outdated'], [flag('all', 'Include transitive', '--all'), flag('long', 'More detail', '--long'), ws()]),
    act('npm', 'Dependencies', 'why', 'Why is a package installed', ['npm', 'explain'], [text('pkg', 'Package', { positional: true }, { required: true, suggest: 'dependencies' })]),
    act('npm', 'Dependencies', 'ls', 'List installed packages', ['npm', 'ls'], [text('pkg', 'Package', { positional: true }, { suggest: 'dependencies' }), text('depth', 'Depth', { flag: '--depth' }, { placeholder: '0' }), flag('all', 'All levels', '--all')]),
    act('npm', 'Dependencies', 'dedupe', 'Dedupe the dependency tree', ['npm', 'dedupe'], [flag('dry', 'Dry run', '--dry-run')]),
    act('npm', 'Dependencies', 'prune', 'Remove extraneous packages', ['npm', 'prune'], [flag('dry', 'Dry run', '--dry-run'), choice('omit', 'Omit', ['dev', 'optional', 'peer'], { flag: '--omit' })]),
    act('npm', 'Security', 'audit', 'Audit for vulnerabilities', ['npm', 'audit'], [choice('level', 'Minimum severity', ['low', 'moderate', 'high', 'critical'], { flag: '--audit-level' }), choice('omit', 'Omit', ['dev', 'optional', 'peer'], { flag: '--omit' })]),
    act('npm', 'Security', 'audit-fix', 'Fix vulnerabilities', ['npm', 'audit', 'fix'], [flag('force', 'Allow breaking upgrades', '--force'), flag('dry', 'Dry run', '--dry-run')]),
    act('npm', 'Workspaces', 'run-all', 'Run a script in every workspace', ['npm', 'run'], [script(), flag('ifPresent', 'Skip workspaces without it', '--if-present'), { ...flag('workspaces', 'All workspaces', '--workspaces'), default: true }], { extraArgs: 'dashdash' }),
    act('npm', 'Workspaces', 'run-in', 'Run a script in one workspace', ['npm', 'run'], [script(), { ...ws(), required: true }], { extraArgs: 'dashdash' }),
    act('npm', 'Run', 'exec', 'Run a package binary (npx)', ['npx'], [text('cmd', 'Command', { positional: true }, { required: true, placeholder: 'tsc --noEmit' })], { extraArgs: 'plain' }),
    act('npm', 'Release', 'version', 'Bump the version', ['npm', 'version'], [choice('bump', 'Bump', SEMVER, { positional: true }, { required: true, default: 'patch' }), flag('noTag', "Don't commit or tag", '--no-git-tag-version'), text('preid', 'Prerelease id', { flag: '--preid' }, { placeholder: 'beta' })]),
    act('npm', 'Release', 'pack', 'Pack a tarball', ['npm', 'pack'], [flag('dry', 'Dry run', '--dry-run'), ws()]),
    act('npm', 'Release', 'publish', 'Publish to the registry', ['npm', 'publish'], [text('tag', 'Dist tag', { flag: '--tag' }, { placeholder: 'latest' }), choice('access', 'Access', ['public', 'restricted'], { flag: '--access' }), flag('dry', 'Dry run', '--dry-run'), ws()], { danger: true }),
    act('npm', 'Maintenance', 'cache-verify', 'Verify the cache', ['npm', 'cache', 'verify'], []),
    act('npm', 'Maintenance', 'cache-clean', 'Clear the cache', ['npm', 'cache', 'clean', '--force'], [], { danger: true })
  ]
}

function yarnBerryActions(): ActionDef[] {
  const ws = (): ActionInput => text('workspace', 'Workspace', { before: ['workspace'] }, { suggest: 'workspaces', description: 'Run it in this workspace (yarn workspace <name> …).' })
  return [
    act('yarn', 'Install', 'install', 'Install dependencies', ['yarn', 'install'], [
      flag('immutable', "Don't change the lockfile", '--immutable', 'Fail if the lockfile would change (CI).'),
      flag('checkCache', 'Check the cache', '--check-cache'),
      flag('refresh', 'Refresh the lockfile', '--refresh-lockfile'),
      choice('mode', 'Mode', ['skip-build', 'update-lockfile'], { flag: '--mode' }, { description: 'skip-build: no postinstall builds; update-lockfile: only update the lockfile.' })
    ]),
    act('yarn', 'Dependencies', 'add', 'Add packages', ['yarn', 'add'], [
      pkgs(),
      flag('dev', 'Dev dependency', '--dev', undefined, '-D'),
      flag('exact', 'Exact version', '--exact', undefined, '-E'),
      flag('peer', 'Peer dependency', '--peer', undefined, '-P'),
      flag('optional', 'Optional dependency', '--optional', undefined, '-O'),
      flag('tilde', 'Tilde range', '--tilde', undefined, '-T'),
      ws()
    ]),
    act('yarn', 'Dependencies', 'remove', 'Remove packages', ['yarn', 'remove'], [pkgs(), flag('all', 'From every workspace', '--all', undefined, '-A'), ws()]),
    act('yarn', 'Dependencies', 'up', 'Upgrade packages (in every workspace)', ['yarn', 'up'], [pkgs(true, 'Packages (patterns allowed, e.g. *tamagui*)'), flag('exact', 'Exact version', '--exact', undefined, '-E'), flag('recursive', 'Also transitive', '--recursive', undefined, '-R'), choice('mode', 'Mode', ['skip-build', 'update-lockfile'], { flag: '--mode' })]),
    act('yarn', 'Dependencies', 'why', 'Why is a package installed', ['yarn', 'why'], [text('pkg', 'Package', { positional: true }, { required: true, suggest: 'dependencies' }), flag('recursive', 'Recursive', '--recursive', undefined, '-R'), flag('peers', 'Include peers', '--peers')]),
    act('yarn', 'Dependencies', 'info', 'Package info', ['yarn', 'info'], [text('pkg', 'Package', { positional: true }, { suggest: 'dependencies' }), flag('all', 'All workspaces', '--all', undefined, '-A'), flag('recursive', 'Recursive', '--recursive', undefined, '-R')]),
    act('yarn', 'Dependencies', 'dedupe', 'Dedupe the dependency tree', ['yarn', 'dedupe'], [flag('check', 'Only check', '--check'), choice('strategy', 'Strategy', ['highest'], { flag: '--strategy' })]),
    act('yarn', 'Security', 'audit', 'Audit for vulnerabilities', ['yarn', 'npm', 'audit'], [
      flag('all', 'All workspaces', '--all', undefined, '-A'),
      flag('recursive', 'Include transitive', '--recursive', undefined, '-R'),
      choice('severity', 'Minimum severity', ['info', 'low', 'moderate', 'high', 'critical'], { flag: '--severity' }),
      choice('environment', 'Dependencies', ['all', 'production', 'development'], { flag: '--environment' })
    ]),
    act(
      'yarn',
      'Workspaces',
      'foreach',
      'Run a script in every workspace',
      ['yarn', 'workspaces', 'foreach'],
      [
        { ...flag('all', 'All workspaces', '--all', undefined, '-A'), default: true },
        flag('parallel', 'In parallel', '--parallel', undefined, '-p'),
        flag('topological', 'Dependencies first', '--topological', undefined, '-t'),
        flag('interlaced', 'Interlace output', '--interlaced', undefined, '-i'),
        flag('verbose', 'Prefix output', '--verbose', undefined, '-v'),
        text('include', 'Include (glob)', { flag: '--include' }, { suggest: 'workspaces' }),
        text('exclude', 'Exclude (glob)', { flag: '--exclude' }, { suggest: 'workspaces' }),
        text('jobs', 'Jobs', { flag: '--jobs' }, { placeholder: 'unlimited' }),
        // Last, after the options: `run <script>`.
        { ...script(), cli: { flag: 'run' } }
      ],
      { extraArgs: 'plain' }
    ),
    act('yarn', 'Workspaces', 'run-in', 'Run a script in one workspace', ['yarn', 'run'], [script(), { ...ws(), required: true }], { extraArgs: 'plain' }),
    act('yarn', 'Workspaces', 'list', 'List workspaces', ['yarn', 'workspaces', 'list'], [flag('verbose', 'With dependencies', '--verbose', undefined, '-v'), flag('json', 'As JSON', '--json')]),
    act('yarn', 'Run', 'dlx', 'Run a package without installing (dlx)', ['yarn', 'dlx'], [text('cmd', 'Package and arguments', { positional: true }, { required: true, placeholder: 'create-vite my-app' }), text('pkg', 'With package', { flag: '--package' }, { placeholder: 'typescript' })], { extraArgs: 'plain', flagsFirst: true }),
    act('yarn', 'Release', 'version', 'Bump the version', ['yarn', 'version'], [choice('bump', 'Bump', ['patch', 'minor', 'major', 'prerelease', 'decline'], { positional: true }, { required: true, default: 'patch' }), flag('immediate', 'Apply now', '--immediate', undefined, '-i'), ws()]),
    act('yarn', 'Release', 'pack', 'Pack a tarball', ['yarn', 'pack'], [flag('dry', 'Dry run', '--dry-run', undefined, '-n'), ws()]),
    act('yarn', 'Release', 'publish', 'Publish to the registry', ['yarn', 'npm', 'publish'], [text('tag', 'Dist tag', { flag: '--tag' }, { placeholder: 'latest' }), choice('access', 'Access', ['public', 'restricted'], { flag: '--access' }), ws()], { danger: true }),
    act('yarn', 'Maintenance', 'constraints', 'Check workspace constraints', ['yarn', 'constraints'], [flag('fix', 'Fix them', '--fix')]),
    act('yarn', 'Maintenance', 'set-version', 'Switch the yarn version', ['yarn', 'set', 'version'], [text('version', 'Version', { positional: true }, { required: true, placeholder: 'stable, canary, 4.5.0' })]),
    act('yarn', 'Maintenance', 'cache-clean', 'Clear the cache', ['yarn', 'cache', 'clean'], [flag('all', 'Also the global mirror', '--all')], { danger: true })
  ]
}

function yarnClassicActions(): ActionDef[] {
  const ws = (): ActionInput => text('workspace', 'Workspace', { before: ['workspace'] }, { suggest: 'workspaces', description: 'Run it in this workspace (yarn workspace <name> …).' })
  return [
    act('yarn1', 'Install', 'install', 'Install dependencies', ['yarn', 'install'], [
      flag('frozen', "Don't change the lockfile", '--frozen-lockfile'),
      flag('production', 'Production only', '--production'),
      flag('ignoreScripts', 'Skip install scripts', '--ignore-scripts'),
      flag('checkFiles', 'Verify installed files', '--check-files'),
      flag('force', 'Refetch everything', '--force')
    ]),
    act('yarn1', 'Dependencies', 'add', 'Add packages', ['yarn', 'add'], [
      pkgs(),
      flag('dev', 'Dev dependency', '--dev', undefined, '-D'),
      flag('exact', 'Exact version', '--exact', undefined, '-E'),
      flag('peer', 'Peer dependency', '--peer', undefined, '-P'),
      flag('optional', 'Optional dependency', '--optional', undefined, '-O'),
      flag('root', 'At the workspace root', '--ignore-workspace-root-check', undefined, '-W'),
      ws()
    ]),
    act('yarn1', 'Dependencies', 'remove', 'Remove packages', ['yarn', 'remove'], [pkgs(), ws()]),
    act('yarn1', 'Dependencies', 'upgrade', 'Upgrade packages', ['yarn', 'upgrade'], [pkgs(false, 'Packages (all if empty)'), flag('latest', 'Ignore ranges (latest)', '--latest'), flag('exact', 'Exact version', '--exact'), text('pattern', 'Pattern', { flag: '--pattern' })]),
    act('yarn1', 'Dependencies', 'outdated', 'List outdated packages', ['yarn', 'outdated'], [pkgs(false, 'Packages (all if empty)')]),
    act('yarn1', 'Dependencies', 'why', 'Why is a package installed', ['yarn', 'why'], [text('pkg', 'Package', { positional: true }, { required: true, suggest: 'dependencies' })]),
    act('yarn1', 'Security', 'audit', 'Audit for vulnerabilities', ['yarn', 'audit'], [choice('level', 'Minimum severity', ['info', 'low', 'moderate', 'high', 'critical'], { flag: '--level' }), choice('groups', 'Dependencies', ['dependencies', 'devDependencies'], { flag: '--groups' })]),
    act('yarn1', 'Workspaces', 'run-all', 'Run a script in every workspace', ['yarn', 'workspaces', 'run'], [script()], { extraArgs: 'plain' }),
    act('yarn1', 'Workspaces', 'run-in', 'Run a script in one workspace', ['yarn', 'run'], [script(), { ...ws(), required: true }], { extraArgs: 'plain' }),
    act('yarn1', 'Workspaces', 'info', 'Workspace info', ['yarn', 'workspaces', 'info'], []),
    act('yarn1', 'Release', 'version', 'Bump the version', ['yarn', 'version'], [choice('bump', 'Bump', ['patch', 'minor', 'major', 'prerelease'], { asFlag: true }, { required: true, default: 'patch' }), flag('noTag', "Don't tag", '--no-git-tag-version')]),
    act('yarn1', 'Release', 'pack', 'Pack a tarball', ['yarn', 'pack'], [text('filename', 'File name', { flag: '--filename' })]),
    act('yarn1', 'Release', 'publish', 'Publish to the registry', ['yarn', 'publish'], [text('tag', 'Dist tag', { flag: '--tag' }), choice('access', 'Access', ['public', 'restricted'], { flag: '--access' })], { danger: true }),
    act('yarn1', 'Maintenance', 'cache-clean', 'Clear the cache', ['yarn', 'cache', 'clean'], [], { danger: true })
  ]
}

function pnpmActions(): ActionDef[] {
  const ws = (): ActionInput => text('filter', 'Workspace filter', { before: ['--filter'] }, { suggest: 'workspaces', description: 'Only matching workspaces (pnpm --filter <name> …).' })
  return [
    act('pnpm', 'Install', 'install', 'Install dependencies', ['pnpm', 'install'], [
      flag('frozen', "Don't change the lockfile", '--frozen-lockfile'),
      flag('prod', 'Production only', '--prod', undefined, '-P'),
      flag('ignoreScripts', 'Skip install scripts', '--ignore-scripts'),
      flag('offline', 'Offline', '--offline'),
      flag('preferOffline', 'Prefer offline', '--prefer-offline')
    ]),
    act('pnpm', 'Dependencies', 'add', 'Add packages', ['pnpm', 'add'], [
      pkgs(),
      flag('dev', 'Dev dependency', '--save-dev', undefined, '-D'),
      flag('exact', 'Exact version', '--save-exact', undefined, '-E'),
      flag('optional', 'Optional dependency', '--save-optional', undefined, '-O'),
      flag('peer', 'Peer dependency', '--save-peer'),
      flag('root', 'At the workspace root', '--workspace-root', undefined, '-w'),
      ws()
    ]),
    act('pnpm', 'Dependencies', 'remove', 'Remove packages', ['pnpm', 'remove'], [pkgs(), flag('recursive', 'In every workspace', '--recursive', undefined, '-r'), ws()]),
    act('pnpm', 'Dependencies', 'update', 'Update packages', ['pnpm', 'update'], [pkgs(false, 'Packages (all if empty)'), flag('latest', 'Ignore ranges (latest)', '--latest', undefined, '-L'), flag('recursive', 'In every workspace', '--recursive', undefined, '-r'), ws()]),
    act('pnpm', 'Dependencies', 'outdated', 'List outdated packages', ['pnpm', 'outdated'], [flag('recursive', 'In every workspace', '--recursive', undefined, '-r'), flag('long', 'More detail', '--long')]),
    act('pnpm', 'Dependencies', 'why', 'Why is a package installed', ['pnpm', 'why'], [text('pkg', 'Package', { positional: true }, { required: true, suggest: 'dependencies' }), flag('recursive', 'In every workspace', '--recursive', undefined, '-r')]),
    act('pnpm', 'Dependencies', 'dedupe', 'Dedupe the dependency tree', ['pnpm', 'dedupe'], [flag('check', 'Only check', '--check')]),
    act('pnpm', 'Security', 'audit', 'Audit for vulnerabilities', ['pnpm', 'audit'], [flag('fix', 'Fix (adds overrides)', '--fix'), choice('level', 'Minimum severity', ['low', 'moderate', 'high', 'critical'], { flag: '--audit-level' }), flag('prod', 'Production only', '--prod', undefined, '-P')]),
    act('pnpm', 'Workspaces', 'run-all', 'Run a script in every workspace', ['pnpm', '-r', 'run'], [script(), flag('parallel', 'In parallel', '--parallel'), flag('ifPresent', 'Skip workspaces without it', '--if-present'), ws()], { extraArgs: 'plain', flagsFirst: true }),
    act('pnpm', 'Workspaces', 'run-in', 'Run a script in one workspace', ['pnpm', 'run'], [script(), { ...ws(), required: true }], { extraArgs: 'plain' }),
    act('pnpm', 'Run', 'dlx', 'Run a package without installing (dlx)', ['pnpm', 'dlx'], [text('cmd', 'Package and arguments', { positional: true }, { required: true, placeholder: 'create-vite my-app' })], { extraArgs: 'plain' }),
    act('pnpm', 'Run', 'exec', 'Run a binary in every workspace', ['pnpm', '-r', 'exec'], [text('cmd', 'Command', { positional: true }, { required: true, placeholder: 'tsc --noEmit' }), ws()], { extraArgs: 'plain', flagsFirst: true }),
    act('pnpm', 'Release', 'pack', 'Pack a tarball', ['pnpm', 'pack'], [ws()]),
    act('pnpm', 'Release', 'publish', 'Publish to the registry', ['pnpm', 'publish'], [flag('recursive', 'Every workspace', '--recursive', undefined, '-r'), text('tag', 'Dist tag', { flag: '--tag' }), choice('access', 'Access', ['public', 'restricted'], { flag: '--access' }), flag('dry', 'Dry run', '--dry-run'), flag('noGitChecks', 'Skip git checks', '--no-git-checks')], { danger: true }),
    act('pnpm', 'Maintenance', 'store-prune', 'Prune the store', ['pnpm', 'store', 'prune'], [])
  ]
}

function bunActions(): ActionDef[] {
  const ws = (): ActionInput => text('filter', 'Workspace filter', { before: ['--filter'] }, { suggest: 'workspaces', description: 'Only matching workspaces (bun --filter <pattern> …).' })
  return [
    act('bun', 'Install', 'install', 'Install dependencies', ['bun', 'install'], [
      flag('frozen', "Don't change the lockfile", '--frozen-lockfile'),
      flag('production', 'Production only', '--production'),
      flag('ignoreScripts', 'Skip install scripts', '--ignore-scripts'),
      flag('force', 'Reinstall everything', '--force')
    ]),
    act('bun', 'Dependencies', 'add', 'Add packages', ['bun', 'add'], [pkgs(), flag('dev', 'Dev dependency', '--dev', undefined, '-d'), flag('exact', 'Exact version', '--exact', undefined, '-E'), flag('optional', 'Optional dependency', '--optional'), flag('peer', 'Peer dependency', '--peer')]),
    act('bun', 'Dependencies', 'remove', 'Remove packages', ['bun', 'remove'], [pkgs()]),
    act('bun', 'Dependencies', 'update', 'Update packages', ['bun', 'update'], [pkgs(false, 'Packages (all if empty)'), flag('latest', 'Ignore ranges (latest)', '--latest')]),
    act('bun', 'Dependencies', 'outdated', 'List outdated packages', ['bun', 'outdated'], [ws()]),
    act('bun', 'Dependencies', 'ls', 'List installed packages', ['bun', 'pm', 'ls'], [flag('all', 'All levels', '--all')]),
    act('bun', 'Security', 'audit', 'Audit for vulnerabilities', ['bun', 'audit'], []),
    act('bun', 'Workspaces', 'run-in', 'Run a script in matching workspaces', ['bun', 'run'], [{ ...ws(), required: true }, script()], { extraArgs: 'plain' }),
    act('bun', 'Run', 'x', 'Run a package without installing (bunx)', ['bunx'], [text('cmd', 'Package and arguments', { positional: true }, { required: true })], { extraArgs: 'plain' }),
    act('bun', 'Release', 'pack', 'Pack a tarball', ['bun', 'pm', 'pack'], [flag('dry', 'Dry run', '--dry-run')]),
    act('bun', 'Release', 'publish', 'Publish to the registry', ['bun', 'publish'], [text('tag', 'Dist tag', { flag: '--tag' }), choice('access', 'Access', ['public', 'restricted'], { flag: '--access' }), flag('dry', 'Dry run', '--dry-run')], { danger: true }),
    act('bun', 'Maintenance', 'cache-clean', 'Clear the cache', ['bun', 'pm', 'cache', 'rm'], [], { danger: true })
  ]
}

/** A package manager's own commands. Yarn 2+ ("Berry") and yarn 1 ("classic") differ. */
export function packageManagerActions(pm: PackageManager, opts: { yarnBerry?: boolean } = {}): ActionDef[] {
  if (pm === 'npm') return npmActions()
  if (pm === 'pnpm') return pnpmActions()
  if (pm === 'bun') return bunActions()
  return opts.yarnBerry ? yarnBerryActions() : yarnClassicActions()
}

/** How a project runs the mono CLI: through its package manager. */
export function monoRunner(pm: PackageManager): string[] {
  return pm === 'yarn' ? ['yarn'] : pm === 'pnpm' ? ['pnpm'] : pm === 'bun' ? ['bunx'] : ['npx']
}
