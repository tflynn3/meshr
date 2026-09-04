import {
  createAgentToolCatalog,
  createAgentSetupTool,
  createPageControlToolCatalog,
  type ConversationalAgentProfile,
  type PageAgentAttention,
  type PageWebMcpClient,
  type PageWebMcpControlClient,
} from "../domain/agentTools";
import {
  createBrowserAgentWithWebMcp,
  disableWebMcpSession,
  enableWebMcpSession,
  getWebMcpSession,
  listOwnedAgents,
  MeshrApiError,
  type WebMcpSessionStatus,
} from "../auth/api";
import {
  rankMeshRecommendations,
  type RecommendationMesh,
} from "../domain/meshRecommendations";

export type WebMcpRegistrationStatus = "ready" | "setup-ready" | "unsupported";

const result = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
});

const temporaryPageControl = Object.freeze({
  temporary: true,
  startsRuntime: false,
  keepsRuntimeAlive: false,
});

type BrowserPrincipalKind = "guest" | "signed-in";

export interface WebMcpSessionReadTicket {
  generation: number;
  startedDuringMutation: boolean;
}

/** Prevent an asynchronous session read from publishing a snapshot that was
 * captured before, or while, a newer page-control mutation was in flight. */
export function createWebMcpSessionMutationFence() {
  let generation = 0;
  let activeMutations = 0;
  return {
    capture(): WebMcpSessionReadTicket {
      return {
        generation,
        startedDuringMutation: activeMutations > 0,
      };
    },
    mutationStarted(): void {
      activeMutations += 1;
      generation += 1;
    },
    mutationSettled(): void {
      activeMutations = Math.max(0, activeMutations - 1);
      generation += 1;
    },
    isCurrent(ticket: WebMcpSessionReadTicket): boolean {
      return !ticket.startedDuringMutation
        && activeMutations === 0
        && ticket.generation === generation;
    },
  };
}

function withPageControlBoundary(
  value: unknown,
  principalKind: BrowserPrincipalKind,
): Record<string, unknown> {
  const principal = principalKind === "guest"
    ? {
        kind: "guest" as const,
        recovery:
          "This guest owns durable agents, but Meshr can recover them only while this browser guest session remains available; clearing it or signing in as another account does not transfer them.",
      }
    : {
        kind: "signed-in" as const,
        recovery: "Owned agents can be recovered by signing back in to this account.",
      };
  return value && typeof value === "object" && !Array.isArray(value)
    ? {
        ...(value as Record<string, unknown>),
        pageControl: temporaryPageControl,
        principal,
      }
    : { value, pageControl: temporaryPageControl, principal };
}

function verifiedAgentId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const agent = (value as { agent?: unknown }).agent;
  if (!agent || typeof agent !== "object") return null;
  const id = (agent as { id?: unknown }).id;
  return typeof id === "string" ? id : null;
}

async function responseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function errorMessage(value: unknown): string {
  if (!value || typeof value !== "object") return "The Meshr page request failed.";
  const envelope = value as {
    error?: { message?: unknown } | string;
    message?: unknown;
  };
  if (typeof envelope.error === "object" && typeof envelope.error?.message === "string") {
    return envelope.error.message;
  }
  if (typeof envelope.message === "string") return envelope.message;
  if (typeof envelope.error === "string") return envelope.error;
  return "The Meshr page request failed.";
}

function meshDirectory(value: unknown): RecommendationMesh[] {
  if (!value || typeof value !== "object") return [];
  const meshes = (value as { meshes?: unknown }).meshes;
  if (!Array.isArray(meshes)) return [];
  return meshes.flatMap((mesh) => {
    if (!mesh || typeof mesh !== "object") return [];
    const row = mesh as Record<string, unknown>;
    if (
      typeof row.id !== "string" ||
      typeof row.name !== "string" ||
      typeof row.description !== "string" ||
      typeof row.visibility !== "string" ||
      typeof row.joinPolicy !== "string" ||
      typeof row.joined !== "boolean"
    ) return [];
    return [{
      id: row.id,
      name: row.name,
      description: row.description,
      visibility: row.visibility,
      joinPolicy: row.joinPolicy,
      joined: row.joined,
    }];
  });
}

function collisionSafeHandle(handle: string, creationKey: string): string {
  // A retry after an ambiguous fallback response must derive the same handle
  // and idempotency key. Random suffixes can turn one logical invocation into
  // multiple durable identities when the first response is lost.
  const suffix = creationKey.slice(-5);
  return `${handle.slice(0, Math.max(2, 26 - suffix.length)).replace(/-+$/u, "")}-${suffix}`;
}

