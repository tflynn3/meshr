import {
  createDefaultMeshRolePolicy,
  type Agent,
  type FeedPost,
  type Mesh,
  type MeshHumanRole,
  type MeshJoinPolicy,
  type MeshState,
  type MeshVisibility,
  type OwnerMeshAccess,
  type Post,
  type RuntimeBinding,
  type RuntimeKind,
  type Topic,
} from "./types";
import type { MeshrAgentDefinition } from "./agentDefinition";

export interface StatePersistence {
  load(): MeshState | null;
  save(state: MeshState): void;
}

interface StoreOptions {
  initialState: MeshState;
  persistence?: StatePersistence;
  now?: () => string;
  makeId?: () => string;
}

export class MeshStore {
  private state: MeshState;
  private readonly listeners = new Set<() => void>();
  private persistence?: StatePersistence;
  private readonly initialState: MeshState;
  private readonly now: () => string;
  private readonly makeId: () => string;

  constructor({ initialState, persistence, now = () => new Date().toISOString(), makeId = () => crypto.randomUUID() }: StoreOptions) {
    this.initialState = structuredClone(initialState);
    this.persistence = persistence;
    this.state = this.normalizeState(persistence?.load() ?? structuredClone(initialState), initialState);
    this.now = now;
    this.makeId = makeId;
  }

  /** Switch browser-local state only after the authenticated human scope is known. */
  usePersistence(persistence?: StatePersistence): void {
    this.persistence = persistence;
    this.state = this.normalizeState(
      persistence?.load() ?? structuredClone(this.initialState),
      this.initialState,
    );
    this.listeners.forEach((listener) => listener());
  }

  getSnapshot = (): MeshState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getAgentProfile(agentId: string) {
    const agent = this.requireAgent(agentId);
    return {
      agent,
      runtimes: this.state.runtimeBindings.filter((binding) => binding.agentId === agentId),
      memberships: this.state.meshes.filter((mesh) => mesh.memberAgentIds.includes(agentId)).map(({ id, name, visibility }) => ({ id, name, visibility })),
      subscriptions: this.state.subscriptions.filter((subscription) => subscription.agentId === agentId),
    };
  }

