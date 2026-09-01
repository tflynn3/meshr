import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  assertNoCloudflareRangeDrift,
  compareCloudflareRanges,
  parsePublishedRanges,
  readCloudflareRangeManifest,
} from "../scripts/check-cloudflare-ip-ranges.ts";

const root = new URL("../", import.meta.url);
const source = readFileSync(new URL("infra/opentofu/main.tf", root), "utf8");

test("checked-in Cloudflare ranges and Cloud Armor splits are internally exact", () => {
  const manifest = readCloudflareRangeManifest(source);
  assert.equal(manifest.ipv4.length, 15);
  assert.equal(manifest.ipv4Primary.length, 10);
  assert.equal(manifest.ipv4Secondary.length, 5);
  assert.equal(manifest.ipv6Primary.length, 4);
  assert.equal(manifest.ipv6Secondary.length, 3);

  const drift = compareCloudflareRanges(
    manifest,
    manifest.ipv4,
    [...manifest.ipv6Primary, ...manifest.ipv6Secondary],
  );
  assert.deepEqual(drift, {
    missingIpv4: [],
    unexpectedIpv4: [],
    missingIpv6: [],
    unexpectedIpv6: [],
    splitErrors: [],
  });
  assert.doesNotThrow(() => assertNoCloudflareRangeDrift(drift));
});

test("Cloudflare range comparison reports published drift and split drift", () => {
  const manifest = readCloudflareRangeManifest(source);
  const drift = compareCloudflareRanges(
    {
      ...manifest,
      ipv4Secondary: manifest.ipv4Secondary.slice(1),
    },
    [...manifest.ipv4, "192.0.2.0/24"],
    [...manifest.ipv6Primary, ...manifest.ipv6Secondary].slice(0, -1),
  );
  assert.deepEqual(drift.missingIpv4, ["192.0.2.0/24"]);
  assert.deepEqual(drift.unexpectedIpv6, [manifest.ipv6Secondary.at(-1)]);
  assert.match(drift.splitErrors.join("\n"), /does not exactly match/);
  assert.throws(
    () => assertNoCloudflareRangeDrift(drift),
    /Cloudflare origin-range drift detected/,
  );
});

test("published Cloudflare parsing rejects empty, duplicate, and wrong-family data", () => {
  assert.deepEqual(
    parsePublishedRanges("192.0.2.0/24\n198.51.100.0/24\n", 4),
    ["192.0.2.0/24", "198.51.100.0/24"],
  );
  assert.throws(() => parsePublishedRanges("\n", 4), /was empty/);
  assert.throws(
    () => parsePublishedRanges("192.0.2.0/24\n192.0.2.0/24\n", 4),
    /duplicates/,
  );
  assert.throws(
    () => parsePublishedRanges("2001:db8::/32\n", 4),
    /invalid IPv4 CIDR/,
  );
});
