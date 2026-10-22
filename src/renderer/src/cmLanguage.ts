import { LanguageDescription, type LanguageSupport } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { languageForPath } from '@shared/languages'

// CodeMirror language support for any file, loaded on demand from @codemirror/language-data
// (~150 languages, including the legacy stream modes).

/** The language description for a file: by name/extension, then shebang / our own mapping. */
export function describeLanguage(path: string, firstLine?: string): LanguageDescription | null {
  const name = path.split(/[\\/]/).pop() ?? path
  const byName = LanguageDescription.matchFilename(languages, name)
  if (byName) return byName
  const id = languageForPath(path, firstLine)
  return id ? LanguageDescription.matchLanguageName(languages, id, true) : null
}

/** Load language support for a file, or undefined for plain text. */
export async function loadLanguage(path: string, firstLine?: string): Promise<{ name: string; support: LanguageSupport } | undefined> {
  const d = describeLanguage(path, firstLine)
  if (!d) return undefined
  try {
    return { name: d.name, support: await d.load() }
  } catch {
    return undefined
  }
}
