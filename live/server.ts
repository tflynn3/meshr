import { MeshrApi } from "../connector/api.ts";
import type { ConnectorBinding, ConnectorState } from "../connector/types.ts";
import type {
  AuthorBindingEvidence,
  IdentityEvidence,
  LiveRuntime,
  LocatedPost,
  PublicBindingEvidence,
  ServerMesh,
  ServerPost,
  ServerTopic,
} from "./types.ts";

const MAX_MESHES = 25;
const MAX_TOPICS_PER_MESH = 50;
const MAX_POST_PAGES = 10;
const POSTS_PER_PAGE = 100;

class RequestBudget {
  private readonly deadline: number;

  constructor(timeoutMs: number) {
    this.deadline = Date.now() + timeoutMs;
  }

  signal(): AbortSignal {
    const remaining = this.deadline - Date.now();
    if (remaining <= 0)
      throw new Error("Meshr server operation exceeded its time budget.");
    return AbortSignal.timeout(Math.max(1, Math.min(remaining, 15_000)));
  }
}

export function publicBinding(
  binding: ConnectorBinding,
): PublicBindingEvidence {
  return {
    pairingId: binding.pairingId,
    bindingId: binding.bindingId,
    agentId: binding.agentId,
    serverUrl: binding.serverUrl,
    runtime: binding.runtime,
    label: binding.label,
    externalSubject: binding.externalSubject,
    handle: binding.requestedProfile.handle,
    status: binding.status,
  };
}

function normalizedServerUrl(value: string): string {
  return new URL(value).toString().replace(/\/$/, "");
}

export function selectRuntimeBindings(input: {
  state: ConnectorState;
  runtime: LiveRuntime;
  selectors?: [string, string];
  serverUrl?: string;
}): [ConnectorBinding, ConnectorBinding] {
  const requestedServer = input.serverUrl
    ? normalizedServerUrl(input.serverUrl)
    : undefined;
  const eligible = input.state.bindings.filter(
    (binding) =>
      binding.runtime === input.runtime &&
      binding.status === "connected" &&
      Boolean(binding.agentToken) &&
      (!requestedServer ||
        normalizedServerUrl(binding.serverUrl) === requestedServer),
  );
  const find = (selector: string): ConnectorBinding | undefined =>
    eligible.find(
      (binding) =>
        binding.pairingId === selector ||
        binding.bindingId === selector ||
        binding.requestedProfile.handle === selector,
    );

  let selected: ConnectorBinding[];
  if (input.selectors) {
    selected = input.selectors.map((selector) => {
      const binding = find(selector);
      if (!binding) {
        throw new Error(
          `No connected ${input.runtime} binding matches ${selector}${requestedServer ? ` on ${requestedServer}` : ""}.`,
        );
      }
      return binding;
    });
  } else {
    selected = [...eligible]
      .sort((left, right) =>
        left.requestedProfile.handle.localeCompare(
          right.requestedProfile.handle,
        ),
      )
      .slice(0, 2);
  }
  if (selected.length !== 2) {
    throw new Error(
      `Live ${input.runtime} requires two connected bindings; found ${eligible.length}.`,
    );
  }
  if (selected[0]!.pairingId === selected[1]!.pairingId) {
    throw new Error(`Live ${input.runtime} requires two distinct bindings.`);
  }
  if (
    normalizedServerUrl(selected[0]!.serverUrl) !==
    normalizedServerUrl(selected[1]!.serverUrl)
  ) {
    throw new Error(
      `Both ${input.runtime} bindings must connect to the same Meshr server.`,
    );
  }
  return selected as [ConnectorBinding, ConnectorBinding];
}

export async function verifyIdentity(
  binding: ConnectorBinding,
  timeoutMs: number,
): Promise<IdentityEvidence> {
  const evidence: IdentityEvidence = {
    binding: publicBinding(binding),
    matches: false,
  };
  try {
    const budget = new RequestBudget(timeoutMs);
    const response = await new MeshrApi(binding.serverUrl).agentRequest<{
      agent: { id: string; handle: string };
    }>(binding, "/v1/agent/profile", { signal: budget.signal() });
    evidence.serverAgentId = response.agent.id;
    evidence.serverHandle = response.agent.handle;
    evidence.matches =
      response.agent.id === binding.agentId &&
      response.agent.handle === binding.requestedProfile.handle;
    if (!evidence.matches)
      evidence.error = "Server identity does not match connector binding.";
  } catch (error) {
    evidence.error = error instanceof Error ? error.message : String(error);
  }
  return evidence;
}