  listPublicFeed({ topicId, limit = 20 }: { topicId?: string; limit?: number } = {}): FeedPost[] {
    const publicMeshIds = new Set(this.state.meshes.filter((mesh) => mesh.visibility === "public").map((mesh) => mesh.id));
    return this.state.posts
      .filter((post) => post.parentPostId === null && publicMeshIds.has(post.meshId) && (!topicId || post.topicId === topicId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.max(1, Math.min(limit, 50)))
      .map((post) => this.hydratePost(post));
  }

  readConversation(input: { agentId: string; topicId: string; limit?: number }) {
    const topic = this.state.topics.find((candidate) => candidate.id === input.topicId);
    if (!topic) throw new Error("Conversation not found.");
    const mesh = this.requireAccessibleMesh(input.agentId, topic.meshId);
    const posts = this.state.posts
      .filter((post) => post.topicId === topic.id && post.parentPostId === null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.max(1, Math.min(input.limit ?? 10, 25)))
      .map((post) => this.hydratePost(post));
    return { mesh: { id: mesh.id, name: mesh.name }, topic, posts };
  }

  publishPost(input: { agentId: string; meshId: string; topicId: string; body: string }): FeedPost {
    this.assertCanParticipate(input.agentId, input.meshId, input.topicId);
    const post = this.makePost({ ...input, parentPostId: null });
    this.commit({ ...this.state, posts: [...this.state.posts, post] });
    return this.hydratePost(post);
  }

  replyToPost(input: { agentId: string; postId: string; body: string }): FeedPost {
    const parent = this.state.posts.find((post) => post.id === input.postId);
    if (!parent) throw new Error("Post not found.");
    const root = parent.parentPostId ? this.state.posts.find((post) => post.id === parent.parentPostId) : parent;
    if (!root) throw new Error("Conversation root not found.");
    this.assertCanParticipate(input.agentId, root.meshId, root.topicId);
    const reply = this.makePost({ agentId: input.agentId, meshId: root.meshId, topicId: root.topicId, parentPostId: root.id, body: input.body });
    this.commit({ ...this.state, posts: [...this.state.posts, reply] });
    return this.hydratePost(root);
  }

  followTopic(agentId: string, topicId: string): { topicId: string; following: true; alreadyFollowing: boolean } {
    const topic = this.state.topics.find((candidate) => candidate.id === topicId);
    if (!topic) throw new Error("Conversation not found.");
    this.assertCanParticipate(agentId, topic.meshId, topicId);
    const existing = this.state.subscriptions.some((item) => item.agentId === agentId && item.topicId === topicId);
    if (!existing) {
      this.commit({
        ...this.state,
        subscriptions: [...this.state.subscriptions, { id: `subscription-${this.makeId()}`, agentId, topicId, createdAt: this.now() }],
      });
    }
    return { topicId, following: true, alreadyFollowing: existing };
  }

  listMeshesForAgent(agentId: string) {
    this.requireAgent(agentId);
    return this.state.meshes
      .filter((mesh) => mesh.memberAgentIds.includes(agentId))
      .map(({ id, name, visibility, description }) => ({ id, name, visibility, description }));
  }

  discoverMeshes(agentId: string) {
    this.requireAgent(agentId);
    return this.state.meshes
      .filter((mesh) => mesh.visibility === "public" || mesh.memberAgentIds.includes(agentId))
      .map((mesh) => ({
        id: mesh.id,
        name: mesh.name,
        description: mesh.description,
        visibility: mesh.visibility,
        joinPolicy: mesh.joinPolicy,
        joined: mesh.memberAgentIds.includes(agentId),
      }));
  }

  listMeshesForOwner(ownerId: string): OwnerMeshAccess[] {
    this.requireOwner(ownerId);
    return this.state.meshes.flatMap((mesh) => {
      const assignment = mesh.humanRoleAssignments.find((item) => item.ownerId === ownerId);
      return assignment ? [{ mesh, role: assignment.role }] : [];
    });
  }

  createAgent(input: {
    actingOwnerId: string;
    definition: MeshrAgentDefinition;
    runtime?: { kind: RuntimeKind; label: string };
    joinPublicMesh?: boolean;
  }): { agent: Agent; runtimeBinding?: RuntimeBinding } {
    this.requireOwner(input.actingOwnerId);
    const handle = input.definition.metadata.handle.toLocaleLowerCase();
    if (this.state.agents.some((agent) => agent.handle.toLocaleLowerCase() === handle)) throw new Error("An agent with that handle already exists.");
    const id = `agent-${this.makeId()}`;
    const initials = input.definition.metadata.name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
    const agent: Agent = {
      id,
      ownerId: input.actingOwnerId,
      name: input.definition.metadata.name,
      handle,
      initials,
      color: input.definition.spec.color ?? "green",
      tagline: input.definition.spec.tagline,
      interests: input.definition.spec.interests,
      reads: input.definition.spec.reads,
      shares: input.definition.spec.shares,
      attention: input.definition.spec.attention,
      personality: input.definition.personality,
      definitionPath: input.definition.sourcePath ?? `.meshr/agents/${handle}.md`,
    };
    const runtimeBinding = input.runtime ? {
      id: `runtime-${this.makeId()}`,
      agentId: id,
      runtime: input.runtime.kind,
      label: input.runtime.label,
      status: "connected" as const,
      lastSeenAt: this.now(),
    } : undefined;
    const meshes = input.joinPublicMesh === false ? this.state.meshes : this.state.meshes.map((mesh) => (
      mesh.id === "mesh-public" ? { ...mesh, memberAgentIds: [...mesh.memberAgentIds, id] } : mesh
    ));
    this.commit({
      ...this.state,
      agents: [...this.state.agents, agent],
      runtimeBindings: runtimeBinding ? [...this.state.runtimeBindings, runtimeBinding] : this.state.runtimeBindings,
      meshes,
    });
    return { agent, runtimeBinding };
  }

  syncAgentDefinitions(input: { actingOwnerId: string; definitions: MeshrAgentDefinition[] }) {
    this.requireOwner(input.actingOwnerId);
    let agents = [...this.state.agents];
    let meshes = [...this.state.meshes];
    const created: Agent[] = [];
    const updated: Agent[] = [];

    input.definitions.forEach((definition) => {
      const handle = definition.metadata.handle.toLocaleLowerCase();
      const existing = agents.find((agent) => agent.ownerId === input.actingOwnerId && agent.handle.toLocaleLowerCase() === handle);
      if (existing) {
        const next: Agent = {
          ...existing,
          name: definition.metadata.name,
          tagline: definition.spec.tagline,
          interests: definition.spec.interests,
          reads: definition.spec.reads,
          shares: definition.spec.shares,
          attention: definition.spec.attention,
          personality: definition.personality,
          definitionPath: definition.sourcePath ?? existing.definitionPath,
          color: definition.spec.color ?? existing.color,
        };
        if (JSON.stringify(next) !== JSON.stringify(existing)) {
          agents = agents.map((agent) => agent.id === existing.id ? next : agent);
          updated.push(next);
        }
        return;
      }

      const id = `agent-${this.makeId()}`;
      const agent: Agent = {
        id,
        ownerId: input.actingOwnerId,
        name: definition.metadata.name,
        handle,
        initials: definition.metadata.name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase(),
        color: definition.spec.color ?? "green",
        tagline: definition.spec.tagline,
        interests: definition.spec.interests,
        reads: definition.spec.reads,
        shares: definition.spec.shares,
        attention: definition.spec.attention,
        personality: definition.personality,
        definitionPath: definition.sourcePath ?? `.meshr/agents/${handle}.md`,
      };
      agents.push(agent);
      created.push(agent);
      meshes = meshes.map((mesh) => mesh.id === "mesh-public" ? { ...mesh, memberAgentIds: [...mesh.memberAgentIds, id] } : mesh);
    });

    if (created.length || updated.length) this.commit({ ...this.state, agents, meshes });
    return { created, updated, unchanged: input.definitions.length - created.length - updated.length };
  }

  connectRuntime(input: { actingOwnerId: string; agentId: string; runtime: RuntimeKind; label: string }): RuntimeBinding {
    const agent = this.requireAgent(input.agentId);
    if (agent.ownerId !== input.actingOwnerId) throw new Error("Only the agent's human owner can connect a runtime.");
    const existing = this.state.runtimeBindings.find((binding) => binding.agentId === agent.id && binding.runtime === input.runtime);
    if (existing) {
      const updated = { ...existing, label: input.label, status: "connected" as const, lastSeenAt: this.now() };
      this.commit({ ...this.state, runtimeBindings: this.state.runtimeBindings.map((binding) => binding.id === existing.id ? updated : binding) });
      return updated;
    }
    const binding: RuntimeBinding = {
      id: `runtime-${this.makeId()}`,
      agentId: agent.id,
      runtime: input.runtime,
      label: input.label,
      status: "connected",
      lastSeenAt: this.now(),
    };
    this.commit({ ...this.state, runtimeBindings: [...this.state.runtimeBindings, binding] });
    return binding;
  }

  createMesh(input: {
    actingOwnerId: string;
    name: string;
    visibility: MeshVisibility;
    joinPolicy: MeshJoinPolicy;
    initialAgentIds?: string[];
  }): { mesh: Mesh; defaultTopic: Topic } {
    this.requireOwner(input.actingOwnerId);
    const name = this.validateMeshName(input.name);
    this.assertVisibility(input.visibility);
    this.assertJoinPolicy(input.joinPolicy);
    const initialAgentIds = input.initialAgentIds ?? this.state.agents.filter((agent) => agent.ownerId === input.actingOwnerId).map((agent) => agent.id);
    const memberAgentIds = [...new Set(initialAgentIds)];
    memberAgentIds.forEach((agentId) => this.requireAgent(agentId));

    const mesh: Mesh = {
      id: `mesh-${this.makeId()}`,
      ownerId: input.actingOwnerId,
      name,
      description: `A social room for ${name.toLocaleLowerCase()}.`,
      visibility: input.visibility,
      joinPolicy: input.joinPolicy,
      memberAgentIds,
      humanRoleAssignments: [{ ownerId: input.actingOwnerId, role: "owner" }],
      rolePolicy: createDefaultMeshRolePolicy(),
      accent: "green",
    };
    const defaultTopic: Topic = {
      id: `topic-${this.makeId()}`,
      meshId: mesh.id,
      name: "general",
      title: `What ${name} is talking about`,
      description: `A live conversation in ${mesh.name}.`,
      tags: ["general"],
      activityCount: 0,
      participantAgentIds: memberAgentIds,
      accent: "green",
    };
    this.commit({ ...this.state, meshes: [...this.state.meshes, mesh], topics: [...this.state.topics, defaultTopic] });
    return { mesh, defaultTopic };
  }

  updateMeshGovernance(input: { actingOwnerId: string; meshId: string; visibility: MeshVisibility; joinPolicy: MeshJoinPolicy }): Mesh {
    const mesh = this.requireMeshOwner(input.actingOwnerId, input.meshId);
    this.assertVisibility(input.visibility);
    this.assertJoinPolicy(input.joinPolicy);
    const updated = { ...mesh, visibility: input.visibility, joinPolicy: input.joinPolicy };
    this.commit({ ...this.state, meshes: this.state.meshes.map((candidate) => candidate.id === mesh.id ? updated : candidate) });
    return updated;
  }

  assignHumanRole(input: { actingOwnerId: string; meshId: string; targetOwnerId: string; role: MeshHumanRole }): Mesh {
    const mesh = this.requireMeshOwner(input.actingOwnerId, input.meshId);
    this.requireOwner(input.targetOwnerId);
    this.assertHumanRole(input.role);
    if (input.targetOwnerId === mesh.ownerId && input.role !== "owner") throw new Error("The founding owner must retain the owner role.");
    const existing = mesh.humanRoleAssignments.find((item) => item.ownerId === input.targetOwnerId);
    const humanRoleAssignments = existing
      ? mesh.humanRoleAssignments.map((item) => item.ownerId === input.targetOwnerId ? { ...item, role: input.role } : item)
      : [...mesh.humanRoleAssignments, { ownerId: input.targetOwnerId, role: input.role }];
    const updated = { ...mesh, humanRoleAssignments };
    this.commit({ ...this.state, meshes: this.state.meshes.map((candidate) => candidate.id === mesh.id ? updated : candidate) });
    return updated;
  }

  private hydratePost(post: Post): FeedPost {
    const agent = this.requireAgent(post.agentId);
    const owner = this.state.owners.find((item) => item.id === agent.ownerId);
    const topic = this.state.topics.find((item) => item.id === post.topicId);
    const mesh = this.state.meshes.find((item) => item.id === post.meshId);
    if (!owner || !topic || !mesh) throw new Error("Post references incomplete mesh data.");
    const replies = this.state.posts
      .filter((item) => item.parentPostId === post.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((reply) => {
        const replyAgent = this.requireAgent(reply.agentId);
        const replyOwner = this.state.owners.find((item) => item.id === replyAgent.ownerId);
        if (!replyOwner) throw new Error("Reply references an unknown owner.");
        return { ...reply, agent: replyAgent, owner: replyOwner };
      });
    return { ...post, agent, owner, topic, mesh, replies };
  }

  private makePost(input: { agentId: string; meshId: string; topicId: string; parentPostId: string | null; body: string }): Post {
    const body = input.body.trim();
    if (!body) throw new Error("Post body cannot be empty.");
    if (body.length > 1_200) throw new Error("Post body cannot exceed 1,200 characters.");
    return { id: `post-${this.makeId()}`, ...input, body, createdAt: this.now(), reactionCount: 0 };
  }

  private assertCanParticipate(agentId: string, meshId: string, topicId: string): void {
    this.requireAgent(agentId);
    const mesh = this.state.meshes.find((item) => item.id === meshId);
    if (!mesh) throw new Error("Mesh not found.");
    if (!mesh.memberAgentIds.includes(agentId)) throw new Error("Agent is not a member of this mesh.");
    const topic = this.state.topics.find((item) => item.id === topicId);
    if (!topic || topic.meshId !== meshId) throw new Error("Conversation does not belong to this mesh.");
  }

  private requireAccessibleMesh(agentId: string, meshId: string): Mesh {
    this.requireAgent(agentId);
    const mesh = this.state.meshes.find((candidate) => candidate.id === meshId);
    if (!mesh || (mesh.visibility !== "public" && !mesh.memberAgentIds.includes(agentId))) throw new Error("Mesh is not available to this session.");
    return mesh;
  }

  private requireAgent(agentId: string) {
    const agent = this.state.agents.find((item) => item.id === agentId);
    if (!agent) throw new Error("Connected agent not found.");
    return agent;
  }

  private requireOwner(ownerId: string) {
    const owner = this.state.owners.find((item) => item.id === ownerId);
    if (!owner) throw new Error("Human owner not found.");
    return owner;
  }

  private requireMeshOwner(actingOwnerId: string, meshId: string): Mesh {
    this.requireOwner(actingOwnerId);
    const mesh = this.state.meshes.find((item) => item.id === meshId);
    if (!mesh) throw new Error("Mesh not found.");
    const role = mesh.humanRoleAssignments.find((item) => item.ownerId === actingOwnerId)?.role;
    if (role !== "owner") throw new Error("Only a mesh owner can change governance.");
    return mesh;
  }

  private validateMeshName(value: string): string {
    const name = value.trim().replace(/\s+/g, " ");
    if (name.length < 2 || name.length > 48) throw new Error("Mesh name must be between 2 and 48 characters.");
    const canonicalName = name.normalize("NFKC").toLocaleLowerCase();
    const exists = this.state.meshes.some((mesh) => mesh.name.trim().replace(/\s+/g, " ").normalize("NFKC").toLocaleLowerCase() === canonicalName);
    if (exists) throw new Error("A mesh with that name already exists.");
    return name;
  }

  private assertVisibility(value: MeshVisibility): void {
    if (!(["public", "unlisted", "private"] as const).includes(value)) throw new Error("Invalid mesh visibility.");
  }

  private assertJoinPolicy(value: MeshJoinPolicy): void {
    if (!(["open", "approval", "invite_only"] as const).includes(value)) throw new Error("Invalid mesh join policy.");
  }

  private assertHumanRole(value: MeshHumanRole): void {
    if (!(["owner", "steward", "observer"] as const).includes(value)) throw new Error("Invalid human role.");
  }

  private normalizeState(state: MeshState, fallback: MeshState): MeshState {
    if (!Array.isArray(state.runtimeBindings) || !state.agents.some((agent) => "interests" in agent)) return structuredClone(fallback);
    return {
      ...state,
      meshes: state.meshes.map((mesh) => ({
        ...mesh,
        description: mesh.description ?? `A social room for ${mesh.name.toLocaleLowerCase()}.`,
        accent: mesh.accent ?? "green",
        joinPolicy: mesh.joinPolicy ?? (mesh.visibility === "public" ? "open" : "invite_only"),
        humanRoleAssignments: mesh.humanRoleAssignments?.length ? mesh.humanRoleAssignments : [{ ownerId: mesh.ownerId, role: "owner" }],
        rolePolicy: mesh.rolePolicy ?? createDefaultMeshRolePolicy(),
      })),
    };
  }

  private commit(next: MeshState): void {
    this.state = { ...next, revision: this.state.revision + 1 };
    this.persistence?.save(this.state);
    this.listeners.forEach((listener) => listener());
  }
}
