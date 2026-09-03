#!/usr/bin/env node

/**
 * Publish the release packages in a resumable order. A package version that
 * already exists is only skipped when the registry tarball has the same
 * integrity or npm confirms that its unpacked package contents are identical.
 * The content fallback handles byte-level tarball differences between npm
 * versions without accepting a mismatched release.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function packPackage(directory) {
  const packageJson = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  const output = run("npm", ["pack", "--json", "--ignore-scripts"], { cwd: directory });
  const records = JSON.parse(output);
  const record = Array.isArray(records) ? records[0] : undefined;
  if (!record?.filename || record.name !== packageJson.name || record.version !== packageJson.version) {
    throw new Error(`npm pack returned an unexpected artifact for ${directory}.`);
  }
  if (!record.integrity && !record.shasum) {
    throw new Error(`npm pack did not return an integrity digest for ${packageJson.name}@${packageJson.version}.`);
  }
  return {
    name: packageJson.name,
    version: packageJson.version,
    directory,
    filename: record.filename,
    integrity: record.integrity ?? null,
    shasum: record.shasum ?? null,
  };
}

function registryRecord(name, version) {
  const spec = `${name}@${version}`;
  const result = spawnSync("npm", ["view", spec, "dist.integrity", "dist.shasum", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status === 0) {
    const value = result.stdout.trim();
    if (!value || value === "null") return null;
    const parsed = JSON.parse(value);
    if (typeof parsed === "string") return { integrity: parsed, shasum: null };
    return {
      integrity: typeof parsed?.integrity === "string" ? parsed.integrity : null,
      shasum: typeof parsed?.shasum === "string" ? parsed.shasum : null,
    };
  }
  const errorText = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (/E404|not[ -]?found|no such package/i.test(errorText)) return null;
  throw new Error(`Unable to inspect ${spec} on npm: ${errorText.trim() || "registry request failed"}`);
}

function registryContentsMatch(artifact) {
  const spec = `${artifact.name}@${artifact.version}`;
  const result = spawnSync(
    "npm",
    ["diff", "--diff", spec, "--diff", artifact.directory],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.status !== 0) {
    const errorText = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    throw new Error(`Unable to compare ${spec} with the release package: ${errorText || "npm diff failed"}`);
  }
  return result.stdout.trim() === "";
}

/**
 * Return the idempotent action for every artifact. `records` is injectable so
 * the exact partial-publish behavior can be tested without network access.
 */
function planPublication(artifacts, records) {
  return artifacts.map((artifact) => {
    const existing = records[`${artifact.name}@${artifact.version}`] ?? null;
    if (!existing) return { action: "publish", artifact };
    const integrityMatches = artifact.integrity && existing.integrity
      ? artifact.integrity === existing.integrity
      : false;
    const shasumMatches = artifact.shasum && existing.shasum
      ? artifact.shasum === existing.shasum
      : false;
    if (!integrityMatches && !shasumMatches && existing.contentsMatch !== true) {
      throw new Error(
        `${artifact.name}@${artifact.version} already exists with different package contents; refusing to publish or skip it.`,
      );
    }
    return { action: "skip", artifact, existing };
  });
}

function main() {
  const directories = process.argv.slice(2).map((directory) => resolve(directory));
  if (directories.length === 0) {
    throw new Error("Pass at least one package directory to publish.");
  }
  const artifacts = directories.map(packPackage);
  const records = Object.fromEntries(artifacts.map((artifact) => {
    const key = `${artifact.name}@${artifact.version}`;
    const existing = registryRecord(artifact.name, artifact.version);
    if (!existing) return [key, null];
    const integrityMatches = artifact.integrity && existing.integrity
      ? artifact.integrity === existing.integrity
      : false;
    const shasumMatches = artifact.shasum && existing.shasum
      ? artifact.shasum === existing.shasum
      : false;
    return [key, {
      ...existing,
      contentsMatch: integrityMatches || shasumMatches
        ? undefined
        : registryContentsMatch(artifact),
    }];
  }));
  const actions = planPublication(artifacts, records);
  for (const plan of actions) {
    const { artifact } = plan;
    const tarball = join(artifact.directory, artifact.filename);
    try {
      if (plan.action === "skip") {
        console.log(`already published and verified: ${artifact.name}@${artifact.version}`);
        continue;
      }
      console.log(`publishing: ${artifact.name}@${artifact.version}`);
      run("npm", ["publish", tarball, "--provenance", "--access", "public"], {
        cwd: artifact.directory,
        stdio: ["ignore", "inherit", "inherit"],
      });
    } finally {
      try { unlinkSync(tarball); } catch { /* npm pack cleanup is best effort */ }
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    console.error(`[meshr] npm package publication failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

export { planPublication };
