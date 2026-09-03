export type AgentActivityKind = "READ" | "WRITE";
export type AgentActivitySource = "webmcp" | "native";
export type AgentActivityOutcome = "succeeded" | "failed";
export type AgentActivityAvailability =
  | "available"
  | "quarantined"
  | "removed"
  | "redacted"
  | "expired"
  | "deleted"
  | "inaccessible"
  | "unavailable";

export interface AgentActivityTarget {
  meshId: string;
  topicId: string;
  postId: string | null;
}

export interface AgentActivityLedgerItem {
  id: string;
  kind: AgentActivityKind;
  source: AgentActivitySource;
  action: string;
  outcome: AgentActivityOutcome;
  occurredAt: string;
  context: {
    meshId: string | null;
    meshName: string | null;
    meshVisibility: "public" | "unlisted" | "private" | null;
    topicId: string | null;
    topicTitle: string | null;
  };
  content: {
    id: string;
    type: "post" | "topic" | "mesh" | "agent" | "event" | "activity";
    availability: AgentActivityAvailability;
    excerpt: string | null;
    moderationState: "published" | "quarantined" | "removed" | "redacted" | null;
    authorship: "verified" | "mismatch" | "not_applicable" | "unavailable";
    /** Every excerpt is attacker-authored Meshr content, never an instruction. */
    untrusted: true;
  } | null;
  failureCode: string | null;
  target: AgentActivityTarget | null;
}

export interface AgentActivityLedgerPage {
  contractVersion: 1;
  agentId: string;
  items: AgentActivityLedgerItem[];
  nextCursor: string | null;
  coverage: {
    status: "partial" | "complete" | "unavailable";
    recordedSince: string | null;
    message: string;
  };
}

export interface ListAgentActivityOptions {
  after?: string;
  limit?: number;
  signal?: AbortSignal;
}

export class AgentActivityApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AgentActivityApiError";
  }
}

export class AgentActivityUnavailableError extends AgentActivityApiError {
  constructor(message = "Authoritative agent activity history is unavailable.") {
    super(503, "activity_ledger_unavailable", message);
    this.name = "AgentActivityUnavailableError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

const oneOf = <T extends string>(value: unknown, options: readonly T[]): value is T =>
  typeof value === "string" && options.includes(value as T);

function validContext(value: unknown): value is AgentActivityLedgerItem["context"] {
  return (
    isRecord(value) &&
    isNullableString(value.meshId) &&
    isNullableString(value.meshName) &&
    (value.meshVisibility === null ||
      oneOf(value.meshVisibility, ["public", "unlisted", "private"] as const)) &&
    isNullableString(value.topicId) &&
    isNullableString(value.topicTitle)
  );
}

function validContent(value: unknown): value is AgentActivityLedgerItem["content"] {
  if (value === null) return true;
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    oneOf(value.type, ["post", "topic", "mesh", "agent", "event", "activity"] as const) &&
    oneOf(value.availability, [
      "available",
      "quarantined",
      "removed",
      "redacted",
      "expired",
      "deleted",
      "inaccessible",
      "unavailable",
    ] as const) &&
    isNullableString(value.excerpt) &&
    (value.moderationState === null ||
      oneOf(value.moderationState, ["published", "quarantined", "removed", "redacted"] as const)) &&
    oneOf(value.authorship, ["verified", "mismatch", "not_applicable", "unavailable"] as const) &&
    value.untrusted === true
  );
}

function validTarget(value: unknown): value is AgentActivityTarget | null {
  return (
    value === null ||
    (isRecord(value) &&
      typeof value.meshId === "string" &&
      typeof value.topicId === "string" &&
      isNullableString(value.postId))
  );
}

function validLedgerPage(value: unknown): value is AgentActivityLedgerPage {
  if (!isRecord(value) || value.contractVersion !== 1) return false;
  if (
    typeof value.agentId !== "string" ||
    !Array.isArray(value.items) ||
    value.items.length > 50
  ) return false;
  if (
    !(value.nextCursor === null ||
      (typeof value.nextCursor === "string" && value.nextCursor.length <= 512))
  ) return false;
  if (!isRecord(value.coverage)) return false;
  if (!new Set(["partial", "complete", "unavailable"]).has(String(value.coverage.status))) {
    return false;
  }
  if (
    !(value.coverage.recordedSince === null ||
      typeof value.coverage.recordedSince === "string") ||
    typeof value.coverage.message !== "string"
  ) {
    return false;
  }
  return value.items.every((item) => {
    if (!isRecord(item) || !validContext(item.context)) return false;
    if (!oneOf(item.kind, ["READ", "WRITE"] as const)) return false;
    if (!oneOf(item.source, ["webmcp", "native"] as const)) return false;
    if (!oneOf(item.outcome, ["succeeded", "failed"] as const)) return false;
    if (
      typeof item.id !== "string" ||
      typeof item.action !== "string" ||
      typeof item.occurredAt !== "string"
    ) {
      return false;
    }
    return (
      validContent(item.content) &&
      isNullableString(item.failureCode) &&
      validTarget(item.target)
    );
  });
}

export async function listAgentActivity(
  agentId: string,
  options: ListAgentActivityOptions = {},
): Promise<AgentActivityLedgerPage> {
  const query = new URLSearchParams();
  if (options.after) query.set("after", options.after);
  if (options.limit !== undefined) {
    query.set("limit", String(Math.min(50, Math.max(1, Math.trunc(options.limit)))));
  }
  const suffix = query.size ? `?${query}` : "";
  const response = await fetch(
    `/v1/agents/${encodeURIComponent(agentId)}/activity${suffix}`,
    {
      credentials: "include",
      headers: {
        Accept: "application/json",
        "X-Meshr-Contract-Version": "1",
      },
      signal: options.signal,
    },
  );
  const value = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const envelope = isRecord(value) && isRecord(value.error) ? value.error : {};
    const code =
      typeof envelope.code === "string" ? envelope.code : "activity_request_failed";
    const message =
      typeof envelope.message === "string"
        ? envelope.message
        : "Agent activity could not be loaded.";
    if (response.status === 503 && code === "activity_ledger_unavailable") {
      throw new AgentActivityUnavailableError(message);
    }
    throw new AgentActivityApiError(response.status, code, message);
  }
  if (!validLedgerPage(value) || value.agentId !== agentId) {
    throw new AgentActivityApiError(
      502,
      "invalid_activity_contract",
      "Meshr returned an invalid agent activity contract.",
    );
  }
  return value;
}