export async function discoverContext(
  binding: ConnectorBinding,
  timeoutMs: number,
): Promise<{
  profile: unknown;
  mesh: ServerMesh;
  topic: ServerTopic;
  posts: ServerPost[];
}> {
  const api = new MeshrApi(binding.serverUrl);
  const budget = new RequestBudget(timeoutMs);
  const profileResponse = await api.agentRequest<{
    agent: { interests?: string[] };
  }>(binding, "/v1/agent/profile", { signal: budget.signal() });
  const meshResponse = await api.agentRequest<{ meshes: ServerMesh[] }>(
    binding,
    "/v1/agent/meshes",
    { signal: budget.signal() },
  );
  const meshes = meshResponse.meshes
    .filter((mesh) => mesh.joined !== false)
    .slice(0, MAX_MESHES);
  if (!meshes.length)
    throw new Error(`${binding.requestedProfile.handle} has no joined mesh.`);

  const candidates: Array<{
    mesh: ServerMesh;
    topic: ServerTopic;
    score: number;
  }> = [];
  const interests = (profileResponse.agent.interests ?? []).map((value) =>
    value.toLowerCase(),
  );
  for (const mesh of meshes) {
    const response = await api.agentRequest<{ topics: ServerTopic[] }>(
      binding,
      `/v1/agent/meshes/${encodeURIComponent(mesh.id)}/topics`,
      { signal: budget.signal() },
    );
    for (const topic of response.topics.slice(0, MAX_TOPICS_PER_MESH)) {
      const haystack =
        `${topic.title} ${topic.description ?? ""} ${(topic.tags ?? []).join(" ")}`.toLowerCase();
      const score = interests.reduce(
        (total, interest) => total + (haystack.includes(interest) ? 1 : 0),
        0,
      );
      candidates.push({ mesh, topic, score });
    }
  }
  candidates.sort(
    (left, right) =>
      right.score - left.score ||
      left.topic.title.localeCompare(right.topic.title) ||
      left.topic.id.localeCompare(right.topic.id),
  );
  const chosen = candidates[0];
  if (!chosen)
    throw new Error(
      `${binding.requestedProfile.handle} cannot see any conversation.`,
    );
  return {
    profile: profileResponse.agent,
    mesh: chosen.mesh,
    topic: chosen.topic,
    posts: await readAllPosts(api, binding, chosen.topic.id, budget),
  };
}

export async function readTargetContext(input: {
  binding: ConnectorBinding;
  meshId: string;
  topicId: string;
  timeoutMs: number;
}): Promise<{ profile: unknown; topic: ServerTopic; posts: ServerPost[] }> {
  const api = new MeshrApi(input.binding.serverUrl);
  const budget = new RequestBudget(input.timeoutMs);
  const profileResponse = await api.agentRequest<{ agent: unknown }>(
    input.binding,
    "/v1/agent/profile",
    { signal: budget.signal() },
  );
  const topicResponse = await api.agentRequest<{ topics: ServerTopic[] }>(
    input.binding,
    `/v1/agent/meshes/${encodeURIComponent(input.meshId)}/topics`,
    { signal: budget.signal() },
  );
  const topic = topicResponse.topics.find(
    (candidate) => candidate.id === input.topicId,
  );
  if (!topic)
    throw new Error(
      `${input.binding.requestedProfile.handle} cannot observe ${input.topicId}.`,
    );
  return {
    profile: profileResponse.agent,
    topic,
    posts: await readAllPosts(api, input.binding, input.topicId, budget),
  };
}

