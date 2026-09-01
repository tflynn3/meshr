import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const CLOUDFLARE_IPV4_URL = "https://www.cloudflare.com/ips-v4";
export const CLOUDFLARE_IPV6_URL = "https://www.cloudflare.com/ips-v6";

const MAX_RANGE_RESPONSE_BYTES = 64 * 1024;

export interface CloudflareRangeManifest {
  ipv4: string[];
  ipv4Primary: string[];
  ipv4Secondary: string[];
  ipv6Primary: string[];
  ipv6Secondary: string[];
}

export interface CloudflareRangeDrift {
  missingIpv4: string[];
  unexpectedIpv4: string[];
  missingIpv6: string[];
  unexpectedIpv6: string[];
  splitErrors: string[];
}

const sortedUnique = (values: readonly string[]): string[] =>
  [...new Set(values)].sort((left, right) => left.localeCompare(right));

const difference = (left: readonly string[], right: readonly string[]): string[] => {
  const rightSet = new Set(right);
  return sortedUnique(left.filter((value) => !rightSet.has(value)));
};

const parseCidr = (value: string, version: 4 | 6): string => {
  const match = value.match(/^([^/]+)\/(\d{1,3})$/);
  if (!match) {
    throw new Error(`invalid IPv${version} CIDR in public range data`);
  }
  const address = match[1]!;
  const prefix = Number(match[2]);
  const maximum = version === 4 ? 32 : 128;
  if (isIP(address) !== version || prefix < 0 || prefix > maximum) {
    throw new Error(`invalid IPv${version} CIDR in public range data`);
  }
  return value;
};

export const parsePublishedRanges = (body: string, version: 4 | 6): string[] => {
  if (Buffer.byteLength(body, "utf8") > MAX_RANGE_RESPONSE_BYTES) {
    throw new Error(`Cloudflare IPv${version} range response exceeded the size limit`);
  }
  const ranges = body
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => parseCidr(line, version));
  if (ranges.length === 0) {
    throw new Error(`Cloudflare IPv${version} range response was empty`);
  }
  if (new Set(ranges).size !== ranges.length) {
    throw new Error(`Cloudflare IPv${version} range response contained duplicates`);
  }
  return ranges;
};

const extractHclStringList = (source: string, localName: string): string[] => {
  const match = source.match(
    new RegExp(`\\b${localName}\\s*=\\s*\\[([\\s\\S]*?)\\n\\s*\\]`),
  );
  if (!match) {
    throw new Error(`missing ${localName} in infra/opentofu/main.tf`);
  }
  const withoutComments = match[1]!.replace(/#.*$/gmu, "");
  const values = [...withoutComments.matchAll(/"([^"]+)"/g)].map(
    ([, value]) => value!,
  );
  const residue = withoutComments.replace(/"[^"]+"/g, "").replace(/[\s,]/g, "");
  if (values.length === 0 || residue.length > 0) {
    throw new Error(`could not safely parse ${localName} in infra/opentofu/main.tf`);
  }
  return values;
};

export const readCloudflareRangeManifest = (
  source: string,
): CloudflareRangeManifest => ({
  ipv4: extractHclStringList(source, "cloudflare_edge_ipv4"),
  ipv4Primary: extractHclStringList(source, "cloudflare_edge_ipv4_primary"),
  ipv4Secondary: extractHclStringList(source, "cloudflare_edge_ipv4_secondary"),
  ipv6Primary: extractHclStringList(source, "cloudflare_edge_ipv6_primary"),
  ipv6Secondary: extractHclStringList(source, "cloudflare_edge_ipv6_secondary"),
});

