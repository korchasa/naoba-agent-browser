import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * What an agent gets back when a file has arrived. The site's own filename is
 * kept beside the path: the path carries a timestamp so two downloads of the
 * same report do not collide, and the name the site gave is what a person
 * recognises.
 */
export interface Download {
  path: string
  url: string
  filename: string
  bytes: number
  mimeType: string
  at: number
}

/** The part of Electron's `DownloadItem` this module uses, so tests can hand it one. */
export interface DownloadHandle {
  getURL(): string
  getFilename(): string
  getMimeType(): string
  getReceivedBytes(): number
  getSavePath(): string
  setSavePath(path: string): void
  once(event: 'done', listener: (event: unknown, state: string) => void): void
}

/** Whoever started a download, as far as this module needs to know. */
export type Starter = object

interface Claim {
  starter: Starter
  path: string | null
  settle(download: Download): void
  fail(error: Error): void
}

const KEPT = 20

/**
 * Every download of one project: the ones an agent asked for by address, and
 * the ones a page started by itself.
 *
 * The asymmetry between the two is the whole point of the class, and it is a
 * boundary rather than a convenience (owner, 2026-09-15). A file the agent named
 * the address of may be written where the agent said, inside the project. A file
 * the page produced on its own goes to a temporary directory and nowhere else:
 * `~/Downloads` being the one place a page can write to unassisted is what
 * rejected the handoff directories for `setFiles`, and admitting a drive-by
 * download into the project would close that same loop from the other end — the
 * page puts a file in, and `setFiles` hands it back out, with nobody asked at
 * any point.
 */
export class DownloadLog {
  /** Finished downloads nobody has collected yet, oldest first. */
  readonly #arrived: Download[] = []
  readonly #waiting: Array<(download: Download) => void> = []
  readonly #claims: Claim[] = []
  readonly #temporaryPath: (filename: string) => string

  constructor(temporaryPath: (filename: string) => string) {
    this.#temporaryPath = temporaryPath
  }

  /**
   * Say that `starter` is about to ask for a file, and where it may go. The
   * claim is what makes the next download from that tab the agent's own rather
   * than the page's, so it is taken before `downloadURL` is called and given up
   * if that call throws.
   */
  expect(starter: Starter, path: string | null): { arrived: Promise<Download>; giveUp(): void } {
    let settle: (download: Download) => void
    let fail: (error: Error) => void
    const arrived = new Promise<Download>((resolve, reject) => {
      settle = resolve
      fail = reject
    })
    const claim: Claim = { starter, path, settle: settle!, fail: fail! }
    this.#claims.push(claim)
    return {
      arrived,
      giveUp: () => {
        const at = this.#claims.indexOf(claim)
        if (at >= 0) this.#claims.splice(at, 1)
      },
    }
  }

  /**
   * A download has started. Naming a save path here is what stops Electron
   * showing the system's "Save as" panel — which would be waiting in a window
   * that normally sits off screen, so nobody would ever answer it.
   *
   * The path has to be decided synchronously: the panel appears the moment this
   * handler returns without one. That is why a claim carries a path already
   * resolved, and why the directory is made with the synchronous call.
   */
  accept(item: DownloadHandle, starter: Starter | null): void {
    const claimed = this.#take(starter)
    const filename = item.getFilename() || 'download'
    const path = claimed?.path ?? this.#temporaryPath(filename)
    mkdirSync(dirname(path), { recursive: true })
    item.setSavePath(path)
    item.once('done', (_event, state) => {
      if (state !== 'completed') {
        const why = state === 'cancelled' ? 'was cancelled' : 'was interrupted'
        const error = Object.assign(
          new Error(`the download of ${item.getURL()} ${why} before it finished`),
          { code: 'download-failed' },
        )
        // A page's own download failing is not an agent's error to hear about:
        // nobody is waiting on it, and `waitForDownload` is about files that
        // arrived. The claim's owner is waiting, and is told.
        if (claimed) claimed.fail(error)
        return
      }
      const download: Download = {
        // Electron may adjust the path it was given — a name already taken
        // comes back with a counter — so the item is asked rather than assumed.
        path: item.getSavePath() || path,
        url: item.getURL(),
        filename,
        bytes: item.getReceivedBytes(),
        mimeType: item.getMimeType(),
        at: Date.now(),
      }
      if (claimed) {
        claimed.settle(download)
        return
      }
      this.#deliver(download)
    })
  }

