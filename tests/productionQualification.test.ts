import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assertPrivateProductionManifest } from "../scripts/check-production-qualification.ts";

const root = new URL("../", import.meta.url);

test("private production overlay reuses runtime security without edge resources", () => {
  const overlay = readFileSync(
    new URL("deploy/production-qualification/kustomization.yaml", root),
    "utf8",
  );
  for (const resource of [
    "serviceaccounts.yaml",
    "config.yaml",
    "secrets.yaml",
    "bootstrap.yaml",
    "workloads.yaml",
    "networkpolicy.yaml",
  ]) {
    assert.match(
      overlay,
      new RegExp(`../production/${resource.replace(".", "\\.")}`),
    );
  }
  assert.doesNotMatch(overlay, /\.\.\/production\/namespace\.yaml/);
  assert.doesNotMatch(
    overlay,
    /gateway\.yaml|backendpolicy\.yaml|healthchecks\.yaml/,
  );
  assert.match(
    overlay,
    /MESHR_TRUST_CLOUDFLARE_CONNECTING_IP:\s*"0"/,
  );
});

test("private production manifest accepts only internal service exposure", () => {
  const safe = `
apiVersion: v1
kind: ConfigMap
metadata: {name: meshr-runtime}
data:
  MESHR_TRUST_CLOUDFLARE_CONNECTING_IP: "0"
---
apiVersion: v1
kind: Service
metadata: {name: api}
spec:
  type: ClusterIP
  ports: [{port: 8787}]
---
apiVersion: apps/v1
kind: Deployment
metadata: {name: api}
spec:
  template:
    spec:
      containers: [{name: api, image: example.invalid/api@sha256:test}]
`;
  assert.deepEqual(assertPrivateProductionManifest(safe), {
    resources: 3,
    services: 1,
  });

  for (const manifest of [
    safe.replace("type: ClusterIP", "type: LoadBalancer"),
    safe.replace(
      "ports: [{port: 8787}]",
      "externalIPs: [203.0.113.10]\n  ports: [{port: 8787}]",
    ),
    safe.replace(
      "ports: [{port: 8787}]",
      "ports: [{port: 8787, nodePort: 30080}]",
    ),
    safe.replace("kind: Deployment", "kind: Gateway"),
    safe.replace("kind: Deployment", "kind: Ingress"),
    safe.replace(
      'MESHR_TRUST_CLOUDFLARE_CONNECTING_IP: "0"',
      'MESHR_TRUST_CLOUDFLARE_CONNECTING_IP: "1"',
    ),
    safe.replace("metadata: {name: meshr-runtime}", "metadata: {name: other}"),
    safe.replace(
      "containers: [{name: api, image: example.invalid/api@sha256:test}]",
      'containers: [{name: api, image: example.invalid/api@sha256:test, env: [{name: MESHR_TRUST_CLOUDFLARE_CONNECTING_IP, value: "1"}]}]',
    ),
    safe.replace("containers:", "hostNetwork: true\n      containers:"),
    safe.replace(
      "image: example.invalid/api@sha256:test",
      "image: example.invalid/api@sha256:test, ports: [{containerPort: 8787, hostPort: 8787}]",
    ),
  ]) {
    assert.throws(() => assertPrivateProductionManifest(manifest));
  }
});
