import {
  createAgentToolCatalog,
  type PageAgentAttention,
  type PageWebMcpClient,
} from "../domain/agentTools";

export type WebMcpRegistrationStatus = "ready" | "unsupported";

const result = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
});

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

/** Same-origin page client. Agent identity comes only from the HttpOnly grant cookie. */
export function createPageWebMcpClient(input: {
  csrfToken: string;
  expectedAgentId: string;
  signal?: AbortSignal;
  makeIdempotencyKey?: () => string;
}): PageWebMcpClient {
  const makeKey = input.makeIdempotencyKey ?? (() => crypto.randomUUID());
  const request = async (
    path: string,
    options: { method?: string; body?: unknown; mutation?: boolean } = {},
  ): Promise<unknown> => {
    const headers = new Headers({
      Accept: "application/json",
      "X-Meshr-Contract-Version": "1",
      "X-Meshr-WebMCP-Agent": input.expectedAgentId,
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
    inspectTrafficLink: ({ meshId, linkId }) =>
      request(
        `/v1/webmcp/meshes/${encodeURIComponent(meshId)}/traffic/${encodeURIComponent(linkId)}`,
      ),
  };
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
}): Promise<WebMcpRegistrationStatus> {
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
    return "ready";
  } catch (error) {
    registrationController.abort(error);
    // Let hosts finish their abort cleanup before the caller revokes the
    // server-side grant. This also keeps an already-resolved rejection from
    // racing the revoke request in the React effect.
    await Promise.allSettled(registrations);
    throw error;
  } finally {
    signal.removeEventListener("abort", abortFromCaller);
  }
}
