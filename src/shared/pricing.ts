// Per-model API rates for cost estimates (USD per million tokens, Anthropic first-party list prices).
// The CLIs report real cost only at the end of a turn; these estimate spend between those points.

export interface Rates {
  input: number
  /** 5-minute cache write. */
  cacheWrite: number
  cacheRead: number
  output: number
}

const r = (input: number, output: number, cacheRead = input / 10): Rates => ({ input, cacheWrite: input * 1.25, cacheRead, output })

/** Most specific first: the first pattern found in the model id wins. */
const TABLE: [RegExp, Rates][] = [
  [/fable-5-1|mythos-5-1/, r(10, 50, 0.25)],
  [/fable|mythos/, r(10, 50)],
  [/opus-5-5/, r(4, 20, 0.2)],
  [/opus/, r(5, 25)],
  [/sonnet-5/, r(2, 10, 0.2)],
  [/sonnet/, r(3, 15)],
  [/haiku-5-5/, r(0.1, 0.5, 0.01)],
  [/haiku/, r(1, 5)]
]

/** Unknown models (incl. Codex) are priced high, so the budget guard errs toward stopping. */
export const FALLBACK_RATES: Rates = r(5, 25)

export function ratesFor(model: string | undefined): Rates {
  const m = (model ?? '').toLowerCase()
  for (const [re, rates] of TABLE) if (re.test(m)) return rates
  return FALLBACK_RATES
}

export interface UsageTokens {
  input: number
  cacheWrite: number
  cacheRead: number
  output: number
}

/** One API request as recorded in a transcript. */
export interface UsageRecord extends UsageTokens {
  /** Dedupe key (Claude writes one line per content block, each carrying the message's usage). */
  id?: string
  model?: string
  /** Tokens in that request's context window. */
  context: number
}

export function costOf(model: string | undefined, u: UsageTokens): number {
  const k = ratesFor(model)
  return (u.input * k.input + u.cacheWrite * k.cacheWrite + u.cacheRead * k.cacheRead + u.output * k.output) / 1_000_000
}
