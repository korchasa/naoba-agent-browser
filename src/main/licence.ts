/**
 * The rules a licence is judged by, with nothing around them.
 *
 * Naoba is bought once and runs forever, but the key it was bought with can be
 * refunded or cancelled — so the application asks the licensing service about
 * it now and then, and remembers the answer. This file holds the part worth
 * testing: what makes a stored answer good enough to go on, and the exact shape
 * of each request. The files, the network and the clock live in
 * `licence-store.ts`.
 *
 * Pure on purpose, like `preferences.ts`: the unit tests load it without
 * Electron. Nothing here may import `electron`.
 */

/** The product this copy belongs to. Not a secret — it names a shop, not a key. */
export const PRODUCT_ID = '39376'

export const API_ORIGIN = 'https://api.freemius.com'

/**
 * How long a stored answer holds without the service confirming it again.
 *
 * A month, because a person can be away from the network for a fortnight and
 * still expect the thing they bought to open, and because one key left running
 * on a machine that never reports back should not be a permanent second copy.
 */
export const GRACE_DAYS = 30

const DAY_MS = 24 * 60 * 60 * 1000

/** What the application keeps on disk after a key is activated. */
export interface LicenceRecord {
  /** The key the person typed. Needed again for every check and for deactivation. */
  key: string
  /** This installation's 32-character identifier, made once and kept. */
  uid: string
  /** The install the service created for this device. */
  installId: string
  plan: string | null
  /** ISO date, or `null` for a licence that does not expire. */
  expiration: string | null
  cancelled: boolean
  /** When the service last confirmed all of the above. */
  checkedAt: number
}

export type Verdict =
  | { state: 'licensed'; until: string | null }
  | { state: 'unlicensed'; reason: string }

/**
 * Whether this copy may be used, judged on what is stored alone — the network
 * is not consulted here and may be unreachable for weeks.
 */
export function verdict(record: LicenceRecord | null, now = Date.now(), graceDays = GRACE_DAYS): Verdict {
  if (!record) return { state: 'unlicensed', reason: 'Naoba has not been unlocked on this Mac yet.' }
  if (record.cancelled) {
    return { state: 'unlicensed', reason: 'This licence key was cancelled or refunded.' }
  }
  if (record.expiration && Date.parse(record.expiration) <= now) {
    return { state: 'unlicensed', reason: `This licence ran out on ${record.expiration.slice(0, 10)}.` }
  }
  const silent = now - record.checkedAt
  if (silent > graceDays * DAY_MS) {
    const days = Math.floor(silent / DAY_MS)
    return {
      state: 'unlicensed',
      reason: `The licence has not been confirmed for ${days} days. Connect to the internet and open Naoba's settings.`,
    }
  }
  return { state: 'licensed', until: record.expiration }
}

/**
 * Which copies answer an agent without a key at all.
 *
 * A test run and the snapshot run drive a browser nobody bought. So does the
 * development copy: it is built from a checkout by the person working on the
 * application, under its own bundle id and its own name, and asking them to buy
 * their own work back on every reinstall helps nobody. The copy people download
 * is not any of these, and it asks.
 */
export function admitsWithoutKey(isTestRun: boolean, isDevCopy: boolean): boolean {
  return isTestRun || isDevCopy
}

