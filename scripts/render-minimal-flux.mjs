#!/usr/bin/env node

import { readFileSync } from "node:fs";
import process from "node:process";
import { parseAllDocuments, stringify } from "yaml";

const [installPath] = process.argv.slice(2);
if (!installPath) {
  throw new Error(
    "usage: node scripts/render-minimal-flux.mjs <verified-install.yaml>",
  );
}

const namespace = "flux-system";
const sourceImageTag = "ghcr.io/fluxcd/source-controller:v1.9.5";
const sourceImage =
  "ghcr.io/fluxcd/source-controller@sha256:6f20d232d596a758c923d2861f23511718fc303b8a2e36a1434a7c736b9f4268";
const kustomizeImageTag = "ghcr.io/fluxcd/kustomize-controller:v1.9.5";
const kustomizeImage =
  "ghcr.io/fluxcd/kustomize-controller@sha256:a3a955eb2bc432c2eaa94d2d3714e3beae7fdf17586fd23aadf71ab597ac3339";

const requiredCrds = new Set([
  "buckets.source.toolkit.fluxcd.io",
  "externalartifacts.source.toolkit.fluxcd.io",
  "gitrepositories.source.toolkit.fluxcd.io",
  "helmcharts.source.toolkit.fluxcd.io",
  "helmrepositories.source.toolkit.fluxcd.io",
  "kustomizations.kustomize.toolkit.fluxcd.io",
  "ocirepositories.source.toolkit.fluxcd.io",
]);

const requiredNamespaced = new Set([
  "ResourceQuota/critical-pods",
  "ServiceAccount/kustomize-controller",
  "ServiceAccount/source-controller",
  "Service/source-controller",
  "Deployment/kustomize-controller",
  "Deployment/source-controller",
  "NetworkPolicy/allow-egress",
]);

const upstream = parseAllDocuments(readFileSync(installPath, "utf8")).map(
  (document) => {
    if (document.errors.length > 0) {
      throw document.errors[0];
    }
    return document.toJS();
  },
);

const selected = upstream.filter((resource) => {
  if (!resource) return false;
  if (resource.kind === "Namespace") {
    return resource.metadata?.name === namespace;
  }
  if (resource.kind === "CustomResourceDefinition") {
    return requiredCrds.has(resource.metadata?.name);
  }
  return (
    resource.metadata?.namespace === namespace &&
    requiredNamespaced.has(`${resource.kind}/${resource.metadata?.name}`)
  );
});

const expectedCount = 1 + requiredCrds.size + requiredNamespaced.size;
if (selected.length !== expectedCount) {
  throw new Error(
    `verified Flux asset selection changed: expected ${expectedCount} resources, got ${selected.length}`,
  );
}

const selectedKeys = new Set(
  selected.map((resource) =>
    resource.kind === "CustomResourceDefinition"
      ? `CustomResourceDefinition/${resource.metadata.name}`
      : `${resource.kind}/${resource.metadata.name}`,
  ),
);
for (const name of requiredCrds) {
  if (!selectedKeys.has(`CustomResourceDefinition/${name}`)) {
    throw new Error(`verified Flux asset is missing CRD ${name}`);
  }
}
for (const key of requiredNamespaced) {
  if (!selectedKeys.has(key)) {
    throw new Error(`verified Flux asset is missing ${key}`);
  }
}

function hardenDeployment(resource) {
  if (resource.kind !== "Deployment") return;
  const container = resource.spec?.template?.spec?.containers?.[0];
  if (!container || container.name !== "manager") {
    throw new Error(`${resource.metadata.name} controller shape changed`);
  }

  const expectedTag =
    resource.metadata.name === "source-controller"
      ? sourceImageTag
      : kustomizeImageTag;
  const pinnedImage =
    resource.metadata.name === "source-controller"
      ? sourceImage
      : kustomizeImage;
  if (container.image !== expectedTag) {
    throw new Error(
      `${resource.metadata.name} image changed from reviewed tag ${expectedTag}`,
    );
  }
  container.image = pinnedImage;
  container.resources = {
    limits: {
      cpu: "500m",
      memory: "1Gi",
      "ephemeral-storage": "1Gi",
    },
    requests: {
      cpu: "500m",
      memory: "1Gi",
      "ephemeral-storage": "1Gi",
    },
  };

  const originalArgs = container.args ?? [];
  if (!originalArgs.includes("--watch-all-namespaces")) {
    throw new Error(`${resource.metadata.name} watch scope flag shape changed`);
  }
  container.args = originalArgs
    .filter((argument) => !argument.startsWith("--events-addr="))
    .map((argument) =>
      argument === "--watch-all-namespaces"
        ? "--watch-all-namespaces=false"
        : argument,
    );
  if (resource.metadata.name === "kustomize-controller") {
    container.args.push(
      "--feature-gates=DisableConfigWatchers=true",
      "--no-cross-namespace-refs=true",
      "--no-remote-bases=true",
    );
  }
}

for (const resource of selected) hardenDeployment(resource);

const rbacUrl = new URL(
  "../deploy/production-qualification/flux-controller-rbac.yaml",
  import.meta.url,
);
const restrictedRbac = parseAllDocuments(readFileSync(rbacUrl, "utf8")).map(
  (document) => {
    if (document.errors.length > 0) throw document.errors[0];
    return document.toJS();
  },
);

for (const resource of [...selected, ...restrictedRbac]) {
  if (["ClusterRole", "ClusterRoleBinding"].includes(resource.kind)) {
    throw new Error(
      `cluster-scoped controller RBAC is forbidden: ${resource.kind}`,
    );
  }
}

process.stdout.write(
  [...selected, ...restrictedRbac]
    .map((resource) => stringify(resource).trimEnd())
    .join("\n---\n") + "\n",
);
