import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";

const terraformSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "infra", "opentofu", "main.tf"),
  "utf8",
);

/** Extract a balanced Terraform resource block without requiring a full HCL parser. */
function resourceBlocks(kind: string): Array<{ name: string; source: string }> {
  const matcher = new RegExp(`resource\\s+"${kind}"\\s+"([^"]+)"\\s*\\{`, "g");
  const blocks: Array<{ name: string; source: string }> = [];

  for (const match of terraformSource.matchAll(matcher)) {
    const start = match.index!;
    const openBrace = terraformSource.indexOf("{", start);
    let depth = 0;
    let end = terraformSource.length;
    for (let index = openBrace; index < terraformSource.length; index += 1) {
      if (terraformSource[index] === "{") depth += 1;
      if (terraformSource[index] === "}") {
        depth -= 1;
        if (depth === 0) {
          end = index + 1;
          break;
        }
      }
    }
    assert.equal(depth, 0, `unbalanced Terraform resource block for ${kind}.${match[1]}`);
    blocks.push({ name: match[1], source: terraformSource.slice(start, end) });
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
    const dependencies = policy.source.match(/depends_on\s*=\s*\[[\s\S]*?\]/)?.[0] ?? "";
    assert.match(dependencies, /google_project_service\.required/, `${policy.name} must wait for required APIs`);

    for (const metricName of metricNames) {
      const metricResource = metricResourceByName.get(metricName);
      assert.ok(metricResource, `${policy.name} references an undeclared log metric ${metricName}`);
      assert.match(
        dependencies,
        new RegExp(`google_logging_metric\\.${metricResource}\\b`),
        `${policy.name} must depend on google_logging_metric.${metricResource}`,
      );
    }
  }
});
