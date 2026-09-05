import { contextBridge, ipcRenderer } from 'electron'

/**
 * The window's own interface talks to the main process through this and nothing
 * else. Pages an agent visits never see it: it is loaded into every view, but
 * only the chrome view calls it, and `contextIsolation` keeps it out of the
 * page's own world.
 */
const api = {
  state: () => ipcRenderer.invoke('ab:state'),
  newTab: (projectId: string, url?: string) => ipcRenderer.invoke('ab:new-tab', projectId, url),
  selectTab: (projectId: string, tabId: string) => ipcRenderer.invoke('ab:select-tab', projectId, tabId),
  closeTab: (projectId: string, tabId: string) => ipcRenderer.invoke('ab:close-tab', projectId, tabId),
  navigate: (projectId: string, tabId: string, url: string) => ipcRenderer.invoke('ab:navigate', projectId, tabId, url),
  panelWidth: (width: number) => ipcRenderer.invoke('ab:panel-width', width),
  announceAutomation: (on: boolean) => ipcRenderer.invoke('ab:announce-automation', on),
  tabMenu: (projectId: string, tabId: string) => ipcRenderer.invoke('ab:tab-menu', projectId, tabId),
  takeOver: (projectId: string, tabId: string) => ipcRenderer.invoke('ab:take-over', projectId, tabId),
  release: (projectId: string, tabId: string) => ipcRenderer.invoke('ab:release', projectId, tabId),
  humanDone: (projectId: string, tabId: string) => ipcRenderer.invoke('ab:human-done', projectId, tabId),
  projects: () => ipcRenderer.invoke('ab:projects'),
  forgetProject: (root: string) => ipcRenderer.invoke('ab:forget-project', root),
  on: (channel: 'projects' | 'tabs' | 'agents' | 'commands', handler: (payload: unknown) => void) => {
    const listener = (_event: unknown, payload: unknown) => handler(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.off(channel, listener)
  },
}

contextBridge.exposeInMainWorld('ab', api)
export type ChromeApi = typeof api
