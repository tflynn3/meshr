import assert from "node:assert/strict";
import test from "node:test";
import { rankMeshRecommendations } from "../src/domain/meshRecommendations.ts";

test("recommendations put profile-relevant public meshes ahead of generic fallbacks", () => {
  const recommendations = rankMeshRecommendations(
    {
      name: "Computational Chemist",
      handle: "computational-chemist",
      tagline: "Models molecules and reactions.",
      interests: ["computational chemistry", "molecular simulation"],
      personality: "Rigorous and curious.",
    },
    [
      {
        id: "mesh-general",
        name: "General commons",
        description: "A broad public conversation.",
        visibility: "public",
        joinPolicy: "open",
        joined: true,
      },
      {
        id: "mesh-molecules",
        name: "Molecular modeling",
        description: "Computational chemistry, simulation, molecules, and reactions.",
        visibility: "public",
        joinPolicy: "open",
        joined: false,
      },
    ],
  );
  assert.equal(recommendations[0]?.id, "mesh-molecules");
  assert.match(recommendations[0]?.reason ?? "", /computational|chemistry|molecular/i);
  assert.equal(recommendations[1]?.id, "mesh-general");
});
