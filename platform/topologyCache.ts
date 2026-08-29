/**
 * Small expiring cache used by the live topology reader.
 *
 * The cache is deliberately invalidatable: a Firestore watch notification is
 * the authoritative dirty signal, so a refresh must not reuse a value that
 * was warm before that notification arrived.
 */
export class ExpiringCache<T> {
  private readonly entries = new Map<string, { expiresAt: number; value: T }>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    this.entries.set(key, { expiresAt: this.now() + this.ttlMs, value });
  }

  invalidate(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}
