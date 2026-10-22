import { describe, expect, it } from 'vitest'
import {
  buildRetryPrompt,
  buildStepPrompt,
  extractJson,
  jobRunBranchName,
  manifestOf,
  newStep,
  normalizeJob,
  parseStepReport,
  resolveRunOptions,
  slugify,
  stepsToRun,
  uniqueId
} from '@shared/jobs'

const raw = {
  name: 'Upgrade deps',
  description: 'Bring dependencies up to date safely.',
  context: 'Use npm.',
  pivots: [{ when: 'a major bump breaks the build', then: 'pin the previous major and note it' }],
  defaults: { workspace: 'inplace', branch: 'develop', bogus: 1 },
  steps: [
    { id: 'Audit Deps', title: 'Audit', prompt: 'List outdated packages.', expectations: ['A list exists'], maxAttempts: 99 },
    { title: 'Upgrade', prompt: 'Upgrade them.', expectations: [{ kind: 'command', text: 'npm test', timeoutSec: 300 }, { kind: 'text', text: '  ' }], pivots: [{ when: 'tests flake', then: 'rerun once' }], onFail: 'continue' },
    { title: 'Upgrade', prompt: 'Again', freshSession: true }
  ]
}

describe('repo jobs', () => {
  it('normalizes untrusted job JSON', () => {
    const j = normalizeJob(raw, 'upgrade-deps')
    expect(j.slug).toBe('upgrade-deps')
    expect(j.defaults).toEqual({ workspace: 'inplace', branch: 'develop' })
    expect(j.steps.map((s) => s.id)).toEqual(['audit-deps', 'upgrade', 'upgrade-2'])
    expect(j.steps[0].expectations).toEqual([{ kind: 'text', text: 'A list exists' }])
    expect(j.steps[0].maxAttempts).toBe(10)
    expect(j.steps[1].expectations).toEqual([{ kind: 'command', text: 'npm test', timeoutSec: 300 }])
    expect(j.steps[1].onFail).toBe('continue')
    expect(j.steps[2].freshSession).toBe(true)
    expect(normalizeJob(null).steps).toEqual([])
  })

  it('round-trips through the on-disk manifest', () => {
    const j = normalizeJob(raw, 'upgrade-deps')
    const m = manifestOf(j) as { steps: Record<string, unknown>[] }
    expect(m.steps[0]).not.toHaveProperty('prompt')
    const back = normalizeJob({ ...m, context: j.context, steps: m.steps.map((s, i) => ({ ...s, prompt: j.steps[i].prompt })) }, j.slug)
    expect(back).toEqual(j)
  })

  it('builds step prompts with context, expectations, pivots and reporting', () => {
    const j = normalizeJob(raw, 'upgrade-deps')
    const first = buildStepPrompt(j, 1, { withContext: true, extra: 'PR #4 changed package.json' })
    expect(first).toContain('Job goal: Bring dependencies')
    expect(first).toContain('## Job context\nUse npm.')
    expect(first).toContain('PR #4 changed package.json')
    expect(first).toContain('## Step 2 of 3: Upgrade')
    expect(first).toContain('`npm test` must exit with code 0')
    // Step pivots first, then job-wide pivots.
    expect(first).toMatch(/1\. If tests flake → rerun once\n2\. If a major bump breaks the build/)
    expect(first).toContain('STEP_STATUS:')
    const later = buildStepPrompt(j, 0, { withContext: false })
    expect(later).not.toContain('Job context')
    // Job-wide pivots still apply to steps without their own.
    expect(later).toContain('1. If a major bump breaks the build')
    const retry = buildRetryPrompt(j, 1, 2, ['`npm test` exited with code 1'])
    expect(retry).toContain('attempt 2 of 2')
    expect(retry).toContain('- `npm test` exited with code 1')
    expect(retry).toContain('consider the pivots')
  })

  it('parses the trailing step report', () => {
    expect(parseStepReport('did stuff\n\nSTEP_STATUS: done\nPIVOT: none\nSUMMARY: Upgraded 4 packages')).toEqual({ status: 'done', pivot: undefined, summary: 'Upgraded 4 packages' })
    expect(parseStepReport('**STEP_STATUS:** partial\n**PIVOT:** 2\n**SUMMARY:** half done**')).toEqual({ status: 'partial', pivot: 2, summary: 'half done' })
    // The last report wins (e.g. Claude quoted the format earlier).
    expect(parseStepReport('STEP_STATUS: done\n...\nSTEP_STATUS: Blocked\nSUMMARY: no network').status).toBe('blocked')
    expect(parseStepReport('no report at all')).toEqual({ status: 'unknown', pivot: undefined, summary: '' })
  })

  it('selects steps and merges run options', () => {
    const j = normalizeJob(raw, 'upgrade-deps')
    expect(stepsToRun(j, {})).toEqual([0, 1, 2])
    expect(stepsToRun(j, { fromStep: 1 })).toEqual([1, 2])
    expect(stepsToRun(j, { onlyStep: 2 })).toEqual([2])
    expect(stepsToRun(j, { onlyStep: 7 })).toEqual([])
    expect(resolveRunOptions(j, { branch: '', model: 'opus' })).toEqual({ workspace: 'inplace', branchMode: 'new', branch: 'develop', model: 'opus' })
    expect(resolveRunOptions(j, { workspace: 'worktree' }).workspace).toBe('worktree')
  })

  it('extracts JSON from model replies', () => {
    expect(extractJson('Here you go:\n```json\n{"a": {"b": "}"}}\n```')).toEqual({ a: { b: '}' } })
    expect(extractJson('{"name":"x","s":"say \\"hi\\""} trailing')).toEqual({ name: 'x', s: 'say "hi"' })
    expect(() => extractJson('nothing here')).toThrow()
  })

  it('makes ids and names', () => {
    expect(slugify('  Fix: the Build!! ')).toBe('fix-the-build')
    expect(slugify('***')).toBe('job')
    expect(uniqueId('Step', ['step', 'step-2'])).toBe('step-3')
    expect(newStep('Verify', ['verify']).id).toBe('verify-2')
    expect(jobRunBranchName('upgrade-deps', 'jab12cd34')).toBe('jobs/upgrade-deps-12cd34')
  })
})
