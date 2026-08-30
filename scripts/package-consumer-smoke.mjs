#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const directories = process.argv.slice(2).map((value) => resolve(value));
if (directories.length === 0) {
  throw new Error("Pass the package directories to smoke-test.");
}

const root = mkdtempSync(join(tmpdir(), "meshr-package-consumer-"));
const packDirectory = join(root, "packs");
const consumerDirectory = join(root, "consumer");
mkdirSync(packDirectory, { recursive: true, mode: 0o700 });
mkdirSync(consumerDirectory, { recursive: true, mode: 0o700 });

try {
  const tarballs = [];
  const packageNames = [];
  for (const directory of directories) {
    const packageJson = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    const output = execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", packDirectory], {
      cwd: directory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const record = JSON.parse(output)[0];
    if (!record?.filename || record.name !== packageJson.name || record.version !== packageJson.version) {
      throw new Error(`Unexpected npm pack result for ${directory}.`);
    }
    tarballs.push(join(packDirectory, record.filename));
    packageNames.push(packageJson.name);
  }

  writeFileSync(join(consumerDirectory, "package.json"), `${JSON.stringify({
    name: "meshr-package-consumer-smoke",
    private: true,
    type: "module",
  }, null, 2)}\n`, { mode: 0o600 });
  // Keep peer resolution enabled: importing the published OpenClaw entry
  // must exercise the real plugin-sdk peer rather than a tarball that only
  // works inside the package's development node_modules.
  execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...tarballs], {
    cwd: consumerDirectory,
    stdio: ["ignore", "pipe", "pipe"],
  });
  execFileSync(process.execPath, ["--input-type=module", "-e", [
    packageNames.includes("@meshr/mcp")
      ? "const mcp = await import('@meshr/mcp');\nif (typeof mcp.createMeshrMcpServer !== 'function') throw new Error('MCP export missing');"
      : "",
    packageNames.includes("@meshr/openclaw")
      ? "const openclaw = await import('@meshr/openclaw');\nif (!openclaw.default || openclaw.default.id !== 'meshr') throw new Error('OpenClaw plugin export missing');"
      : "",
  ].join("\n")], { cwd: consumerDirectory, stdio: ["ignore", "pipe", "pipe"] });
  if (packageNames.includes("@meshr/mcp")) {
    const mcpBin = join(consumerDirectory, "node_modules", ".bin", "meshr-mcp");
    execFileSync(mcpBin, ["--help"], { cwd: consumerDirectory, stdio: ["ignore", "pipe", "pipe"] });
  }
  if (packageNames.includes("@meshr/openclaw")) {
    const openClawRoot = join(consumerDirectory, "node_modules", "@meshr", "openclaw");
    const manifest = JSON.parse(readFileSync(join(openClawRoot, "openclaw.plugin.json"), "utf8"));
    if (manifest.id !== "meshr") throw new Error("Packed OpenClaw manifest id mismatch");
    const extension = JSON.parse(readFileSync(join(openClawRoot, "package.json"), "utf8"))?.openclaw?.extensions?.[0];
    if (typeof extension !== "string" || !extension) throw new Error("Packed OpenClaw extension is missing");
    const extensionPath = join(openClawRoot, extension);
    execFileSync(process.execPath, ["--input-type=module", "-e", [
      `const plugin = (await import(${JSON.stringify(extensionPath)})).default;`,
      "if (!plugin || plugin.id !== 'meshr' || typeof plugin.register !== 'function') throw new Error('Packed OpenClaw runtime entry invalid');",
    ].join("\n")], { cwd: consumerDirectory, stdio: ["ignore", "pipe", "pipe"] });
  }
  process.stdout.write(`${JSON.stringify({ ok: true, packages: directories }, null, 2)}\n`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
