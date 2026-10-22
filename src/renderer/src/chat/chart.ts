// Minimal SVG charts for ```chart blocks: {"type":"bar"|"line"|"pie","title","labels","series":[{"name","values"}]}

interface ChartSpec {
  type?: 'bar' | 'line' | 'pie'
  title?: string
  labels?: string[]
  series?: { name?: string; values: number[] }[]
}

const PALETTE = ['var(--accent)', '#5fb3f9', '#4cc38a', '#b78bf7', '#e8b04b', '#f06a8a', '#3fd0c9', '#9aa4ff']
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')

export function renderChart(src: string): string {
  let spec: ChartSpec
  try {
    spec = JSON.parse(src)
  } catch {
    return `<pre class="chart-error">Invalid chart JSON</pre>`
  }
  const labels = spec.labels ?? []
  const series = (spec.series ?? []).filter((s) => Array.isArray(s.values))
  if (!series.length) return `<pre class="chart-error">Chart has no series</pre>`
  const W = 560
  const H = 240
  const P = { l: 44, r: 12, t: spec.title ? 30 : 12, b: 34 }
  const title = spec.title ? `<text x="${W / 2}" y="18" text-anchor="middle" class="ch-title">${esc(spec.title)}</text>` : ''
  const legend = series.length > 1 ? `<div class="ch-legend">${series.map((s, i) => `<span><i style="background:${PALETTE[i % PALETTE.length]}"></i>${esc(s.name ?? `Series ${i + 1}`)}</span>`).join('')}</div>` : ''

  if (spec.type === 'pie') {
    const vals = series[0].values
    const total = vals.reduce((a, b) => a + Math.max(0, b), 0) || 1
    let a0 = -Math.PI / 2
    const cx = W / 2
    const cy = (H + P.t) / 2
    const r = Math.min(W, H - P.t) / 2 - 10
    const arcs = vals
      .map((v, i) => {
        const a1 = a0 + (Math.max(0, v) / total) * Math.PI * 2
        const large = a1 - a0 > Math.PI ? 1 : 0
        const d = `M${cx},${cy} L${cx + r * Math.cos(a0)},${cy + r * Math.sin(a0)} A${r},${r} 0 ${large} 1 ${cx + r * Math.cos(a1)},${cy + r * Math.sin(a1)} Z`
        a0 = a1
        return `<path d="${d}" fill="${PALETTE[i % PALETTE.length]}"><title>${esc(labels[i] ?? '')}: ${v}</title></path>`
      })
      .join('')
    const leg = `<div class="ch-legend">${vals.map((v, i) => `<span><i style="background:${PALETTE[i % PALETTE.length]}"></i>${esc(labels[i] ?? `#${i + 1}`)} (${Math.round((v / total) * 100)}%)</span>`).join('')}</div>`
    return `<div class="chart"><svg viewBox="0 0 ${W} ${H}">${title}${arcs}</svg>${leg}</div>`
  }

  const all = series.flatMap((s) => s.values)
  const max = Math.max(0, ...all)
  const min = Math.min(0, ...all)
  const span = max - min || 1
  const n = Math.max(labels.length, ...series.map((s) => s.values.length))
  const iw = W - P.l - P.r
  const ih = H - P.t - P.b
  const y = (v: number): number => P.t + ih - ((v - min) / span) * ih
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => min + f * span)
  const grid = ticks
    .map((t) => `<line x1="${P.l}" x2="${W - P.r}" y1="${y(t)}" y2="${y(t)}" class="ch-grid"/><text x="${P.l - 6}" y="${y(t) + 4}" text-anchor="end" class="ch-axis">${+t.toFixed(2)}</text>`)
    .join('')
  const step = iw / Math.max(1, n)
  const xl = labels
    .map((l, i) => (n <= 16 || i % Math.ceil(n / 16) === 0 ? `<text x="${P.l + step * i + step / 2}" y="${H - P.b + 16}" text-anchor="middle" class="ch-axis">${esc(String(l)).slice(0, 12)}</text>` : ''))
    .join('')
  let marks = ''
  if (spec.type === 'line') {
    marks = series
      .map((s, si) => {
        const pts = s.values.map((v, i) => `${P.l + step * i + step / 2},${y(v)}`).join(' ')
        const dots = s.values.map((v, i) => `<circle cx="${P.l + step * i + step / 2}" cy="${y(v)}" r="3" fill="${PALETTE[si % PALETTE.length]}"><title>${esc(labels[i] ?? '')}: ${v}</title></circle>`).join('')
        return `<polyline points="${pts}" fill="none" stroke="${PALETTE[si % PALETTE.length]}" stroke-width="2"/>${dots}`
      })
      .join('')
  } else {
    const bw = (step * 0.75) / series.length
    marks = series
      .map((s, si) =>
        s.values
          .map((v, i) => {
            const x = P.l + step * i + step * 0.125 + bw * si
            const top = y(Math.max(v, 0))
            const h = Math.abs(y(v) - y(0))
            return `<rect x="${x}" y="${top}" width="${Math.max(1, bw - 2)}" height="${Math.max(1, h)}" rx="3" fill="${PALETTE[si % PALETTE.length]}"><title>${esc(labels[i] ?? '')}: ${v}</title></rect>`
          })
          .join('')
      )
      .join('')
  }
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}">${title}${grid}${marks}${xl}</svg>${legend}</div>`
}
