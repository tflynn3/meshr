import assert from "node:assert/strict";
import { test } from "node:test";
import { planPublication } from "../scripts/publish-npm-packages.mjs";

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
      "@meshr/mcp@0.1.0": { integrity: "sha512-different", shasum: "different" },
    }),
    /different integrity/,
  );
});
