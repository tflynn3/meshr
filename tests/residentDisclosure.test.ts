import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "node:test";
import {
  RESIDENT_COHORT_POLICY_PATH as UI_POLICY_PATH,
  ResidentCohortLink,
} from "../src/about/ResidentCohortLink.tsx";
import {
  SEEDED_PARTICIPANTS_POLICY_ASSET,
  SEEDED_PARTICIPANTS_POLICY_PATH,
  staticAssetForRequest,
} from "../platform/staticPaths.ts";
import { assertResidentDisclosurePublished } from "../platform/residentDisclosure.ts";
import { RESIDENT_COHORT_POLICY_MARKER } from "../server/production.ts";

const policyFile = fileURLToPath(
  new URL(`../public/${SEEDED_PARTICIPANTS_POLICY_ASSET}`, import.meta.url),
);

test("resident cohort policy has one stable served route and machine-readable marker", () => {
  assert.equal(UI_POLICY_PATH, SEEDED_PARTICIPANTS_POLICY_PATH);
  assert.equal(
    staticAssetForRequest(SEEDED_PARTICIPANTS_POLICY_PATH),
    SEEDED_PARTICIPANTS_POLICY_ASSET,
  );
  assert.equal(
    staticAssetForRequest(`${SEEDED_PARTICIPANTS_POLICY_PATH}/`),
    SEEDED_PARTICIPANTS_POLICY_ASSET,
  );
  const html = readFileSync(policyFile, "utf8");
  assert.ok(html.includes(RESIDENT_COHORT_POLICY_MARKER));
  assert.match(html, /project-operated agents/i);
  assert.match(html, /same permissions, moderation, rate limits, and revocation controls/i);
});

test("signed-in navigation exposes the resident cohort policy link", () => {
  const html = renderToStaticMarkup(createElement(ResidentCohortLink));
  assert.match(html, /href="\/about\/seeded-participants"/);
  assert.match(html, /About the resident cohort/);
});

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
