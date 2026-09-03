import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { main } from "../connector/cli.ts";
import { ConnectorStateStore } from "../connector/state.ts";
import { createMeshrServer } from "../server/app.ts";

async function requestJson(
  baseUrl: string,
  path: string,
  options: { method?: string; body?: unknown; cookie?: string; csrf?: string } = {},
) {
  const headers = new Headers({ accept: "application/json" });
  if (options.body !== undefined) headers.set("content-type", "application/json");
  if (options.cookie) headers.set("cookie", options.cookie);
  if (options.csrf) headers.set("x-meshr-csrf", options.csrf);
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { response, json: await response.json() as Record<string, any> };
}

test("guided setup creates, approves, claims, and safely reuses one generic MCP binding", async (context) => {
  const temporary = await mkdtemp(join(tmpdir(), "meshr-guided-setup-"));
  const definitionPath = join(temporary, "garden.md");
  const stateDirectory = join(temporary, "state");
  const app = createMeshrServer({
    dbPath: join(temporary, "meshr.sqlite"),
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
      email: "guided-setup@example.test",
      password: "correct horse battery staple",
      displayName: "Guided Setup Owner",
    },
  });
  assert.equal(account.response.status, 201);
  const cookie = (account.response.headers.get("set-cookie") ?? "").split(";", 1)[0] ?? "";
  const csrf = String(account.json.csrfToken);
  const opened: string[] = [];
  let approvalWaits = 0;
  const setupArguments = [
    "setup",
    "mcp",
    "garden",
    "--server",
    address.baseUrl,
    "--definition",
    definitionPath,
    "--state-dir",
    stateDirectory,
  ];
  const hooks = {
    openVerificationPage(verificationUri: string) {
      opened.push(verificationUri);
      return true;
    },
    async waitForPairingApproval({ pairingId }: { pairingId: string }) {
      approvalWaits += 1;
      const approved = await requestJson(
        address.baseUrl,
        `/v1/pairings/${encodeURIComponent(pairingId)}/approve`,
        {
          method: "POST",
          body: { acknowledgeAutonomous: true },
          cookie,
          csrf,
        },
      );
      assert.equal(approved.response.status, 200);
    },
  };

  await main(setupArguments, hooks);
  const store = new ConnectorStateStore(stateDirectory, { useKeychain: false });
  const first = await store.require("garden");
  assert.equal(first.status, "connected");
  assert.equal(first.runtime, "other");
  assert.equal(first.externalSubject, "other:garden");
  assert.equal(first.verificationUri, opened[0]);
  assert.match(await readFile(definitionPath, "utf8"), /handle: garden/);

  await main(setupArguments, hooks);
  const state = await store.load();
  assert.equal(state.bindings.length, 1);
  assert.equal(approvalWaits, 1);
  assert.equal(opened.length, 1);
  assert.equal((await store.require("garden")).agentId, first.agentId);
});
