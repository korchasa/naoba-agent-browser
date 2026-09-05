import { BrowserWindow, nativeImage, Tray } from 'electron'
import { Globe, Hand, type IconNode } from 'lucide'
import type { Hub } from './hub.ts'

/**
 * The application lives in the menu bar. Agents work in windows nobody has to
 * look at, and a window comes to the screen only when the person clicks for it
 * here — or when an agent needs them.
 *
 * The icon does one thing: a click brings the application forward — the
 * project that is waiting for the person if there is one, otherwise the one
 * worked in most recently. Everything else — switching project, the port,
 * quitting — is inside the window, under the project's name.
 */
export function installTray(hub: Hub): Tray {
  const tray = new Tray(nativeImage.createEmpty())
  tray.setToolTip('Naoba — click to open')
  const painter = new IconPainter()

  const contexts = () => [...hub.contexts.values()]
  const waiting = () => contexts().filter((context) => context.pendingHuman.size > 0)

  /** The window a click should bring up, or `null` when there is none yet. */
  const foremost = () => {
    const asking = waiting()
    if (asking.length > 0) return asking[0]!
    return contexts().sort((a, b) => b.lastTouched - a.lastTouched)[0] ?? null
  }

  const open = () => {
    const context = foremost()
    // With no project yet the window still opens: its panel says how to
    // connect an agent, which beats answering a click with nothing.
    if (context) context.reveal(true)
    else hub.shell.reveal(true)
  }
  tray.on('click', open)
  tray.on('right-click', open)

  let shown = ''
  const refresh = () => {
    // The icon itself says it: a hand when an agent is waiting for the person,
    // and the number of connected agents drawn into the glyph — the two things
    // worth a glance at the menu bar.
    const connected = contexts().reduce((sum, context) => sum + context.agents.size, 0)
    const key = `${waiting().length > 0 ? 'hand' : 'globe'}:${connected}`
    if (key === shown) return
    shown = key
    void painter.paint(waiting().length > 0, connected).then((image) => {
      if (shown === key && !tray.isDestroyed()) tray.setImage(image)
    })
  }

  refresh()
  const timer = setInterval(refresh, 2_000)
  timer.unref?.()
  return tray
}


/** Points across, in the menu bar. */
const ICON_POINTS = 18
/** The retina factor the icon is painted at. */
const ICON_SCALE = 2

/**
 * The icon is painted by a canvas in an offscreen renderer rather than pixel
 * by pixel here: a hand and a number both need anti-aliasing to read at
 * eighteen points, and Chromium already knows how to draw both. A template
 * image is black plus alpha; macOS inverts it for the menu bar on its own.
 */
class IconPainter {
  #window: BrowserWindow | null = null

  async paint(hand: boolean, count: number): Promise<Electron.NativeImage> {
    const window = this.#window ?? (this.#window = await this.#open())
    const dataUrl: string = await window.webContents.executeJavaScript(
      `draw(${JSON.stringify(hand ? svg(Hand) : svg(Globe))}, ${count})`,
    )
    const png = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64')
    const image = nativeImage.createFromBuffer(png, { scaleFactor: ICON_SCALE })
    image.setTemplateImage(true)
    return image
  }

  async #open(): Promise<BrowserWindow> {
    const px = ICON_POINTS * ICON_SCALE
    const window = new BrowserWindow({
      show: false,
      width: px,
      height: px,
      webPreferences: { offscreen: true, sandbox: true },
    })
    const html = `<canvas id="c" width="${px}" height="${px}"></canvas><script>
      const PX = ${px}, S = ${ICON_SCALE}
      const canvas = document.getElementById('c'), ctx = canvas.getContext('2d')
      const glyph = (markup) => new Promise((resolve, reject) => {
        const image = new Image()
        image.onload = () => resolve(image)
        image.onerror = () => reject(new Error('the icon did not load'))
        image.src = 'data:image/svg+xml;utf8,' + encodeURIComponent(markup)
      })
      async function draw(markup, count) {
        ctx.clearRect(0, 0, PX, PX)
        ctx.drawImage(await glyph(markup), 0, 0, PX, PX)
        if (count > 0) {
          // A badge in the lower right: a hole in the glyph with the number in it,
          // so it reads on the light bar and the dark one alike.
          const label = String(count), r = 5.5 * S, cx = PX - r - 0.5 * S, cy = PX - r - 0.5 * S
          ctx.globalCompositeOperation = 'destination-out'
          ctx.beginPath(); ctx.arc(cx, cy, r + 1 * S, 0, Math.PI * 2); ctx.fill()
          ctx.globalCompositeOperation = 'source-over'
          ctx.fillStyle = '#000'
          ctx.font = 'bold ' + (label.length > 1 ? 6.5 : 8) * S + 'px -apple-system, Helvetica, sans-serif'
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
          ctx.fillText(label, cx, cy + 0.5 * S)
        }
        return canvas.toDataURL('image/png')
      }
    </script>`
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    return window
  }
}

/** A Lucide icon as standalone SVG markup, filled black the way a template image wants. */
function svg(node: IconNode): string {
  const body = node
    .map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(' ')}/>`)
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
}
