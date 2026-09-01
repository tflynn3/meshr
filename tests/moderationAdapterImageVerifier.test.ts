import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..");
const verifier = join(root, "scripts/verify-moderation-adapter-image.sh");
const sourceSha = "a".repeat(40);
const repositoryRoot = "registry.example/meshr";
const builderId = "https://github.com/tflynn3/meshr/actions/runs/123456";
const digest = (value: string): string =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
const json = (value: unknown): string => JSON.stringify(value);

type Architecture = "amd64" | "arm64";
type FixtureImage = {
  name: "api" | "event-plane" | "moderation-adapter" | "web";
  dockerfile: string;
  moderationWitness: boolean;
};
const adapterImage: FixtureImage = {
  name: "moderation-adapter",
  dockerfile: "deploy/images/moderation-adapter.Dockerfile",
  moderationWitness: true,
};
type FixtureMutation =
  | "wrong-index-digest"
  | "wrong-child-bytes"
  | "extra-platform"
  | "unrecognized-attestation"
  | "swapped-config"
  | "duplicate-env"
  | "missing-label"
  | "config-platform"
  | "bad-provenance"
  | "bad-builder"
  | "missing-provenance"
  | "duplicate-provenance"
  | "missing-max-provenance"
  | "wrong-slsa-subject"
  | "wrong-slsa-bytes"
  | "wrong-attestation-subject"
  | "missing-attestation-artifact-type"
  | "wrong-dockerfile-directory"
  | "legacy-invocation-id"
  | "missing-build-arg"
  | "missing-root-build-arg"
  | "unexpected-build-arg"
  | "unexpected-root-build-arg";

