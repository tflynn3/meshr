import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { MeshrApi } from "../connector/api.ts";
import { beginPairing, claimPairing } from "../connector/pairing.ts";
import { syncBindingDefinition } from "../connector/profileSync.ts";
import { ConnectorStateStore } from "../connector/state.ts";
import { createRemoteAgentTools } from "../connector/tools.ts";
import { createMeshrServer } from "../server/app.ts";

interface JsonResponse {
  response: Response;
  json: any;
}

async function requestJson(
  baseUrl: string,
  path: string,
  options: {
    method?: string;
    body?: unknown;
    cookie?: string;
    csrf?: string;
  } = {},
): Promise<JsonResponse> {
  const headers = new Headers({ accept: "application/json" });
  if (options.body !== undefined) headers.set("content-type", "application/json");
  if (options.cookie) headers.set("cookie", options.cookie);
  if (options.csrf) headers.set("x-meshr-csrf", options.csrf);
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const json = await response.json();
  return { response, json };
}

const sessionCookie = (response: Response): string =>
  (response.headers.get("set-cookie") ?? "").split(";", 1)[0] ?? "";

test("real connector pairs, proves its key, calls the API, and serves the same tools over MCP", async (context) => {
  const temporary = await mkdtemp(join(tmpdir(), "meshr-connector-e2e-"));
  const databasePath = join(temporary, "meshr.sqlite");
  const stateDirectory = join(temporary, "connector-state");
  const definitionPath = join(temporary, "bramble.md");
  await copyFile(resolve(".meshr/agents/bramble.md"), definitionPath);
  const app = createMeshrServer({
    dbPath: databasePath,
    publicWebUrl: "https://meshr.example/connect",
  });
  const address = await app.listen(0, "127.0.0.1");
  context.after(async () => {
    await app.close();
    await rm(temporary, { recursive: true, force: true });
  });

  const account = await requestJson(address.baseUrl, "/v1/accounts", {
    method: "POST",
    body: {
      email: "connector@example.test",
      password: "correct horse battery staple",
      displayName: "Connector Owner",
    },
  });
  assert.equal(account.response.status, 201);
  const cookie = sessionCookie(account.response);
  const csrf = account.json.csrfToken as string;

  // Keep this integration test hermetic: production macOS runs use the
  // Keychain, while the test intentionally exercises the documented 0600 file
  // fallback without mutating the developer's login keychain.
  const store = new ConnectorStateStore(stateDirectory, { useKeychain: false });
  const started = await beginPairing({
    runtime: "codex",
    label: "Codex live test",
    externalSubject: "codex:bramble-e2e",
    definitionPath,
    serverUrl: address.baseUrl,
    store,
  });
  assert.equal(started.binding.status, "pending");
  assert.match(started.binding.pairingCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(
    started.verificationUri,
    `https://meshr.example/connect?code=${started.binding.pairingCode}`,
  );

  const lookup = await requestJson(
    address.baseUrl,
    `/v1/pairings/lookup?code=${encodeURIComponent(started.binding.pairingCode)}`,
    { cookie },
  );
  assert.equal(lookup.response.status, 200);
  assert.equal(lookup.json.pairing.requestedProfile.handle, "bramble");
  assert.equal(lookup.json.pairing.externalSubject, "codex:bramble-e2e");

  const approved = await requestJson(
    address.baseUrl,
    `/v1/pairings/${encodeURIComponent(started.binding.pairingId)}/approve`,
    { method: "POST", body: { acknowledgeAutonomous: true }, cookie, csrf },
  );
  assert.equal(approved.response.status, 200);
  assert.equal(approved.json.pairing.status, "approved");

  const connected = await claimPairing(started.binding.pairingId, store);
  assert.equal(connected.status, "connected");
  assert.ok(connected.agentToken);
  assert.equal(connected.agentId, approved.json.pairing.agentId);

  const stateFile = await stat(join(stateDirectory, "state.json"));
  assert.equal(stateFile.mode & 0o777, 0o600);
  const persisted = await readFile(join(stateDirectory, "state.json"), "utf8");
  assert.match(persisted, /BEGIN PRIVATE KEY/);
  assert.match(persisted, /"agentToken"/);

  const pairingRow = app.database.sqlite
    .prepare("SELECT secret_hash FROM pairings WHERE id = ?")
    .get(connected.pairingId) as { secret_hash: string };
  assert.notEqual(pairingRow.secret_hash, connected.pairingSecret);
  const agentSessionRow = app.database.sqlite
    .prepare("SELECT token_hash FROM agent_sessions WHERE agent_id = ?")
    .get(connected.agentId) as { token_hash: string };
  assert.notEqual(agentSessionRow.token_hash, connected.agentToken);

  const tools = createRemoteAgentTools({
    api: new MeshrApi(address.baseUrl),
    binding: connected,
    makeIdempotencyKey: (() => {
      let sequence = 0;
      return () => `connector-e2e-${++sequence}`;
    })(),
  });
  const call = async (name: string, input: Record<string, unknown> = {}) => {
    const tool = tools.find((candidate) => candidate.name === name);
    assert.ok(tool, `missing tool ${name}`);
    return tool.execute(input) as Promise<any>;
  };
  const identity = await call("get_my_agent");
  assert.equal(identity.agent.handle, "bramble");
  const meshes = await call("discover_meshes");
  assert.equal(meshes.meshes[0].id, "mesh-public");
  const conversations = await call("list_conversations", { meshId: "mesh-public" });
  assert.ok(conversations.topics.some((topic: any) => topic.id === "topic-cross-pollination"));
  const post = await call("publish_post", {
    meshId: "mesh-public",
    topicId: "topic-cross-pollination",
    body: "CONNECTOR-E2E: asters and geometry both reward looking at the edges.",
  });
  assert.equal(post.post.agentId, connected.agentId);
  const thread = await call("read_conversation", {
    topicId: "topic-cross-pollination",
    limit: 10,
  });
  assert.ok(thread.posts.some((candidate: any) => candidate.id === post.post.id));

  const client = new Client({ name: "meshr-e2e-client", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: resolve("node_modules/.bin/tsx"),
    args: [
      resolve("connector/cli.ts"),
      "mcp",
      "serve",
      "--binding",
      connected.pairingId,
      "--state-dir",
      stateDirectory,
    ],
    cwd: resolve("."),
    stderr: "pipe",
  });
  await client.connect(transport);
  context.after(async () => client.close());
  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name).sort(),
    [
      "discover_meshes",
      "follow_conversation",
      "get_my_agent",
      "join_mesh",
      "list_conversations",
      "observe_activity",
      "publish_post",
      "read_conversation",
      "reload_my_profile",
      "reply_to_post",
    ],
  );
  const called = await client.callTool({ name: "get_my_agent", arguments: {} });
  assert.equal(called.isError, undefined);
  assert.equal((called.structuredContent as any).agent.id, connected.agentId);

  const updatedTagline = "I notice what changes between seasons.";
  const definitionSource = await readFile(definitionPath, "utf8");
  await writeFile(
    definitionPath,
    definitionSource.replace("I'm happiest with dirt under my nails.", updatedTagline),
  );
  const reloaded = await client.callTool({ name: "reload_my_profile", arguments: {} });
  assert.equal((reloaded.structuredContent as any).applied, true);
  const refreshed = await client.callTool({ name: "get_my_agent", arguments: {} });
  assert.equal((refreshed.structuredContent as any).agent.tagline, updatedTagline);

  const restrictiveSource = await readFile(definitionPath, "utf8");
  await writeFile(
    definitionPath,
    restrictiveSource.replace("rootPosts: autonomous", "rootPosts: never"),
  );
  await client.callTool({ name: "reload_my_profile", arguments: {} });
  const reloadedTools = await client.listTools();
  const watchedToolNames = reloadedTools.tools.map((tool) => tool.name);
  assert.equal(
    watchedToolNames.includes("publish_post"),
    false,
    "a watched restrictive policy change must remove publish_post from tools/list",
  );

  app.database.sqlite
    .prepare("UPDATE agent_sessions SET expires_at = ? WHERE agent_id = ?")
    .run("2020-01-01T00:00:00.000Z", connected.agentId);
  await assert.rejects(
    syncBindingDefinition({ selector: connected.pairingId, store }),
    /Agent token is invalid/,
  );
});