async function browserAgentCreationKey(
  profile: ConversationalAgentProfile,
): Promise<string> {
  const canonical = JSON.stringify({
    name: profile.name,
    handle: profile.handle,
    tagline: profile.tagline,
    interests: profile.interests,
    personality: profile.personality,
    participation: profile.participation,
    acknowledgeAutonomous: profile.acknowledgeAutonomous ?? false,
  });
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return `webmcp-create-${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")}`;
}

export async function createConversationalAgent(input: {
  profile: ConversationalAgentProfile;
  csrfToken: string;
  signal?: AbortSignal;
  onCreated?: (session: WebMcpSessionStatus) => void;
}): Promise<WebMcpSessionStatus & {
  recommendations: ReturnType<typeof rankMeshRecommendations>;
  recommendationStatus: "ready" | "unavailable";
  nextStep: string;
}> {
  const create = async (
    profile: ConversationalAgentProfile,
    idempotencyKey: string,
  ) =>
    createBrowserAgentWithWebMcp(
      {
        ...profile,
        idempotencyKey,
      },
      input.csrfToken,
      input.signal,
    );
  let profile = input.profile;
  let session: WebMcpSessionStatus;
  const requestedKey = await browserAgentCreationKey(profile);
  try {
    session = await create(profile, requestedKey);
  } catch (error) {
    if (!(error instanceof MeshrApiError) || error.code !== "handle_unavailable") throw error;
    profile = {
      ...profile,
      handle: collisionSafeHandle(profile.handle, requestedKey),
    };
    session = await create(profile, await browserAgentCreationKey(profile));
  }
  if (!session.agent) throw new Error("Meshr created no usable agent identity.");
  const client = createPageWebMcpClient({
    csrfToken: input.csrfToken,
    expectedAgentId: session.agent.id,
    signal: input.signal,
  });
  let recommendations: ReturnType<typeof rankMeshRecommendations> = [];
  let recommendationStatus: "ready" | "unavailable" = "ready";
  try {
    const directory = await client.discoverMeshes();
    recommendations = rankMeshRecommendations(profile, meshDirectory(directory));
  } catch {
    // The durable identity already exists. Treat discovery as enrichment so a
    // transient directory failure cannot misreport creation or invite a retry
    // that would create another agent.
    recommendationStatus = "unavailable";
  }
  const result = {
    ...session,
    recommendations,
    recommendationStatus,
    nextStep: recommendations[0]
      ? `Tell the person about @${session.agent.handle} and ask whether to explore ${recommendations[0].name}.`
      : `Tell the person about @${session.agent.handle} and offer to explore the public mesh.`,
  };
  if (!input.signal?.aborted) input.onCreated?.(session);
  return result;
}

/** Human-session client for the control tools that remain available before,
 * during, and after an agent's temporary page grant. */
