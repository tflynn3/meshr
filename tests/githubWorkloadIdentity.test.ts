import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../", import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, root), "utf8");
const variableBlock = (source: string, name: string): string => {
  const start = source.indexOf(`variable "${name}"`);
  assert.notEqual(start, -1, `missing Terraform variable ${name}`);
  const next = source.indexOf('\nvariable "', start + 1);
  return source.slice(start, next === -1 ? source.length : next);
};

test("production Workload Identity separates immutable build and deploy identities", () => {
  const terraform = read("infra/opentofu/main.tf");
  const variables = read("infra/opentofu/variables.tf");

  assert.match(variables, /variable "github_repository_id"/);
  assert.match(variables, /variable "github_repository_owner_id"/);
  assert.match(variables, /github_repository_id must contain only decimal digits/);
  assert.match(variables, /github_repository_owner_id must contain only decimal digits/);
  assert.doesNotMatch(variableBlock(variables, "github_repository_id"), /\bdefault\s*=/);
  assert.doesNotMatch(variableBlock(variables, "github_repository_owner_id"), /\bdefault\s*=/);
  assert.match(variableBlock(variables, "github_deploy_identity"), /default\s*=\s*null/);
  assert.match(
    terraform,
    /github_deploy_identity\s*=\s*var\.github_deploy_identity == null \? local\.github_build_identity : var\.github_deploy_identity/,
  );

  assert.match(
    terraform,
    /"attribute\.build_repository_id"\s*=\s*"assertion\.repository_id"/,
  );
  assert.equal(
    [
      ...terraform.matchAll(
        /assertion\.repository_id == '\$\{local\.github_build_identity\.repository_id\}'/g,
      ),
    ].length,
    1,
  );
  assert.equal(
    [
      ...terraform.matchAll(
        /assertion\.repository_owner_id == '\$\{local\.github_build_identity\.repository_owner_id\}'/g,
      ),
    ].length,
    1,
  );
  assert.equal(
    [
      ...terraform.matchAll(
        /assertion\.repository_id == '\$\{local\.github_deploy_identity\.repository_id\}'/g,
      ),
    ].length,
    2,
  );
  assert.equal(
    [
      ...terraform.matchAll(
        /assertion\.repository_owner_id == '\$\{local\.github_deploy_identity\.repository_owner_id\}'/g,
      ),
    ].length,
    2,
  );
  assert.match(
    terraform,
    /assertion\.workflow_ref == '\$\{local\.github_build_workflow_ref\}'/,
  );
  assert.equal(
    [
      ...terraform.matchAll(
        /assertion\.workflow_ref == '\$\{local\.github_deploy_workflow_ref\}'/g,
      ),
    ].length,
    2,
  );

  assert.match(
    terraform,
    /attribute\.build_repository_id\/\$\{local\.github_build_identity\.repository_id\}/,
  );
  assert.equal(
    [
      ...terraform.matchAll(
        /attribute\.release\/\$\{local\.github_deploy_identity\.repository_id\}:(?:canary|production)/g,
      ),
    ].length,
    2,
  );
  assert.equal(
    [
      ...terraform.matchAll(
        /"attribute\.release"\s*=\s*"assertion\.repository_id \+ ':' \+ assertion\.environment"/g,
      ),
    ].length,
    2,
  );

  assert.doesNotMatch(terraform, /assertion\.repository ==/);
  assert.doesNotMatch(terraform, /"attribute\.repository"\s*=/);
  assert.doesNotMatch(terraform, /"attribute\.repository_id"\s*=/);
});
