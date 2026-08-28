import { sha256 } from "./security.ts";

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
  remaining: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/**
 * A small, dependency-free token bucket for the local adapter. Production
 * deployments should combine this burst guard with Cloud Armor and the
 * Firestore minute counters written with the social mutation transaction.
 */
export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number = Date.now,
  ) {}

  consume(key: string, amount = 1): RateLimitResult {
    const timestamp = this.now();
    const previous = this.buckets.get(key) ?? {
      tokens: this.capacity,
      updatedAt: timestamp,
    };
    const elapsed = Math.max(0, timestamp - previous.updatedAt) / 1_000;
    const tokens = Math.min(this.capacity, previous.tokens + elapsed * this.refillPerSecond);
    if (tokens < amount) {
      const retryAfterSeconds = Math.max(1, Math.ceil((amount - tokens) / this.refillPerSecond));
      this.buckets.set(key, { tokens, updatedAt: timestamp });
      return { allowed: false, retryAfterSeconds, remaining: Math.floor(tokens) };
    }
    const remaining = tokens - amount;
    this.buckets.set(key, { tokens: remaining, updatedAt: timestamp });
    return { allowed: true, retryAfterSeconds: 0, remaining: Math.floor(remaining) };
  }

  clear(): void {
    this.buckets.clear();
  }
}

export interface ModerationDecision {
  state: "published" | "quarantined";
  reason: string | null;
  severity: "low" | "medium" | "high" | "critical";
  asyncReview: boolean;
}

const highConfidenceSecretPatterns: Array<[RegExp, string]> = [
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i, "private_key"],
  [/(?:sk|rk|xox[baprs])-live-[A-Za-z0-9_-]{12,}/, "provider_secret"],
  [/AIza[0-9A-Za-z_-]{30,}/, "google_api_key"],
  [/(?:password|passwd|secret|token)\s*[:=]\s*['\"]?[^\s'\"]{12,}/i, "credential_literal"],
];

const unsafeLinkPatterns: Array<[RegExp, string]> = [
  [/\b(?:javascript|vbscript):/i, "unsafe_link"],
  [/\bdata:text\/html(?:[;,]|\s|$)/i, "unsafe_link"],
  [/\bfile:\/\//i, "unsafe_link"],
];

/** Deterministic, explainable checks that run before a post is published. */
export function moderatePost(body: string, postId: string): ModerationDecision {
  for (const [pattern, reason] of highConfidenceSecretPatterns) {
    if (pattern.test(body)) {
      return {
        state: "quarantined",
        reason,
        severity: "high",
        asyncReview: true,
      };
    }
  }
  for (const [pattern, reason] of unsafeLinkPatterns) {
    if (pattern.test(body)) {
      return {
        state: "quarantined",
        reason,
        severity: "high",
        asyncReview: true,
      };
    }
  }
  // A stable sample avoids random test behaviour while providing a bounded
  // async-review queue for ordinary traffic.
  const sample = Number.parseInt(sha256(postId).slice(0, 8), 16) % 20 === 0;
  return {
    state: "published",
    reason: null,
    severity: "low",
    asyncReview: sample,
  };
}
