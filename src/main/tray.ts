import { app, Menu, nativeImage, Tray } from 'electron'
import { deflateSync } from 'node:zlib'
import type { Hub } from './hub.ts'

/**
 * The application lives in the menu bar. Agents work in windows nobody has to
 * look at, and a window comes to the screen only when the person clicks for it
 * here — or when an agent needs them.
 *
 * A click on the icon brings the application forward, the way a click on a
 * menu-bar app is expected to: the project that is waiting for the person if
 * there is one, otherwise the one worked in most recently. Everything else —
 * the list of projects, the port, quitting — sits behind a right click, where
 * macOS keeps the secondary things.
 */
export function installTray(hub: Hub): Tray {
  const tray = new Tray(trayIcon())
  tray.setToolTip('Naoba — click to open, right-click for the projects')

  const contexts = () => [...hub.contexts.values()]
  const waiting = () => contexts().filter((context) => context.pendingHuman.size > 0)

  /** The window a click should bring up, or `null` when there is none yet. */
  const foremost = () => {
    const asking = waiting()
    if (asking.length > 0) return asking[0]!
    return contexts().sort((a, b) => b.lastTouched - a.lastTouched)[0] ?? null
  }

  const menu = () => {
    const projectItems = contexts().map((context) => {
      const agents = context.agents.size
      const tabs = context.tabs.length
      const asking = context.pendingHuman.size > 0
      return {
        label: `${asking ? '✋ ' : ''}${context.identity.name}` +
          `  —  ${agents} agent${agents === 1 ? '' : 's'}, ${tabs} tab${tabs === 1 ? '' : 's'}`,
        click: () => context.reveal(true),
      }
    })
    const asking = waiting()
    return Menu.buildFromTemplate([
      { label: asking.length > 0 ? `${asking.length} agent${asking.length === 1 ? '' : 's'} need you` : 'Naoba', enabled: false },
      { type: 'separator' },
      ...(projectItems.length > 0
        ? projectItems
        : [{ label: 'No project has connected yet', enabled: false as const }]),
      { type: 'separator' },
      { label: `Listening on 127.0.0.1:${hub.port}`, enabled: false },
      { label: 'Quit Naoba', click: () => app.quit() },
    ])
  }

  tray.on('click', () => {
    const context = foremost()
    // Nothing to show yet: the menu at least says so, and how to connect.
    if (context) context.reveal(true)
    else tray.popUpContextMenu(menu())
  })
  tray.on('right-click', () => tray.popUpContextMenu(menu()))

  const refresh = () => {
    // Next to the icon: how many agents are connected, and a hand when one of
    // them is waiting for the person — the two things worth a glance at the
    // menu bar. Nothing at all while nobody is connected.
    const connected = contexts().reduce((sum, context) => sum + context.agents.size, 0)
    const parts = [waiting().length > 0 ? '✋' : '', connected > 0 ? String(connected) : '']
    tray.setTitle(parts.filter(Boolean).join(' '))
  }

  refresh()
  const timer = setInterval(refresh, 2_000)
  timer.unref?.()
  return tray
}

/**
 * The icon, drawn here rather than shipped as a file: sixteen pixels of browser
 * window are not worth a binary asset, and a template image is just black plus
 * alpha, which macOS inverts for the menu bar on its own.
 */
function trayIcon() {
  const size = 16
  const pixels = Buffer.alloc(size * size * 4)
  const set = (x: number, y: number, alpha: number) => {
    const at = (y * size + x) * 4
    pixels[at] = 0
    pixels[at + 1] = 0
    pixels[at + 2] = 0
    pixels[at + 3] = alpha
  }

  // A window outline with a title bar — the smallest thing that reads as a browser.
  for (let x = 2; x <= 13; x++) {
    set(x, 2, 255)
    set(x, 13, 255)
    if (x <= 13) set(x, 5, 180)
  }
  for (let y = 2; y <= 13; y++) {
    set(2, y, 255)
    set(13, y, 255)
  }
  // Two dots in the title bar, the way a browser's controls sit there.
  set(4, 3, 255)
  set(6, 3, 255)

  const image = nativeImage.createFromBuffer(encodePng(size, size, pixels), { width: size, height: size })
  image.setTemplateImage(true)
  return image
}

/** A minimal PNG encoder: one IHDR, one IDAT, one IEND, no filtering worth the name. */
function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0 // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }

  const chunk = (type: string, body: Buffer): Buffer => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(body.length)
    const typed = Buffer.concat([Buffer.from(type, 'ascii'), body])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(typed) >>> 0)
    return Buffer.concat([length, typed, crc])
  }

  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer: Buffer): number {
  let c = -1
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8)
  return c ^ -1
}
