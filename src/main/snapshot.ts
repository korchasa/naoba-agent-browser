import { app, nativeImage, nativeTheme, screen } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Hub } from './hub.ts'
import type { AgentHandle } from './context.ts'
import { identify } from './project.ts'
import { pause } from './tab.ts'

/**
 * Draw the window with a believable project in it and save a picture of it.
 *
 * This exists for two audiences. It produces the store screenshots without
 * anybody arranging windows by hand, and it is how the interface gets looked at
 * in both appearances before a release — a build that compiles proves nothing
 * about a screen nobody has seen.
 */
export async function writeSnapshots(hub: Hub, directory: string, demoPage: string): Promise<void> {
  mkdirSync(directory, { recursive: true })

  const identity = identify(join(app.getPath('temp'), 'agent-browser-demo', 'checkout'))
  const context = hub.contextFor({ ...identity, name: 'checkout' })

  // A window with one agent and an empty log photographs as an empty product.
  for (
    const [label, ide] of [
      ['claude · checkout', 'claude'],
      ['codex · checkout', 'codex'],
    ] as const
  ) {
    const agent: AgentHandle = {
      id: `demo-${label}`,
      label,
      descriptor: { label, ide, pid: 0 },
      currentTabId: null,
      send: () => undefined,
    }
    context.agents.set(agent.id, agent)
  }

  context.openTab(demoPage)
  const second = context.openTab(demoPage)
  context.openTab(demoPage)
  context.selectTab(second.id)

  for (
    const [who, what] of [
      ['claude · checkout', 'navigate(https://shop.example/cart)'],
      ['claude · checkout', 'fill(#coupon)'],
      ['claude · checkout', 'click(button.apply)'],
      ['codex · checkout', 'snapshot(document)'],
      ['codex · checkout', 'getNetworkLog()'],
      ['claude · checkout', 'requestHuman(sign in to the shop)'],
    ] as const
  ) {
    context.log(who, what, second.id)
    await pause(20)
  }

  context.reveal(false)
  const window = context.window()
  window.setContentSize(1440, 900)
  context.layout()
  await pause(600)

  const shoot = async (name: string): Promise<void> => {
    for (const appearance of ['light', 'dark'] as const) {
      nativeTheme.themeSource = appearance
      await pause(500)
      const image = await composeWindow(context)
      const file = join(directory, `${name}-${appearance}.png`)
      writeFileSync(file, image)
      process.stdout.write(`snapshot: ${file}\n`)
    }
  }

  await shoot('01-working')

  // The screen a person is summoned to. It is the one screen the app opens by
  // itself, so it is the one most worth looking at before a release.
  context.pendingHuman.set(second.id, {
    tabId: second.id,
    reason: 'sign in to the shop, then hand the tab back',
    agentId: 'demo-claude · checkout',
    resolve: () => undefined,
  })
  refresh(context)
  await shoot('02-waiting')

  // Someone reading at an accessibility text size sees the same window with
  // every string a third larger. Nothing may fall out of it. The size is set on
  // the root element rather than through the zoom factor: zoom leaves the view
  // showing a stale frame, and the strip then photographs as it was a step ago.
  await setTextSize(context, '18px')
  await shoot('03-large-text')
  await setTextSize(context, '13px')

  // What the first launch actually looks like: one blank tab, no agent yet.
  context.pendingHuman.clear()
  context.agents.clear()
  context.activity.length = 0
  for (const tab of [...context.tabs.values()].slice(1)) context.closeTab(tab.id)
  refresh(context)
  await shoot('04-first-run')
}

/** Grow or restore the interface's own text, the way a reader would. */
async function setTextSize(context: ReturnType<Hub['contextFor']>, size: string): Promise<void> {
  for (const view of [context.chrome(), context.panel()]) {
    await view?.webContents.executeJavaScript(`document.documentElement.style.fontSize = ${JSON.stringify(size)}`)
  }
  await pause(300)
}

/** Push every part of the state the panel draws from. */
function refresh(context: ReturnType<Hub['contextFor']>): void {
  context.notifyTabs()
  context.notifyAgents()
  context.toChrome('activity', context.activity.slice(0, 60))
}

/**
 * A window is three views side by side, and Electron can photograph a view but
 * not a window. So each one is captured and the pixels are laid out by hand.
 */
async function composeWindow(context: {
  window(): Electron.BaseWindow
  chrome(): Electron.WebContentsView | null
  panel(): Electron.WebContentsView | null
  activeTab(): { view: Electron.WebContentsView } | null
}): Promise<Buffer> {
  const bounds = context.window().getContentBounds()

  // A view the person is not looking at is drawn lazily, so the first capture
  // after a change — a new appearance, a larger text size — hands back the
  // frame from before it. Nudging each view and taking the picture twice is
  // what makes the photograph match the state.
  const capture = async (view: Electron.WebContentsView | null) => {
    if (!view || view.webContents.isDestroyed()) return null
    view.webContents.invalidate()
    // Wait for the renderer to have actually painted: two frames after the
    // change is the first moment its own pixels exist.
    await view.webContents.executeJavaScript(
      'new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(1))))',
    )
    await view.webContents.capturePage()
    await pause(200)
    const image = await view.webContents.capturePage()
    const size = image.getSize()
    return { bitmap: image.toBitmap(), width: size.width, height: size.height }
  }

  const chrome = await capture(context.chrome())
  // A captured view comes back in physical pixels while the window reports
  // points, and the ratio between them is the only reliable scale — the
  // display's own `scaleFactor` disagrees often enough to put every piece of
  // the window in the wrong place, which is how the first snapshots came out
  // with the page sliding under the tab strip.
  const scale = chrome ? chrome.width / bounds.width : screen.getPrimaryDisplay().scaleFactor
  if (process.env.AB_SNAPSHOT_DEBUG) {
    const page = context.activeTab()?.view
    process.stdout.write(
      `bounds=${JSON.stringify(bounds)} scale=${scale} chrome=${chrome?.width}x${chrome?.height} ` +
        `pageBounds=${JSON.stringify(page?.getBounds())} panelBounds=${JSON.stringify(context.panel()?.getBounds())}\n`,
    )
  }
  const width = Math.round(bounds.width * scale)
  const height = Math.round(bounds.height * scale)
  const canvas = Buffer.alloc(width * height * 4, 0)

  const paste = (piece: { bitmap: Buffer; width: number; height: number } | null, atX: number, atY: number) => {
    if (!piece) return
    for (let y = 0; y < piece.height; y++) {
      const targetY = atY + y
      if (targetY < 0 || targetY >= height) continue
      const columns = Math.min(piece.width, width - atX)
      if (columns <= 0) continue
      const from = y * piece.width * 4
      if (from + columns * 4 > piece.bitmap.length) break
      piece.bitmap.copy(canvas, (targetY * width + atX) * 4, from, from + columns * 4)
    }
  }

  // The strip is as tall as its own text needs, so read it rather than assume it.
  const top = Math.round((context.chrome()?.getBounds().height ?? 0) * scale)
  paste(await capture(context.activeTab()?.view ?? null), 0, top)
  const panel = await capture(context.panel())
  if (panel) paste(panel, width - panel.width, top)
  paste(chrome, 0, 0)

  return nativeImage.createFromBitmap(canvas, { width, height }).toPNG()
}
