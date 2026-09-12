/**
 * What the Dock icon says, and when it asks for attention.
 *
 * It carries one number: how many calls are waiting for the person. A badge on
 * macOS means "this many things want you", not "this many things are running",
 * so the count of connected agents does not belong here — that is ambient
 * status, and the menu-bar icon is where ambient status goes.
 *
 * Pure on purpose, like `login.ts`: the decision is reached without Electron,
 * and `main.ts` hands in the real `app.dock`. Nothing here may import
 * `electron`.
 */

/** What the icon should say now, and whether this is news worth a bounce. */
export interface DockSignal {
  badge: string
  bounce: boolean
}

/**
 * A count that went up is a new call for the person and is announced once.
 * Standing still is not news, and neither is a call being answered: the person
 * is already dealing with those.
 */
export function dockSignal(waiting: number, before: number): DockSignal {
  return { badge: waiting > 0 ? String(waiting) : '', bounce: waiting > before }
}

/** All this needs of the Dock, so a fake one is enough to test the decision. */
export interface DockLike {
  setBadge(text: string): void
  bounce(type: 'informational'): unknown
}

export interface DockWatch {
  /** Look again: the badge follows, and a new call bounces the icon once. */
  look(): void
  /** Sent to the menu bar or quitting: leave no badge behind. */
  stop(): void
}

/**
 * Keep the icon on the count. The first look only draws it: a call that was
 * already waiting when the Dock icon appeared did not start waiting then, and
 * bouncing for it would announce the setting rather than the agent.
 */
export function watchDock(dock: DockLike, waiting: () => number): DockWatch {
  let before = waiting()
  dock.setBadge(dockSignal(before, before).badge)
  return {
    look() {
      const now = waiting()
      const signal = dockSignal(now, before)
      before = now
      dock.setBadge(signal.badge)
      if (signal.bounce) dock.bounce('informational')
    },
    stop() {
      dock.setBadge('')
    },
  }
}

/** How often the icon looks, in step with the menu-bar icon's own refresh. */
const LOOK_EVERY_MS = 2_000

/** The watch above, on a timer. The returned call stops it and clears the badge. */
export function installDock(dock: DockLike, waiting: () => number, everyMs = LOOK_EVERY_MS): () => void {
  const watch = watchDock(dock, waiting)
  const timer = setInterval(() => watch.look(), everyMs)
  timer.unref?.()
  return () => {
    clearInterval(timer)
    watch.stop()
  }
}
