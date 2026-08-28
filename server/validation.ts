import type { AgentProfileInput, RuntimeKind, SocialProvider } from "./types.ts";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

export function asObject(value: unknown, name = "request body"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "invalid_request", `${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

export function requiredString(
  object: Record<string, unknown>,
  key: string,
  options: { min?: number; max: number; pattern?: RegExp } = { max: 1_000 },
): string {
  const value = object[key];
  if (typeof value !== "string") {
    throw new ApiError(400, "invalid_request", `${key} must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length < (options.min ?? 1) || trimmed.length > options.max) {
    throw new ApiError(
      400,
      "invalid_request",
      `${key} must be between ${options.min ?? 1} and ${options.max} characters.`,
    );
  }
  if (options.pattern && !options.pattern.test(trimmed)) {
    throw new ApiError(400, "invalid_request", `${key} has an invalid format.`);
  }
  return trimmed;
}

export function optionalString(
  object: Record<string, unknown>,
  key: string,
  max: number,
): string | undefined {
  if (object[key] === undefined) return undefined;
  if (typeof object[key] !== "string") {
    throw new ApiError(400, "invalid_request", `${key} must be a string.`);
  }
  const value = object[key].trim();
  if (value.length > max) {
    throw new ApiError(400, "invalid_request", `${key} is too long.`);
  }
  return value;
}

const runtimeKinds = new Set<RuntimeKind>([
  "codex",
  "claude",
  "openclaw",
  "ollama",
  "local",
  "other",
]);

export function parseRuntime(value: unknown): RuntimeKind {
  if (typeof value !== "string" || !runtimeKinds.has(value as RuntimeKind)) {
    throw new ApiError(400, "invalid_request", "runtime is not supported.");
  }
  return value as RuntimeKind;
}

export function parseSocialProvider(value: unknown): SocialProvider {
  if (value !== "google" && value !== "github") {
    throw new ApiError(400, "invalid_provider", "provider must be google or github.");
  }
  return value;
}

export function parseAgentProfile(
  value: unknown,
  options: { partial?: boolean } = {},
): Partial<AgentProfileInput> & Pick<AgentProfileInput, never> {
  const input = asObject(value, "profile");
  const allowed = new Set([
    "name",
    "handle",
    "tagline",
    "interests",
    "personality",
    "attention",
  ]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      throw new ApiError(400, "invalid_profile", `profile.${key} is not allowed.`);
    }
  }

  const result: Partial<AgentProfileInput> = {};
  if (!options.partial || input.name !== undefined) {
    result.name = requiredString(input, "name", { min: 1, max: 80 });
  }
  if (!options.partial || input.handle !== undefined) {
    result.handle = requiredString(input, "handle", {
      min: 2,
      max: 32,
      pattern: /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/i,
    }).toLowerCase();
  }
  if (input.tagline !== undefined) {
    result.tagline = optionalString(input, "tagline", 180);
  }
  if (input.personality !== undefined) {
    result.personality = optionalString(input, "personality", 2_000);
  }
  if (input.interests !== undefined) {
    if (!Array.isArray(input.interests) || input.interests.length > 32) {
      throw new ApiError(
        400,
        "invalid_profile",
        "profile.interests must be an array with at most 32 entries.",
      );
    }
    result.interests = input.interests.map((entry) => {
      if (typeof entry !== "string" || entry.trim().length < 1 || entry.trim().length > 80) {
        throw new ApiError(
          400,
          "invalid_profile",
          "Each profile interest must be between 1 and 80 characters.",
        );
      }
      return entry.trim();
    });
  }
  if (input.attention !== undefined) {
    const attention = asObject(input.attention, "profile.attention");
    const allowedAttention = new Set(["browse", "rootPosts", "replies", "notes"]);
    for (const key of Object.keys(attention)) {
      if (!allowedAttention.has(key)) {
        throw new ApiError(
          400,
          "invalid_profile",
          `profile.attention.${key} is not allowed.`,
        );
      }
    }
    const parsed: NonNullable<AgentProfileInput["attention"]> = {};
    if (attention.browse !== undefined) {
      if (!new Set(["public", "joined", "mentions"]).has(String(attention.browse))) {
        throw new ApiError(400, "invalid_profile", "profile.attention.browse is invalid.");
      }
      parsed.browse = attention.browse as "public" | "joined" | "mentions";
    }
    for (const key of ["rootPosts", "replies"] as const) {
      if (attention[key] !== undefined) {
        if (!new Set(["never", "draft", "autonomous"]).has(String(attention[key]))) {
          throw new ApiError(400, "invalid_profile", `profile.attention.${key} is invalid.`);
        }
        parsed[key] = attention[key] as "never" | "draft" | "autonomous";
      }
    }
    if (attention.notes !== undefined) {
      parsed.notes = optionalString(attention, "notes", 2_000);
    }
    result.attention = parsed;
  }
  return result;
}

export function parsePositiveInteger(
  raw: string | null,
  fallback: number,
  maximum: number,
  minimum = 0,
): number {
  if (raw === null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ApiError(400, "invalid_request", "Pagination parameter is invalid.");
  }
  return value;
}
