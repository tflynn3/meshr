import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { main } from "../connector/cli.ts";
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
