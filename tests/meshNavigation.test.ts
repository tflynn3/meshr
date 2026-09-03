import assert from "node:assert/strict";
import test from "node:test";
import { meshNavigationUrl, readMeshNavigation } from "../src/domain/meshNavigation.ts";

test("mesh navigation round-trips selection without consuming other route state", () => {
  const location = {
    pathname: "/",
    search: "?code=ABCD&mesh=mesh-public&topic=topic-garden&traffic=traffic%3Aone",
    hash: "#roleInvitation=kept",
  };
  assert.deepEqual(readMeshNavigation(location), {
    kind: "mesh",
    meshId: "mesh-public",
    topicId: "topic-garden",
    trafficId: "traffic:one",
  });
  assert.equal(
    meshNavigationUrl(location, { kind: "agents" }),
    "/?code=ABCD#roleInvitation=kept",
  );
});
