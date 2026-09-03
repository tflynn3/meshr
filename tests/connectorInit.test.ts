import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  main,
  parseConnectorRuntime,
  verificationPageCommand,
} from "../connector/cli.ts";
import { parseMeshrAgentDefinition } from "../src/domain/agentDefinition.ts";

test("meshr init creates a restrictive, parseable starter definition", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meshr-init-"));
  const definitionPath = join(directory, "agents", "garden.md");
  await main([
    "init",
    "--handle",
    "garden",
    "--name",
    "Garden Observer",
    "--definition",
    definitionPath,
  ]);
  const source = await readFile(definitionPath, "utf8");
  const definition = parseMeshrAgentDefinition(source, definitionPath);
  assert.equal(definition.metadata.handle, "garden");
  assert.equal(definition.spec.attention.rootPosts, "draft");
  assert.equal(definition.spec.attention.replies, "draft");
  assert.equal((await stat(definitionPath)).mode & 0o777, 0o600);
  await assert.rejects(
    () => main(["init", "--handle", "garden", "--definition", definitionPath]),
    /Definition already exists/,
  );
});

test("generic MCP runtime aliases to the neutral public runtime and rejects Ollama", () => {
  assert.equal(parseConnectorRuntime("mcp"), "other");
  assert.equal(parseConnectorRuntime("other"), "other");
  assert.throws(
    () => parseConnectorRuntime("ollama"),
    /Ollama is a model provider used through an MCP-capable host/,
  );
});

test("approval URLs use non-interpreting launch commands and reject unsafe schemes", () => {
  assert.deepEqual(
    verificationPageCommand(
      "https://meshr.example/connect?code=ABCD-EFGH&next=review",
      "win32",
    ),
    {
      executable: "rundll32.exe",
      args: [
        "url.dll,FileProtocolHandler",
        "https://meshr.example/connect?code=ABCD-EFGH&next=review",
      ],
    },
  );
  assert.deepEqual(
    verificationPageCommand("http://127.0.0.1:5173/?code=ABCD-EFGH", "darwin"),
    {
      executable: "open",
      args: ["http://127.0.0.1:5173/?code=ABCD-EFGH"],
    },
  );
  assert.equal(verificationPageCommand("javascript:alert(1)", "win32"), null);
  assert.equal(verificationPageCommand("http://meshr.example/connect", "linux"), null);
  assert.equal(verificationPageCommand("https://user:secret@meshr.example/", "linux"), null);
});
