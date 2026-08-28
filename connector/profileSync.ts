import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadAgentDefinition } from "./definition";
import { MeshrApi, MeshrApiError } from "./api";
import { ConnectorStateStore } from "./state";
import type { ConnectorBinding } from "./types";

export interface ProfileSyncResult {
  binding: ConnectorBinding;
  changed: boolean;
  response?: unknown;
  profileReload?: {
    contract_version: 1;
    applied?: boolean;
    applied_fields: string[];
    pending_owner_review_fields: string[];
    source_digest: string;
    validation_failures: string[];
  };
}

function assertBindingProfileResponse(
  binding: ConnectorBinding,
  response: unknown,
  options: { allowIdentityChanges?: boolean } = {},
): void {
  const record =
    response && typeof response === "object" && !Array.isArray(response)
      ? (response as Record<string, unknown>)
      : {};
  const agent =
    record.agent && typeof record.agent === "object" && !Array.isArray(record.agent)
      ? (record.agent as Record<string, unknown>)
      : {};
  if (typeof agent.id !== "string" || typeof agent.handle !== "string") {
    throw new Error("Meshr returned an invalid authenticated agent profile.");
  }
  if (binding.agentId && agent.id !== binding.agentId) {
    throw new Error(
      `Authenticated Meshr agent ${agent.id} does not match binding ${binding.agentId}.`,
    );
  }
  if (!options.allowIdentityChanges && agent.handle !== binding.requestedProfile.handle) {
    throw new Error(
      `Authenticated Meshr handle @${agent.handle} does not match binding @${binding.requestedProfile.handle}.`,
    );
  }
}

/** Prove that the stored bearer still resolves to an authenticated agent profile. */
export async function verifyBindingSession(
  binding: ConnectorBinding,
  options: { allowIdentityChanges?: boolean } = {},
): Promise<unknown> {
  const response = await new MeshrApi(binding.serverUrl).agentRequest(
    binding,
    "/v1/agent/profile",
  );
  assertBindingProfileResponse(binding, response, options);
  return response;
}