export function createPageWebMcpControlClient(input: {
  csrfToken: string;
  principalKind: BrowserPrincipalKind;
  signal?: AbortSignal;
  onSessionChanged?: (session: WebMcpSessionStatus) => void;
  onMutationStarted?: () => void;
  onMutationSettled?: () => void;
}): PageWebMcpControlClient {
  let currentSession: WebMcpSessionStatus | null = null;
  const rememberSession = (session: WebMcpSessionStatus): WebMcpSessionStatus => {
    currentSession = session;
    return session;
  };
  const noteSession = (session: WebMcpSessionStatus): WebMcpSessionStatus => {
    rememberSession(session);
    if (!input.signal?.aborted) input.onSessionChanged?.(session);
    return session;
  };
  let mutationTail: Promise<void> = Promise.resolve();
  const serializeMutation = <T>(operation: () => Promise<T>): Promise<T> => {
    const run = mutationTail.then(async () => {
      input.onMutationStarted?.();
      try {
        return await operation();
      } finally {
        input.onMutationSettled?.();
      }
    });
    mutationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
  return {
    getMeshrSession: async () =>
      withPageControlBoundary(
        rememberSession(await getWebMcpSession(input.signal)),
        input.principalKind,
      ),
    listMyAgents: async () =>
      withPageControlBoundary(
        { agents: await listOwnedAgents(input.signal) },
        input.principalKind,
      ),
    createAgent: (profile) =>
      serializeMutation(async () =>
        withPageControlBoundary(
          await createConversationalAgent({
            profile,
            csrfToken: input.csrfToken,
            signal: input.signal,
            onCreated: noteSession,
          }),
          input.principalKind,
        ),
      ),
    selectMyAgent: ({ agentId }) =>
      serializeMutation(async () =>
        withPageControlBoundary(
          noteSession(
            await enableWebMcpSession(agentId, input.csrfToken, input.signal),
          ),
          input.principalKind,
        ),
      ),
    releasePageControl: () =>
      serializeMutation(async () => {
        const observed = currentSession
          ?? rememberSession(await getWebMcpSession(input.signal));
        if (!observed.enabled) {
          return withPageControlBoundary(observed, input.principalKind);
        }
        if (!observed.agent || !observed.pageSessionId) {
          throw new Error("webmcp_authority_corrupt");
        }
        const expected = {
          agentId: observed.agent.id,
          pageSessionId: observed.pageSessionId,
        };
        return withPageControlBoundary(
          noteSession(await disableWebMcpSession(
            input.csrfToken,
            expected,
            input.signal,
          )),
          input.principalKind,
        );
      }),
  };
}

/** Same-origin page client. Agent identity comes only from the HttpOnly grant cookie. */
export function createPageWebMcpClient(input: {
  csrfToken: string;
  expectedAgentId: string;
  signal?: AbortSignal;
  makeIdempotencyKey?: () => string;
  makeActivityId?: () => string;
}): PageWebMcpClient {
  const makeKey = input.makeIdempotencyKey ?? (() => crypto.randomUUID());
  const makeActivityId = input.makeActivityId ?? (() => crypto.randomUUID());
  const request = async (
    path: string,
    options: { method?: string; body?: unknown; mutation?: boolean } = {},
  ): Promise<unknown> => {
    const headers = new Headers({
      Accept: "application/json",
      "X-Meshr-Contract-Version": "1",
      "X-Meshr-WebMCP-Agent": input.expectedAgentId,
      "X-Meshr-Activity-Id": makeActivityId(),
    });
    if (options.body !== undefined) headers.set("Content-Type", "application/json");
    if (options.mutation) {
      headers.set("X-Meshr-CSRF", input.csrfToken);
      headers.set("Idempotency-Key", makeKey());
    }
    const response = await fetch(path, {
      method: options.method ?? "GET",
      credentials: "include",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: input.signal,
    });
    const payload = await responseJson(response);
    if (!response.ok) throw new Error(errorMessage(payload));
    return payload;
  };
  return {
    getMyAgent: () => request("/v1/webmcp/profile"),
    discoverMeshes: () => request("/v1/webmcp/meshes"),
    observeMeshActivity: ({ meshId }) => {
      const query = meshId ? `?meshId=${encodeURIComponent(meshId)}` : "";
      return request(`/v1/webmcp/activity${query}`);
    },
    readConversation: ({ topicId, limit }) => {
      const query = typeof limit === "number" ? `?limit=${Math.trunc(limit)}` : "";
      return request(`/v1/webmcp/topics/${encodeURIComponent(topicId)}/posts${query}`);
    },
    publishPost: ({ meshId, topicId, body }) =>
      request("/v1/webmcp/posts", {
        method: "POST",
        mutation: true,
        body: { meshId, topicId, body },
      }),
    replyToPost: ({ postId, body }) =>
      request(`/v1/webmcp/posts/${encodeURIComponent(postId)}/replies`, {
        method: "POST",
        mutation: true,
        body: { body },
      }),
    followConversation: ({ topicId }) =>
      request(`/v1/webmcp/topics/${encodeURIComponent(topicId)}/follow`, {
        method: "PUT",
        mutation: true,
      }),
    joinMesh: ({ meshId, invitationToken }) =>
      request(`/v1/webmcp/meshes/${encodeURIComponent(meshId)}/join`, {
        method: "POST",
        mutation: true,
        body: invitationToken ? { invitationToken } : {},
      }),
    inspectTrafficLink: ({ meshId, linkId }) =>
      request(
        `/v1/webmcp/meshes/${encodeURIComponent(meshId)}/traffic/${encodeURIComponent(linkId)}`,
      ),
  };
}

export async function registerMeshrSetupTools({
  modelContext,
  signal,
  createAgent,
}: {
  modelContext: ModelContext | undefined;
  signal: AbortSignal;
  createAgent: (profile: ConversationalAgentProfile) => Promise<unknown>;
}): Promise<"setup-ready" | "unsupported"> {
  if (!modelContext) return "unsupported";
  const tool = createAgentSetupTool(createAgent);
  await modelContext.registerTool(
    {
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
      execute: async (toolInput) => result(await tool.execute(toolInput)),
    },
    { signal },
  );
  return "setup-ready";
}

/** Register the browser-native provisioning and recovery surface whether or
 * not an agent currently has temporary page authority. */
export async function registerMeshrControlTools({
  modelContext,
  signal,
  client,
}: {
  modelContext: ModelContext | undefined;
  signal: AbortSignal;
  client: PageWebMcpControlClient;
}): Promise<"setup-ready" | "unsupported"> {
  if (!modelContext) return "unsupported";
  const registrationController = new AbortController();
  const abortFromCaller = () => registrationController.abort(signal.reason);
  if (signal.aborted) abortFromCaller();
  else signal.addEventListener("abort", abortFromCaller, { once: true });
  const registrations: Array<Promise<void>> = [];
  let registered = false;
  try {
    for (const tool of createPageControlToolCatalog(client)) {
      registrations.push(modelContext.registerTool(
        {
          name: tool.name,
          title: tool.title,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: tool.annotations,
          execute: async (toolInput) => result(await tool.execute(toolInput)),
        },
        { signal: registrationController.signal },
      ));
    }
    await Promise.all(registrations);
    registered = true;
    return "setup-ready";
  } catch (error) {
    registrationController.abort(error);
    await Promise.allSettled(registrations);
    throw error;
  } finally {
    if (!registered) signal.removeEventListener("abort", abortFromCaller);
  }
}

/** Register native page tools only after a human has selected an owned agent. */
export async function registerMeshrTools({
  modelContext,
  csrfToken,
  expectedAgentId,
  attention,
  signal,
  client,
}: {
  modelContext: ModelContext | undefined;
  csrfToken: string;
  expectedAgentId: string;
  attention: PageAgentAttention;
  signal: AbortSignal;
  client?: PageWebMcpClient;
}): Promise<"ready" | "unsupported"> {
  if (!modelContext) return "unsupported";
  const resolvedClient = client ?? createPageWebMcpClient({
    csrfToken,
    expectedAgentId,
    signal,
  });

  // Registration is a batch from the page's point of view. A host can reject
  // one tool after accepting others, so give every registration a shared
  // child signal and abort the whole batch on the first failure. WebMCP hosts
  // use that signal as the cleanup fence for tools that were registered before
  // the rejection; without it the UI could revoke the grant while a partial
  // tool surface remained exposed in the browser.
  const registrationController = new AbortController();
  const abortFromCaller = () => registrationController.abort(signal.reason);
  if (signal.aborted) abortFromCaller();
  else signal.addEventListener("abort", abortFromCaller, { once: true });
  const registrations: Array<Promise<void>> = [];
  let registered = false;
  try {
    // Keep the calls inside the guarded section as well: a host is allowed to
    // throw synchronously before returning its registration promise.
    for (const tool of createAgentToolCatalog(resolvedClient, attention)) {
      registrations.push(modelContext.registerTool(
        {
          name: tool.name,
          title: tool.title,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: tool.annotations,
          execute: async (toolInput) => result(await tool.execute(toolInput)),
        },
        { signal: registrationController.signal },
      ));
    }
    await Promise.all(registrations);
    // Registration proves the browser accepted the tool surface. This
    // same-origin read also proves the short-lived page grant resolves to the
    // exact identity selected for the session before the UI reports success.
    const identity = await resolvedClient.getMyAgent();
    if (verifiedAgentId(identity) !== expectedAgentId) {
      throw new Error("The page grant did not verify the selected Meshr identity.");
    }
    // Keep the caller→host cleanup fence attached after a successful batch.
    // React tears down the effect when the grant expires, the selected agent
    // changes, or the page unmounts; detaching here would leave stale tools
    // registered in the host even though the server grant was revoked.
    registered = true;
    return "ready";
  } catch (error) {
    registrationController.abort(error);
    // Let hosts finish their abort cleanup before the caller revokes the
    // server-side grant. This also keeps an already-resolved rejection from
    // racing the revoke request in the React effect.
    await Promise.allSettled(registrations);
    throw error;
  } finally {
    // Failed setup has no durable tool surface to clean up after this call;
    // remove the listener once the batch has been aborted and settled. On
    // success the `{ once: true }` listener remains until the caller aborts.
    if (!registered) signal.removeEventListener("abort", abortFromCaller);
  }
}
