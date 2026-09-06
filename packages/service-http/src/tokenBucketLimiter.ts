type Bucket = {
  tokens: number;
  updatedAtMs: number;
};

/**
 * A token bucket per key with a bounded key count. When the map is full the
 * least recently touched bucket is evicted, so a flood of new keys cannot grow
 * memory without bound; it can only shorten the memory of old keys.
 */
export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly maxKeys: number,
  ) {
    if (capacity <= 0 || refillPerSecond <= 0 || maxKeys <= 0) {
      throw new Error("rate limits must be positive");
    }
  }

  /** Takes `cost` tokens from the bucket for `key`, or refuses when they are not there. */
  allow(key: string, nowMs: number, cost = 1): boolean {
    const bucket = this.bucketFor(key || "unknown", nowMs);
    if (bucket.tokens < cost) return false;
    bucket.tokens -= cost;
    return true;
  }

  get size(): number {
    return this.buckets.size;
  }

  private bucketFor(key: string, nowMs: number): Bucket {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.maxKeys) this.evictOldest();
      bucket = { tokens: this.capacity, updatedAtMs: nowMs };
      this.buckets.set(key, bucket);
    }
    const elapsedSeconds = Math.max(0, nowMs - bucket.updatedAtMs) / 1_000;
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsedSeconds * this.refillPerSecond);
    bucket.updatedAtMs = nowMs;
    return bucket;
  }

  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestMs = Number.POSITIVE_INFINITY;
    for (const [key, bucket] of this.buckets) {
      if (bucket.updatedAtMs < oldestMs) {
        oldestKey = key;
        oldestMs = bucket.updatedAtMs;
      }
    }
    if (oldestKey !== null) this.buckets.delete(oldestKey);
  }
}
