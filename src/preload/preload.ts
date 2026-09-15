import { contextBridge, ipcRenderer } from 'electron'

/**
 * The window's own interface talks to the main process through this and nothing
 * else — the panel and the settings window, and no other view.
 *
 * It must never be loaded into a tab. `contextIsolation` keeps the preload's
 * own world apart from the page's, which is a different promise from the one
 * that matters here: `exposeInMainWorld` crosses that line on purpose, so a tab
 * that loaded this handed every site `window.ab` — the register of admitted
 * projects with their absolute paths, the login item, and the power to open
 * tabs and take them over. Measured on the installed copy, 2026-09-12, from a
 * page on example.com. A tab is built with no preload at all (`tab.ts`), and an
 * integration test holds it there.
 */
const api = {
  state: () => ipcRenderer.invoke('ab:state'),
  newTab: (projectId: string, url?: string) => ipcRenderer.invoke('ab:new-tab', projectId, url),
  selectTab: (projectId: string, tabId: string) => ipcRenderer.invoke('ab:select-tab', projectId, tabId),
  closeTab: (projectId: string, tabId: string) => ipcRenderer.invoke('ab:close-tab', projectId, tabId),
  navigate: (projectId: string, tabId: string, url: string) => ipcRenderer.invoke('ab:navigate', projectId, tabId, url),
  panelWidth: (width: number) => ipcRenderer.invoke('ab:panel-width', width),
  announceAutomation: (on: boolean) => ipcRenderer.invoke('ab:announce-automation', on),
  settings: () => ipcRenderer.invoke('ab:settings'),
  openSettings: () => ipcRenderer.invoke('ab:open-settings'),
  openAtLogin: (on: boolean) => ipcRenderer.invoke('ab:open-at-login', on),
  activateLicence: (key: string, buyer: unknown = null) => ipcRenderer.invoke('ab:activate-licence', key, buyer),
  deactivateLicence: () => ipcRenderer.invoke('ab:deactivate-licence'),
  installUpdate: () => ipcRenderer.invoke('ab:install-update'),
  copy: (text: string) => ipcRenderer.invoke('ab:copy', text),
  orphanCloseMs: (ms: number) => ipcRenderer.invoke('ab:orphan-close-ms', ms),
  presence: (value: string) => ipcRenderer.invoke('ab:presence', value),
  tabMenu: (projectId: string, tabId: string) => ipcRenderer.invoke('ab:tab-menu', projectId, tabId),
  takeOver: (projectId: string, tabId: string) => ipcRenderer.invoke('ab:take-over', projectId, tabId),
  release: (projectId: string, tabId: string) => ipcRenderer.invoke('ab:release', projectId, tabId),
  humanDone: (projectId: string, tabId: string) => ipcRenderer.invoke('ab:human-done', projectId, tabId),
  projects: () => ipcRenderer.invoke('ab:projects'),
  forgetProject: (root: string) => ipcRenderer.invoke('ab:forget-project', root),
  on: (channel: 'projects' | 'tabs' | 'agents' | 'commands' | 'settings', handler: (payload: unknown) => void) => {
    const listener = (_event: unknown, payload: unknown) => handler(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.off(channel, listener)
  },
}

contextBridge.exposeInMainWorld('ab', api)
export type ChromeApi = typeof api
