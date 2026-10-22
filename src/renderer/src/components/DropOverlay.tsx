import { useEffect, useRef, useState } from 'react'
import { api, bridge } from '../api'
import { activeSession, openFolders, set, toast } from '../store'
import { Icon } from './Icon'

type Zone = 'open' | 'worktree' | 'insert'

const quote = (p: string): string => (/\s/.test(p) ? `"${p}"` : p)

/** Window-wide drag & drop: a folder (or a file's folder) opens a Claude session. */
export function DropOverlay() {
  const [visible, setVisible] = useState(false)
  const [hot, setHot] = useState<Zone>('open')
  const depth = useRef(0)
  const target = activeSession()

  useEffect(() => {
    const isFiles = (e: DragEvent): boolean => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files')
    const enter = (e: DragEvent): void => {
      if (!isFiles(e)) return
      e.preventDefault()
      depth.current++
      setVisible(true)
    }
    const over = (e: DragEvent): void => {
      if (!isFiles(e)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
    const leave = (e: DragEvent): void => {
      if (!isFiles(e)) return
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) setVisible(false)
    }
    const drop = (e: DragEvent): void => {
      if (!isFiles(e)) return
      e.preventDefault()
      e.stopPropagation()
      depth.current = 0
      setVisible(false)
      const zoneEl = (e.target as HTMLElement | null)?.closest('[data-zone]') as HTMLElement | null
      let zone = (zoneEl?.dataset.zone as Zone | undefined) ?? 'open'
      if (e.shiftKey && zone === 'open') zone = 'worktree'
      const paths = [...(e.dataTransfer?.files ?? [])].map((f) => bridge.pathForFile(f)).filter(Boolean)
      if (!paths.length) return toast('Could not read the dropped item’s path', 'error')
      void handle(paths, zone, e.altKey)
    }
    window.addEventListener('dragenter', enter, true)
    window.addEventListener('dragover', over, true)
    window.addEventListener('dragleave', leave, true)
    window.addEventListener('drop', drop, true)
    return () => {
      window.removeEventListener('dragenter', enter, true)
      window.removeEventListener('dragover', over, true)
      window.removeEventListener('dragleave', leave, true)
      window.removeEventListener('drop', drop, true)
    }
  }, [])

  const handle = async (paths: string[], zone: Zone, pickTemplate: boolean): Promise<void> => {
    const s = activeSession()
    if (zone === 'insert' && s) {
      if (s.kind === 'agent') window.dispatchEvent(new CustomEvent('deck:insert', { detail: { id: s.id, paths } }))
      else bridge.write(s.id, paths.map(quote).join(' ') + ' ')
      return
    }
    const folders = await api.fs.resolveDrop(paths)
    if (!folders.length) return toast('Nothing to open there', 'error')
    if (pickTemplate) return set({ newSession: { cwd: folders[0] } })
    await openFolders(folders, { worktree: zone === 'worktree' })
  }

  if (!visible) return null
  const zoneProps = (z: Zone) => ({
    'data-zone': z,
    className: `drop-zone ${hot === z ? 'hot' : ''}`,
    onDragEnter: () => setHot(z),
    onDragOver: () => hot !== z && setHot(z)
  })
  return (
    <div className="drop-overlay" data-zone="open" onDragOver={(e) => e.target === e.currentTarget && setHot('open')}>
      <div {...zoneProps('open')}>
        <Icon name="folder-open" size={34} style={{ color: 'var(--accent)' }} />
        <h3>Open Claude here</h3>
        <div className="muted">A new session in the folder — or in the folder containing a dropped file.</div>
      </div>
      <div {...zoneProps('worktree')}>
        <Icon name="branch" size={34} style={{ color: 'var(--accent)' }} />
        <h3>Open in a new worktree</h3>
        <div className="muted">Isolated Git checkout, so it can run in the background. (Or hold Shift.)</div>
      </div>
      {target && (
        <div {...zoneProps('insert')}>
          <Icon name="arrow" size={34} style={{ color: 'var(--accent)' }} />
          <h3>Insert into “{target.name}”</h3>
          <div className="muted">Paste the path(s) into the current prompt — images become attachments.</div>
        </div>
      )}
    </div>
  )
}
