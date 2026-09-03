import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { planPublication } from "../scripts/publish-npm-packages.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");

test("OpenClaw publication advertises only engine-strict dependency bands", () => {
  const packageJson = JSON.parse(
    readFileSync(resolve(repositoryRoot, "integrations/openclaw/package.json"), "utf8"),
  );
  const workflow = readFileSync(
    resolve(repositoryRoot, ".github/workflows/ci.yml"),
    "utf8",
  );
  const publishWorkflow = readFileSync(
    resolve(repositoryRoot, ".github/workflows/publish-packages.yml"),
    "utf8",
  );
  assert.equal(
    packageJson.engines?.node,
    ">=22.22.3 <23 || >=24.15.0 <25 || >=26.0.0 <27",
  );
  assert.match(
    workflow,
    /- node: "26\.x"\s+package: integrations\/openclaw/,
  );
  assert.doesNotMatch(
    workflow,
    /- node: "25\.x"\s+package: integrations\/openclaw/,
  );
  const workflowOpenClawPeer = publishWorkflow.match(
    /packageJson\.peerDependencies\?\.openclaw !== '([^']+)'/,
  )?.[1];
  assert.equal(workflowOpenClawPeer, packageJson.peerDependencies?.openclaw);
  for (const packageDirectory of ["packages/mcp", "integrations/openclaw"]) {
    const auditCommand = `npm audit --audit-level=high --prefix ${packageDirectory}`;
    assert.ok(workflow.includes(auditCommand), `CI must audit ${packageDirectory}`);
    assert.ok(publishWorkflow.includes(auditCommand), `publication must audit ${packageDirectory}`);
  }
});

test("resumable npm publication skips a verified first package and publishes the missing second package", () => {
  const artifacts = [
    {
      name: "@meshr/mcp",
      version: "0.1.0",
      directory: "packages/mcp",
      filename: "meshr-mcp-0.1.0.tgz",
      integrity: "sha512-mcp",
      shasum: "mcp",
    },
    {
      name: "@meshr/openclaw",
      version: "0.1.0",
      directory: "integrations/openclaw",
      filename: "meshr-openclaw-0.1.0.tgz",
      integrity: "sha512-openclaw",
      shasum: "openclaw",
    },
  ];
  const actions = planPublication(artifacts, {
    "@meshr/mcp@0.1.0": { integrity: "sha512-mcp", shasum: "mcp" },
    "@meshr/openclaw@0.1.0": null,
  });
  assert.deepEqual(actions.map((action) => action.action), ["skip", "publish"]);
});

test("resumable npm publication refuses an existing mismatched artifact", () => {
  assert.throws(
    () => planPublication([{
      name: "@meshr/mcp",
      version: "0.1.0",
      directory: "packages/mcp",
      filename: "meshr-mcp-0.1.0.tgz",
      integrity: "sha512-current",
      shasum: "current",
    }], {
      "@meshr/mcp@0.1.0": {
        integrity: "sha512-different",
        shasum: "different",
        contentsMatch: false,
      },
    }),
    /different package contents/,
  );
});

test("resumable npm publication accepts identical contents from a different npm tar encoding", () => {
  const actions = planPublication([{
    name: "@meshr/mcp",
    version: "0.1.0",
    directory: "packages/mcp",
    filename: "meshr-mcp-0.1.0.tgz",
    integrity: "sha512-npm-11",
    shasum: "npm-11",
  }], {
    "@meshr/mcp@0.1.0": {
      integrity: "sha512-npm-10",
      shasum: "npm-10",
      contentsMatch: true,
    },
  });

  assert.equal(actions[0]?.action, "skip");
});