  /**
   * The next file to arrive, or one that already has. A click is what starts
   * the download this answers, and a small file can be on disk before the click
   * call even returns — so an arrival nobody was waiting for is kept rather
   * than dropped, and this collects it.
   */
  next(timeoutMs: number): Promise<Download> {
    const ready = this.#arrived.shift()
    if (ready) return Promise.resolve(ready)
    return new Promise<Download>((resolve, reject) => {
      const collect = (download: Download) => {
        clearTimeout(timer)
        resolve(download)
      }
      const timer = setTimeout(() => {
        const at = this.#waiting.indexOf(collect)
        if (at >= 0) this.#waiting.splice(at, 1)
        reject(
          Object.assign(
            new Error(
              `no download started in ${Math.round(timeoutMs / 1000)}s; ` +
                'waitForDownload answers the file a click produced — click first, or use download(url) when the ' +
                'file has an address of its own',
            ),
            { code: 'timeout' },
          ),
        )
      }, timeoutMs)
      this.#waiting.push(collect)
    })
  }

  /** What has arrived and nobody has collected. */
  get pending(): readonly Download[] {
    return this.#arrived
  }

  /** A project being unloaded: nothing is coming, and a caller still waiting is told so. */
  clear(): void {
    this.#arrived.length = 0
    this.#waiting.length = 0
    for (const claim of this.#claims.splice(0)) {
      claim.fail(Object.assign(new Error('the download was abandoned when the project was unloaded'), {
        code: 'download-failed',
      }))
    }
  }

  /**
   * The claim this download belongs to, if any. Claims are matched by who
   * started them and taken in order, so two agents downloading at once each get
   * their own file. A page that starts a download of its own in the same breath
   * as an agent's call could take that agent's claim; the cost is a file in the
   * wrong place of two the same scenario asked for, which is why the claim is
   * not also matched on the address — a download that redirects arrives under
   * the address it ended at, and matching on the one that was asked for would
   * miss every redirect.
   */
  #take(starter: Starter | null): Claim | null {
    const at = this.#claims.findIndex((claim) => claim.starter === starter)
    if (at < 0) return null
    const [claim] = this.#claims.splice(at, 1)
    return claim ?? null
  }

  #deliver(download: Download): void {
    const waiting = this.#waiting.shift()
    if (waiting) {
      waiting(download)
      return
    }
    this.#arrived.push(download)
    if (this.#arrived.length > KEPT) this.#arrived.splice(0, this.#arrived.length - KEPT)
  }
}

/**
 * Where a file goes when the agent named no path: the system's temporary
 * directory, under one folder of ours, the same answer `screenshot()` gives.
 *
 * The site's filename is kept at the end rather than replaced, because the
 * extension is half of what the file is — a `.csv` an agent has to guess at is
 * a `.csv` nothing will open. The project's name and a timestamp go in front of
 * it so the path reads as something when an agent shows it to a person, and so
 * two downloads of `report.pdf` are two files.
 */
export function temporaryDownloadPath(temp: string, projectName: string, filename: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const project = safe(projectName) || 'project'
  return join(temp, 'naoba', 'downloads', `${project}-${stamp}-${safe(filename) || 'download'}`)
}

/**
 * A name that cannot leave the directory it is joined to. The filename comes
 * from the site's `Content-Disposition` header, so `../../.zshrc` is a name a
 * page can choose.
 */
function safe(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+/, '').replace(/-+$/, '')
}
