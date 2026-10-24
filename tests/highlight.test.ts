import { beforeAll, describe, expect, it } from 'vitest'
import { languageForPath, languageFromShebang, normalizeLang } from '@shared/languages'
import { extractSymbols } from '@shared/symbols'
import { highlight, highlightDiffLines, highlightLines, langForFile, loadAllLanguages, splitHtmlLines } from '../src/renderer/src/highlight'

// The full language set loads on demand in the app; load it up front here.
beforeAll(() => loadAllLanguages())

describe('language detection', () => {
  it('maps extensions, special file names and shebangs', () => {
    expect(languageForPath('src/app.tsx')).toBe('typescript')
    expect(languageForPath('C:\\x\\Dockerfile')).toBe('dockerfile')
    expect(languageForPath('Dockerfile.dev')).toBe('dockerfile')
    expect(languageForPath('Makefile')).toBe('makefile')
    expect(languageForPath('CMakeLists.txt')).toBe('cmake')
    expect(languageForPath('.env.local')).toBe('ini')
    expect(languageForPath('Gemfile')).toBe('ruby')
    expect(languageForPath('lib/x.rs')).toBe('rs')
    expect(languageForPath('bin/run', '#!/usr/bin/env python3')).toBe('python')
    expect(languageFromShebang('#!/bin/bash')).toBe('bash')
    expect(languageFromShebang('#!/usr/bin/env node')).toBe('javascript')
    expect(normalizeLang('C++')).toBe('cpp')
    expect(normalizeLang('sh')).toBe('bash')
  })

  it('resolves to languages highlight.js knows, plain text otherwise', () => {
    for (const f of ['a.rs', 'a.kt', 'a.ex', 'a.hs', 'a.clj', 'a.vue', 'a.ps1', 'a.sql', 'a.swift', 'a.dart', 'a.zig', 'a.tf', 'a.jl', 'a.scala', 'a.erl', 'a.f90', 'a.nim']) expect(langForFile(f)).not.toBe('')
    expect(langForFile('a.rs')).toBe('rust')
    expect(langForFile('notes.unknownext')).toBe('plaintext')
    expect(langForFile('README')).toBe('plaintext')
  })
})

describe('highlighting', () => {
  it('escapes plain text and unknown languages', () => {
    expect(highlight('<a> & b', 'plaintext')).toBe('&lt;a&gt; &amp; b')
    expect(highlight('<x>', 'no-such-lang')).toBe('&lt;x&gt;')
  })

  it('splits highlighted HTML into balanced lines', () => {
    expect(splitHtmlLines('<span class="a">one\ntwo</span>\nthree')).toEqual(['<span class="a">one</span>', '<span class="a">two</span>', 'three'])
    const lines = highlightLines('/* a\n b */\nconst x = 1', 'javascript')
    expect(lines).toHaveLength(3)
    expect(lines[1]).toContain('hljs-comment')
    for (const l of lines) expect((l.match(/<span/g) ?? []).length).toBe((l.match(/<\/span>/g) ?? []).length)
  })

  it('highlights diffs with multi-line context on each side', () => {
    const out = highlightDiffLines([' /* start', '-old line', '+new line', ' end */', '+const y = 2', '\\ No newline at end of file'], 'javascript')
    expect(out).toHaveLength(6)
    expect(out[1]).toContain('hljs-comment')
    expect(out[2]).toContain('hljs-comment')
    expect(out[4]).toContain('hljs-keyword')
    expect(out[5]).toBe(' No newline at end of file')
    expect(highlightDiffLines(['+<b>'], 'plaintext')).toEqual(['&lt;b&gt;'])
  })
})

describe('symbols', () => {
  it('outlines TypeScript', () => {
    const src = ['export interface Props {', '  a: string', '}', 'export class Store {', '  private items = []', '  async load(id: string): Promise<void> {', '    if (x) {', '    }', '  }', '}', 'export const run = async () => {}', 'function helper() {}', 'type Id = string'].join('\n')
    const s = extractSymbols(src, 'typescript')
    expect(s.map((x) => [x.name, x.kind, x.line])).toEqual([
      ['Props', 'interface', 1],
      ['Store', 'class', 4],
      ['load', 'method', 6],
      ['run', 'function', 11],
      ['helper', 'function', 12],
      ['Id', 'type', 13]
    ])
    expect(s.find((x) => x.name === 'load')!.depth).toBe(1)
  })

  it('outlines Python, Go, Markdown and CSS', () => {
    expect(extractSymbols('class A:\n    def f(self):\n        pass\nasync def g():\n    pass', 'python').map((x) => [x.name, x.depth])).toEqual([
      ['A', 0],
      ['f', 1],
      ['g', 0]
    ])
    expect(extractSymbols('type S struct{}\nfunc (s *S) Do() {}\nfunc main() {}', 'go').map((x) => x.name)).toEqual(['S', 'Do', 'main'])
    expect(extractSymbols('# Title\n```\n# not a heading\n```\n## Sub', 'markdown').map((x) => [x.name, x.depth])).toEqual([
      ['Title', 0],
      ['Sub', 1]
    ])
    expect(extractSymbols('.btn {\n  color: red;\n}\n@media (max-width: 1px) {\n  .x { }\n}', 'css').map((x) => x.name)).toEqual(['.btn', '@media (max-width: 1px)', '.x'])
  })

  it('falls back to common rules for unknown languages and skips comments', () => {
    const s = extractSymbols('// function nope() {}\n/*\nclass Nope {}\n*/\nfunction yes() {}\nfn also() {}', undefined)
    expect(s.map((x) => x.name)).toEqual(['yes', 'also'])
  })
})
