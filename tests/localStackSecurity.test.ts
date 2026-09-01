import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, root), "utf8");

test("the local cluster publishes its HTTP and Kubernetes API ports on loopback only", () => {
  const config = read("deploy/local/k3d.yaml");
  assert.match(config, /kubeAPI:\s+host: 127\.0\.0\.1\s+hostIP: 127\.0\.0\.1/);
  assert.match(config, /port: 127\.0\.0\.1:8080:80/);

  const launcher = read("scripts/local-stack.sh");
  assert.match(launcher, /assert_loopback_bindings\(\)/);
  assert.match(launcher, /--filter "label=k3d\.cluster=\$\{cluster_name\}"/);
  assert.match(launcher, /docker inspect "\$\{nodes\[@\]\}"/);
  assert.match(launcher, /\.HostConfig\.NetworkMode "host"/);
  assert.match(launcher, /\.HostConfig\.PublishAllPorts/);
  assert.match(launcher, /\.NetworkSettings\.Ports/);
  assert.doesNotMatch(launcher, /\.HostConfig\.PortBindings/);
  assert.doesNotMatch(launcher, /local load_balancer=/);
  assert.match(launcher, /refusing to start or mutate it/);
  assert.match(launcher, /k3d cluster stop "\$cluster_name"/);
});

test("the local internal token is generated at runtime and passed to each smoke phase", () => {
  const config = read("deploy/local/config.yaml");
  const launcher = read("scripts/local-stack.sh");
  const smoke = read("scripts/smoke-local-stack.ts");

  for (const source of [config, launcher, smoke]) {
    assert.doesNotMatch(source, /meshr-local-development-only/);
  }
  assert.doesNotMatch(config, /kind: Secret/);
  assert.match(launcher, /token="\$\(openssl rand -hex 32\)"/);
  assert.match(launcher, /printf '%s' "\$token" >"\$token_file"/);
  assert.match(launcher, /create secret generic "\$local_internal_secret"/);
  assert.match(launcher, /base64decode/);
  assert.equal(
    launcher.match(/MESHR_LOCAL_INTERNAL_TOKEN="\$internal_token"/g)?.length,
    2,
  );
  assert.match(smoke, /MESHR_LOCAL_INTERNAL_TOKEN must be supplied from the live Kubernetes Secret/);
});

test("Bazel local images use the clean Debian 13 runtime digest", () => {
  const moduleFile = read("MODULE.bazel");
  assert.match(moduleFile, /gcr\.io\/distroless\/nodejs24-debian13/);
  assert.match(
    moduleFile,
    /sha256:774b7d020b24214835769e24c3544835526cd0288f0b094eae48e8b2c2429a79/,
  );
  assert.doesNotMatch(moduleFile, /nodejs24-debian12/);
});

test("local application and emulator pods retain the container hardening baseline", () => {
  const workloads = read("deploy/local/workloads.yaml");
  const emulators = read("deploy/local/emulators.yaml");

  for (const source of [workloads, emulators]) {
    assert.match(source, /automountServiceAccountToken: false/);
    assert.match(source, /runAsNonRoot: true/);
    assert.match(source, /seccompProfile: \{type: RuntimeDefault\}/);
    assert.match(source, /allowPrivilegeEscalation: false/);
    assert.match(source, /readOnlyRootFilesystem: true/);
    assert.match(source, /capabilities: \{drop: \["ALL"\]\}/);
  }
  assert.match(workloads, /fsGroup: 65532/);
  assert.match(emulators, /CLOUDSDK_CONFIG, value: \/tmp\/\.config\/gcloud/);
  assert.equal((emulators.match(/emptyDir: \{sizeLimit: 512Mi\}/g) ?? []).length, 2);
});