/** A 32-character identifier for this installation, from whatever gives us bytes. */
export function newUid(bytes: (count: number) => Uint8Array): string {
  return [...bytes(16)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export interface Request {
  url: string
  method: 'GET' | 'POST'
  body?: unknown
}

/**
 * Who is unlocking, for the one kind of key that needs telling.
 *
 * A key that was bought carries its buyer already, so activation says nothing
 * about the person. A key written by hand in the shop — a gift, a review copy —
 * belongs to nobody yet, and the service will not take it until it knows who to
 * hand it to.
 */
export interface Buyer {
  firstName: string
  lastName: string
  email: string
}

export function activateRequest(
  key: string,
  uid: string,
  title: string,
  buyer: Buyer | null = null,
  productId = PRODUCT_ID,
): Request {
  const who = buyer
    ? { first_name: buyer.firstName, last_name: buyer.lastName, user_email: buyer.email }
    : {}
  return {
    url: `${API_ORIGIN}/v1/products/${productId}/licenses/activate.json`,
    method: 'POST',
    body: { uid, license_key: key, title, ...who },
  }
}

/**
 * Whether the service refused because it does not know who is activating.
 *
 * It complains about one field at a time — the name first, then the surname,
 * then the address — so any of the three means the same thing: this key has no
 * buyer on it.
 */
export function asksWhoYouAre(code: unknown): boolean {
  return code === 'first_name_required' || code === 'last_name_required' || code === 'user_email_required'
}

export function checkRequest(record: LicenceRecord, productId = PRODUCT_ID): Request {
  const query = `uid=${encodeURIComponent(record.uid)}&license_key=${encodeURIComponent(record.key)}`
  return {
    url: `${API_ORIGIN}/v1/products/${productId}/installs/${record.installId}/license.json?${query}`,
    method: 'GET',
  }
}

export function deactivateRequest(record: LicenceRecord, productId = PRODUCT_ID): Request {
  return {
    url: `${API_ORIGIN}/v1/products/${productId}/licenses/deactivate.json`,
    method: 'POST',
    body: { uid: record.uid, install_id: record.installId, license_key: record.key },
  }
}

/** The record to store after the service accepted a key. */
export function recordFrom(answer: unknown, key: string, uid: string, now = Date.now()): LicenceRecord {
  const data = answer as Record<string, unknown>
  const installId = data?.install_id ?? data?.id
  if (installId === undefined || installId === null) {
    throw new Error('the licensing service accepted the key but named no installation')
  }
  return {
    key,
    uid,
    installId: String(installId),
    plan: typeof data.license_plan_name === 'string' ? data.license_plan_name : null,
    expiration: typeof data.expiration === 'string' ? data.expiration : null,
    cancelled: data.is_cancelled === true,
    checkedAt: now,
  }
}

/** The record after a check, which can turn a good licence bad and never the other way by itself. */
export function refreshed(record: LicenceRecord, answer: unknown, now = Date.now()): LicenceRecord {
  const data = answer as Record<string, unknown>
  return {
    ...record,
    plan: typeof data.plan_name === 'string' ? data.plan_name : record.plan,
    expiration: typeof data.expiration === 'string' ? data.expiration : null,
    cancelled: data.is_cancelled === true,
    checkedAt: now,
  }
}

/** What the settings window says about the licence, in the three forms a row draws. */
export interface LicenceState {
  licensed: boolean
  sentence: string
  plan: string | null
  /** The last four characters of the key, enough for the person to recognise it. */
  tail: string | null
  /** When the service last confirmed it, as a date, or `null` if never. */
  checkedOn: string | null
  /**
   * True on a copy that answers agents without a key. There is no key to buy,
   * none to type and none to free, so the row says what this copy is and shows
   * no button at all.
   */
  needsNoKey: boolean
}

/** What that row says on a copy which needs no key. */
export function describeFreeCopy(): LicenceState {
  return {
    licensed: true,
    sentence: 'This copy was built from the source and runs without a key.',
    plan: null,
    tail: null,
    checkedOn: null,
    needsNoKey: true,
  }
}

export function describe(record: LicenceRecord | null, now = Date.now(), graceDays = GRACE_DAYS): LicenceState {
  const answer = verdict(record, now, graceDays)
  if (answer.state === 'licensed') {
    const until = answer.until ? `, good until ${answer.until.slice(0, 10)}` : ', and it does not expire'
    return {
      licensed: true,
      sentence: `Unlocked${until}.`,
      plan: record?.plan ?? null,
      tail: record ? record.key.slice(-4) : null,
      checkedOn: record ? new Date(record.checkedAt).toISOString().slice(0, 10) : null,
      needsNoKey: false,
    }
  }
  return {
    licensed: false,
    sentence: answer.reason,
    plan: record?.plan ?? null,
    tail: record ? record.key.slice(-4) : null,
    checkedOn: record ? new Date(record.checkedAt).toISOString().slice(0, 10) : null,
    needsNoKey: false,
  }
}
