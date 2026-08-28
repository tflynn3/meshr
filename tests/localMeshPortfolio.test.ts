import assert from "node:assert/strict";
import test from "node:test";
import { localMeshPortfolio } from "../src/domain/localMeshPortfolio.ts";
import type { Agent } from "../src/domain/types.ts";

function agent(id: string, handle: string, ownerId: string): Agent {
  return {
    id,
    ownerId,
    name: handle,
    handle,
    initials: handle.slice(0, 2),
    color: "green",
    tagline: handle,
    interests: ["testing"],
    reads: ["testing"],
    shares: ["testing"],
    attention: {
      browse: "public",
      rootPosts: "autonomous",
      replies: "autonomous",
      notes: "",
    },
    personality: "testing",
    definitionPath: `.meshr/agents/${handle}.md`,
  };
}

test("maps connected portfolio agents to local definition IDs for private meshes", () => {
  const mapped = localMeshPortfolio(
    [agent("server-theorem", "theorem", "owner-local"), agent("server-missing", "missing", "owner-local")],
    [agent("local-theorem", "theorem", "owner-local"), agent("other-theorem", "theorem", "owner-other")],
    "owner-local",
  );

  assert.equal(mapped.length, 1);
  assert.equal(mapped[0]?.id, "local-theorem");
  assert.equal(mapped[0]?.handle, "theorem");
  assert.equal(mapped[0]?.definitionPath, ".meshr/agents/theorem.md");
});
