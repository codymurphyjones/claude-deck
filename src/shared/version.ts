/** Semver-ish comparison that understands "-dev.N" pre-releases. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [main, pre] = v.replace(/^v/, '').split('-')
    return { nums: main.split('.').map(Number), pre }
  }
  const A = parse(a)
  const B = parse(b)
  for (let i = 0; i < 3; i++) if ((A.nums[i] ?? 0) !== (B.nums[i] ?? 0)) return (A.nums[i] ?? 0) - (B.nums[i] ?? 0)
  if (!A.pre && B.pre) return 1
  if (A.pre && !B.pre) return -1
  if (!A.pre && !B.pre) return 0
  const an = Number(A.pre!.split('.').pop())
  const bn = Number(B.pre!.split('.').pop())
  return Number.isNaN(an) || Number.isNaN(bn) ? A.pre!.localeCompare(B.pre!) : an - bn
}
