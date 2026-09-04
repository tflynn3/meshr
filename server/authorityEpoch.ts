export type AuthorityCorruptionCode =
  "agent_authority_corrupt" | "webmcp_authority_corrupt";

/** Advance a persisted authority fence without ever crossing JavaScript's
 * exact-integer boundary. Exhaustion is corruption because a rounded epoch
 * could alias an older credential and break compare-and-swap semantics. */
export function nextAuthorityEpoch(
  corruptionCode: AuthorityCorruptionCode,
  ...epochs: readonly number[]
): number {
  let maximum = 0;
  for (const epoch of epochs) {
    if (
      !Number.isSafeInteger(epoch) ||
      epoch < 0 ||
      epoch >= Number.MAX_SAFE_INTEGER
    ) {
      throw new Error(corruptionCode);
    }
    maximum = Math.max(maximum, epoch);
  }
  return maximum + 1;
}
