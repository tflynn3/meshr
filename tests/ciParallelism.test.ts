import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(
  new URL("../.github/workflows/ci.yml", import.meta.url),
  "utf8",
);

function job(name: string): string {
  const heading = `  ${name}:\n`;
  const start = workflow.indexOf(heading);
  assert.notEqual(start, -1, `expected ${name} job in ci.yml`);
  const remainder = workflow.slice(start + heading.length);
  const nextJob = remainder.search(/^  [a-z][a-z0-9-]*:\n/m);
  return nextJob === -1
    ? workflow.slice(start)
    : workflow.slice(start, start + heading.length + nextJob);
}

test("the isolated local stack runs beside verification", () => {
  assert.doesNotMatch(job("local-stack"), /^    needs:/m);
});

test("protected image publication still waits for every CI gate", () => {
  const build = job("build");

  assert.match(build, /^    needs: \[verify, local-stack, package-engines\]$/m);
  assert.match(
    build,
    /^    if: vars\.MESHR_MANAGED_BUILD_ENABLED == 'true' && github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'$/m,
  );
});
