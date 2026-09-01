#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 <image@sha256:digest> <40-lowercase-source-sha> <dockerfile> <receipt.json>" >&2
  exit 64
}

[ "$#" -eq 4 ] || usage
immutable_image="$1"
source_sha="$2"
dockerfile="$3"
receipt_path="$4"

printf '%s' "$immutable_image" |
  grep -Eq '^[a-z0-9.-]+/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$' || usage
printf '%s' "$source_sha" | grep -Eq '^[a-f0-9]{40}$' || usage
image_repository="${immutable_image%@*}"
image_name="${image_repository##*/}"
case "$image_name:$dockerfile" in
  api:deploy/images/api.Dockerfile | \
    event-plane:deploy/images/event-plane.Dockerfile | \
    moderation-adapter:deploy/images/moderation-adapter.Dockerfile | \
    web:deploy/images/web.Dockerfile) ;;
  *)
    echo "image name and Dockerfile are not an allowed Meshr runtime-image pair" >&2
    usage
    ;;
esac
if [ "$image_name" = "moderation-adapter" ]; then
  require_moderation_witness=true
else
  require_moderation_witness=false
fi

registry_token="${MESHR_REGISTRY_BEARER_TOKEN:-}"
printf '%s' "$registry_token" | grep -Eq '^[A-Za-z0-9._~-]+$' || {
  echo "MESHR_REGISTRY_BEARER_TOKEN is required for authenticated OCI blob verification" >&2
  exit 64
}
expected_builder_id="${MESHR_EXPECTED_BUILDER_ID:-}"
printf '%s' "$expected_builder_id" |
  grep -Eq '^https://github[.]com/tflynn3/meshr/actions/runs/[1-9][0-9]*$' || {
  echo "MESHR_EXPECTED_BUILDER_ID must name the exact Meshr GitHub Actions run" >&2
  exit 64
}

for command_name in curl docker jq sha256sum; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "$command_name is required to verify a Meshr release image" >&2
    exit 69
  }
done

tmp_dir="$(mktemp -d)"
trap 'rm -r -- "$tmp_dir"' EXIT

registry_host="${image_repository%%/*}"
repository_path="${image_repository#*/}"
index_json="$tmp_dir/index.json"
attestation_entries="$tmp_dir/attestations.jsonl"
platform_entries="$tmp_dir/platforms.jsonl"

bound_file() {
  local input_path="$1"
  local maximum_bytes="$2"
  local description="$3"
  local actual_bytes

  actual_bytes="$(wc -c <"$input_path" | tr -d '[:space:]')"
  printf '%s' "$actual_bytes" | grep -Eq '^[0-9]+$'
  [ "$actual_bytes" -le "$maximum_bytes" ] || {
    echo "$description exceeds the $maximum_bytes-byte verification limit" >&2
    exit 1
  }
}

fetch_blob() {
  local blob_digest="$1"
  local output_path="$2"
  local maximum_bytes="$3"
  local description="$4"

  printf '%s' "$blob_digest" | grep -Eq '^sha256:[a-f0-9]{64}$'
  printf 'header = "Authorization: Bearer %s"\n' "$registry_token" |
    curl --fail --silent --show-error --location \
      --proto '=https' --proto-redir '=https' --config - \
      --max-filesize "$maximum_bytes" --max-time 120 \
      --output "$output_path" \
      "https://$registry_host/v2/$repository_path/blobs/$blob_digest"
  bound_file "$output_path" "$maximum_bytes" "$description"
  test "sha256:$(sha256sum "$output_path" | awk '{print $1}')" = \
    "$blob_digest" || {
    echo "OCI blob bytes do not match $blob_digest" >&2
    exit 1
  }
}

