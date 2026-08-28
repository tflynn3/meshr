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
    private readonly maxKeys = 10_000,
  ) {}

  private prune(timestamp: number): void {
    if (this.buckets.size < this.maxKeys) return;
    // Keep the in-process guard bounded even when an attacker rotates source
    // addresses. Entries that have refilled to capacity are least useful and
    // can be dropped without changing the effective limit for active callers.
    for (const [key, bucket] of this.buckets) {
      const elapsed = Math.max(0, timestamp - bucket.updatedAt) / 1_000;
      if (bucket.tokens + elapsed * this.refillPerSecond >= this.capacity) {
        this.buckets.delete(key);
      }
      if (this.buckets.size < this.maxKeys) break;
    }
    if (this.buckets.size >= this.maxKeys) {
      const oldest = this.buckets.entries().next().value as [string, Bucket] | undefined;
      if (oldest) this.buckets.delete(oldest[0]);
    }
  }

  consume(key: string, amount = 1): RateLimitResult {
    const timestamp = this.now();
    if (!this.buckets.has(key)) this.prune(timestamp);
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
  // Provider prefixes are high-confidence signals. A connector can use a
  // restricted alphabet (or a synthetic value in a test), so entropy must not
  // allow a credential-shaped token through this synchronous gate.
  [/(?:sk|rk)_live_[A-Za-z0-9_-]{16,}/, "provider_secret"],
  [/(?:sk|rk)-live-[A-Za-z0-9_-]{16,}/, "provider_secret"],
  [/(?:sk|sk-proj|sess)-[A-Za-z0-9_-]{20,}/, "provider_secret"],
  [/sk-ant-(?:api|admin)-[A-Za-z0-9_-]{16,}/i, "provider_secret"],
  [/(?:xox[baprs])-[A-Za-z0-9-]{20,}/, "provider_secret"],
  [/(?:gh[porsu]|github_pat)_[A-Za-z0-9_]{20,}/, "provider_secret"],
  [/AKIA[0-9A-Z]{16}/, "provider_secret"],
  [/(?:npm|npat)_[A-Za-z0-9]{30,}/, "provider_secret"],
  [/(?:hf|r8)_[A-Za-z0-9]{20,}/, "provider_secret"],
  [/xai-[A-Za-z0-9_-]{20,}/, "provider_secret"],
  [/AIza[0-9A-Za-z_-]{30,}/, "google_api_key"],
  [/(?:whsec|dop_v1|lin_api)_[A-Za-z0-9_-]{20,}/, "provider_secret"],
  [/(?:password|passwd|secret|token)\s*[:=]\s*['\"]?[^\s'\"]{12,}/i, "credential_literal"],
];

function tokenHasSecretShape(value: string): boolean {
  if (value.length < 16) return false;
  const distinct = new Set(value).size;
  if (distinct < 8) return false;
  // Reject deterministic filler while still accepting provider tokens that use
  // a restricted alphabet. Only high-confidence, long credential-shaped values
  // are quarantined by this synchronous gate.
  const entropy = [...new Set(value)].reduce((sum, character) => {
    const frequency = value.split(character).length - 1;
    const probability = frequency / value.length;
    return sum - probability * Math.log2(probability);
  }, 0);
  return entropy >= 2.75;
}

const unsafeLinkPatterns: Array<[RegExp, string]> = [
  [/\b(?:javascript|vbscript):/i, "unsafe_link"],
  [/\bdata:text\/html(?:[;,]|\s|$)/i, "unsafe_link"],
  [/\bfile:\/\//i, "unsafe_link"],
];

/** Deterministic, explainable checks that run before a post is published. */
export function moderatePost(body: string, postId: string): ModerationDecision {
  for (const [pattern, reason] of highConfidenceSecretPatterns) {
    const match = pattern.exec(body);
    // Keep the entropy check only for generic labelled literals. The provider
    // formats above are already sufficiently specific to quarantine directly.
    if (
      match &&
      (reason === "private_key" || reason !== "credential_literal" || tokenHasSecretShape(match[0]))
    ) {
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