function runFixture(
  mutation?: FixtureMutation,
  fixtureImage: FixtureImage = adapterImage,
) {
  const directory = mkdtempSync(join(tmpdir(), "meshr-adapter-verifier-"));
  const repository = `${repositoryRoot}/${fixtureImage.name}`;
  const mediaType = "application/vnd.oci.image.manifest.v1+json";
  const architectures: Architecture[] = ["amd64", "arm64"];
  const configDocuments = Object.fromEntries(
    architectures.map((architecture) => {
      const env = fixtureImage.moderationWitness
        ? [`MESHR_MODERATION_RELEASE_SHA=${sourceSha}`]
        : ["NODE_ENV=production"];
      if (mutation === "duplicate-env" && architecture === "arm64") {
        env.push(`MESHR_MODERATION_RELEASE_SHA=${sourceSha}`);
      }
      return [
        architecture,
        json({
          architecture:
            mutation === "config-platform" && architecture === "arm64"
              ? "amd64"
              : architecture,
          os: "linux",
          config: {
            Env: env,
            Labels: fixtureImage.moderationWitness
              ? mutation === "missing-label" && architecture === "arm64"
                ? {}
                : { "org.opencontainers.image.revision": sourceSha }
              : {},
          },
        }),
      ];
    }),
  ) as Record<Architecture, string>;
  const configDigests = {
    amd64: digest(configDocuments.amd64),
    arm64: digest(configDocuments.arm64),
  };
  const childDocuments = Object.fromEntries(
    architectures.map((architecture) => [
      architecture,
      json({
        schemaVersion: 2,
        mediaType,
        config: {
          mediaType: "application/vnd.oci.image.config.v1+json",
          digest:
            mutation === "swapped-config" && architecture === "arm64"
              ? configDigests.amd64
              : configDigests[architecture],
        },
        layers: [],
      }),
    ]),
  ) as Record<Architecture, string>;
  const childDigests = {
    amd64: digest(childDocuments.amd64),
    arm64: digest(childDocuments.arm64),
  };
  if (mutation === "wrong-child-bytes") {
    childDigests.arm64 = `sha256:${"3".repeat(64)}`;
  }

  const expectedSubject = (
    architecture: Architecture,
    childDigest: string,
  ) => ({
    name: `pkg:docker/${repository}@${sourceSha}?platform=linux%2F${architecture}`,
    digest: { sha256: childDigest.slice("sha256:".length) },
  });
  const slsaDocuments = Object.fromEntries(
    architectures.map((architecture) => {
      const subject = expectedSubject(architecture, childDigests[architecture]);
      if (mutation === "wrong-slsa-subject" && architecture === "arm64") {
        subject.digest.sha256 = "f".repeat(64);
      }
      return [
        architecture,
        json({
          _type: "https://in-toto.io/Statement/v1",
          predicateType: "https://slsa.dev/provenance/v1",
          subject: [subject],
          predicate: {
            buildDefinition: {
              buildType:
                "https://github.com/moby/buildkit/blob/master/docs/attestations/slsa-definitions.md",
              externalParameters: {
                configSource: {
                  path: basename(fixtureImage.dockerfile),
                },
                request: {
                  frontend: "dockerfile.v0",
                  locals: [{ name: "context" }, { name: "dockerfile" }],
                  ...(fixtureImage.moderationWitness
                    ? mutation === "missing-build-arg"
                      ? {}
                      : {
                          args: {
                            "build-arg:MESHR_MODERATION_RELEASE_SHA": sourceSha,
                          },
                        }
                    : mutation === "unexpected-build-arg"
                      ? { args: { "build-arg:UNREVIEWED": "value" } }
                      : {}),
                  root: {
                    configSource: {
                      path: basename(fixtureImage.dockerfile),
                    },
                    request: {
                      args: {
                        ...(fixtureImage.moderationWitness
                          ? mutation === "missing-root-build-arg"
                            ? {}
                            : {
                                "build-arg:MESHR_MODERATION_RELEASE_SHA":
                                  sourceSha,
                              }
                          : mutation === "unexpected-root-build-arg"
                            ? { "build-arg:UNREVIEWED": "value" }
                            : {}),
                        "vcs:localdir:context": ".",
                        "vcs:localdir:dockerfile":
                          mutation === "wrong-dockerfile-directory"
                            ? "deploy/other"
                            : dirname(fixtureImage.dockerfile),
                        "vcs:revision": sourceSha,
                        "vcs:source": "https://github.com/tflynn3/meshr",
                      },
                    },
                  },
                  compatibilityVersion: 30,
                },
              },
              internalParameters: {
                builderPlatform: "linux/amd64",
                buildConfig: { llbDefinition: [{ id: "step0" }] },
              },
              resolvedDependencies: [
                {
                  uri: "pkg:docker/node@24-bookworm-slim",
                  digest: { sha256: "9".repeat(64) },
                },
              ],
            },
            runDetails: {
              builder: {
                id:
                  mutation === "bad-builder" && architecture === "arm64"
                    ? "https://github.com/attacker/repository/actions/runs/1"
                    : builderId,
              },
              metadata: {
                ...(mutation === "legacy-invocation-id"
                  ? { invocationID: "fixture-invocation" }
                  : { invocationId: "fixture-invocation" }),
                startedOn: "2026-08-31T12:00:00.123Z",
                finishedOn: "2026-08-31T12:01:00.456Z",
                buildkit_completeness: {
                  request: true,
                  resolvedDependencies: false,
                },
                buildkit_metadata: {
                  vcs: {
                    "localdir:context": ".",
                    "localdir:dockerfile": dirname(fixtureImage.dockerfile),
                    revision:
                      mutation === "bad-provenance" && architecture === "arm64"
                        ? "b".repeat(40)
                        : sourceSha,
                    source: "https://github.com/tflynn3/meshr",
                  },
                  source: {
                    infos:
                      mutation === "missing-max-provenance" &&
                      architecture === "arm64"
                        ? []
                        : [
                            {
                              filename: basename(fixtureImage.dockerfile),
                              data: "RlJPTSBub2RlOjI0",
                            },
                          ],
                  },
                  layers: {
                    step0: [
                      {
                        digest: "sha256:" + "8".repeat(64),
                      },
                    ],
                  },
                },
              },
            },
          },
        }),
      ];
    }),
  ) as Record<Architecture, string>;
  const spdxDocuments = Object.fromEntries(
    architectures.map((architecture) => [
      architecture,
      json({
        _type: "https://in-toto.io/Statement/v1",
        predicateType: "https://spdx.dev/Document",
        subject: [expectedSubject(architecture, childDigests[architecture])],
        predicate: {
          SPDXID: "SPDXRef-DOCUMENT",
          dataLicense: "CC0-1.0",
          spdxVersion: "SPDX-2.3",
        },
      }),
    ]),
  ) as Record<Architecture, string>;
  const slsaDigests = {
    amd64: digest(slsaDocuments.amd64),
    arm64:
      mutation === "wrong-slsa-bytes"
        ? `sha256:${"6".repeat(64)}`
        : digest(slsaDocuments.arm64),
  };
  const spdxDigests = {
    amd64: digest(spdxDocuments.amd64),
    arm64: digest(spdxDocuments.arm64),
  };
  const attestationDocuments = Object.fromEntries(
    architectures.map((architecture) => {
      const layers = [
        {
          mediaType: "application/vnd.in-toto+json",
          digest: slsaDigests[architecture],
          size: slsaDocuments[architecture].length,
          annotations: {
            "in-toto.io/predicate-type": "https://slsa.dev/provenance/v1",
          },
        },
        {
          mediaType: "application/vnd.in-toto+json",
          digest: spdxDigests[architecture],
          size: spdxDocuments[architecture].length,
          annotations: {
            "in-toto.io/predicate-type": "https://spdx.dev/Document",
          },
        },
      ];
      if (mutation === "missing-provenance" && architecture === "arm64") {
        layers.shift();
      }
      if (mutation === "duplicate-provenance" && architecture === "arm64") {
        layers.push({ ...layers[0]! });
      }
      return [
        architecture,
        json({
          schemaVersion: 2,
          mediaType,
          ...(mutation === "missing-attestation-artifact-type" &&
          architecture === "arm64"
            ? {}
            : {
                artifactType:
                  "application/vnd.docker.attestation.manifest.v1+json",
              }),
          subject: {
            mediaType,
            digest:
              mutation === "wrong-attestation-subject" &&
              architecture === "arm64"
                ? childDigests.amd64
                : childDigests[architecture],
            size: childDocuments[architecture].length,
          },
          config: {
            mediaType: "application/vnd.oci.empty.v1+json",
            digest: digest("{}"),
          },
          layers,
        }),
      ];
    }),
  ) as Record<Architecture, string>;
  const attestationDigests = {
    amd64: digest(attestationDocuments.amd64),
    arm64: digest(attestationDocuments.arm64),
  };
  const manifests: Array<Record<string, unknown>> = [
    ...architectures.map((architecture) => ({
      mediaType,
      digest: childDigests[architecture],
      platform: { os: "linux", architecture },
    })),
    ...architectures.map((architecture) => ({
      mediaType,
      digest: attestationDigests[architecture],
      platform: { os: "unknown", architecture: "unknown" },
      annotations: {
        "vnd.docker.reference.type":
          mutation === "unrecognized-attestation" && architecture === "arm64"
            ? "unknown-attestation"
            : "attestation-manifest",
        "vnd.docker.reference.digest": childDigests[architecture],
      },
    })),
  ];
  if (mutation === "extra-platform") {
    manifests.push({
      mediaType,
      digest: `sha256:${"8".repeat(64)}`,
      platform: { os: "linux", architecture: "s390x" },
    });
  }
  const indexDocument = json({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests,
  });
  const indexDigest =
    mutation === "wrong-index-digest"
      ? `sha256:${"9".repeat(64)}`
      : digest(indexDocument);

  const files: Record<string, string> = {
    index: indexDocument,
    "child-amd64": childDocuments.amd64,
    "child-arm64": childDocuments.arm64,
    "attestation-amd64": attestationDocuments.amd64,
    "attestation-arm64": attestationDocuments.arm64,
    "config-amd64": configDocuments.amd64,
    "config-arm64": configDocuments.arm64,
    "slsa-amd64": slsaDocuments.amd64,
    "slsa-arm64": slsaDocuments.arm64,
    "spdx-amd64": spdxDocuments.amd64,
    "spdx-arm64": spdxDocuments.arm64,
    "attestation-config": "{}",
  };
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(directory, `${name}.json`), contents);
  }
  const docker = join(directory, "docker");
  writeFileSync(
    docker,
    `#!/usr/bin/env bash
set -euo pipefail
test "$1 $2 $3 $4" = "buildx imagetools inspect --raw"
case "\${5##*@}" in
  "$INDEX_DIGEST") file=index ;;
  "$AMD64_CHILD") file=child-amd64 ;;
  "$ARM64_CHILD") file=child-arm64 ;;
  "$AMD64_ATTESTATION") file=attestation-amd64 ;;
  "$ARM64_ATTESTATION") file=attestation-arm64 ;;
  *) exit 70 ;;
esac
cat "$FIXTURE_DIRECTORY/$file.json"
`,
  );
  chmodSync(docker, 0o755);
  const curl = join(directory, "curl");
  writeFileSync(
    curl,
    `#!/usr/bin/env bash
set -euo pipefail
read -r _authorization
output=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output)
      output="$2"
      shift 2
      ;;
    https://*)
      url="$1"
      shift
      ;;
    *)
      shift
      ;;
  esac
done
case "\${url##*/}" in
  "$AMD64_CONFIG") file=config-amd64 ;;
  "$ARM64_CONFIG") file=config-arm64 ;;
  "$AMD64_SLSA") file=slsa-amd64 ;;
  "$ARM64_SLSA") file=slsa-arm64 ;;
  "$AMD64_SPDX") file=spdx-amd64 ;;
  "$ARM64_SPDX") file=spdx-arm64 ;;
  "$ATTESTATION_CONFIG") file=attestation-config ;;
  *) exit 71 ;;
esac
cp "$FIXTURE_DIRECTORY/$file.json" "$output"
`,
  );
  chmodSync(curl, 0o755);
  const receipt = join(directory, "receipt.json");
  const result = spawnSync(
    "bash",
    [
      verifier,
      `${repository}@${indexDigest}`,
      sourceSha,
      fixtureImage.dockerfile,
      receipt,
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH ?? ""}`,
        FIXTURE_DIRECTORY: directory,
        MESHR_REGISTRY_BEARER_TOKEN: "fixture-token",
        MESHR_EXPECTED_BUILDER_ID: builderId,
        INDEX_DIGEST: indexDigest,
        AMD64_CHILD: childDigests.amd64,
        ARM64_CHILD: childDigests.arm64,
        AMD64_ATTESTATION: attestationDigests.amd64,
        ARM64_ATTESTATION: attestationDigests.arm64,
        AMD64_CONFIG: configDigests.amd64,
        ARM64_CONFIG: configDigests.arm64,
        AMD64_SLSA: slsaDigests.amd64,
        ARM64_SLSA: slsaDigests.arm64,
        AMD64_SPDX: spdxDigests.amd64,
        ARM64_SPDX: spdxDigests.arm64,
        ATTESTATION_CONFIG: digest("{}"),
      },
    },
  );
  const receiptValue =
    result.status === 0 ? JSON.parse(readFileSync(receipt, "utf8")) : undefined;
  rmSync(directory, { recursive: true, force: true });
  return { ...result, receipt: receiptValue };
}

test("adapter image verifier binds the index, both platforms, configs, SBOMs, and provenance", () => {
  const result = runFixture();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.receipt?.sourceSha, sourceSha);
  assert.match(
    result.receipt?.provenanceDocumentSha256,
    /^sha256:[a-f0-9]{64}$/,
  );
  assert.deepEqual(
    result.receipt?.platforms.map(
      (entry: { platform: string }) => entry.platform,
    ),
    ["linux/amd64", "linux/arm64"],
  );
  assert.equal(result.receipt?.attestations.length, 2);
});

test("release image verifier validates provenance and SBOM content for every runtime image", () => {
  for (const fixtureImage of [
    {
      name: "api",
      dockerfile: "deploy/images/api.Dockerfile",
      moderationWitness: false,
    },
    {
      name: "event-plane",
      dockerfile: "deploy/images/event-plane.Dockerfile",
      moderationWitness: false,
    },
    adapterImage,
    {
      name: "web",
      dockerfile: "deploy/images/web.Dockerfile",
      moderationWitness: false,
    },
  ] satisfies FixtureImage[]) {
    const result = runFixture(undefined, fixtureImage);
    assert.equal(result.status, 0, `${fixtureImage.name}: ${result.stderr}`);
    assert.equal(
      result.receipt?.provenance.dockerfile,
      fixtureImage.dockerfile,
    );
    assert.equal(result.receipt?.sourceSha, sourceSha);
  }
});

test("adapter image verifier rejects broken descriptors, configs, and attestations", () => {
  for (const mutation of [
    "wrong-index-digest",
    "wrong-child-bytes",
    "extra-platform",
    "unrecognized-attestation",
    "swapped-config",
    "duplicate-env",
    "missing-label",
    "config-platform",
    "bad-provenance",
    "bad-builder",
    "missing-provenance",
    "duplicate-provenance",
    "missing-max-provenance",
    "wrong-slsa-subject",
    "wrong-slsa-bytes",
    "wrong-attestation-subject",
    "missing-attestation-artifact-type",
    "wrong-dockerfile-directory",
    "legacy-invocation-id",
    "missing-build-arg",
    "missing-root-build-arg",
  ] as const) {
    const result = runFixture(mutation);
    assert.notEqual(result.status, 0, `${mutation} unexpectedly passed`);
  }
});

test("release image verifier rejects undeclared build arguments on non-adapter images", () => {
  for (const mutation of [
    "unexpected-build-arg",
    "unexpected-root-build-arg",
  ] as const) {
    const result = runFixture(mutation, {
      name: "api",
      dockerfile: "deploy/images/api.Dockerfile",
      moderationWitness: false,
    });
    assert.notEqual(result.status, 0, `${mutation} unexpectedly passed`);
  }
});
