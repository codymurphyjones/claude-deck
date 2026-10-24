import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import ts from 'typescript'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { lineCol, TsProjects } from '../src/main/lsp/tsService'

// The editor's TypeScript service against a small throwaway project.

let dir: string
let svc: TsProjects
const p = (rel: string): string => path.join(dir, rel).replace(/\\/g, '/')

const UTIL = ['/** Adds two numbers. */', 'export function add(a: number, b: number): number {', '  return a + b', '}', 'export const greeting = "hi"', ''].join('\n')
const MAIN = ['import { add, greeting } from "./util"', '', 'const total: number = add(1, 2)', 'const bad: string = total', 'greeting.', ''].join('\n')

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-ts-'))
  fs.mkdirSync(path.join(dir, 'src'))
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', noEmit: true }, include: ['src'] }))
  fs.writeFileSync(path.join(dir, 'src', 'util.ts'), UTIL)
  fs.writeFileSync(path.join(dir, 'src', 'main.ts'), MAIN)
  svc = new TsProjects(ts)
  svc.update(p('src/main.ts'), MAIN, dir)
})

afterAll(() => {
  svc.dispose()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('TsProjects', () => {
  it('reports type errors with positions in the open text', () => {
    const diags = svc.diagnostics(p('src/main.ts'))
    const bad = diags.find((d) => d.code === 2322)
    expect(bad).toBeTruthy()
    expect(bad!.severity).toBe('error')
    expect(bad!.line).toBe(4)
    expect(MAIN.slice(bad!.from, bad!.to)).toBe('bad')
    expect(bad!.message).toMatch(/number.*string/)
  })

  it('uses unsaved text from the editor, not the file on disk', () => {
    const fixed = MAIN.replace('const bad: string = total', 'const bad: number = total').replace('greeting.\n', 'greeting.length\n')
    svc.update(p('src/main.ts'), fixed, dir)
    expect(svc.diagnostics(p('src/main.ts'))).toEqual([])
    svc.update(p('src/main.ts'), MAIN, dir)
    expect(svc.diagnostics(p('src/main.ts')).some((d) => d.code === 2322)).toBe(true)
  })

  it('gives quick info with types and docs', () => {
    const info = svc.quickInfo(p('src/main.ts'), MAIN.indexOf('add(1') + 1)
    expect(info?.text).toBe('(alias) add(a: number, b: number): number\nimport add')
    expect(info?.doc).toContain('Adds two numbers.')
    expect(MAIN.slice(info!.from, info!.to)).toBe('add')
  })

  it('finds definitions in files that are not open', () => {
    const defs = svc.definition(p('src/main.ts'), MAIN.indexOf('add(1') + 1)
    expect(defs).toHaveLength(1)
    expect(defs[0].file.toLowerCase()).toBe(p('src/util.ts').toLowerCase())
    expect(defs[0]).toMatchObject({ line: 2, col: 17 })
  })

  it('completes members, filtered by the typed prefix', () => {
    const pos = MAIN.indexOf('greeting.') + 'greeting.'.length
    const all = svc.completions(p('src/main.ts'), pos)
    expect(all.isMember).toBe(true)
    expect(all.items.map((i) => i.name)).toContain('toUpperCase')
    const some = svc.completions(p('src/main.ts'), pos, 'tup')
    expect(some.items.map((i) => i.name)).toContain('toUpperCase')
    expect(some.items.map((i) => i.name)).not.toContain('length')
    const details = svc.completionDetails(p('src/main.ts'), pos, 'toUpperCase')
    expect(details?.text).toContain('toUpperCase(): string')
  })

  it('works for a folder without a tsconfig (inferred project, JS allowed)', () => {
    const loose = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-js-'))
    try {
      const file = path.join(loose, 'a.js').replace(/\\/g, '/')
      const text = 'function twice(n) { return n * 2 }\nconst x = twice(2)\nconst y = ;\n'
      fs.writeFileSync(file, text)
      svc.update(file, text, loose)
      const diags = svc.diagnostics(file)
      expect(diags.some((d) => d.severity === 'error' && d.line === 3)).toBe(true)
      expect(svc.quickInfo(file, text.indexOf('twice(2)'))?.text).toContain('function twice(n: any): number')
      svc.close(file)
      expect(svc.diagnostics(file)).toEqual([])
    } finally {
      fs.rmSync(loose, { recursive: true, force: true })
    }
  })

  it('uses the referenced project of a solution-style tsconfig (and its path aliases)', () => {
    const sol = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-sol-'))
    try {
      fs.mkdirSync(path.join(sol, 'app'))
      fs.mkdirSync(path.join(sol, 'shared'))
      fs.writeFileSync(path.join(sol, 'tsconfig.json'), JSON.stringify({ files: [], references: [{ path: './tsconfig.app.json' }] }))
      fs.writeFileSync(
        path.join(sol, 'tsconfig.app.json'),
        JSON.stringify({ compilerOptions: { strict: true, module: 'ESNext', moduleResolution: 'Bundler', baseUrl: '.', paths: { '@shared/*': ['shared/*'] } }, include: ['app', 'shared'] })
      )
      fs.writeFileSync(path.join(sol, 'shared', 'n.ts'), 'export const n = 1\n')
      const file = path.join(sol, 'app', 'a.ts').replace(/\\/g, '/')
      const text = "import { n } from '@shared/n'\nconst s: string = n\n"
      fs.writeFileSync(file, text)
      svc.update(file, text, sol)
      expect(svc.diagnostics(file).map((d) => d.code)).toEqual([2322])
      svc.close(file)
    } finally {
      fs.rmSync(sol, { recursive: true, force: true })
    }
  })

  it('maps offsets to 1-based lines and columns', () => {
    expect(lineCol('ab\ncd', 0)).toEqual({ line: 1, col: 1 })
    expect(lineCol('ab\ncd', 3)).toEqual({ line: 2, col: 1 })
    expect(lineCol('ab\ncd', 4)).toEqual({ line: 2, col: 2 })
  })
})
