import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";

const terraformSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "infra", "opentofu", "main.tf"),
  "utf8",
);

/** Find the end of a balanced HCL expression while ignoring strings/comments. */
function balancedEnd(source: string, openIndex: number, open: string, close: string): number {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = openIndex; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];

    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quoted) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        quoted = false;
      }
      continue;
    }
    if (character === '"') {
      quoted = true;
    } else if (character === "#" || (character === "/" && next === "/")) {
      lineComment = true;
      if (character === "/") index += 1;
    } else if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
    } else if (character === open) {
      depth += 1;
    } else if (character === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return -1;
}

/** Extract a balanced Terraform resource block without requiring a full HCL parser. */
function resourceBlocks(kind: string): Array<{ name: string; source: string }> {
  const matcher = new RegExp(`resource\\s+"${kind}"\\s+"([^"]+)"\\s*\\{`, "g");
  const blocks: Array<{ name: string; source: string }> = [];

  for (const match of terraformSource.matchAll(matcher)) {
    const start = match.index!;
    const openBrace = terraformSource.indexOf("{", start);
    const closeBrace = balancedEnd(terraformSource, openBrace, "{", "}");
    assert.notEqual(closeBrace, -1, `unbalanced Terraform resource block for ${kind}.${match[1]}`);
    blocks.push({ name: match[1], source: terraformSource.slice(start, closeBrace + 1) });
  }

  return blocks;
}

test("every log-based monitoring alert waits for its metric descriptor", () => {
  const metricResourceByName = new Map<string, string>();
  for (const metric of resourceBlocks("google_logging_metric")) {
    const name = metric.source.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1];
    assert.ok(name, `logging metric ${metric.name} must declare a name`);
    metricResourceByName.set(name, metric.name);
  }

  const policies = resourceBlocks("google_monitoring_alert_policy");
  const logMetricPolicies = policies.filter((policy) => policy.source.includes("logging.googleapis.com/user/"));
  assert.ok(logMetricPolicies.length > 0, "expected at least one log-based monitoring policy");

  for (const policy of logMetricPolicies) {
    const metricNames = [...policy.source.matchAll(/logging\.googleapis\.com\/user\/([A-Za-z0-9_-]+)/g)].map(
      (match) => match[1],
    );
    const dependsStart = policy.source.indexOf("depends_on");
    assert.notEqual(dependsStart, -1, `${policy.name} must declare depends_on`);
    const dependsOpen = policy.source.indexOf("[", dependsStart);
    const dependsClose = balancedEnd(policy.source, dependsOpen, "[", "]");
    assert.notEqual(dependsClose, -1, `${policy.name} has an unbalanced depends_on list`);
    const dependencies = policy.source.slice(dependsOpen + 1, dependsClose);
    const activeDependencies = dependencies
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((line) => line.replace(/#.*$/, "").replace(/\/\/.*$/, "").trim())
      .filter(Boolean)
      .join("\n");
    assert.match(activeDependencies, /google_project_service\.required/, `${policy.name} must wait for required APIs`);

    for (const metricName of metricNames) {
      const metricResource = metricResourceByName.get(metricName);
      assert.ok(metricResource, `${policy.name} references an undeclared log metric ${metricName}`);
      assert.match(
        activeDependencies,
        new RegExp(`google_logging_metric\\.${metricResource}\\b`),
        `${policy.name} must depend on google_logging_metric.${metricResource}`,
      );
    }
  }
});
