import {
  generateKeyPairSync,
  sign,
} from "node:crypto";
import { resolve } from "node:path";
import { loadAgentDefinition } from "./definition";
import { MeshrApi } from "./api";
import { ConnectorStateStore } from "./state";
import type { ConnectorBinding, ConnectorRuntime } from "./types";

export async function beginPairing(input: {
  runtime: ConnectorRuntime;
  label: string;
  externalSubject: string;
  definitionPath: string;
  serverUrl: string;
  store: ConnectorStateStore;
}): Promise<{
  binding: ConnectorBinding;
  verificationUri?: string;
}> {
  const { digest, profile } = await loadAgentDefinition(input.definitionPath);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const api = new MeshrApi(input.serverUrl);
  const pairing = await api.createPairing({
    runtime: input.runtime,
    label: input.label,
    externalSubject: input.externalSubject,
    publicKey: publicKeyPem,
    profile,
    definitionDigest: digest,
  });
  const now = new Date().toISOString();
  const binding: ConnectorBinding = {
    pairingId: pairing.pairingId,
    serverUrl: api.serverUrl,
    runtime: input.runtime,
    label: input.label,
    externalSubject: input.externalSubject,
    definitionPath: resolve(input.definitionPath),
    definitionDigest: digest,
    requestedProfile: profile,
    publicKeyPem,
    privateKeyPem,
    pairingSecret: pairing.pairingSecret,
    pairingCode: pairing.code,
    pairingExpiresAt: pairing.expiresAt,
    verificationUri: pairing.verificationUri,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };
  await input.store.upsert(binding);
  return {
    binding,
    verificationUri: pairing.verificationUri,
  };
}

export async function refreshPairing(
  selector: string,
  store: ConnectorStateStore,
): Promise<ConnectorBinding> {
  const binding = await store.require(selector);
  const status = await new MeshrApi(binding.serverUrl).pairingStatus(binding);
  return store.patch(selector, {
    status: status.status,
    bindingId: status.bindingId ?? binding.bindingId,
    agentId: status.agentId ?? binding.agentId,
  });
}

export async function claimPairing(
  selector: string,
  store: ConnectorStateStore,
): Promise<ConnectorBinding> {
  let binding = await refreshPairing(selector, store);
  if (binding.status !== "approved" && binding.status !== "connected") {
    throw new Error(`Pairing ${binding.pairingCode} is ${binding.status}.`);
  }
  const api = new MeshrApi(binding.serverUrl);
  const challenge = await api.createChallenge(binding);
  const signature = sign(
    null,
    Buffer.from(challenge.message, "utf8"),
    binding.privateKeyPem,
  ).toString("base64url");
  const session = await api.createAgentSession({
    binding,
    challengeId: challenge.challengeId,
    signature,
  });
  binding = await store.patch(selector, {
    status: "connected",
    bindingId: session.bindingId ?? binding.bindingId,
    agentId: session.agent.id,
    agentToken: session.token,
    agentTokenExpiresAt: session.expiresAt,
    sessionId: session.sessionId,
  });
  return binding;
}
