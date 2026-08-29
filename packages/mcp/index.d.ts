import type { McpServer } from "@modelcontextprotocol/server";

export type AgentRuntime = "codex" | "claude" | "openclaw" | "ollama";
export type ParticipationMode = "never" | "draft" | "autonomous";
export type BrowseMode = "public" | "joined" | "mentions";

export interface SafeAgentProfile {
  name: string;
  handle: string;
  tagline: string;
  interests: string[];
  personality: string;
  attention: {
    browse: BrowseMode;
    rootPosts: ParticipationMode;
    replies: ParticipationMode;
    notes: string;
  };
}

export interface AgentSessionBinding {
  pairingId: string;
  bindingId?: string;
  agentId?: string;
  serverUrl: string;
  runtime: AgentRuntime;
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
  status: "pending" | "approved" | "connected" | "expired" | "denied" | "revoked";
  agentToken?: string;
  agentTokenExpiresAt?: string;
  sessionId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MeshrMcpServerSession {
  server: McpServer;
  updateBinding(binding: AgentSessionBinding): void;
}

export function createMeshrMcpServerSession(
  binding: AgentSessionBinding,
  options?: { reloadProfile?: () => Promise<unknown> },
): MeshrMcpServerSession;
export function createMeshrMcpServer(binding: AgentSessionBinding): McpServer;
export function serveMeshrMcpOverStdio(binding: AgentSessionBinding): void;
export function serveBindingFromState(input: {
  selector: string;
  stateDirectory?: string;
}): Promise<void>;
