/**
 * One settings window, however often it is asked for.
 *
 * Pure on purpose, the way `login.ts` is: the Electron call that makes the
 * window lives in `main.ts` and arrives here as a factory, so a unit test can
 * hand it a window that only records what was done to it.
 */

/** As much of a window as this needs to know about. */
export interface WindowLike {
  isDestroyed(): boolean
  focus(): void
  show(): void
  send(channel: string, payload: unknown): void
  onClosed(handler: () => void): void
}

export class SettingsWindow {
  #current: WindowLike | null = null
  readonly #create: () => WindowLike

  constructor(create: () => WindowLike) {
    this.#create = create
  }

  get isOpen(): boolean {
    return this.#current !== null && !this.#current.isDestroyed()
  }

  /**
   * The window, made on the first ask and brought forward on every one after.
   * A second window would be two answers to one question, and the person would
   * edit whichever they happened to be looking at.
   */
  open(): WindowLike {
    const current = this.#current
    if (current && !current.isDestroyed()) {
      current.show()
      current.focus()
      return current
    }
    const window = this.#create()
    this.#current = window
    // Not kept alive in the background: a window the person closed is gone, and
    // asking again makes a fresh one that reads the settings as they are now.
    window.onClosed(() => {
      if (this.#current === window) this.#current = null
    })
    return window
  }

  /**
   * A value changed somewhere else — the grip on the panel's edge, a project
   * admitted — and the window is redrawn. With no window open there is nowhere
   * for it to land, which is ordinary rather than a failure.
   */
  push(payload: unknown): void {
    const current = this.#current
    if (!current || current.isDestroyed()) return
    current.send('settings', payload)
  }
}
