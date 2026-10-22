import { describe, expect, it } from 'vitest'
import { dataRows, decodeJobCard, encodeJobCard, sameJob, writeDataStrip } from '@shared/jobCard'
import { normalizeJob } from '@shared/jobs'

const job = normalizeJob({
  name: 'UI refactor ✨',
  description: 'Unify styling across the app.',
  context: 'Keep the public API stable.\n'.repeat(40),
  pivots: [{ when: 'tests break', then: 'revert and report' }],
  defaults: { workspace: 'inplace' },
  steps: [
    { title: 'Audit', prompt: 'Find every component.', expectations: [{ kind: 'command', text: 'npm test', timeoutSec: 300 }] },
    { title: 'Refactor', prompt: 'Do it.', freshSession: true }
  ]
})

/** An image with `top` rows of noise above the strip and `bottom` rows below, like a rendered card. */
async function image(kind: 'routine' | 'repo', width: number, top = 40, bottom = 3) {
  const bytes = await encodeJobCard({ kind, job })
  const rows = dataRows(bytes.length, width)
  const height = top + rows + bottom
  const rgba = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < top * width * 4; i++) rgba[i] = (i * 7919) % 256
  writeDataStrip(bytes, rgba, width, top)
  return { rgba, width, height, top }
}

describe('job cards', () => {
  it('round-trips a routine and a repo job through pixels', async () => {
    for (const kind of ['routine', 'repo'] as const) {
      const { rgba, width, height } = await image(kind, 560)
      const card = await decodeJobCard(rgba, width, height)
      expect(card?.kind).toBe(kind)
      expect(card?.job).toEqual(job)
    }
  })

  it('keeps every data pixel opaque', async () => {
    const { rgba, width, height, top } = await image('routine', 97)
    for (let p = top * width; p < (height - 3) * width; p++) expect(rgba[p * 4 + 3]).toBe(255)
  })

  it('rejects ordinary and damaged images', async () => {
    expect(await decodeJobCard(new Uint8ClampedArray(64 * 64 * 4).fill(200), 64, 64)).toBeUndefined()
    const { rgba, width, height, top } = await image('repo', 120)
    rgba[(top * width + 20) * 4] ^= 0xff
    expect(await decodeJobCard(rgba, width, height)).toBeUndefined()
  })

  it('compares definitions ignoring the slug', () => {
    expect(sameJob(job, { ...job, slug: 'other' })).toBe(true)
    expect(sameJob(job, { ...job, name: 'x' })).toBe(false)
  })
})
