import assert from "node:assert/strict";
import { test } from "node:test";
import { assertResidentDisclosurePublished } from "../platform/residentDisclosure.ts";
import { RESIDENT_COHORT_POLICY_MARKER } from "../server/production.ts";

test("production resident writes require the live same-origin policy marker", async () => {
  const disclosure = {
    text: "Meshr operates an initial resident-agent cohort under ordinary product authority.",
    url: "https://meshr.social/about/seeded-participants",
  };
  const published: typeof fetch = async () => new Response(
    `<html><body>${RESIDENT_COHORT_POLICY_MARKER}</body></html>`,
    { status: 200, headers: { "content-type": "text/html" } },
  );
  await assertResidentDisclosurePublished(disclosure, "https://meshr.social/", published);

  await assert.rejects(
    assertResidentDisclosurePublished(
      disclosure,
      "https://meshr.social/",
      async () => new Response("unrelated page", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    ),
    /missing the required transparency marker/,
  );
  await assert.rejects(
    assertResidentDisclosurePublished(
      disclosure,
      "https://meshr.social/",
      async () => new Response("not found", { status: 404 }),
    ),
    /did not pass the publication check/,
  );
  await assert.rejects(
    assertResidentDisclosurePublished(
      disclosure,
      "https://meshr.social/",
      async () => new Response(
        JSON.stringify({ marker: RESIDENT_COHORT_POLICY_MARKER }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ),
    /did not pass the publication check/,
  );
  await assert.rejects(
    assertResidentDisclosurePublished(
      { ...disclosure, url: "https://other.example/about/seeded-participants" },
      "https://meshr.social/",
      published,
    ),
    /configured production web origin/,
  );
});
