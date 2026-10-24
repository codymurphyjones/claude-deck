import { Marked, type Tokens } from 'marked'
import { beforeAll, describe, expect, it } from 'vitest'
import { normalizeLang } from '@shared/languages'
import { inferFenceLang, tagFences } from '../src/renderer/src/chat/fenceLang'
import { loadAllLanguages } from '../src/renderer/src/highlight'

// The full highlight.js language set loads on demand in the app; load it up front here.
beforeAll(() => loadAllLanguages())

const LUA = 'local t = {}\nfor i = 1, 10 do\n  t[i] = i * 2\nend\nprint(#t)'

/** The lang of each fenced code block after tagging. */
function langs(src: string): string[] {
  const md = new Marked()
  const tokens = md.lexer(src)
  tagFences(tokens, (ts, cb) => md.walkTokens(ts, cb))
  const out: string[] = []
  md.walkTokens(tokens, (t) => {
    if (t.type === 'code') out.push((t as Tokens.Code).lang ?? '')
  })
  return out
}

describe('fence language inference', () => {
  it('uses a file named just before the fence', () => {
    expect(inferFenceLang(LUA, 'Update `src/init.lua`:')).toBe('lua')
    expect(inferFenceLang(LUA, 'See [the config](lua/plugins.lua)')).toBe('lua')
    expect(inferFenceLang('x', 'In `src/app.ts:12`')).toBe('typescript')
  })

  it('ignores bare words that only look like files', () => {
    expect(inferFenceLang('npm install', 'Install it with Node.js:')).toBe('plaintext')
  })

  it('uses a shebang, then a language named in the last sentence', () => {
    expect(inferFenceLang('#!/usr/bin/env lua\nprint(1)')).toBe('lua')
    expect(inferFenceLang(LUA, "Here's the Lua version:")).toBe('lua')
    expect(inferFenceLang(LUA, 'Python was slow. Here it is in Lua:')).toBe('lua')
    expect(inferFenceLang('x', 'Here it is in JavaScript:')).toBe('javascript')
  })

  it('falls back to the message language, then plain text rather than a weak guess', () => {
    expect(inferFenceLang(LUA, '', 'lua')).toBe('lua')
    expect(inferFenceLang(LUA)).not.toBe('fortran')
    expect(inferFenceLang('hello world this is output')).toBe('plaintext')
  })

  it('tags untagged fences in a message and leaves tagged ones alone', () => {
    const src = ['Edit `init.lua`:', '', '```', LUA, '```', '', 'Then:', '', '```python', 'x = 1', '```', '', '- item', '', '  ```', '  ' + 'echo hi', '  ```'].join('\n')
    expect(langs(src)).toEqual(['lua', 'python', 'python'])
    expect(langs('```lua\nlocal a = 1\n```\n\nand\n\n```\nlocal b = 2\n```')).toEqual(['lua', 'lua'])
  })

  it('maps luau fences to lua', () => {
    expect(normalizeLang('luau')).toBe('lua')
  })
})
