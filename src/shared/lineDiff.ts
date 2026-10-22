// Line-level LCS diff used to render Edit tool calls.
export type DiffLine = { t: ' ' | '+' | '-'; s: string }

export function lineDiff(a: string, b: string): DiffLine[] {
  const A = a.split('\n')
  const B = b.split('\n')
  if (A.length * B.length > 400_000) return [...A.map((s) => ({ t: '-' as const, s })), ...B.map((s) => ({ t: '+' as const, s }))]
  const n = A.length
  const m = B.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      out.push({ t: ' ', s: A[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ t: '-', s: A[i++] })
    else out.push({ t: '+', s: B[j++] })
  }
  while (i < n) out.push({ t: '-', s: A[i++] })
  while (j < m) out.push({ t: '+', s: B[j++] })
  return out
}
