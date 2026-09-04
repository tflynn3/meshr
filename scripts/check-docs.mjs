import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, normalize, resolve, sep } from "node:path";

const root = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const publicDocs = execFileSync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "*.md"],
  { cwd: root },
)
  .toString("utf8")
  .split("\0")
  .filter(Boolean)
  .filter((file) => existsSync(resolve(root, file)))
  .filter((file) => file !== "AGENTS.md" && !file.startsWith(".meshr/agents/"))
  .sort();

const failures = [];
const graph = new Map(publicDocs.map((file) => [file, new Set()]));
const knownDocs = new Set(publicDocs);
const scriptNames = new Set(Object.keys(packageJson.scripts));
const packageVersions = new Map([
  ["mcp", JSON.parse(readFileSync(resolve(root, "packages/mcp/package.json"), "utf8")).version],
  ["openclaw", JSON.parse(readFileSync(resolve(root, "integrations/openclaw/package.json"), "utf8")).version],
]);

function report(file, message) {
  failures.push(`${file}: ${message}`);
}

function markdownLinks(source) {
  const withoutFences = source
    .replace(/```[\s\S]*?```/g, "")
    .replace(/~~~[\s\S]*?~~~/g, "");
  return [...withoutFences.matchAll(/(!?)\[([^\]]*)\]\(([^)]+)\)/g)].map((match) => ({
    image: match[1] === "!",
    label: match[2].trim(),
    rawTarget: match[3].trim(),
  }));
}

function localTarget(file, rawTarget) {
  const unwrapped = rawTarget.startsWith("<") && rawTarget.endsWith(">")
    ? rawTarget.slice(1, -1)
    : rawTarget.split(/\s+["']/u, 1)[0];
  if (!unwrapped || unwrapped.startsWith("#") || /^[a-z][a-z0-9+.-]*:/iu.test(unwrapped)) {
    return undefined;
  }
  let decoded;
  try {
    decoded = decodeURIComponent(unwrapped.split("#", 1)[0].split("?", 1)[0]);
  } catch {
    report(file, `cannot decode link target ${rawTarget}`);
    return undefined;
  }
  if (!decoded) return undefined;
  const absolute = resolve(root, dirname(file), decoded);
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) {
    report(file, `link escapes the repository: ${rawTarget}`);
    return undefined;
  }
  return { absolute, relative: normalize(absolute.slice(root.length + 1)) };
}

for (const file of publicDocs) {
  const source = readFileSync(resolve(root, file), "utf8");
  for (const link of markdownLinks(source)) {
    if (link.image && link.label.length < 8) {
      report(file, `image needs meaningful alt text: ${link.rawTarget}`);
    }
    const target = localTarget(file, link.rawTarget);
    if (!target) continue;
    if (!existsSync(target.absolute)) {
      report(file, `missing local link target ${link.rawTarget}`);
      continue;
    }
    const resolvedTarget = statSync(target.absolute).isDirectory()
      ? normalize(`${target.relative}/README.md`)
      : target.relative;
    if (!link.image && extname(resolvedTarget).toLowerCase() === ".md" && knownDocs.has(resolvedTarget)) {
      graph.get(file).add(resolvedTarget);
    }
  }

  for (const match of source.matchAll(/\bnpm(?:\s+--silent)?\s+run\s+([a-z0-9:_-]+)/giu)) {
    if (!scriptNames.has(match[1])) report(file, `documents missing npm script ${match[1]}`);
  }

  if (!file.startsWith("docs/history/")) {
    for (const match of source.matchAll(/@meshr\/(mcp|openclaw)@(\d+\.\d+\.\d+)/gu)) {
      const expected = packageVersions.get(match[1]);
      if (match[2] !== expected) {
        report(file, `pins @meshr/${match[1]}@${match[2]}, package version is ${expected}`);
      }
    }
  }
}

const reachable = new Set(["README.md"]);
const pending = ["README.md"];
while (pending.length > 0) {
  const file = pending.pop();
  for (const target of graph.get(file) ?? []) {
    if (!reachable.has(target)) {
      reachable.add(target);
      pending.push(target);
    }
  }
}
for (const file of publicDocs) {
  if (!reachable.has(file)) report(file, "is not reachable from README.md");
}

const serverGuide = readFileSync(resolve(root, "server/README.md"), "utf8");
if (!serverGuide.includes(packageJson.engines.node)) {
  report("server/README.md", `must state the root Node engine ${packageJson.engines.node}`);
}

if (failures.length > 0) {
  console.error(`Documentation audit failed with ${failures.length} issue(s):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    `Documentation audit passed: ${publicDocs.length} Markdown files, ` +
      `${[...graph.values()].reduce((sum, links) => sum + links.size, 0)} local guide links.`,
  );
}
