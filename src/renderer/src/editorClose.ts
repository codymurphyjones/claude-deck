import { api } from './api'
import { closeProjectTab, editorUnsaved } from './store'

// Lives outside components/FileEditor.tsx so the tab strip can close editors without importing
// CodeMirror (the editor itself loads on demand).

/** Close an editor tab, asking first if files have unsaved changes. */
export async function requestCloseEditor(tabId: string): Promise<void> {
  const dirty = editorUnsaved.get(tabId)?.() ?? []
  if (dirty.length) {
    const r = await api.dialog.confirm(`Close the editor with ${dirty.length} unsaved file${dirty.length === 1 ? '' : 's'}?`, dirty.join(', '), ['Discard changes', 'Cancel'])
    if (r !== 0) return
  }
  closeProjectTab(tabId)
}
