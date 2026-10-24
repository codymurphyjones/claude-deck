import * as fs from 'fs'
import * as path from 'path'
import { describe, expect, it } from 'vitest'
import { agentBrowserUrl, APP_TOOL_TIERS, appToolTier, AUTO_ALLOWED_TOOLS, autoAllowedTools, browserUrl, confirmTools, expandShellRules, MESH_TOOLS } from '@shared/agentTools'

describe('deck-mesh tool registry', () => {
  // The MCP server script defines the schemas; its tool names must match the lists the app uses
  // for permissions and dispatch.
  const src = fs.readFileSync(path.resolve('resources/meshMcp.cjs'), 'utf8')
  const served = [...src.matchAll(/^ {4}name: '(\w+)'/gm)].map((m) => m[1])

  it('lists exactly the tools the MCP server serves', () => {
    expect([...served].sort()).toEqual([...MESH_TOOLS, ...Object.keys(APP_TOOL_TIERS)].sort())
  })

  it('never pre-allows tools that run processes or load pages', () => {
    expect(AUTO_ALLOWED_TOOLS).not.toContain('run_process')
    expect(AUTO_ALLOWED_TOOLS).not.toContain('open_browser')
    expect(AUTO_ALLOWED_TOOLS).toContain('mesh_claim')
    expect(AUTO_ALLOWED_TOOLS).toContain('show_diff')
  })
})

describe('browser URLs', () => {
  it('adds a scheme like the address bar does', () => {
    expect(browserUrl('localhost:5173')).toBe('http://localhost:5173')
    expect(browserUrl('127.0.0.1:3000/x')).toBe('http://127.0.0.1:3000/x')
    expect(browserUrl('example.com:8080')).toBe('https://example.com:8080')
    expect(browserUrl('https://a.dev')).toBe('https://a.dev')
  })

  it('lets agents open only http(s) pages', () => {
    expect(agentBrowserUrl('localhost:5173')).toEqual({ url: 'http://localhost:5173/' })
    expect(agentBrowserUrl('file:///C:/Users/me/.env')).toHaveProperty('error')
    expect(agentBrowserUrl('chrome://settings')).toHaveProperty('error')
    // Scheme-less input never becomes a script URL.
    expect(agentBrowserUrl('javascript:alert(1)')).not.toEqual({ url: expect.stringMatching(/^javascript:/) })
  })
})

describe('agent permissions', () => {
  it("applies the user's tier overrides", () => {
    expect(autoAllowedTools({ run_process: 'auto' })).toContain('run_process')
    expect(autoAllowedTools({ open_file: 'confirm' })).not.toContain('open_file')
    expect(confirmTools({ open_file: 'confirm' })).toEqual(expect.arrayContaining(['open_file', 'run_process', 'open_browser']))
    expect(appToolTier('show_diff', {})).toBe('auto')
  })

  it('makes a shell rule cover both shells', () => {
    expect(expandShellRules(['Bash(git push *)', ' ', 'Write(src/**)'])).toEqual(['Bash(git push *)', 'PowerShell(git push *)', 'Write(src/**)'])
    expect(expandShellRules(['PowerShell(Remove-Item *)', 'Bash(Remove-Item *)'])).toEqual(['PowerShell(Remove-Item *)', 'Bash(Remove-Item *)'])
  })
})
