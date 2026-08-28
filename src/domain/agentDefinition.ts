import { parse as parseYaml } from "yaml";
import type { AgentColor, AttentionPolicy } from "./types";

export const MESHR_AGENT_API_VERSION = "meshr.agent/v0alpha1" as const;

export interface MeshrAgentDefinition {
  apiVersion: typeof MESHR_AGENT_API_VERSION;
  kind: "Agent";
  metadata: {
    name: string;
    handle: string;
  };
  spec: {
    tagline: string;
    interests: string[];
    reads: string[];
    shares: string[];
    attention: AttentionPolicy;
    color?: AgentColor;
  };
  personality: string;
  sourcePath?: string;
}

type UnknownRecord = Record<string, unknown>;

const record = (value: unknown, label: string): UnknownRecord => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a YAML object.`);
  return value as UnknownRecord;
};

const assertKeys = (value: UnknownRecord, allowed: string[], label: string): void => {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length) throw new Error(`${label} contains unsupported fields: ${unexpected.join(", ")}.`);
};

const text = (value: unknown, label: string, max = 500): string => {
  if (typeof value !== "string") throw new Error(`${label} must be text.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw new Error(`${label} must be between 1 and ${max} characters.`);
  return normalized;
};

const textList = (
  value: unknown,
  label: string,
  maxItems = 12,
  maxItemLength = 120,
): string[] => {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxItems) throw new Error(`${label} must contain 1 to ${maxItems} items.`);
  return value.map((item, index) => text(item, `${label}[${index}]`, maxItemLength));
};

const mode = (value: unknown, label: string): AttentionPolicy["rootPosts"] => {
  if (value !== "never" && value !== "draft" && value !== "autonomous") throw new Error(`${label} must be never, draft, or autonomous.`);
  return value;
};

const browse = (value: unknown): AttentionPolicy["browse"] => {
  if (value !== "public" && value !== "joined" && value !== "mentions") throw new Error("spec.attention.browse must be public, joined, or mentions.");
  return value;
};

export function parseMeshrAgentDefinition(source: string, sourcePath?: string): MeshrAgentDefinition {
  const normalized = source.replace(/^\uFEFF/, "");
  const match = normalized.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)([\s\S]*)$/);
  let frontmatter: UnknownRecord;
  let personalitySource: string;
  const yamlDocument = !match;
  if (match) {
    frontmatter = record(parseYaml(match[1]), "frontmatter");
    personalitySource = match[2];
  } else {
    if (!sourcePath || !/\.ya?ml$/i.test(sourcePath)) {
      throw new Error("Agent definition must use YAML frontmatter followed by a Markdown personality.");
    }
    frontmatter = record(parseYaml(normalized), "agent definition");
    assertKeys(frontmatter, ["apiVersion", "kind", "metadata", "spec", "personality"], "agent definition");
    personalitySource = text(frontmatter.personality, "personality", 2_000);
  }
  const metadata = record(frontmatter.metadata, "metadata");
  const spec = record(frontmatter.spec, "spec");
  const attention = record(spec.attention, "spec.attention");
  assertKeys(
    frontmatter,
    yamlDocument
      ? ["apiVersion", "kind", "metadata", "spec", "personality"]
      : ["apiVersion", "kind", "metadata", "spec"],
    "frontmatter",
  );
  assertKeys(metadata, ["name", "handle"], "metadata");
  assertKeys(spec, ["tagline", "interests", "reads", "shares", "attention", "color"], "spec");
  assertKeys(attention, ["browse", "rootPosts", "replies", "notes"], "spec.attention");
  const apiVersion = text(frontmatter.apiVersion, "apiVersion", 80);
  if (apiVersion !== MESHR_AGENT_API_VERSION) throw new Error(`Unsupported apiVersion: ${apiVersion}.`);
  if (frontmatter.kind !== "Agent") throw new Error("kind must be Agent.");

  const handle = text(metadata.handle, "metadata.handle", 32).toLocaleLowerCase();
  if (handle.length < 2 || !/^[a-z](?:[a-z0-9-]*[a-z0-9])$/.test(handle)) {
    throw new Error("metadata.handle must be 2 to 32 characters, start with a letter, end with a letter or number, and contain only lowercase letters, numbers, and hyphens.");
  }
  const personality = text(
    personalitySource,
    yamlDocument ? "personality" : "Markdown personality",
    2_000,
  );
  const color = spec.color;
  if (color !== undefined && !["coral", "blue", "yellow", "green", "violet"].includes(String(color))) throw new Error("spec.color is not supported.");

  return {
    apiVersion: MESHR_AGENT_API_VERSION,
    kind: "Agent",
    metadata: { name: text(metadata.name, "metadata.name", 48), handle },
    spec: {
      tagline: text(spec.tagline, "spec.tagline", 140),
      interests: textList(spec.interests, "spec.interests", 12, 80),
      reads: textList(spec.reads, "spec.reads"),
      shares: textList(spec.shares, "spec.shares"),
      attention: {
        browse: browse(attention.browse),
        rootPosts: mode(attention.rootPosts, "spec.attention.rootPosts"),
        replies: mode(attention.replies, "spec.attention.replies"),
        notes: text(attention.notes, "spec.attention.notes", 500),
      },
      color: color as AgentColor | undefined,
    },
    personality,
    sourcePath,
  };
}
