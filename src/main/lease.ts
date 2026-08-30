/**
 * A lease says who is working on a tab. It exists so that a multi-step scenario
 * ("open the form, fill three fields, submit") is not cut in half by another
 * agent, and so that the person watching can always take a tab back.
 */
export type Holder = { kind: 'agent'; id: string; label: string } | { kind: 'human' }

export interface Lease {
  readonly tabId: string
  readonly holder: Holder
  readonly reason: string | null
  readonly expiresAt: number
}

export type LeaseEvent =
  | { type: 'claimed'; tabId: string; holder: Holder; reason: string | null }
  | { type: 'released'; tabId: string; holder: Holder }
  | { type: 'taken-over'; tabId: string; from: Holder; to: Holder }
  | { type: 'expired'; tabId: string; holder: Holder }

export function holderLabel(holder: Holder): string {
  return holder.kind === 'human' ? 'the person at the keyboard' : holder.label
}

function sameHolder(a: Holder, b: Holder): boolean {
  if (a.kind === 'human' || b.kind === 'human') return a.kind === b.kind
  return a.id === b.id
}

export class LeaseTable {
  readonly #leases = new Map<string, Lease>()
  readonly #listeners = new Set<(event: LeaseEvent) => void>()
  readonly #now: () => number

  constructor(now: () => number = Date.now) {
    this.#now = now
  }

  onChange(listener: (event: LeaseEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  #emit(event: LeaseEvent): void {
    for (const listener of this.#listeners) listener(event)
  }

  /** Current holder, after expiring a stale lease. A crashed agent must not hold a tab forever. */
  holderOf(tabId: string): Holder | null {
    const lease = this.#leases.get(tabId)
    if (!lease) return null
    if (lease.expiresAt <= this.#now()) {
      this.#leases.delete(tabId)
      this.#emit({ type: 'expired', tabId, holder: lease.holder })
      return null
    }
    return lease.holder
  }

  leaseOf(tabId: string): Lease | null {
    return this.holderOf(tabId) ? this.#leases.get(tabId) ?? null : null
  }

  /** Take the tab, or return the holder standing in the way. Re-claiming your own tab extends it. */
  claim(tabId: string, holder: Holder, ttlMs: number, reason: string | null = null): { ok: true } | { ok: false; heldBy: Holder } {
    const current = this.holderOf(tabId)
    if (current && !sameHolder(current, holder)) return { ok: false, heldBy: current }
    this.#leases.set(tabId, { tabId, holder, reason, expiresAt: this.#now() + ttlMs })
    if (!current) this.#emit({ type: 'claimed', tabId, holder, reason })
    return { ok: true }
  }

  /** The person always wins; the agent that loses gets told, never silently ignored. */
  takeOver(tabId: string, to: Holder): Holder | null {
    const from = this.holderOf(tabId)
    this.#leases.set(tabId, { tabId, holder: to, reason: null, expiresAt: this.#now() + FOREVER })
    if (from && !sameHolder(from, to)) this.#emit({ type: 'taken-over', tabId, from, to })
    else if (!from) this.#emit({ type: 'claimed', tabId, holder: to, reason: null })
    return from
  }

  release(tabId: string, holder: Holder): boolean {
    const current = this.#leases.get(tabId)
    if (!current || !sameHolder(current.holder, holder)) return false
    this.#leases.delete(tabId)
    this.#emit({ type: 'released', tabId, holder })
    return true
  }

  /** Every lease an agent held, dropped at once — what a disconnect must do. */
  releaseAll(holder: Holder): string[] {
    const dropped: string[] = []
    for (const [tabId, lease] of [...this.#leases]) {
      if (sameHolder(lease.holder, holder)) {
        this.#leases.delete(tabId)
        dropped.push(tabId)
        this.#emit({ type: 'released', tabId, holder })
      }
    }
    return dropped
  }

  entries(): Lease[] {
    for (const tabId of [...this.#leases.keys()]) this.holderOf(tabId)
    return [...this.#leases.values()]
  }
}

export const FOREVER = 365 * 24 * 60 * 60 * 1000
