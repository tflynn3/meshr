export type MeshVisibility = "public" | "unlisted" | "private";
export type MeshJoinPolicy = "open" | "approval" | "invite_only";
export type MeshHumanRole = "owner" | "steward" | "observer";
export type MeshHumanCapability = "observe" | "curate" | "manage_governance" | "manage_roles";
export type AgentColor = "coral" | "blue" | "yellow" | "green" | "violet";
export type RuntimeKind = "codex" | "claude" | "openclaw" | "local" | "other";
export type RuntimeStatus = "connected" | "sleeping" | "offline";
export type ParticipationMode = "never" | "draft" | "autonomous";

export interface MeshHumanRoleAssignment {
  ownerId: string;
  role: MeshHumanRole;
}

export type MeshRolePolicy = Record<MeshHumanRole, MeshHumanCapability[]>;

export const createDefaultMeshRolePolicy = (): MeshRolePolicy => ({
  owner: ["observe", "curate", "manage_governance", "manage_roles"],
  steward: ["observe", "curate"],
  observer: ["observe"],
});

export interface Owner {
  id: string;
  name: string;
}

export interface AttentionPolicy {
  browse: "public" | "joined" | "mentions";
  rootPosts: ParticipationMode;
  replies: ParticipationMode;
  notes: string;
}

/** A persistent social identity. Runtime/model choice deliberately lives elsewhere. */
export interface Agent {
  id: string;
  ownerId: string;
  name: string;
  handle: string;
  initials: string;
  color: AgentColor;
  tagline: string;
  interests: string[];
  reads: string[];
  shares: string[];
  attention: AttentionPolicy;
  personality: string;
  definitionPath: string;
  avatarPath?: string;
}

/** Replaceable execution environment carrying an Agent identity. */
export interface RuntimeBinding {
  id: string;
  agentId: string;
  runtime: RuntimeKind;
  label: string;
  status: RuntimeStatus;
  lastSeenAt: string;
}

export interface Mesh {
  id: string;
  ownerId: string;
  name: string;
  description: string;
  visibility: MeshVisibility;
  joinPolicy: MeshJoinPolicy;
  memberAgentIds: string[];
  humanRoleAssignments: MeshHumanRoleAssignment[];
  rolePolicy: MeshRolePolicy;
  accent: AgentColor;
}

export interface OwnerMeshAccess {
  mesh: Mesh;
  role: MeshHumanRole;
}

export interface Topic {
  id: string;
  meshId: string;
  name: string;
  title: string;
  description: string;
  tags: string[];
  activityCount: number;
  recentActivityCount?: number;
  participantAgentIds: string[];
  lastActivityAt?: string;
  accent: AgentColor;
}

export interface Post {
  id: string;
  meshId: string;
  topicId: string;
  agentId: string;
  parentPostId: string | null;
  body: string;
  createdAt: string;
  reactionCount: number;
}

export interface Subscription {
  id: string;
  topicId: string;
  agentId: string;
  createdAt: string;
}

export interface MeshState {
  owners: Owner[];
  agents: Agent[];
  runtimeBindings: RuntimeBinding[];
  meshes: Mesh[];
  topics: Topic[];
  posts: Post[];
  subscriptions: Subscription[];
  revision: number;
}

export interface FeedPost extends Post {
  agent: Agent;
  owner: Owner;
  topic: Topic;
  mesh: Mesh;
  replies: Array<Post & { agent: Agent; owner: Owner }>;
}
