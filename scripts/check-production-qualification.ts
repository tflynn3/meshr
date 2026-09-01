#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { parseAllDocuments } from "yaml";

const MAX_RENDER_BYTES = 8 * 1024 * 1024;
const FORBIDDEN_KINDS = new Set([
  "BackendConfig",
  "FrontendConfig",
  "Gateway",
  "GCPBackendPolicy",
  "HealthCheckPolicy",
  "HTTPRoute",
  "Ingress",
  "ManagedCertificate",
]);

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function optionalRecord(
  value: unknown,
  label: string,
): Record<string, unknown> | undefined {
  return value === undefined ? undefined : record(value, label);
}

function stringArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} must be a string array.`);
  }
  return value;
}

export function assertPrivateProductionManifest(serialized: string): {
  resources: number;
  services: number;
} {
  if (Buffer.byteLength(serialized, "utf8") > MAX_RENDER_BYTES) {
    throw new Error("Production qualification render exceeds the bounded parser input.");
  }
  const documents = parseAllDocuments(serialized, { maxAliasCount: 0 });
  let resources = 0;
  let services = 0;
  let runtimeConfigFound = false;
  for (let index = 0; index < documents.length; index += 1) {
    const document = documents[index]!;
    if (document.errors.length > 0) {
      throw new Error(`Manifest document ${index + 1} is invalid YAML.`);
    }
    const value = document.toJS({ maxAliasCount: 0 }) as unknown;
    if (value == null) continue;
    const resource = record(value, `Manifest document ${index + 1}`);
    const kind = String(resource.kind ?? "");
    const metadata = optionalRecord(resource.metadata, `${kind || "resource"}.metadata`);
    const name = String(metadata?.name ?? "unnamed");
    if (!kind) throw new Error(`Manifest document ${index + 1} has no kind.`);
    resources += 1;
    if (FORBIDDEN_KINDS.has(kind)) {
      throw new Error(`Private production qualification forbids ${kind}/${name}.`);
    }

    if (kind === "ConfigMap") {
      const data = optionalRecord(resource.data, `ConfigMap/${name}.data`);
      if (
        data?.MESHR_TRUST_CLOUDFLARE_CONNECTING_IP !== undefined &&
        data.MESHR_TRUST_CLOUDFLARE_CONNECTING_IP !== "0"
      ) {
        throw new Error(
          `ConfigMap/${name} must not enable trust in CF-Connecting-IP on the edge-free qualification path.`,
        );
      }
      if (name === "meshr-runtime") {
        runtimeConfigFound = true;
        if (data?.MESHR_TRUST_CLOUDFLARE_CONNECTING_IP !== "0") {
          throw new Error(
            "ConfigMap/meshr-runtime must explicitly disable trust in CF-Connecting-IP.",
          );
        }
      }
    }

    const spec = optionalRecord(resource.spec, `${kind}/${name}.spec`);
    if (kind === "Service") {
      services += 1;
      const serviceType = String(spec?.type ?? "ClusterIP");
      if (serviceType !== "ClusterIP") {
        throw new Error(`Service/${name} must be ClusterIP, not ${serviceType}.`);
      }
      if (stringArray(spec?.externalIPs, `Service/${name}.spec.externalIPs`).length > 0) {
        throw new Error(`Service/${name} must not declare externalIPs.`);
      }
      if (spec?.externalName !== undefined || spec?.loadBalancerClass !== undefined) {
        throw new Error(`Service/${name} contains an external service target.`);
      }
      const ports = spec?.ports;
      if (ports !== undefined) {
        if (!Array.isArray(ports)) throw new Error(`Service/${name}.spec.ports must be an array.`);
        for (const port of ports) {
          if (record(port, `Service/${name} port`).nodePort !== undefined) {
            throw new Error(`Service/${name} must not declare a nodePort.`);
          }
        }
      }
    }

    const template = optionalRecord(spec?.template, `${kind}/${name}.spec.template`);
    const podSpec = optionalRecord(template?.spec, `${kind}/${name}.spec.template.spec`);
    if (podSpec?.hostNetwork === true) {
      throw new Error(`${kind}/${name} must not use host networking.`);
    }
    for (const field of ["initContainers", "containers"] as const) {
      const containers = podSpec?.[field];
      if (containers === undefined) continue;
      if (!Array.isArray(containers)) {
        throw new Error(`${kind}/${name} ${field} must be an array.`);
      }
      for (const container of containers) {
        const details = record(container, `${kind}/${name} ${field} entry`);
        const environment = details.env;
        if (environment !== undefined) {
          if (!Array.isArray(environment)) {
            throw new Error(`${kind}/${name} container env must be an array.`);
          }
          for (const entry of environment) {
            const variable = record(entry, `${kind}/${name} container env entry`);
            if (
              variable.name === "MESHR_TRUST_CLOUDFLARE_CONNECTING_IP" &&
              variable.value !== "0"
            ) {
              throw new Error(
                `${kind}/${name} must not override CF-Connecting-IP trust on the edge-free qualification path.`,
              );
            }
          }
        }
        const ports = details.ports;
        if (ports === undefined) continue;
        if (!Array.isArray(ports)) {
          throw new Error(`${kind}/${name} container ports must be an array.`);
        }
        for (const port of ports) {
          if (record(port, `${kind}/${name} container port`).hostPort !== undefined) {
            throw new Error(`${kind}/${name} must not declare a hostPort.`);
          }
        }
      }
    }
  }
  if (resources === 0 || services === 0) {
    throw new Error("Production qualification render must contain resources and Services.");
  }
  if (!runtimeConfigFound) {
    throw new Error("Production qualification render must contain ConfigMap/meshr-runtime.");
  }
  return { resources, services };
}

export function checkProductionQualification(
  repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url))),
): { resources: number; services: number } {
  const rendered = execFileSync(
    process.env.KUBECTL_BIN?.trim() || "kubectl",
    [
      "kustomize",
      resolve(repositoryRoot, "deploy/production-qualification"),
      "--load-restrictor=LoadRestrictionsNone",
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: MAX_RENDER_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return assertPrivateProductionManifest(rendered);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkProductionQualification();
  console.log(
    `Private production qualification render is edge-free (${result.resources} resources, ${result.services} ClusterIP Services).`,
  );
}
