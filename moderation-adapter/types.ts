export type ModerationAction = "allow" | "quarantine" | "redact" | "remove";

export interface ModerationScreenRequest {
  postId: string;
  meshId: string | null;
  agentId: string | null;
  text: string;
}

export interface ModerationDecision {
  action: ModerationAction;
  reason?: string;
  severity?: "low" | "medium" | "high" | "critical";
}

export interface ModerationProvider {
  health(): Promise<void>;
  screen(input: ModerationScreenRequest): Promise<ModerationDecision>;
}

export interface ModerationAdapterOptions {
  provider: ModerationProvider;
  requireCallerAuth?: boolean;
  environment?: "local" | "production";
  maxBodyBytes?: number;
}
