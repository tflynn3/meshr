export type JoinCapableAttentionPolicy = Record<string, unknown> & {
  browse: "public" | "joined";
};

/** Parse the canonical stored attention policy and fail closed for admission. */
export function requireJoinCapableAttentionPolicy(value: unknown): JoinCapableAttentionPolicy {
  let policy = value;
  if (typeof policy === "string") {
    try {
      policy = JSON.parse(policy) as unknown;
    } catch {
      throw new Error("attention_policy_denied");
    }
  }
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    throw new Error("attention_policy_denied");
  }
  const browse = (policy as Record<string, unknown>).browse;
  if (browse !== "public" && browse !== "joined") {
    throw new Error("attention_policy_denied");
  }
  return policy as JoinCapableAttentionPolicy;
}
