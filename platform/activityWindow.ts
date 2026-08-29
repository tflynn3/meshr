/**
 * Rolling topology activity is grouped into minute buckets. Keep this policy
 * separate from the worker so the clock-boundary contract can be tested
 * deterministically without starting a Pub/Sub consumer.
 */
export const TOPOLOGY_ACTIVITY_WINDOW_MINUTES = 15;
// Native hosts can stamp an event a few seconds ahead of the materializer's
// wall clock (especially around a minute boundary). Keep that small bounded
// skew in the rolling projection; materially future events remain outside the
// recent window until their timestamp is sane or the producer is corrected.
export const TOPOLOGY_ACTIVITY_MAX_FUTURE_SKEW_MS = 2 * 60 * 1_000;

export function isActivityWithinRecentWindow(
  activityBucketMs: number,
  nowMs: number,
): boolean {
  if (!Number.isFinite(activityBucketMs) || !Number.isFinite(nowMs)) return false;
  const activityWindowCutoffMs = Math.floor(
    (nowMs - TOPOLOGY_ACTIVITY_WINDOW_MINUTES * 60 * 1_000) / 60_000,
  ) * 60_000;
  const activityCurrentMinuteMs = Math.floor(nowMs / 60_000) * 60_000;
  return activityBucketMs >= activityWindowCutoffMs &&
    activityBucketMs <= activityCurrentMinuteMs + TOPOLOGY_ACTIVITY_MAX_FUTURE_SKEW_MS;
}
