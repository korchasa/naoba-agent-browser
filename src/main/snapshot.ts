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
export async function writeSnapshots(
  hub: Hub,
  directory: string,
  demoPage: string,
  settings?: SettingsPane,
): Promise<void> {
  mkdirSync(directory, { recursive: true })

  const identity = identify(join(app.getPath('temp'), 'naoba-demo', 'checkout'))
  const context = hub.contextFor({ ...identity, name: 'checkout' })

  // A window with one agent and an empty tree photographs as an empty product.
  // The tree is the picture, so the demo needs what a tree is for: several
  // agents, a tab each, and one tab two of them share.
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
  context.selectTab(cart.id)

  // Every demo tab shows the same fixture page, so without this they all carry
  // one title and the tree is a column of identical rows — the one thing the
  // picture is meant to disprove.
  await named(cart, 'Your basket — Example Shop')
  await named(docs, 'Payments API — Docs')
  await named(admin, 'Orders — Admin')

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
  const shell = hub.shell
  shell.window().setContentSize(1440, 900)
  shell.layout()
  const composed = { window: () => shell.window(), panel: () => shell.panel(), activeTab: () => context.activeTab() }
  await pause(600)

  const shoot = async (name: string): Promise<void> => {
    for (const appearance of ['light', 'dark'] as const) {
      nativeTheme.themeSource = appearance
      await pause(500)
      const image = await composeWindow(composed)
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
  await setTextSize(shell, '18px')
  await shoot('03-large-text')
  await setTextSize(shell, '13px')

  // What the first launch actually looks like: no agent yet, and so no tab.
  context.pendingHuman.clear()
  context.agents.clear()
  for (const tab of [...context.tabs.values()]) context.closeTab(tab.id)
  refresh(context)
  await shoot('04-first-run')

  if (settings) await shootSettings(settings, directory)
}

/** As much of the settings window as a picture of it needs. */
interface SettingsPane {
  open(): void
  current(): Electron.BrowserWindow | null
}

/**
 * The one screen that is about the application rather than about a project, and
 * the only one a person opens on purpose. It is a window of its own, so nothing
 * has to be laid out by hand — but a freshly opened, unfocused window is
 * exactly the case `capturePage` gets wrong, so it goes through the same
 * settling as everything else here.
 */
async function shootSettings(pane: SettingsPane, directory: string): Promise<void> {
  pane.open()
  // The window is created hidden and shows itself once it has something to
  // draw; a picture taken before that is of nothing.
  for (let wait = 0; wait < 40 && !pane.current()?.isVisible(); wait++) await pause(100)
  const window = pane.current()
  if (!window) {
    process.stdout.write('snapshot: the settings window did not open\n')
    return
  }
  const wc = window.webContents

  const shoot = async (name: string): Promise<void> => {
    for (const appearance of ['light', 'dark'] as const) {
      nativeTheme.themeSource = appearance
      await pause(500)
      const image = await settled(wc)
      if (!image) return
      const file = join(directory, `${name}-${appearance}.png`)
      writeFileSync(file, image.toPNG())
      process.stdout.write(`snapshot: ${file}\n`)
    }
  }

  await shoot('05-settings')
  // Someone reading at an accessibility text size sees every string a third
  // larger. Nothing may fall out of the rows, and the switches must still line
  // up with the words they answer for.
  await wc.executeJavaScript("document.documentElement.style.fontSize = '18px'")
  await pause(300)
  await shoot('06-settings-large-text')
  await wc.executeJavaScript("document.documentElement.style.fontSize = '13px'")
}

/** Give a demo tab a title of its own, so the tree reads like four sites. */
async function named(tab: Tab, title: string): Promise<void> {
  await tab.waitForLoad()
  await tab.wc.executeJavaScript(`document.title = ${JSON.stringify(title)}`)
}

/** Grow or restore the interface's own text, the way a reader would. */
async function setTextSize(shell: Hub['shell'], size: string): Promise<void> {
  const view = shell.panel()
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
 * A picture that matches the state, rather than the state of a moment ago.
 *
 * A view the person is not looking at is drawn lazily, so the first capture
 * after a change — a new appearance, a larger text size — hands back the frame
 * from before it. Nudging the view and waiting two animation frames is what
 * makes its own pixels exist; the wait is bounded, because a view the
 * compositor has throttled may never run the frame callback at all.
 *
 * Two frames in the renderer are not two frames on screen: the window is shown
 * transparent and unfocused, so its compositor commits lazily and `capturePage`
 * hands back whatever was last committed. Measured on the waiting screen: one
 * warm-up capture and 200 ms still photographed the tree as it had been a step
 * earlier. A translucent view over the window's material commits later still,
 * and a capture taken mid-commit is half a frame — the previous picture with
 * the new one bleeding through. So the picture is taken until two in a row
 * agree byte for byte; that, and nothing shorter, is a settled frame.
 */
async function settled(wc: Electron.WebContents): Promise<Electron.NativeImage | null> {
  if (wc.isDestroyed()) return null
  wc.invalidate()
  await Promise.race([
    wc.executeJavaScript(
      'new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(1))))',
    ),
    pause(1500),
  ])
  let image = await wc.capturePage()
  for (let attempt = 0; attempt < 10; attempt++) {
    await pause(300)
    const next = await wc.capturePage()
    const agrees = next.toBitmap().equals(image.toBitmap())
    image = next
    if (agrees && attempt > 0) break
  }
  return image
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
    if (!view) return null
    const image = await settled(view.webContents)
    if (!image) return null
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
  // The panel is translucent — it sits on the window's sidebar material, which
  // a capture of the view alone does not contain. So the photograph starts
  // from a flat stand-in for that material and the panel is blended onto it;
  // without this the panel comes out transparent and reads as black.
  const canvas = Buffer.alloc(width * height * 4, 0)
  const [b, g, r] = nativeTheme.shouldUseDarkColors ? [0x24, 0x22, 0x21] : [0xf2, 0xef, 0xec]
  for (let at = 0; at < canvas.length; at += 4) canvas[at] = b, canvas[at + 1] = g, canvas[at + 2] = r, canvas[at + 3] = 255

  const paste = (piece: { bitmap: Buffer; width: number; height: number } | null, atX: number, atY: number) => {
    if (!piece) return
    for (let y = 0; y < piece.height; y++) {
      const targetY = atY + y
      if (targetY < 0 || targetY >= height) continue
      const columns = Math.min(piece.width, width - atX)
      if (columns <= 0) continue
      const from = y * piece.width * 4
      if (from + columns * 4 > piece.bitmap.length) break
      for (let x = 0; x < columns; x++) {
        const src = from + x * 4
        const dst = (targetY * width + atX + x) * 4
        // Bitmaps are premultiplied BGRA: a covered pixel is the source plus
        // whatever of the background its alpha leaves uncovered.
        const alpha = piece.bitmap[src + 3]! / 255
        for (let channel = 0; channel < 3; channel++) {
          canvas[dst + channel] = Math.round(piece.bitmap[src + channel]! + canvas[dst + channel]! * (1 - alpha))
        }
        canvas[dst + 3] = 255
      }
    }
  }

  paste(await capture(context.activeTab()?.view ?? null), Math.round(panelPoints * scale), 0)
  paste(panel, 0, 0)

  return nativeImage.createFromBitmap(canvas, { width, height }).toPNG()
}