export const compareCloudflareRanges = (
  manifest: CloudflareRangeManifest,
  publishedIpv4: readonly string[],
  publishedIpv6: readonly string[],
): CloudflareRangeDrift => {
  for (const range of manifest.ipv4) parseCidr(range, 4);
  for (const range of [...manifest.ipv4Primary, ...manifest.ipv4Secondary]) {
    parseCidr(range, 4);
  }
  for (const range of [...manifest.ipv6Primary, ...manifest.ipv6Secondary]) {
    parseCidr(range, 6);
  }

  const configuredIpv4Split = [
    ...manifest.ipv4Primary,
    ...manifest.ipv4Secondary,
  ];
  const configuredIpv6 = [...manifest.ipv6Primary, ...manifest.ipv6Secondary];
  const splitErrors: string[] = [];
  if (new Set(manifest.ipv4).size !== manifest.ipv4.length) {
    splitErrors.push("the canonical IPv4 Cloudflare list contains duplicate CIDRs");
  }
  if (manifest.ipv4Primary.length > 10 || manifest.ipv4Secondary.length > 10) {
    splitErrors.push("an IPv4 Cloud Armor rule contains more than 10 CIDRs");
  }
  if (manifest.ipv6Primary.length > 10 || manifest.ipv6Secondary.length > 10) {
    splitErrors.push("an IPv6 Cloud Armor rule contains more than 10 CIDRs");
  }
  if (
    new Set(configuredIpv4Split).size !== configuredIpv4Split.length ||
    difference(manifest.ipv4, configuredIpv4Split).length > 0 ||
    difference(configuredIpv4Split, manifest.ipv4).length > 0
  ) {
    splitErrors.push("the IPv4 Cloud Armor split does not exactly match its canonical list");
  }
  if (new Set(configuredIpv6).size !== configuredIpv6.length) {
    splitErrors.push("the IPv6 Cloud Armor split contains duplicate CIDRs");
  }

  return {
    missingIpv4: difference(publishedIpv4, manifest.ipv4),
    unexpectedIpv4: difference(manifest.ipv4, publishedIpv4),
    missingIpv6: difference(publishedIpv6, configuredIpv6),
    unexpectedIpv6: difference(configuredIpv6, publishedIpv6),
    splitErrors,
  };
};

const fetchPublishedRangeText = async (url: string): Promise<string> => {
  const response = await fetch(url, {
    headers: { accept: "text/plain" },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Cloudflare range endpoint returned HTTP ${response.status}`);
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("text/plain")) {
    throw new Error("Cloudflare range endpoint returned an unexpected content type");
  }
  return response.text();
};

export const assertNoCloudflareRangeDrift = (
  drift: CloudflareRangeDrift,
): void => {
  const issues = [
    ...drift.missingIpv4.map((range) => `missing IPv4 range ${range}`),
    ...drift.unexpectedIpv4.map((range) => `unexpected IPv4 range ${range}`),
    ...drift.missingIpv6.map((range) => `missing IPv6 range ${range}`),
    ...drift.unexpectedIpv6.map((range) => `unexpected IPv6 range ${range}`),
    ...drift.splitErrors,
  ];
  assert.equal(
    issues.length,
    0,
    `Cloudflare origin-range drift detected:\n- ${issues.join("\n- ")}`,
  );
};

export const main = async (): Promise<void> => {
  const root = resolve(import.meta.dirname, "..");
  const source = await readFile(resolve(root, "infra/opentofu/main.tf"), "utf8");
  const [ipv4Body, ipv6Body] = await Promise.all([
    fetchPublishedRangeText(CLOUDFLARE_IPV4_URL),
    fetchPublishedRangeText(CLOUDFLARE_IPV6_URL),
  ]);
  const publishedIpv4 = parsePublishedRanges(ipv4Body, 4);
  const publishedIpv6 = parsePublishedRanges(ipv6Body, 6);
  const manifest = readCloudflareRangeManifest(source);
  assertNoCloudflareRangeDrift(
    compareCloudflareRanges(manifest, publishedIpv4, publishedIpv6),
  );
  process.stdout.write(
    `Cloudflare origin ranges match the published lists (${publishedIpv4.length} IPv4, ${publishedIpv6.length} IPv6).\n`,
  );
};

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown failure";
    process.stderr.write(`Cloudflare range check failed: ${message}\n`);
    process.exitCode = 1;
  });
}
