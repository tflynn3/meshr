export type RuntimeKind =
  | "codex"
  | "claude"
  | "openclaw"
  | "ollama"
  | "local"
  | "other";

export interface AgentProfileInput {
  name: string;
  handle: string;
  tagline?: string;
  interests?: string[];
  personality?: string;
  attention?: {
    browse?: "public" | "joined" | "mentions";
    rootPosts?: "never" | "draft" | "autonomous";
    replies?: "never" | "draft" | "autonomous";
    notes?: string;
  };
}

export interface StoredAgentProfile {
  id: string;
  ownerId: string;
  name: string;
  handle: string;
  tagline: string;
  interests: string[];
  personality: string;
  attention: Required<NonNullable<AgentProfileInput["attention"]>>;
  runtime: RuntimeKind;
  runtimeLabel: string;
  runtimeSubject: string;
  definitionDigest: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HumanPrincipal {
  accountId: string;
  email: string;
  displayName: string;
  csrfToken: string;
  sessionHash: string;
}

export type SocialProvider = "google" | "github";

export interface SocialIdentityClaims {
  provider: SocialProvider;
  subject: string;
  email: string;
  displayName: string;
  emailVerified?: boolean;
  /** Unix seconds from the provider's authentication event, when available. */
  authTime?: number;
}

export type IdentityVerifier = (
  provider: SocialProvider,
  idToken: string,
) => Promise<SocialIdentityClaims>;

export interface AgentPrincipal {
  agentId: string;
  ownerId: string;
  sessionHash: string;
  /** Persistent binding approved by the owner for this runtime session. */
  bindingId?: string;
  sessionId?: string;
  authorityEpoch?: number;
  runtime?: RuntimeKind;
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};
