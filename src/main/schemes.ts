/**
 * What this browser does with an address it cannot render itself.
 *
 * Three outcomes and no fourth: the address is loaded, handed to whatever
 * application the machine has registered for it, or refused in words. Nothing
 * is remembered and nobody is asked. A question to the person would stop an
 * agent's scenario in the middle, which is the one thing this browser is built
 * to avoid; the record an attempt leaves behind is where such a question would
 * later be waited for.
 *
 * Handing an address on is the move that needs the care. It lets a page choose
 * which application opens on somebody's machine, and this application refuses
 * bigger moves elsewhere — so the list of schemes that go through is closed,
 * short, and every entry on it opens a window the person then types into.
 * Nothing on it acts by itself.
 *
 * The list of schemes that load had to be written down too, and the reason is
 * worth keeping: a failed load says nothing useful. Measured on 2026-09-19
 * against Electron 44.4.3, `loadURL('mailto:…')` and `loadURL('x-nothing://…')`
 * both reject with `ERR_FAILED (-2)` — the same code an address that turns out
 * to be a file raises — and `did-fail-load` never fires at all. Nor can Electron
 * be asked: `isProtocolHandled` answered `false` for all 18 schemes tried, `http`
 * and `file` included, because it reports what the application registered rather
 * than what Chromium renders. So the decision is taken before the load, from the
 * scheme, and every entry in `RENDERED` was measured by loading it.
 *
 * Pure on purpose, like `permissions.ts` and `login.ts`: the unit tests load
 * this file without Electron, and `tab.ts`, `context.ts` and `hand-off.ts` make
 * the calls it decides about. Nothing here may import `electron`.
 */

export type SchemeOutcome = 'load' | 'hand-on' | 'refuse'

/**
 * What Chromium renders here. Each one was loaded in a window on 2026-09-19 and
 * came back with a document: `about:`, `data:`, `file:`, `view-source:` and
 * `devtools:` directly, `blob:` from a page that had made the address itself.
 * `http` and `https` are the whole point of the application.
 *
 * Adding to this list opens nothing new — it only stops something that already
 * worked from being refused. Leaving something out of it is the failure mode,
 * and it is a visible one: the refusal names the scheme.
 */
const RENDERED = new Set(['http', 'https', 'file', 'about', 'data', 'blob', 'view-source', 'devtools'])

/**
 * What may be handed to the machine. All three open a window the person then
 * types into — a message that is not sent, a number that is not dialled — so the
 * worst a page can do with one is waste a moment of somebody's attention.
 *
 * A scheme a native client registers is deliberately absent, single sign-on
 * included. Sending an agent's click into an arbitrary application is not the
 * same move as sending a person's click to their mail client, and telling the
 * two apart is the whole reason this file exists.
 */
const HANDED_ON = new Set(['mailto', 'tel', 'sms'])

/** The scheme of an address, lowercased, or '' when it carries none. */
export function schemeOf(url: string): string {
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(url.trim())
  return match ? match[1]!.toLowerCase() : ''
}

export function outcomeFor(url: string): SchemeOutcome {
  const scheme = schemeOf(url)
  if (HANDED_ON.has(scheme)) return 'hand-on'
  // An address with no scheme at all has already been through `normalizeUrl`,
  // which puts `https://` in front of it; one that reaches here without a scheme
  // is a relative address inside a page and belongs to the document it came from.
  if (scheme === '' || RENDERED.has(scheme)) return 'load'
  return 'refuse'
}

/**
 * What an agent reads when the address went to another application.
 *
 * It says where the tab stayed as well as where the address went, because the
 * tab not moving is the part a scenario has to account for.
 */
export function handOffNotice(url: string, stayedAt: string): string {
  return `${url} is not a page this browser can show, so it went to whatever application this machine ` +
    `opens ${schemeOf(url)}: addresses with. The tab did not move; it is still on ${stayedAt}.`
}

/** What an agent reads when nothing was opened at all. */
export function refusalFor(url: string, stayedAt: string): string {
  return `${url} is an address in the ${schemeOf(url)}: scheme, which this browser does not show and does ` +
    `not hand to another application. Nothing was opened. The tab did not move; it is still on ${stayedAt}. ` +
    `If a person has to finish this, hand them the tab with requestHuman.`
}

/**
 * What an agent reads when the address would have gone, but one just did.
 *
 * A separate sentence from the refusal, because the refusal says this browser
 * never hands such an address on, and here it does — a second ago.
 */
export function tooSoonNotice(url: string, stayedAt: string): string {
  return `${url} was not handed to this machine: an address in the ${schemeOf(url)}: scheme went a moment ago, ` +
    `and a page that asks twice in a second is asking on its own rather than for the person. Wait a second and ` +
    `try again if you meant it. The tab did not move; it is still on ${stayedAt}.`
}

/**
 * Whether a hand-off comes too soon after the last one from the same tab.
 *
 * One per second. A page that loops `mailto:` would otherwise leave a column of
 * compose windows on the person's screen, and the second one is already useless
 * to them.
 */
const APART_MS = 1_000

export function tooSoon(lastHandOff: number | null, now: number): boolean {
  if (lastHandOff === null) return false
  return now - lastHandOff < APART_MS
}
