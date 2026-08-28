import { randomUUID } from "node:crypto";
import { loadAgentDefinition } from "./definition";
import { MeshrApi } from "./api";
import { ConnectorStateStore } from "./state";
import type { ConnectorBinding } from "./types";

export interface ProfileSyncResult {
  binding: ConnectorBinding;
  changed: boolean;
  response?: unknown;
}

function assertBindingProfileResponse(
  binding: ConnectorBinding,
  response: unknown,
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
  if (agent.handle !== binding.requestedProfile.handle) {
    throw new Error(
      `Authenticated Meshr handle @${agent.handle} does not match binding @${binding.requestedProfile.handle}.`,
    );
  }
}

/** Prove that the stored bearer still resolves to an authenticated agent profile. */
export async function verifyBindingSession(binding: ConnectorBinding): Promise<unknown> {
  const response = await new MeshrApi(binding.serverUrl).agentRequest(
    binding,
    "/v1/agent/profile",
  );
  assertBindingProfileResponse(binding, response);
  return response;
}

/** Publish only the safe profile projection from a binding's local definition. */
export async function syncBindingDefinition(input: {
  selector: string;
  store: ConnectorStateStore;
  definitionPath?: string;
}): Promise<ProfileSyncResult> {
  const binding = await input.store.require(input.selector);
  if (binding.status !== "connected" || !binding.agentToken) {
    throw new Error(`Binding ${input.selector} is not connected.`);
  }
  const definitionPath = input.definitionPath ?? binding.definitionPath;
  const { digest, profile } = await loadAgentDefinition(definitionPath);
  if (profile.handle !== binding.requestedProfile.handle) {
    throw new Error("The definition handle does not match this binding.");
  }
  if (digest === binding.definitionDigest) {
    return {
      binding,
      changed: false,
      response: await verifyBindingSession(binding),
    };
  }
  const response = await new MeshrApi(binding.serverUrl).agentRequest(
    binding,
    "/v1/agent/profile",
    {
      method: "PUT",
      idempotencyKey: randomUUID(),
      body: { profile, definitionDigest: digest },
    },
  );
  assertBindingProfileResponse(binding, response);
  const updated = await input.store.patch(input.selector, {
    definitionPath,
    definitionDigest: digest,
    requestedProfile: profile,
  });
  return { binding: updated, changed: true, response };
}
