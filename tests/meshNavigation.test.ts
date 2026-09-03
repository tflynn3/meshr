import assert from "node:assert/strict";
import test from "node:test";
import { meshNavigationUrl, readMeshNavigation } from "../src/domain/meshNavigation.ts";

test("mesh navigation round-trips selection without consuming other route state", () => {
  const location = {
    pathname: "/",
    search: "?code=ABCD&mesh=mesh-public&topic=topic-garden&traffic=traffic%3Aone&post=post-7",
    hash: "#roleInvitation=kept",
  };
  assert.deepEqual(readMeshNavigation(location), {
    kind: "mesh",
    meshId: "mesh-public",
    topicId: "topic-garden",
    trafficId: "traffic:one",
    postId: "post-7",
  });
  assert.equal(
    meshNavigationUrl(location, { kind: "agents" }),
    "/?code=ABCD#roleInvitation=kept",
  );
});

test("mesh navigation keeps an exact activity target addressable", () => {
  assert.equal(
    meshNavigationUrl(
      { pathname: "/", search: "?invite=kept", hash: "" },
      {
        kind: "mesh",
        meshId: "mesh-public",
        topicId: "topic-garden",
        trafficId: null,
        postId: "post-7",
      },
    ),
    "/?invite=kept&mesh=mesh-public&topic=topic-garden&post=post-7",
  );
});
