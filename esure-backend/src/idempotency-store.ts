/**
 * In-memory idempotency store for run creation requests.
 *
 * Contract:
 *  - The same key + identical canonical request body returns the original run
 *    without re-executing.
 *  - The same key with a different canonical body returns a conflict error.
 *  - Concurrent identical requests are deduplicated atomically within one
 *    process (the first caller sets the entry; concurrent callers wait for the
 *    same settled promise).
 *  - Entries expire after `retentionMs` (default 24 h) measured from creation.
 *  - Capacity is bounded; once `maxEntries` is reached, new keys are rejected
 *    with a 503 until enough entries expire.
 *
 * Limitations (documented):
 *  - Retention and deduplication are in-process only. A process restart or
 *    a second instance will not find entries written by another process. For
 *    distributed or durable idempotency use a shared database.
 */

export interface IdempotencyEntry<T> {
  /** Canonical JSON fingerprint of the request that created this entry. */
  readonly requestFingerprint: string;
  /** Settled result shared across all callers with the same key. */
  readonly result: Promise<T>;
  /** Millisecond epoch of when the entry was created. */
  readonly createdAt: number;
}

export type IdempotencyConflict = { conflict: true; existingFingerprint: string };
export type IdempotencyCapacityError = { capacityExceeded: true };

export type IdempotencyInsertResult<T> =
  | { status: "created"; entry: IdempotencyEntry<T> }
  | { status: "existing"; entry: IdempotencyEntry<T> }
  | { status: "conflict"; existingFingerprint: string }
  | { status: "capacity" };

export class IdempotencyStore<T> {
  readonly #entries = new Map<string, IdempotencyEntry<T>>();

  constructor(
    private readonly maxEntries: number = 1_000,
    private readonly retentionMs: number = 86_400_000, // 24 h
    private readonly now: () => number = Date.now,
  ) {}

  get size(): number {
    this.#removeExpired();
    return this.#entries.size;
  }

  /**
   * Attempt to insert an idempotency entry.
   *
   * @param key            - The Idempotency-Key header value.
   * @param fingerprint    - Canonical JSON fingerprint of the request body.
   * @param resultPromise  - The promise returned by the actual handler (only
   *                         used when creating a new entry; ignored otherwise).
   */
  insert(key: string, fingerprint: string, producer: Promise<T> | (() => Promise<T>)): IdempotencyInsertResult<T> {
    this.#removeExpired();

    const existing = this.#entries.get(key);
    if (existing) {
      if (existing.requestFingerprint !== fingerprint) {
        return { status: "conflict", existingFingerprint: existing.requestFingerprint };
      }
      return { status: "existing", entry: existing };
    }

    if (this.#entries.size >= this.maxEntries) {
      return { status: "capacity" };
    }

    const resultPromise = typeof producer === "function" ? producer() : producer;
    const entry: IdempotencyEntry<T> = {
      requestFingerprint: fingerprint,
      result: resultPromise,
      createdAt: this.now(),
    };
    this.#entries.set(key, entry);
    return { status: "created", entry };
  }

  #removeExpired(): void {
    const cutoff = this.now() - this.retentionMs;
    for (const [key, entry] of this.#entries) {
      if (entry.createdAt <= cutoff) this.#entries.delete(key);
    }
  }
}
