import { contextBridge, ipcRenderer, webUtils } from 'electron'

const api = {
  call: (method: string, ...args: unknown[]): Promise<unknown> => ipcRenderer.invoke('deck:call', method, args),
  write: (id: string, data: string): void => ipcRenderer.send('deck:write', id, data),
  resize: (id: string, cols: number, rows: number): void => ipcRenderer.send('deck:resize', id, cols, rows),
  on: (channel: string, cb: (...args: unknown[]) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, ...args: unknown[]): void => cb(...args)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  platform: process.platform
}

contextBridge.exposeInMainWorld('deckBridge', api)

export type DeckBridge = typeof api
