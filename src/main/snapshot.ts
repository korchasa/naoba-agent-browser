import { app, nativeImage, nativeTheme, screen } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Hub } from './hub.ts'
import type { AgentHandle } from './context.ts'
import { identify } from './project.ts'
import { pause, type Tab } from './tab.ts'

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

  // A window with one agent and an empty tree photographs as an empty product.
  // The tree is the picture, so the demo needs what a tree is for: several
  // agents, a tab each, one tab two of them share, and one the person opened.
  const actors = [
    ['claude · checkout', 'claude'],
    ['codex · checkout', 'codex'],
    ['cursor · checkout', 'cursor'],
  ] as const
  for (const [label, ide] of actors) {
    const agent: AgentHandle = {
      id: `demo-${label}`,
      label,
      descriptor: { label, ide, pid: 0 },
      currentTabId: null,
      send: () => undefined,
    }
    context.agents.set(agent.id, agent)
  }
  const [claude, codex, cursor] = actors.map(([label]) => ({ id: `demo-${label}`, label }))

  const cart = context.openTab(demoPage, claude!.id)
  const docs = context.openTab(demoPage, codex!.id)
  const admin = context.openTab(demoPage, cursor!.id)
  const mine = context.openTab(demoPage)
  context.selectTab(cart.id)

  // Every demo tab shows the same fixture page, so without this they all carry
  // one title and the tree is a column of identical rows — the one thing the
  // picture is meant to disprove.
  await named(cart, 'Your basket — Example Shop')
  await named(docs, 'Payments API — Docs')
  await named(admin, 'Orders — Admin')
  await named(mine, 'Example Shop')

  for (
    const [who, what, where] of [
      [claude!, 'navigate(https://shop.example/cart)', cart],
      [claude!, 'fill(#coupon)', cart],
      [claude!, 'click(button.apply)', cart],
      [codex!, 'navigate(https://docs.example/api)', docs],
      [codex!, 'snapshot(document)', docs],
      [codex!, 'getNetworkLog()', docs],
      [cursor!, 'waitFor(table.orders)', admin],
      [cursor!, 'getText(table.orders tr)', admin],
      // Two agents in one tab is the case the flat log could never show.
      [codex!, 'getConsoleLogs()', cart],
      [claude!, 'requestHuman(sign in to the shop)', cart],
    ] as const
  ) {
    context.log(who, what, where.id)
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
  context.pendingHuman.set(cart.id, {
    tabId: cart.id,
    reason: 'sign in to the shop, then hand the tab back',
    agentId: claude!.id,
    resolve: () => undefined,
  })
  refresh(context)
  await shoot('02-waiting')

  // Someone reading at an accessibility text size sees the same window with
  // every string a third larger. Nothing may fall out of it. The size is set on
  // the root element rather than through the zoom factor: zoom leaves the view
  // showing a stale frame, and the panel then photographs as it was a step ago.
  await setTextSize(context, '18px')
  await shoot('03-large-text')
  await setTextSize(context, '13px')

  // What the first launch actually looks like: one blank tab, no agent yet.
  context.pendingHuman.clear()
  context.agents.clear()
  for (const tab of context.tabs) tab.commands.clear()
  for (const tab of [...context.tabs.values()].slice(1)) context.closeTab(tab.id)
  refresh(context)
  await shoot('04-first-run')
}

/** Give a demo tab a title of its own, so the tree reads like four sites. */
async function named(tab: Tab, title: string): Promise<void> {
  await tab.waitForLoad()
  await tab.wc.executeJavaScript(`document.title = ${JSON.stringify(title)}`)
}

/** Grow or restore the interface's own text, the way a reader would. */
async function setTextSize(context: ReturnType<Hub['contextFor']>, size: string): Promise<void> {
  const view = context.panel()
  await view?.webContents.executeJavaScript(`document.documentElement.style.fontSize = ${JSON.stringify(size)}`)
  await pause(300)
}

/** Push every part of the state the panel draws from. */
function refresh(context: ReturnType<Hub['contextFor']>): void {
  context.notifyTabs()
  context.notifyAgents()
  for (const tab of context.tabs) {
    context.toChrome('commands', { tabId: tab.id, commands: [...tab.commands.entries] })
  }
}

/**
 * A window is two views side by side, and Electron can photograph a view but
 * not a window. So each one is captured and the pixels are laid out by hand.
 */
async function composeWindow(context: {
  window(): Electron.BaseWindow
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
    // Two frames in the renderer are not two frames on screen: the window is
    // shown transparent and unfocused, so its compositor commits lazily and
    // `capturePage` hands back whatever was last committed. Measured on the
    // waiting screen: one warm-up capture and 200 ms still photographed the
    // tree as it had been a step earlier, while the page it was drawn from
    // already held the new rows. Three captures with a pause between them is
    // what makes the picture match the state.
    for (let attempt = 0; attempt < 2; attempt++) {
      await view.webContents.capturePage()
      await pause(300)
    }
    const image = await view.webContents.capturePage()
    const size = image.getSize()
    return { bitmap: image.toBitmap(), width: size.width, height: size.height }
  }

  const panelPoints = context.panel()?.getBounds().width ?? 0
  const panel = await capture(context.panel())
  // A captured view comes back in physical pixels while the window reports
  // points, and the ratio between them is the only reliable scale — the
  // display's own `scaleFactor` disagrees often enough to put every piece of
  // the window in the wrong place, which is how the first snapshots came out
  // with the page sliding under the chrome.
  const scale = panel && panelPoints > 0 ? panel.width / panelPoints : screen.getPrimaryDisplay().scaleFactor
  if (process.env.AB_SNAPSHOT_DEBUG) {
    const page = context.activeTab()?.view
    process.stdout.write(
      `bounds=${JSON.stringify(bounds)} scale=${scale} panel=${panel?.width}x${panel?.height} ` +
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

  paste(await capture(context.activeTab()?.view ?? null), Math.round(panelPoints * scale), 0)
  paste(panel, 0, 0)

  return nativeImage.createFromBitmap(canvas, { width, height }).toPNG()
}