export async function publishRoot(input: {
  binding: ConnectorBinding;
  meshId: string;
  topicId: string;
  body: string;
  idempotencyKey: string;
  timeoutMs: number;
}): Promise<unknown> {
  const budget = new RequestBudget(input.timeoutMs);
  return new MeshrApi(input.binding.serverUrl).agentRequest(
    input.binding,
    "/v1/agent/posts",
    {
      method: "POST",
      idempotencyKey: input.idempotencyKey,
      body: { meshId: input.meshId, topicId: input.topicId, body: input.body },
      signal: budget.signal(),
    },
  );
}

export async function publishReply(input: {
  binding: ConnectorBinding;
  postId: string;
  body: string;
  idempotencyKey: string;
  timeoutMs: number;
}): Promise<unknown> {
  const budget = new RequestBudget(input.timeoutMs);
  return new MeshrApi(input.binding.serverUrl).agentRequest(
    input.binding,
    `/v1/agent/posts/${encodeURIComponent(input.postId)}/replies`,
    {
      method: "POST",
      idempotencyKey: input.idempotencyKey,
      body: { body: input.body },
      signal: budget.signal(),
    },
  );
}

async function readAllPosts(
  api: MeshrApi,
  binding: ConnectorBinding,
  topicId: string,
  budget: RequestBudget,
): Promise<ServerPost[]> {
  const posts: ServerPost[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_POST_PAGES; page += 1) {
    const query = new URLSearchParams({ limit: String(POSTS_PER_PAGE) });
    if (cursor) query.set("after", cursor);
    const response = await api.agentRequest<{
      posts: ServerPost[];
      nextCursor: string | null;
    }>(
      binding,
      `/v1/agent/topics/${encodeURIComponent(topicId)}/posts?${query}`,
      { signal: budget.signal() },
    );
    posts.push(...response.posts);
    if (!response.nextCursor || response.nextCursor === cursor) break;
    cursor = response.nextCursor;
  }
  return posts;
}

export async function locateMarkedPost(input: {
  binding: ConnectorBinding;
  marker: string;
  timeoutMs: number;
  parentPostId?: string | null;
  targetMeshId?: string;
  targetTopicId?: string;
}): Promise<LocatedPost> {
  const api = new MeshrApi(input.binding.serverUrl);
  const budget = new RequestBudget(input.timeoutMs);
  const meshResponse = await api.agentRequest<{ meshes: ServerMesh[] }>(
    input.binding,
    "/v1/agent/meshes",
    { signal: budget.signal() },
  );
  const meshes = meshResponse.meshes
    .filter((mesh) => !input.targetMeshId || mesh.id === input.targetMeshId)
    .slice(0, MAX_MESHES);
  for (const mesh of meshes) {
    const topicResponse = await api.agentRequest<{ topics: ServerTopic[] }>(
      input.binding,
      `/v1/agent/meshes/${encodeURIComponent(mesh.id)}/topics`,
      { signal: budget.signal() },
    );
    const topics = topicResponse.topics
      .filter(
        (topic) => !input.targetTopicId || topic.id === input.targetTopicId,
      )
      .slice(0, MAX_TOPICS_PER_MESH);
    for (const topic of topics) {
      const posts = await readAllPosts(api, input.binding, topic.id, budget);
      const post = posts.find(
        (candidate) =>
          candidate.body.includes(input.marker) &&
          (input.parentPostId === undefined ||
            candidate.parentPostId === input.parentPostId),
      );
      if (post) return { mesh, topic, post };
    }
  }
  throw new Error(`No server post contains ${input.marker}.`);
}

export function authorBindingEvidence(
  binding: ConnectorBinding,
  marker: string,
  located: LocatedPost,
): AuthorBindingEvidence {
  const observedHandle = located.post.agent?.handle ?? "";
  const evidence: AuthorBindingEvidence = {
    postId: located.post.id,
    parentPostId: located.post.parentPostId,
    meshId: located.post.meshId,
    topicId: located.post.topicId,
    marker,
    expectedAgentId: binding.agentId,
    expectedHandle: binding.requestedProfile.handle,
    observedAgentId: located.post.agentId,
    observedHandle,
    agentIdMatches: located.post.agentId === binding.agentId,
    handleMatches: observedHandle === binding.requestedProfile.handle,
  };
  return evidence;
}
