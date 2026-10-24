// Types shared by the editor's TypeScript support: src/main/lsp (language service) and
// src/renderer/src/editorTs.ts (CodeMirror side). Offsets are into the document text the editor sent.

export interface TsDiagnostic {
  from: number
  to: number
  severity: 'error' | 'warning' | 'info' | 'hint'
  message: string
  code: number
  /** 1-based. */
  line: number
  /** 1-based. */
  col: number
}

export interface TsQuickInfo {
  from: number
  to: number
  /** The signature / type, e.g. `const x: number`. */
  text: string
  /** Documentation and JSDoc tags, if any. */
  doc: string
}

export interface TsLocation {
  file: string
  /** 1-based. */
  line: number
  /** 1-based. */
  col: number
}

export interface TsCompletion {
  name: string
  kind: string
  sortText: string
  insertText?: string
  /** Range the completion replaces, when TypeScript says so. */
  from?: number
  to?: number
  source?: string
  data?: unknown
}

export interface TsCompletionDetails {
  text: string
  doc: string
}
