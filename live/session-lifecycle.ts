import { MeshrApi, MeshrApiError } from "../connector/api.ts";
import type { ConnectorBinding } from "../connector/types.ts";

export interface NativeSessionLifecycleObservation {
  hostExitedAt: string;
  onlineVerifiedAt: string;
  offlineObservedAt: string;
  offlineAfterSeconds: number;
}

export interface NativeSessionLifecycleOptions {
  /** Timestamp captured immediately after the native host process exits. */
  hostExitedAt?: string;
  /** The launch contract's maximum heartbeat grace period. */
  offlineAfterSeconds?: number;
}

export interface NativeSessionOnlineObservation {
  hostExitedAt: string;
  onlineVerifiedAt: string;
}

function lifecycleError(error: unknown): boolean {
  return (
    error instanceof MeshrApiError &&
    error.status === 401 &&
    error.code === "agent_authentication_failed" &&
    /offline|expired/i.test(error.message)
  );
}

function timestamp(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be an ISO timestamp.`);
  return parsed;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Confirm the bearer left by the host is still online without touching its
 * heartbeat. The session probe is deliberately read-only so this check cannot
 * keep an unattended native host alive while it waits for the offline edge.
 */
export async function observeNativeSessionOnline(
  binding: ConnectorBinding,
  options: NativeSessionLifecycleOptions = {},
): Promise<NativeSessionOnlineObservation> {
  if (!binding.sessionId || !binding.agentToken) {
    throw new Error(`Binding ${binding.requestedProfile.handle} has no active native session.`);
  }
  const hostExitedAt = options.hostExitedAt ?? new Date().toISOString();
  timestamp(hostExitedAt, "hostExitedAt");
  await new MeshrApi(binding.serverUrl).agentRequest(binding, "/v1/agent/session");
  return { hostExitedAt, onlineVerifiedAt: new Date().toISOString() };
}

/**
 * Wait for the same host session to become unauthorized. Call this only after
 * the online probe and any post readback that needs the bearer have completed.
 */
export async function waitForNativeSessionOffline(
  binding: ConnectorBinding,
  online: NativeSessionOnlineObservation,
  options: NativeSessionLifecycleOptions = {},
): Promise<NativeSessionLifecycleObservation> {
  const maximumSeconds = options.offlineAfterSeconds ?? 90;
  if (!Number.isSafeInteger(maximumSeconds) || maximumSeconds < 90 || maximumSeconds > 600) {
    throw new Error("offlineAfterSeconds must be an integer from 90 to 600.");
  }
  const hostExitedMs = timestamp(online.hostExitedAt, "hostExitedAt");
  const onlineVerifiedMs = timestamp(online.onlineVerifiedAt, "onlineVerifiedAt");
  if (onlineVerifiedMs < hostExitedMs || onlineVerifiedMs > Date.now() + 5_000) {
    throw new Error("Native session online verification timestamp is invalid.");
  }
  const deadline = hostExitedMs + maximumSeconds * 1_000;
  const api = new MeshrApi(binding.serverUrl);
  while (Date.now() <= deadline) {
    try {
      await api.agentRequest(binding, "/v1/agent/session");
    } catch (error) {
      if (!lifecycleError(error)) throw error;
      const observedAt = new Date().toISOString();
      const observedMs = Date.parse(observedAt);
      if (observedMs > deadline) {
        throw new Error(
          `Native host session for ${binding.requestedProfile.handle} did not go offline within ${maximumSeconds} seconds.`,
        );
      }
      return {
        hostExitedAt: online.hostExitedAt,
        onlineVerifiedAt: online.onlineVerifiedAt,
        offlineObservedAt: observedAt,
        offlineAfterSeconds: Number(((observedMs - hostExitedMs) / 1_000).toFixed(3)),
      };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await delay(Math.min(500, remaining));
  }
  throw new Error(
    `Native host session for ${binding.requestedProfile.handle} did not go offline within ${maximumSeconds} seconds.`,
  );
}

/**
 * Run the phase's readback while the host bearer is online, then observe the
 * offline transition from the exact host-exit witness.
 */
export async function observeNativeSessionOffline<T>(
  binding: ConnectorBinding,
  beforeWait: () => Promise<T>,
  options: NativeSessionLifecycleOptions = {},
): Promise<{ value: T; observation: NativeSessionLifecycleObservation }> {
  const online = await observeNativeSessionOnline(binding, options);
  const value = await beforeWait();
  const observation = await waitForNativeSessionOffline(binding, online, options);
  return { value, observation };
}
