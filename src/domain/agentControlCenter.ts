import type { Agent, Mesh, Post, RuntimeBinding, Topic } from "./types";

/** URL state for the durable portfolio detail surface. */
export type AgentDetailRoute =
  | { kind: "agents" }
  | { kind: "agent"; agentId: string };

export type AgentControlWebMcpStatus =
  | "disabled"
  | "registering"
  | "ready"
  | "unsupported"
  | "error";

export interface AgentControlWebMcpSession {
  enabled: boolean;
  agentId: string | null;
  expiresAt: string | null;
  status: AgentControlWebMcpStatus;
}

export interface AgentControlTrafficLink {
  id: string;
  meshId: string;
  sourceAgentId: string;
  targetAgentId: string;
  eventCount: number;
  recentEventCount?: number;
  lastEventAt?: string;
}

export interface AgentControlCenterInput {
  agent: Agent;
  runtime: RuntimeBinding | undefined;
  webMcp: AgentControlWebMcpSession;
  meshes: Mesh[];
  topics: Topic[];
  posts: Post[];
  links: AgentControlTrafficLink[];
}

export type AgentLifecycleState =
  | "needs_setup"
  | "page_active"
  | "page_attention"
  | "runtime_connected"
  | "runtime_sleeping"
  | "runtime_offline"
  | "identity_ready";

export interface AgentLifecycle {
  state: AgentLifecycleState;
  label: string;
  detail: string;
  primaryAction: "enable_webmcp" | "disable_webmcp" | "open_setup" | null;
  primaryActionLabel: string | null;
}

export interface AgentControlCenterModel {
  lifecycle: AgentLifecycle;
  pageControlActive: boolean;
  memberships: Mesh[];
  participatedTopics: Topic[];
  observedPosts: Post[];
  links: AgentControlTrafficLink[];
}

export function readAgentDetailRoute(search: string): AgentDetailRoute {
  const agentId = new URLSearchParams(search).get("agent")?.trim();
  return agentId ? { kind: "agent", agentId } : { kind: "agents" };
}

export function agentDetailSearch(agentId: string, search = ""): string {
  const params = new URLSearchParams(search);
  params.set("agent", agentId);
  return `?${params.toString()}`;
}

export function agentPortfolioSearch(search = ""): string {
  const params = new URLSearchParams(search);
  params.delete("agent");
  const next = params.toString();
  return next ? `?${next}` : "";
}

function lifecycleFor(
  runtime: RuntimeBinding | undefined,
  pageControlActive: boolean,
  webMcp: AgentControlWebMcpSession,
): AgentLifecycle {
  if (pageControlActive) {
    if (webMcp.status === "ready") {
      return {
        state: "page_active",
        label: "Page control active",
        detail: "This page currently holds the WebMCP session for this identity.",
        primaryAction: "disable_webmcp",
        primaryActionLabel: "Disable page control",
      };
    }
    return {
      state: "page_attention",
      label: "Page session needs attention",
      detail:
        webMcp.status === "unsupported"
          ? "The session is active, but this browser cannot register page tools."
          : webMcp.status === "error"
            ? "The session is active, but page-tool registration needs attention."
            : "The page session is active and tools are still being prepared.",
      primaryAction: "disable_webmcp",
      primaryActionLabel: "Disable page control",
    };
  }
  if (runtime?.status === "connected") {
    return {
      state: "runtime_connected",
      label: "Native runtime connected",
      detail: `${runtime.label} is the observed controller for this identity.`,
      primaryAction: null,
      primaryActionLabel: null,
    };
  }
  if (runtime?.status === "sleeping") {
    return {
      state: "runtime_sleeping",
      label: "Native runtime sleeping",
      detail: `${runtime.label} is attached but is not currently connected.`,
      primaryAction: "open_setup",
      primaryActionLabel: "Continue runtime setup",
    };
  }
  if (runtime?.status === "offline") {
    return {
      state: "runtime_offline",
      label: "Native runtime offline",
      detail: `${runtime.label} is attached but Meshr has no current connection.`,
      primaryAction: "open_setup",
      primaryActionLabel: "Continue runtime setup",
    };
  }
  return {
    state: "needs_setup",
    label: "Ready for a controller",
    detail: "The identity exists in Meshr; attach a native runtime or grant this page temporary control.",
    primaryAction: "enable_webmcp",
    primaryActionLabel: "Enable page control",
  };
}

/**
 * Derives a single controller lifecycle and relationships from the projections
 * the browser actually receives. It deliberately does not infer model health,
 * token usage, or per-agent authored counts from topic-wide activity.
 */
export function deriveAgentControlCenter(
  input: AgentControlCenterInput,
): AgentControlCenterModel {
  const pageControlActive = input.webMcp.enabled && input.webMcp.agentId === input.agent.id;
  const memberships = input.meshes.filter((mesh) => mesh.memberAgentIds.includes(input.agent.id));
  const participatedTopics = input.topics.filter((topic) =>
    topic.participantAgentIds.includes(input.agent.id),
  );
  const observedPosts = input.posts.filter((post) => post.agentId === input.agent.id);
  const links = input.links.filter(
    (link) => link.sourceAgentId === input.agent.id || link.targetAgentId === input.agent.id,
  );
  return {
    lifecycle: lifecycleFor(input.runtime, pageControlActive, input.webMcp),
    pageControlActive,
    memberships,
    participatedTopics,
    observedPosts,
    links,
  };
}
