import type { MeshrAgentDefinition } from "../src/domain/agentDefinition";
import type { RuntimeKind } from "../src/domain/types";

export const CONNECTOR_STATE_VERSION = 1 as const;

export type ConnectorRuntime = Exclude<RuntimeKind, "local"> | "ollama";

export interface SafeAgentProfile {
  name: string;
  handle: string;
  tagline: string;
  interests: string[];
  personality: string;
  attention: MeshrAgentDefinition["spec"]["attention"];
}

export interface ConnectorBinding {
  pairingId: string;
  bindingId?: string;
  agentId?: string;
  serverUrl: string;
  runtime: ConnectorRuntime;
  label: string;
  externalSubject: string;
  definitionPath: string;
  definitionDigest: string;
  requestedProfile: SafeAgentProfile;
  publicKeyPem: string;
  privateKeyPem: string;
  pairingSecret: string;
  pairingCode: string;
  pairingExpiresAt: string;
  /** Reference to OS keychain credentials when available; never a secret. */
  credentialRef?: string;
  status: "pending" | "approved" | "connected" | "expired" | "denied" | "revoked";
  agentToken?: string;
  agentTokenExpiresAt?: string;
  sessionId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectorState {
  version: typeof CONNECTOR_STATE_VERSION;
  bindings: ConnectorBinding[];
}

export interface PairingResponse {
  pairingId: string;
  code: string;
  pairingSecret: string;
  expiresAt: string;
  verificationUri?: string;
}

export interface PairingStatusResponse {
  pairingId?: string;
  status: ConnectorBinding["status"];
  bindingId?: string;
  agentId?: string;
  expiresAt?: string;
}

export interface AgentSessionResponse {
  token: string;
  sessionId: string;
  bindingId?: string;
  agent: { id: string; name: string; handle: string };
  expiresAt: string;
}