docker buildx imagetools inspect --raw "$immutable_image" >"$index_json"
bound_file "$index_json" 1048576 "release image index"
expected_index_digest="${immutable_image##*@}"
actual_index_digest="sha256:$(sha256sum "$index_json" | awk '{print $1}')"
test "$actual_index_digest" = "$expected_index_digest" || {
  echo "release image index bytes do not match $expected_index_digest" >&2
  exit 1
}
jq -e '
  (.mediaType == "application/vnd.oci.image.index.v1+json" or
    .mediaType == "application/vnd.docker.distribution.manifest.list.v2+json") and
  ([.manifests[] |
    select(.platform.os == "linux" and
      (.platform.architecture == "amd64" or .platform.architecture == "arm64")) |
    (.platform.os + "/" + .platform.architecture)] | sort) ==
      ["linux/amd64", "linux/arm64"] and
  all(.manifests[];
    (.platform.os == "linux" and
      (.platform.architecture == "amd64" or .platform.architecture == "arm64") and
      ((.platform.variant // "") == "") and
      (.mediaType == "application/vnd.oci.image.manifest.v1+json" or
        .mediaType == "application/vnd.docker.distribution.manifest.v2+json") and
      (.digest | test("^sha256:[a-f0-9]{64}$"))) or
    (.platform.os == "unknown" and .platform.architecture == "unknown" and
      ((.platform.variant // "") == "") and
      .mediaType == "application/vnd.oci.image.manifest.v1+json" and
      (.digest | test("^sha256:[a-f0-9]{64}$")) and
      .annotations["vnd.docker.reference.type"] == "attestation-manifest" and
      (.annotations["vnd.docker.reference.digest"] |
        test("^sha256:[a-f0-9]{64}$")))) and
  ([.manifests[] |
    select(.platform.os == "unknown" and .platform.architecture == "unknown") |
    .annotations["vnd.docker.reference.digest"]] | sort) ==
      ([.manifests[] |
        select(.platform.os == "linux" and
          (.platform.architecture == "amd64" or .platform.architecture == "arm64")) |
        .digest] | sort)
' "$index_json" >/dev/null || {
  echo "release image index must contain exactly linux/amd64 and linux/arm64 plus one recognized BuildKit attestation manifest for each" >&2
  exit 1
}

while IFS=$'\t' read -r attestation_digest subject_digest; do
  architecture="$(jq -r --arg subject "$subject_digest" '
    [.manifests[] |
      select(.platform.os == "linux" and .digest == $subject)][0].platform.architecture // empty
  ' "$index_json")"
  test "$architecture" = "amd64" || test "$architecture" = "arm64"
  platform="linux/$architecture"
  expected_subject="pkg:docker/$image_repository@$source_sha?platform=linux%2F$architecture"
  attestation_manifest="$tmp_dir/attestation-${attestation_digest#sha256:}.json"
  docker buildx imagetools inspect --raw \
    "$image_repository@$attestation_digest" >"$attestation_manifest"
  bound_file "$attestation_manifest" 1048576 "$platform attestation manifest"
  test "sha256:$(sha256sum "$attestation_manifest" | awk '{print $1}')" = \
    "$attestation_digest" || {
    echo "attestation manifest bytes do not match $attestation_digest" >&2
    exit 1
  }
  jq -e --arg subjectDigest "$subject_digest" '
    .schemaVersion == 2 and
    .mediaType == "application/vnd.oci.image.manifest.v1+json" and
    .artifactType == "application/vnd.docker.attestation.manifest.v1+json" and
    (.subject.mediaType == "application/vnd.oci.image.manifest.v1+json" or
      .subject.mediaType == "application/vnd.docker.distribution.manifest.v2+json") and
    .subject.digest == $subjectDigest and
    (.subject.size | type == "number" and . > 0) and
    .config.mediaType == "application/vnd.oci.empty.v1+json" and
    (.config.digest | test("^sha256:[a-f0-9]{64}$")) and
    ([.layers[] |
      select(.mediaType == "application/vnd.in-toto+json") |
      .annotations["in-toto.io/predicate-type"]] | sort) ==
      ["https://slsa.dev/provenance/v1", "https://spdx.dev/Document"] and
    all(.layers[];
      .mediaType == "application/vnd.in-toto+json" and
      (.digest | test("^sha256:[a-f0-9]{64}$")) and
      (.size | type == "number" and . > 0) and
      ((.urls // []) | length) == 0 and
      .annotations["in-toto.io/predicate-type"] != null)
  ' "$attestation_manifest" >/dev/null || {
    echo "attestation manifest for $subject_digest lacks exactly one SLSA and one SPDX statement" >&2
    exit 1
  }

  attestation_config_digest="$(jq -r '.config.digest' "$attestation_manifest")"
  attestation_config="$tmp_dir/attestation-config-${attestation_digest#sha256:}.json"
  fetch_blob "$attestation_config_digest" "$attestation_config" 65536 \
    "$platform attestation config"
  jq -e 'type == "object" and length == 0' "$attestation_config" >/dev/null || {
    echo "$platform attestation config is not the expected empty OCI object" >&2
    exit 1
  }

  slsa_digest="$(jq -r '
    [.layers[] |
      select(.annotations["in-toto.io/predicate-type"] ==
        "https://slsa.dev/provenance/v1")][0].digest // empty
  ' "$attestation_manifest")"
  spdx_digest="$(jq -r '
    [.layers[] |
      select(.annotations["in-toto.io/predicate-type"] ==
        "https://spdx.dev/Document")][0].digest // empty
  ' "$attestation_manifest")"
  slsa_statement="$tmp_dir/slsa-${subject_digest#sha256:}.json"
  spdx_statement="$tmp_dir/spdx-${subject_digest#sha256:}.json"
  fetch_blob "$slsa_digest" "$slsa_statement" 8388608 "$platform SLSA statement"
  fetch_blob "$spdx_digest" "$spdx_statement" 33554432 "$platform SPDX statement"

  jq -e \
    --arg digest "${subject_digest#sha256:}" \
    --arg builder "$expected_builder_id" \
    --arg sha "$source_sha" \
    --arg subject "$expected_subject" \
    --arg dockerfile "$dockerfile" \
    --argjson requireWitness "$require_moderation_witness" '
    ($dockerfile | split("/")) as $dockerfileParts |
    ($dockerfileParts[-1]) as $dockerfileBasename |
    ($dockerfileParts[0:-1] | join("/")) as $dockerfileDirectory |
    ._type == "https://in-toto.io/Statement/v1" and
    .predicateType == "https://slsa.dev/provenance/v1" and
    (.subject | length) == 1 and
    .subject[0].name == $subject and
    (.subject[0].digest | keys) == ["sha256"] and
    .subject[0].digest.sha256 == $digest and
    .predicate.buildDefinition.buildType ==
      "https://github.com/moby/buildkit/blob/master/docs/attestations/slsa-definitions.md" and
    .predicate.buildDefinition.externalParameters.configSource ==
      {path:$dockerfileBasename} and
    .predicate.buildDefinition.externalParameters.request.frontend == "dockerfile.v0" and
    (if $requireWitness then
      .predicate.buildDefinition.externalParameters.request.args ==
        {"build-arg:MESHR_MODERATION_RELEASE_SHA":$sha}
    else
      ((.predicate.buildDefinition.externalParameters.request | has("args") | not) or
        .predicate.buildDefinition.externalParameters.request.args == {})
    end) and
    ([.predicate.buildDefinition.externalParameters.request.locals[].name] | sort) ==
      ["context", "dockerfile"] and
    .predicate.buildDefinition.externalParameters.request.root.configSource ==
      {path:$dockerfileBasename} and
    .predicate.buildDefinition.externalParameters.request.root.request.args ==
      ({
        "vcs:localdir:context":".",
        "vcs:localdir:dockerfile":$dockerfileDirectory,
        "vcs:revision":$sha,
        "vcs:source":"https://github.com/tflynn3/meshr"
      } + (if $requireWitness then
        {"build-arg:MESHR_MODERATION_RELEASE_SHA":$sha}
      else
        {}
      end)) and
    .predicate.buildDefinition.externalParameters.request.compatibilityVersion == 30 and
    ((.predicate.buildDefinition.externalParameters.request | has("secrets") | not) or
      .predicate.buildDefinition.externalParameters.request.secrets == []) and
    ((.predicate.buildDefinition.externalParameters.request | has("ssh") | not) or
      .predicate.buildDefinition.externalParameters.request.ssh == []) and
    .predicate.buildDefinition.internalParameters.builderPlatform == "linux/amd64" and
    (.predicate.buildDefinition.internalParameters.buildConfig.llbDefinition | length) > 0 and
    (.predicate.buildDefinition.resolvedDependencies | length) > 0 and
    all(.predicate.buildDefinition.resolvedDependencies[];
      (.uri | type == "string" and length > 0) and
      (.digest | type == "object" and length > 0) and
      all(.digest[]; test("^[a-f0-9]{40,128}$"))) and
    .predicate.runDetails.builder.id == $builder and
    (.predicate.runDetails.metadata.invocationId | type == "string" and length > 0) and
    (.predicate.runDetails.metadata.startedOn |
      test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$")) and
    (.predicate.runDetails.metadata.finishedOn |
      test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$")) and
    .predicate.runDetails.metadata.buildkit_completeness.request == true and
    (.predicate.runDetails.metadata.buildkit_completeness.resolvedDependencies |
      type == "boolean") and
    .predicate.runDetails.metadata.buildkit_metadata.vcs == {
      "localdir:context":".",
      "localdir:dockerfile":$dockerfileDirectory,
      "revision":$sha,
      "source":"https://github.com/tflynn3/meshr"
    } and
    any(.predicate.runDetails.metadata.buildkit_metadata.source.infos[];
      .filename == $dockerfileBasename and
      (.data | type == "string" and length > 0)) and
    (.predicate.runDetails.metadata.buildkit_metadata.layers | length) > 0
  ' "$slsa_statement" >/dev/null || {
    echo "$platform SLSA statement is not bound to the expected child, source, Dockerfile, and complete BuildKit invocation" >&2
    exit 1
  }
  jq -e \
    --arg digest "${subject_digest#sha256:}" \
    --arg subject "$expected_subject" '
    ._type == "https://in-toto.io/Statement/v1" and
    .predicateType == "https://spdx.dev/Document" and
    (.subject | length) == 1 and
    .subject[0].name == $subject and
    (.subject[0].digest | keys) == ["sha256"] and
    .subject[0].digest.sha256 == $digest and
    .predicate.SPDXID == "SPDXRef-DOCUMENT" and
    .predicate.dataLicense == "CC0-1.0" and
    (.predicate.spdxVersion | test("^SPDX-2\\.[23]$"))
  ' "$spdx_statement" >/dev/null || {
    echo "$platform SPDX statement is not bound to the expected child" >&2
    exit 1
  }
  jq -cn \
    --arg manifestDigest "$attestation_digest" \
    --arg subjectDigest "$subject_digest" \
    --arg provenanceDigest "$slsa_digest" \
    --arg sbomDigest "$spdx_digest" \
    '{
      manifestDigest:$manifestDigest,
      subjectDigest:$subjectDigest,
      provenanceDigest:$provenanceDigest,
      sbomDigest:$sbomDigest
    }' >>"$attestation_entries"
done < <(jq -r '.manifests[] |
  select(.platform.os == "unknown" and .platform.architecture == "unknown") |
  [.digest, .annotations["vnd.docker.reference.digest"]] | @tsv' "$index_json")

for architecture in amd64 arm64; do
  platform="linux/$architecture"
  child_digest="$(jq -r --arg architecture "$architecture" '
    [.manifests[] |
      select(.platform.os == "linux" and .platform.architecture == $architecture)][0].digest // empty
  ' "$index_json")"
  printf '%s' "$child_digest" | grep -Eq '^sha256:[a-f0-9]{64}$'
  child_manifest="$tmp_dir/$architecture-manifest.json"
  child_image="$image_repository@$child_digest"
  docker buildx imagetools inspect --raw "$child_image" >"$child_manifest"
  bound_file "$child_manifest" 1048576 "$platform runtime manifest"
  actual_child_digest="sha256:$(sha256sum "$child_manifest" | awk '{print $1}')"
  test "$actual_child_digest" = "$child_digest" || {
    echo "$platform manifest bytes do not match $child_digest" >&2
    exit 1
  }
  jq -e '
    .schemaVersion == 2 and
    (.mediaType == "application/vnd.oci.image.manifest.v1+json" or
      .mediaType == "application/vnd.docker.distribution.manifest.v2+json") and
    (.config.mediaType == "application/vnd.oci.image.config.v1+json" or
      .config.mediaType == "application/vnd.docker.container.image.v1+json") and
    (.config.digest | test("^sha256:[a-f0-9]{64}$")) and
    all(.layers[];
      (.digest | test("^sha256:[a-f0-9]{64}$")) and
      ((.urls // []) | length) == 0)
  ' "$child_manifest" >/dev/null || {
    echo "$platform runtime manifest is not a closed OCI/Docker image manifest" >&2
    exit 1
  }
  config_digest="$(jq -r '.config.digest' "$child_manifest")"
  config_json="$tmp_dir/$architecture-config.json"
  fetch_blob "$config_digest" "$config_json" 1048576 "$platform image config"
  jq -e \
    --arg architecture "$architecture" \
    --arg witness "MESHR_MODERATION_RELEASE_SHA=$source_sha" \
    --arg sha "$source_sha" \
    --argjson requireWitness "$require_moderation_witness" '
    .os == "linux" and
    .architecture == $architecture and
    ((.variant // "") == "") and
    (.config.Env | type == "array") and
    (if $requireWitness then
      ([.config.Env[] | select(startswith("MESHR_MODERATION_RELEASE_SHA="))] |
        length == 1 and .[0] == $witness) and
      .config.Labels["org.opencontainers.image.revision"] == $sha
    else
      ([.config.Env[] | select(startswith("MESHR_MODERATION_RELEASE_SHA="))] |
        length == 0)
    end)
  ' "$config_json" >/dev/null || {
    echo "$platform image config does not carry the exact platform and expected release witness policy" >&2
    exit 1
  }
  jq -cn \
    --arg platform "$platform" \
    --arg manifestDigest "$child_digest" \
    --arg configDigest "$config_digest" \
    '{platform:$platform,manifestDigest:$manifestDigest,configDigest:$configDigest}' \
    >>"$platform_entries"
done

provenance_bundle="$tmp_dir/provenance.json"
jq -s 'sort_by(.subject[0].name)' "$tmp_dir"/slsa-*.json >"$provenance_bundle"
bound_file "$provenance_bundle" 16777216 "combined provenance document"

mkdir -p "$(dirname "$receipt_path")"
jq -n \
  --arg image "$immutable_image" \
  --arg indexDigest "${immutable_image##*@}" \
  --arg sourceSha "$source_sha" \
  --arg indexSha256 "$(sha256sum "$index_json" | awk '{print $1}')" \
  --arg provenanceSha256 "$(sha256sum "$provenance_bundle" | awk '{print $1}')" \
  --arg dockerfile "$dockerfile" \
  --slurpfile attestations "$attestation_entries" \
  --slurpfile platforms "$platform_entries" \
  '{
    schemaVersion: 1,
    image: $image,
    indexDigest: $indexDigest,
    sourceSha: $sourceSha,
    indexDocumentSha256: ("sha256:" + $indexSha256),
    provenanceDocumentSha256: ("sha256:" + $provenanceSha256),
    platforms: ($platforms | sort_by(.platform)),
    attestations: ($attestations | sort_by(.subjectDigest)),
    provenance: {
      platforms: ["linux/amd64", "linux/arm64"],
      predicateType: "https://slsa.dev/provenance/v1",
      buildType: "https://github.com/moby/buildkit/blob/master/docs/attestations/slsa-definitions.md",
      sourceRepository: "https://github.com/tflynn3/meshr",
      sourceRevision: $sourceSha,
      dockerfile: $dockerfile
    }
  }' >"$receipt_path"
bound_file "$receipt_path" 32768 "release image verification receipt"

jq -e --arg image "$immutable_image" --arg sha "$source_sha" --arg dockerfile "$dockerfile" '
  (keys | sort) ==
    ["attestations", "image", "indexDigest", "indexDocumentSha256", "platforms", "provenance", "provenanceDocumentSha256", "schemaVersion", "sourceSha"] and
  .schemaVersion == 1 and
  .image == $image and
  .sourceSha == $sha and
  .provenance.dockerfile == $dockerfile and
  (.platforms | length) == 2 and
  (.attestations | length) == 2 and
  (.sourceSha | test("^[a-f0-9]{40}$"))
' "$receipt_path" >/dev/null