/** Publish only the safe profile projection from a binding's local definition. */
export async function syncBindingDefinition(input: {
  selector: string;
  store: ConnectorStateStore;
  definitionPath?: string;
  /** A reload may propose identity changes; normal verification rejects a mismatch. */
  allowIdentityChanges?: boolean;
}): Promise<ProfileSyncResult> {
  const binding = await input.store.require(input.selector);
  if (binding.status !== "connected" || !binding.agentToken) {
    throw new Error(`Binding ${input.selector} is not connected.`);
  }
  const definitionPath = input.definitionPath ?? binding.definitionPath;
  let digest = binding.definitionDigest;
  let profile: Awaited<ReturnType<typeof loadAgentDefinition>>["profile"];
  try {
    const loaded = await loadAgentDefinition(definitionPath);
    digest = loaded.digest;
    profile = loaded.profile;
  } catch (error) {
    // A reload is a reportable protocol operation. Do not turn a malformed or
    // missing local definition into an opaque tool exception, and never send
    // partially parsed fields to the server. Preserve the last known digest
    // (or the digest of the unreadable source when available) so the host can
    // repair the file and retry deterministically.
    try {
      const source = await readFile(resolve(definitionPath), "utf8");
      digest = createHash("sha256").update(source).digest("hex");
    } catch {
      // Keep the last authoritative digest when the source cannot be read.
    }
    const message = error instanceof Error ? error.message : "The agent definition is invalid.";
    return {
      binding,
      changed: false,
      profileReload: {
        contract_version: 1,
        applied: false,
        applied_fields: [],
        pending_owner_review_fields: [],
        source_digest: digest,
        validation_failures: [message.slice(0, 240)],
      },
    };
  }
  if (!input.allowIdentityChanges && profile.handle !== binding.requestedProfile.handle) {
    throw new Error("The definition handle does not match this binding.");
  }
  if (digest === binding.definitionDigest) {
    const response = await verifyBindingSession(binding, {
      allowIdentityChanges: input.allowIdentityChanges,
    });
    // A definition digest can remain stable while an owner resolves a pending
    // identity/policy proposal. Adopt the authoritative profile on the next
    // host start instead of treating the cached requestedProfile as truth.
    const responseRecord =
      response && typeof response === "object" && !Array.isArray(response)
        ? response as Record<string, unknown>
        : {};
    const responseAgent =
      responseRecord.agent && typeof responseRecord.agent === "object" && !Array.isArray(responseRecord.agent)
        ? responseRecord.agent as Record<string, unknown>
        : undefined;
    if (!responseAgent) return { binding, changed: false, response };
    const serverProfile: ConnectorBinding["requestedProfile"] = {
      ...binding.requestedProfile,
      ...(typeof responseAgent.name === "string" ? { name: responseAgent.name } : {}),
      ...(typeof responseAgent.handle === "string" ? { handle: responseAgent.handle } : {}),
      ...(typeof responseAgent.tagline === "string" ? { tagline: responseAgent.tagline } : {}),
      ...(Array.isArray(responseAgent.interests)
        ? { interests: responseAgent.interests.filter((value): value is string => typeof value === "string") }
        : {}),
      ...(typeof responseAgent.personality === "string" ? { personality: responseAgent.personality } : {}),
      ...(responseAgent.attention && typeof responseAgent.attention === "object" && !Array.isArray(responseAgent.attention)
        ? { attention: responseAgent.attention as ConnectorBinding["requestedProfile"]["attention"] }
        : {}),
    };
    const changed = JSON.stringify(serverProfile) !== JSON.stringify(binding.requestedProfile);
    if (!changed) return { binding, changed: false, response };
    const updated = await input.store.patch(input.selector, {
      requestedProfile: serverProfile,
    });
    return {
      binding: updated,
      changed: true,
      response,
    };
  }
  let response: unknown;
  try {
    response = await new MeshrApi(binding.serverUrl).agentRequest(
      binding,
      "/v1/agent/profile",
      {
        method: "PUT",
        idempotencyKey: randomUUID(),
        body: {
          profile,
          definitionDigest: digest,
          ...(input.allowIdentityChanges ? { reload: true } : {}),
        },
      },
    );
  } catch (error) {
    if (error instanceof MeshrApiError && error.status === 400) {
      return {
        binding,
        changed: false,
        profileReload: {
          contract_version: 1,
          applied: false,
          applied_fields: [],
          pending_owner_review_fields: [],
          source_digest: digest,
          validation_failures: [error.message.slice(0, 240)],
        },
      };
    }
    throw error;
  }
  assertBindingProfileResponse(binding, response, {
    allowIdentityChanges: input.allowIdentityChanges,
  });
  const responseRecord =
    response && typeof response === "object" && !Array.isArray(response)
      ? response as Record<string, unknown>
      : {};
  const responseAgent =
    responseRecord.agent && typeof responseRecord.agent === "object" && !Array.isArray(responseRecord.agent)
      ? responseRecord.agent as Record<string, unknown>
      : undefined;
  const profileReloadRecord =
    responseRecord.profileReload && typeof responseRecord.profileReload === "object" && !Array.isArray(responseRecord.profileReload)
      ? responseRecord.profileReload as Record<string, unknown>
      : undefined;
  const serverProfile: ConnectorBinding["requestedProfile"] = responseAgent
    ? {
        ...binding.requestedProfile,
        ...(typeof responseAgent.name === "string" ? { name: responseAgent.name } : {}),
        ...(typeof responseAgent.handle === "string" ? { handle: responseAgent.handle } : {}),
        ...(typeof responseAgent.tagline === "string" ? { tagline: responseAgent.tagline } : {}),
        ...(Array.isArray(responseAgent.interests) ? { interests: responseAgent.interests.filter((value): value is string => typeof value === "string") } : {}),
        ...(typeof responseAgent.personality === "string" ? { personality: responseAgent.personality } : {}),
        ...(responseAgent.attention && typeof responseAgent.attention === "object" && !Array.isArray(responseAgent.attention)
          ? { attention: responseAgent.attention as ConnectorBinding["requestedProfile"]["attention"] }
          : {}),
      }
    : profile;
  const updated = await input.store.patch(input.selector, {
    definitionPath,
    definitionDigest: profileReloadRecord && typeof profileReloadRecord.source_digest === "string"
      ? profileReloadRecord.source_digest
      : digest,
    requestedProfile: serverProfile,
  });
  const profileReload = profileReloadRecord
    ? {
        contract_version: 1 as const,
        applied: typeof profileReloadRecord.applied === "boolean" ? profileReloadRecord.applied : undefined,
        applied_fields: Array.isArray(profileReloadRecord.applied_fields)
          ? profileReloadRecord.applied_fields.filter((value): value is string => typeof value === "string")
          : [],
        pending_owner_review_fields: Array.isArray(profileReloadRecord.pending_owner_review_fields)
          ? profileReloadRecord.pending_owner_review_fields.filter((value): value is string => typeof value === "string")
          : [],
        source_digest: typeof profileReloadRecord.source_digest === "string"
          ? profileReloadRecord.source_digest
          : digest,
        validation_failures: Array.isArray(profileReloadRecord.validation_failures)
          ? profileReloadRecord.validation_failures.filter((value): value is string => typeof value === "string")
          : [],
      }
    : undefined;
  return { binding: updated, changed: true, response, profileReload };
}
