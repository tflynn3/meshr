#!/usr/bin/env bash
set -euo pipefail

script_directory="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(CDPATH='' cd -- "${script_directory}/../.." && pwd)"
namespace=flux-system
kustomization_name=meshr-production-qualification
quota_name=meshr-production-qualification-releases
wait_attempts="${MESHR_QUALIFICATION_WAIT_ATTEMPTS:-450}"

temporary_directory="$(mktemp -d)"
transaction_armed=false
transaction_complete=false
transaction_target_id=
transaction_previous_id=
transaction_previous_object=
transaction_target_object=
staged_release_id=
transaction_succeeded_during_recovery=false
transaction_cancelled=false
transaction_cancel_status=
switch_skipped_ready=false

usage() {
  printf '%s\n' \
    "usage: $0 initialize RELEASE_SHA IMAGE_INPUTS_JSON BOOTSTRAP_RUNTIME_JSON" \
    "usage: $0 bootstrap RELEASE_SHA IMAGE_INPUTS_JSON BOOTSTRAP_RUNTIME_JSON" \
    "       $0 promote RELEASE_SHA IMAGE_INPUTS_JSON READY_RUNTIME_JSON" \
    "       $0 validate RELEASE_SHA IMAGE_INPUTS_JSON RUNTIME_INPUTS_JSON" \
    "       $0 rollback EXPECTED_ACTIVE_RELEASE_ID EXPECTED_PREVIOUS_RELEASE_ID" >&2
  exit 64
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'required command is unavailable: %s\n' "$1" >&2
    exit 69
  }
}

for required_command in awk cut grep jq kubectl shasum tail; do
  require_command "$required_command"
done

case "$wait_attempts" in
  '' | *[!0-9]*)
    printf 'MESHR_QUALIFICATION_WAIT_ATTEMPTS must be a positive integer\n' >&2
    exit 64
    ;;
esac
test "$wait_attempts" -gt 0 || {
  printf 'MESHR_QUALIFICATION_WAIT_ATTEMPTS must be greater than zero\n' >&2
  exit 64
}

api_get() {
  kubectl -n "$namespace" get "$1" "$2" -o json >"$3"
}

export_admission_anchors() {
  local runtime_object="$1"
  local anchor_name anchor_value
  : "${CONNECT_GATEWAY_DEPLOY_SERVICE_ACCOUNT_EMAIL:?set the exact hosted deploy GSA}"
  printf '%s' "$CONNECT_GATEWAY_DEPLOY_SERVICE_ACCOUNT_EMAIL" |
    grep -Eq '^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9][.]iam[.]gserviceaccount[.]com$' ||
    return 1
  for anchor_name in \
    GCP_PROJECT_ID \
    MESHR_FIRESTORE_DATABASE \
    MESHR_TOPOLOGY_FIRESTORE_DATABASE \
    MESHR_EVENT_AUDIT_FIRESTORE_DATABASE \
    MESHR_NOTIFICATIONS_FIRESTORE_DATABASE \
    MESHR_MODERATION_FIRESTORE_DATABASE \
    MESHR_MODERATION_AUDIENCE; do
    anchor_value="$(jq -er --arg name "$anchor_name" '
      (.data // .)[$name] |
      select(type == "string" and length > 0 and
        (contains("\n") | not) and (contains("\r") | not))
    ' "$runtime_object")" || return 1
    printf -v "$anchor_name" '%s' "$anchor_value" || return 1
    # anchor_name is limited to the fixed environment-variable allowlist above.
    # shellcheck disable=SC2163
    export "$anchor_name"
  done
  export CONNECT_GATEWAY_DEPLOY_SERVICE_ACCOUNT_EMAIL
}

release_phase() {
  printf '%s\n' "$1" | cut -d- -f1
}

release_sha() {
  printf '%s\n' "$1" | cut -d- -f2
}

verify_forward_target_not_failed() {
  local current_transition_kind="$1"
  local target_release_id="$2"
  local failed_release_id="$3"
  local target_commit_sha failed_commit_sha
  test "$current_transition_kind" = rollback || return 0
  target_commit_sha="$(release_sha "$target_release_id")" || return 1
  failed_commit_sha="$(release_sha "$failed_release_id")" || return 1
  test "$target_commit_sha" != "$failed_commit_sha" || {
    printf '%s\n' \
      'refusing to promote the commit recorded as failed by the last rollback' >&2
    return 1
  }
}

runtime_release_id() {
  local target_sha="$1"
  local runtime_inputs="$2"
  local force_scan bootstrap_id phase runtime_hash
  force_scan="$(jq -r '.MESHR_FORCE_PROJECTION_BOOTSTRAP_SCAN' "$runtime_inputs")" ||
    return 1
  bootstrap_id="$(jq -r '.MESHR_EXPECTED_AUTHORITY_BOOTSTRAP_ID' "$runtime_inputs")" ||
    return 1
  if test "$force_scan" = 1 && test "$bootstrap_id" = pending; then
    phase=b
  elif test "$force_scan" = 0 && test "$bootstrap_id" != pending; then
    phase=r
  else
    printf '%s\n' \
      'runtime bootstrap ID and force-scan flag do not form a bootstrap or ready phase' >&2
    return 1
  fi
  runtime_hash="$(jq -cS . "$runtime_inputs" | shasum -a 256 | awk '{print substr($1, 1, 12)}')" ||
    return 1
  printf '%s-%s-%s\n' "$phase" "$target_sha" "$runtime_hash"
}

validate_release_inputs() {
  local target_sha="$1"
  local image_inputs="$2"
  local runtime_inputs="$3"
  local project_id computed_release_id runtime_name

  printf '%s' "$target_sha" | grep -Eq '^[a-f0-9]{40}$' || {
    printf 'release SHA must be a lowercase full commit hash\n' >&2
    return 1
  }
  test -f "$image_inputs" && test -f "$runtime_inputs" || {
    printf 'release input JSON files must exist\n' >&2
    return 1
  }

  jq -e '
    type == "object" and
    keys == ["API_IMAGE", "EVENT_PLANE_IMAGE", "MODERATION_ADAPTER_IMAGE", "WEB_IMAGE"] and
    all(.[]; type == "string" and length <= 512 and
      (contains("\n") | not) and (contains("\r") | not))
  ' "$image_inputs" >/dev/null || return 1

  jq -e --arg sha "$target_sha" '
    type == "object" and
    keys == [
      "GCP_PROJECT_ID",
      "MESHR_COST_PROTECTION_MODE",
      "MESHR_CUTOVER_VALIDATION_AGENT_ID",
      "MESHR_CUTOVER_VALIDATION_BINDING_ID",
      "MESHR_CUTOVER_VALIDATION_MESH_ID",
      "MESHR_CUTOVER_VALIDATION_SESSION_ID",
      "MESHR_DATABASE_CUTOVER_MODE",
      "MESHR_EVENT_AUDIT_FIRESTORE_DATABASE",
      "MESHR_EXPECTED_AUTHORITY_BOOTSTRAP_ID",
      "MESHR_FIRESTORE_DATABASE",
      "MESHR_FORCE_PROJECTION_BOOTSTRAP_SCAN",
      "MESHR_MODERATION_AUDIENCE",
      "MESHR_MODERATION_ENDPOINT",
      "MESHR_MODERATION_FIRESTORE_DATABASE",
      "MESHR_MODERATION_HEALTHCHECK_URL",
      "MESHR_MODERATION_RELEASE_SHA",
      "MESHR_MODERATION_REVISION_TAG",
      "MESHR_NOTIFICATIONS_FIRESTORE_DATABASE",
      "MESHR_RELEASE_SHA",
      "MESHR_TOPOLOGY_FIRESTORE_DATABASE"
    ] and
    all(.[]; type == "string" and length <= 512 and
      (contains("\n") | not) and (contains("\r") | not)) and
    (.GCP_PROJECT_ID | test("^[a-z][a-z0-9-]{4,28}[a-z0-9]$")) and
    .MESHR_RELEASE_SHA == $sha and
    (.MESHR_FORCE_PROJECTION_BOOTSTRAP_SCAN | test("^[01]$")) and
    (.MESHR_DATABASE_CUTOVER_MODE | test("^(off|normal|validation)$")) and
    (.MESHR_COST_PROTECTION_MODE | test("^(normal|protect|throttle)$")) and
    (.MESHR_MODERATION_AUDIENCE |
      test("^https://[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?([.][a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*[.]run[.]app$") and
      (contains("---") | not)) and
    .MESHR_MODERATION_RELEASE_SHA == $sha and
    .MESHR_MODERATION_REVISION_TAG ==
      ("r-" + (.MESHR_MODERATION_RELEASE_SHA[0:20])) and
    ((.MESHR_MODERATION_REVISION_TAG | length) + 3 +
      (.MESHR_MODERATION_AUDIENCE | ltrimstr("https://") |
        split(".")[0] | length) <= 63) and
    .MESHR_MODERATION_ENDPOINT ==
      ("https://" + .MESHR_MODERATION_REVISION_TAG + "---" +
        (.MESHR_MODERATION_AUDIENCE | ltrimstr("https://")) + "/screen") and
    .MESHR_MODERATION_HEALTHCHECK_URL ==
      ("https://" + .MESHR_MODERATION_REVISION_TAG + "---" +
        (.MESHR_MODERATION_AUDIENCE | ltrimstr("https://")) + "/health") and
    ([
      .MESHR_EXPECTED_AUTHORITY_BOOTSTRAP_ID,
      .MESHR_CUTOVER_VALIDATION_MESH_ID,
      .MESHR_CUTOVER_VALIDATION_BINDING_ID,
      .MESHR_CUTOVER_VALIDATION_AGENT_ID,
      .MESHR_CUTOVER_VALIDATION_SESSION_ID
    ] | all(test("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")))
  ' "$runtime_inputs" >/dev/null || return 1

  project_id="$(jq -r '.GCP_PROJECT_ID' "$runtime_inputs")" || return 1
  jq -e --arg project "$project_id" '
    (.API_IMAGE |
      test("^us-central1-docker[.]pkg[.]dev/" + $project +
        "/meshr/api@sha256:[a-f0-9]{64}$")) and
    (.EVENT_PLANE_IMAGE |
      test("^us-central1-docker[.]pkg[.]dev/" + $project +
        "/meshr/event-plane@sha256:[a-f0-9]{64}$")) and
    (.MODERATION_ADAPTER_IMAGE |
      test("^us-central1-docker[.]pkg[.]dev/" + $project +
        "/meshr/moderation-adapter@sha256:[a-f0-9]{64}$")) and
    (.WEB_IMAGE |
      test("^us-central1-docker[.]pkg[.]dev/" + $project +
        "/meshr/web@sha256:[a-f0-9]{64}$"))
  ' "$image_inputs" >/dev/null || return 1

  computed_release_id="$(runtime_release_id "$target_sha" "$runtime_inputs")" ||
    return 1
  printf '%s' "$computed_release_id" \
    | grep -Eq '^[br]-[a-f0-9]{40}-[a-f0-9]{12}$' || return 1
  test "${#computed_release_id}" -eq 55 || return 1
  runtime_name="meshr-r-${computed_release_id}"
  test "${#runtime_name}" -le 63 || return 1
}

render_kustomization() {
  local target_sha="$1"
  local target_release_id="$2"
  local output_json="$3"
  local rendered_flux rendered_kustomization grep_status target_id_sha
  # shellcheck disable=SC2016
  local placeholder_marker='${'
  rendered_flux="${temporary_directory}/flux-${target_release_id}.yaml"
  rendered_kustomization="${temporary_directory}/kustomization-${target_release_id}.yaml"

  printf '%s' "$target_sha" | grep -Eq '^[a-f0-9]{40}$' || return 1
  printf '%s' "$target_release_id" \
    | grep -Eq '^[br]-[a-f0-9]{40}-[a-f0-9]{12}$' || return 1
  target_id_sha="${target_release_id#?-}"
  target_id_sha="${target_id_sha%%-*}"
  test "$target_id_sha" = "$target_sha" || return 1
  awk -v sha="$target_sha" -v release_id="$target_release_id" '
    {
      gsub(/[$][{]MESHR_PRODUCTION_QUALIFICATION_SHA[}]/, sha)
      gsub(/[$][{]MESHR_PRODUCTION_QUALIFICATION_RELEASE_ID[}]/, release_id)
      print
    }
  ' "${script_directory}/flux.yaml" >"$rendered_flux" || return 1
  if grep -F "$placeholder_marker" "$rendered_flux" >/dev/null; then
    printf '%s\n' 'rendered Kustomization contains an unexpanded placeholder' >&2
    return 1
  else
    grep_status=$?
    test "$grep_status" -eq 1 || return 1
  fi
  awk 'found { print } /^---[[:space:]]*$/ { found = 1; next }' \
    "$rendered_flux" >"$rendered_kustomization" || return 1
  kubectl create --dry-run=client -o json -f "$rendered_kustomization" \
    >"$output_json" || return 1
}

make_release_objects() {
  local target_sha="$1"
  local target_release_id="$2"
  local image_inputs="$3"
  local runtime_inputs="$4"
  local source_output="$5"
  local images_output="$6"
  local runtime_output="$7"

  jq -n --arg sha "$target_sha" '{
    apiVersion: "source.toolkit.fluxcd.io/v1",
    kind: "GitRepository",
    metadata: {
      name: ("meshr-pq-source-" + $sha),
      namespace: "flux-system"
    },
    spec: {
      interval: "24h",
      timeout: "5m",
      url: "https://github.com/tflynn3/meshr.git",
      provider: "generic",
      suspend: false,
      recurseSubmodules: false,
      ref: { branch: "main", commit: $sha }
    }
  }' >"$source_output" || return 1
  jq -n --arg sha "$target_sha" --slurpfile release_data "$image_inputs" '{
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: ("meshr-pq-images-" + $sha),
      namespace: "flux-system"
    },
    immutable: true,
    data: $release_data[0]
  }' >"$images_output" || return 1
  jq -n --arg release_id "$target_release_id" \
    --slurpfile release_data "$runtime_inputs" '{
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: {
        name: ("meshr-r-" + $release_id),
        namespace: "flux-system"
      },
      immutable: true,
      data: $release_data[0]
  }' >"$runtime_output" || return 1
}

verify_source_object() {
  local actual="$1"
  local expected="$2"
  jq -e --slurpfile expected "$expected" '
    .apiVersion == $expected[0].apiVersion and
    .kind == $expected[0].kind and
    .metadata.name == $expected[0].metadata.name and
    .metadata.namespace == $expected[0].metadata.namespace and
    (.metadata.deletionTimestamp // null) == null and
    .spec == $expected[0].spec and
    ((.metadata.annotations // {}) | length == 0) and
    ((.metadata.labels // {}) | length == 0) and
    ((.metadata.ownerReferences // []) | length == 0) and
    ((.metadata.finalizers // []) == [] or
      (.metadata.finalizers // []) == ["finalizers.fluxcd.io"])
  ' "$actual" >/dev/null
}

verify_configmap_object() {
  local actual="$1"
  local expected="$2"
  jq -e --slurpfile expected "$expected" '
    .apiVersion == "v1" and .kind == "ConfigMap" and
    .metadata.name == $expected[0].metadata.name and
    .metadata.namespace == "flux-system" and
    (.metadata.deletionTimestamp // null) == null and
    .immutable == true and .data == $expected[0].data and
    ((.binaryData // {}) | length == 0) and
    ((.metadata.annotations // {}) | length == 0) and
    ((.metadata.labels // {}) | length == 0) and
    ((.metadata.ownerReferences // []) | length == 0) and
    ((.metadata.finalizers // []) | length == 0)
  ' "$actual" >/dev/null
}

verify_bootstrap_pointer() {
  local actual="$1"
  local bootstrap_release_id="$2"
  local active_release_id previous_release_id target_sha active_sha active_phase
  active_release_id="$(jq -r \
    '.metadata.annotations["meshr.social/active-release-id"]' "$actual")" ||
    return 1
  previous_release_id="$(jq -r \
    '.metadata.annotations["meshr.social/previous-release-id"]' "$actual")" ||
    return 1
  target_sha="$(release_sha "$bootstrap_release_id")" || return 1

  verify_kustomization_shape \
    "$actual" "$active_release_id" false bootstrap || return 1
  test "$previous_release_id" = "$bootstrap_release_id" || return 1
  active_sha="$(release_sha "$active_release_id")" || return 1
  test "$active_sha" = "$target_sha" || return 1
  if test "$active_release_id" != "$bootstrap_release_id"; then
    active_phase="$(release_phase "$active_release_id")" || return 1
    test "$active_phase" = r || return 1
  fi
}

verify_initialization_pointer() {
  local actual="$1"
  local bootstrap_release_id="$2"
  local active_release_id previous_release_id
  active_release_id="$(jq -r \
    '.metadata.annotations["meshr.social/active-release-id"]' "$actual")" ||
    return 1
  previous_release_id="$(jq -r \
    '.metadata.annotations["meshr.social/previous-release-id"]' "$actual")" ||
    return 1
  test "$active_release_id" = "$bootstrap_release_id" || return 1
  test "$previous_release_id" = "$bootstrap_release_id" || return 1
  verify_kustomization_shape \
    "$actual" "$bootstrap_release_id" false bootstrap || return 1
}

quota_preflight() {
  local target_sha="$1"
  local target_release_id="$2"
  local quota sources configmaps source_needed image_needed runtime_needed
  local kustomization_needed source_count configmap_count source_limit configmap_limit
  local source_used configmap_used kustomization_used attempt
  quota="${temporary_directory}/quota.json"
  sources="${temporary_directory}/source-inventory.json"
  configmaps="${temporary_directory}/configmap-inventory.json"
  attempt=1
  while test "$attempt" -le "$wait_attempts"; do
    if api_get resourcequota "$quota_name" "$quota" 2>/dev/null &&
      jq -e '
        . as $quota |
        $quota.status.hard == $quota.spec.hard and
        ([
          "count/configmaps",
          "count/gitrepositories.source.toolkit.fluxcd.io",
          "count/kustomizations.kustomize.toolkit.fluxcd.io"
          ] as $quota_keys |
          all($quota_keys[];
            . as $key |
            ($quota.status.used[$key] // "") | test("^[0-9]+$")))
      ' "$quota" >/dev/null; then
      break
    fi
    test "$attempt" -lt "$wait_attempts" || {
      printf '%s\n' \
        'qualification release quota status did not become authoritative' >&2
      return 1
    }
    sleep 2 || return 1
    attempt=$((attempt + 1))
  done
  kubectl -n "$namespace" get gitrepositories.source.toolkit.fluxcd.io \
    -o json >"$sources" || return 1
  kubectl -n "$namespace" get configmaps -o json >"$configmaps" || return 1
  jq -e '
    .spec.hard["count/gitrepositories.source.toolkit.fluxcd.io"] as $source_limit |
    .spec.hard["count/configmaps"] as $configmap_limit |
    ($source_limit | test("^[1-9][0-9]{0,2}$")) and
    ($source_limit | tonumber <= 64) and
    ($configmap_limit | test("^[1-9][0-9]{0,2}$")) and
    ($configmap_limit | tonumber <= 192) and
    .spec.hard["count/kustomizations.kustomize.toolkit.fluxcd.io"] == "1"
  ' "$quota" >/dev/null || return 1
  source_limit="$(jq -r \
    '.spec.hard["count/gitrepositories.source.toolkit.fluxcd.io"]' "$quota")" ||
    return 1
  configmap_limit="$(jq -r '.spec.hard["count/configmaps"]' "$quota")" ||
    return 1
  jq -e '
    all(.items[]; .metadata.name | test("^meshr-pq-source-[a-f0-9]{40}$"))
  ' "$sources" >/dev/null || {
    printf '%s\n' \
      'unexpected GitRepository exists in the qualification release inventory' >&2
    return 1
  }
  jq -e '
    all(.items[];
      .metadata.name == "kube-root-ca.crt" or
      (.metadata.name | test("^meshr-pq-images-[a-f0-9]{40}$")) or
      (.metadata.name | test("^meshr-r-[br]-[a-f0-9]{40}-[a-f0-9]{12}$")))
  ' "$configmaps" >/dev/null || {
    printf '%s\n' \
      'unexpected ConfigMap exists in the qualification release inventory' >&2
    return 1
  }

  source_needed=1
  image_needed=1
  runtime_needed=1
  kustomization_needed=1
  if api_get gitrepository.source.toolkit.fluxcd.io \
    "meshr-pq-source-${target_sha}" "${temporary_directory}/quota-source.json" \
    2>/dev/null; then
    source_needed=0
  fi
  if api_get configmap "meshr-pq-images-${target_sha}" \
    "${temporary_directory}/quota-images.json" 2>/dev/null; then
    image_needed=0
  fi
  if api_get configmap "meshr-r-${target_release_id}" \
    "${temporary_directory}/quota-runtime.json" 2>/dev/null; then
    runtime_needed=0
  fi
  if api_get kustomization.kustomize.toolkit.fluxcd.io \
    "$kustomization_name" "${temporary_directory}/quota-kustomization.json" \
    2>/dev/null; then
    kustomization_needed=0
  fi
  source_count="$(jq '.items | length' "$sources")" || return 1
  configmap_count="$(jq '.items | length' "$configmaps")" || return 1
  source_used="$(jq -r \
    '.status.used["count/gitrepositories.source.toolkit.fluxcd.io"]' "$quota")" ||
    return 1
  configmap_used="$(jq -r '.status.used["count/configmaps"]' "$quota")" ||
    return 1
  kustomization_used="$(jq -r \
    '.status.used["count/kustomizations.kustomize.toolkit.fluxcd.io"]' \
    "$quota")" || return 1
  test "$source_count" -eq "$source_used" &&
    test "$configmap_count" -eq "$configmap_used" &&
    test "$kustomization_used" -eq "$((1 - kustomization_needed))" || {
    printf '%s\n' \
      'qualification release quota usage does not match the live retained inventory' >&2
    return 1
  }
  test "$((source_count + source_needed))" -le "$source_limit" || {
    printf '%s\n' \
      'qualification GitRepository capacity is exhausted; operator review or garbage collection is required' >&2
    return 1
  }
  test "$((configmap_count + image_needed + runtime_needed))" \
    -le "$configmap_limit" || {
    printf '%s\n' \
      'qualification ConfigMap capacity is exhausted; operator review or garbage collection is required' >&2
    return 1
  }
}

create_or_verify_source() {
  local target_sha="$1"
  local expected="$2"
  local actual name
  actual="${temporary_directory}/source-${target_sha}-actual.json"
  name="meshr-pq-source-${target_sha}"
  if ! api_get gitrepository.source.toolkit.fluxcd.io "$name" "$actual" 2>/dev/null; then
    if ! kubectl create -f "$expected" >/dev/null; then
      api_get gitrepository.source.toolkit.fluxcd.io "$name" "$actual" || return 1
    fi
    api_get gitrepository.source.toolkit.fluxcd.io "$name" "$actual" || return 1
  fi
  verify_source_object "$actual" "$expected" || {
    printf 'existing GitRepository %s does not exactly match release input\n' "$name" >&2
    return 1
  }
}

create_or_verify_configmap() {
  local name="$1"
  local expected="$2"
  local actual
  actual="${temporary_directory}/${name}-actual.json"
  if ! api_get configmap "$name" "$actual" 2>/dev/null; then
    if ! kubectl create -f "$expected" >/dev/null; then
      api_get configmap "$name" "$actual" || return 1
    fi
    api_get configmap "$name" "$actual" || return 1
  fi
  verify_configmap_object "$actual" "$expected" || {
    printf 'existing ConfigMap %s does not exactly match release input\n' "$name" >&2
    return 1
  }
}

stage_release() {
  local target_sha="$1"
  local image_inputs="$2"
  local runtime_inputs="$3"
  local source_expected images_expected runtime_expected
  local source_readback images_readback runtime_readback
  validate_release_inputs "$target_sha" "$image_inputs" "$runtime_inputs" || return 1
  staged_release_id="$(runtime_release_id "$target_sha" "$runtime_inputs")" || return 1
  source_expected="${temporary_directory}/source-${target_sha}-expected.json"
  images_expected="${temporary_directory}/images-${target_sha}-expected.json"
  runtime_expected="${temporary_directory}/runtime-${staged_release_id}-expected.json"
  make_release_objects "$target_sha" "$staged_release_id" "$image_inputs" \
    "$runtime_inputs" "$source_expected" "$images_expected" "$runtime_expected" ||
    return 1
  quota_preflight "$target_sha" "$staged_release_id" || return 1
  create_or_verify_configmap "meshr-pq-images-${target_sha}" "$images_expected" ||
    return 1
  create_or_verify_configmap "meshr-r-${staged_release_id}" "$runtime_expected" ||
    return 1
  create_or_verify_source "$target_sha" "$source_expected" || return 1

  # A failed create may have raced an existing object. Adopt it only after a
  # fresh, byte-semantic readback of every protected field.
  source_readback="${temporary_directory}/source-${staged_release_id}-readback.json"
  images_readback="${temporary_directory}/images-${staged_release_id}-readback.json"
  runtime_readback="${temporary_directory}/runtime-${staged_release_id}-readback.json"
  api_get gitrepository.source.toolkit.fluxcd.io \
    "meshr-pq-source-${target_sha}" "$source_readback" || return 1
  api_get configmap "meshr-pq-images-${target_sha}" "$images_readback" || return 1
  api_get configmap "meshr-r-${staged_release_id}" "$runtime_readback" || return 1
  verify_source_object "$source_readback" "$source_expected" || return 1
  verify_configmap_object "$images_readback" "$images_expected" || return 1
  verify_configmap_object "$runtime_readback" "$runtime_expected" || return 1
}

wait_for_source() {
  local target_sha="$1"
  local source_name="meshr-pq-source-${target_sha}"
  local source_actual="${temporary_directory}/source-wait-${target_sha}.json"
  local attempt=1
  while test "$attempt" -le "$wait_attempts"; do
    if api_get gitrepository.source.toolkit.fluxcd.io \
      "$source_name" "$source_actual" 2>/dev/null &&
      jq -e --arg sha "$target_sha" '
        .metadata.generation as $generation |
        .status.observedGeneration == $generation and
        any(.status.conditions[]?;
          .type == "Ready" and .status == "True" and
          .observedGeneration == $generation) and
        .status.artifact.revision == ("main@sha1:" + $sha)
      ' "$source_actual" >/dev/null; then
      return 0
    fi
    sleep 2 || return 1
    attempt=$((attempt + 1))
  done
  printf 'GitRepository %s did not become ready for its exact commit\n' \
    "$source_name" >&2
  return 1
}

verify_kustomization_shape() {
  local actual="$1"
  local active_release_id="$2"
  local require_ready="$3"
  local expected_transition_kind="${4:-any}"
  local active_sha expected
  case "$expected_transition_kind" in
    any | bootstrap | forward | rollback) ;;
    *) return 1 ;;
  esac
  active_sha="$(release_sha "$active_release_id")" || return 1
  expected="${temporary_directory}/expected-kustomization-${active_release_id}.json"
  render_kustomization "$active_sha" "$active_release_id" "$expected" ||
    return 1
  jq -e --arg active "$active_release_id" --arg sha "$active_sha" \
    --arg transition "$expected_transition_kind" \
    --argjson require_ready "$require_ready" --slurpfile expected "$expected" '
      .apiVersion == "kustomize.toolkit.fluxcd.io/v1" and
      .kind == "Kustomization" and
      .metadata.name == "meshr-production-qualification" and
      .metadata.namespace == "flux-system" and
      (.metadata.deletionTimestamp // null) == null and
      .spec == $expected[0].spec and
      (.metadata.annotations | keys) ==
        ["meshr.social/active-release-id", "meshr.social/previous-release-id",
          "meshr.social/transition-kind"] and
      .metadata.annotations["meshr.social/active-release-id"] == $active and
      (.metadata.annotations["meshr.social/previous-release-id"] |
        test("^[br]-[a-f0-9]{40}-[a-f0-9]{12}$")) and
      (.metadata.annotations["meshr.social/transition-kind"] as $actual_transition |
        ($actual_transition == "bootstrap" or $actual_transition == "forward" or
          $actual_transition == "rollback") and
        ($transition == "any" or $actual_transition == $transition)) and
      ((.metadata.labels // {}) | length == 0) and
      ((.metadata.ownerReferences // []) | length == 0) and
      ((.metadata.finalizers // []) == [] or
        (.metadata.finalizers // []) == ["finalizers.fluxcd.io"]) and
      (($require_ready | not) or
        (.metadata.generation as $generation |
          .status.observedGeneration == $generation and
          any(.status.conditions[]?;
            .type == "Ready" and .status == "True" and
            .observedGeneration == $generation) and
          .status.lastAppliedRevision == ("main@sha1:" + $sha)))
    ' "$actual" >/dev/null || return 1
}

kustomization_is_ready_for_release() {
  local actual="$1"
  local active_release_id="$2"
  local active_sha
  active_sha="$(release_sha "$active_release_id")" || return 1
  jq -e --arg sha "$active_sha" '
    .metadata.generation as $generation |
    .status.observedGeneration == $generation and
    any(.status.conditions[]?;
      .type == "Ready" and .status == "True" and
      .observedGeneration == $generation) and
    .status.lastAppliedRevision == ("main@sha1:" + $sha)
  ' "$actual" >/dev/null
}

wait_for_kustomization() {
  local active_release_id="$1"
  local expected_transition_kind="${2:-any}"
  local actual="${temporary_directory}/kustomization-wait-${active_release_id}.json"
  local attempt=1
  while test "$attempt" -le "$wait_attempts"; do
    if api_get kustomization.kustomize.toolkit.fluxcd.io \
      "$kustomization_name" "$actual" 2>/dev/null &&
      verify_kustomization_shape "$actual" "$active_release_id" true \
        "$expected_transition_kind"; then
      return 0
    fi
    sleep 2 || return 1
    attempt=$((attempt + 1))
  done
  printf 'Kustomization did not become Ready at release %s\n' \
    "$active_release_id" >&2
  return 1
}

make_switch_patch() {
  local current_object="$1"
  local target_object="$2"
  local next_active_id="$3"
  local next_previous_id="$4"
  local next_transition_kind="$5"
  local output="$6"
  jq -n --arg active "$next_active_id" --arg previous "$next_previous_id" \
    --arg transition "$next_transition_kind" \
    --slurpfile current "$current_object" --slurpfile target "$target_object" '[
      {op: "test", path: "/metadata/resourceVersion",
        value: $current[0].metadata.resourceVersion},
      {op: "test", path: "/spec", value: $current[0].spec},
      {op: "test", path: "/metadata/annotations/meshr.social~1active-release-id",
        value: $current[0].metadata.annotations["meshr.social/active-release-id"]},
      {op: "test", path: "/metadata/annotations/meshr.social~1previous-release-id",
        value: $current[0].metadata.annotations["meshr.social/previous-release-id"]},
      {op: "test", path: "/metadata/annotations/meshr.social~1transition-kind",
        value: $current[0].metadata.annotations["meshr.social/transition-kind"]},
      {op: "replace", path: "/spec", value: $target[0].spec},
      {op: "replace", path: "/metadata/annotations/meshr.social~1active-release-id",
        value: $active},
      {op: "replace", path: "/metadata/annotations/meshr.social~1previous-release-id",
        value: $previous},
      {op: "replace", path: "/metadata/annotations/meshr.social~1transition-kind",
        value: $transition}
    ]' >"$output" || return 1
}

apply_switch() {
  local current_object="$1"
  local target_object="$2"
  local next_active_id="$3"
  local next_previous_id="$4"
  local next_transition_kind="$5"
  local ready_guard_release_id="${6:-}"
  local patch_file="${temporary_directory}/switch-${next_active_id}.json"
  local observed="${temporary_directory}/switch-observed-${next_active_id}.json"
  local candidate_current="$current_object"
  local attempt=1
  case "$next_transition_kind" in
    bootstrap | forward | rollback) ;;
    *) return 1 ;;
  esac
  switch_skipped_ready=false
  while test "$attempt" -le 5; do
    if test -n "$ready_guard_release_id"; then
      verify_kustomization_shape "$candidate_current" \
        "$ready_guard_release_id" false forward || return 1
      if kustomization_is_ready_for_release \
        "$candidate_current" "$ready_guard_release_id"; then
        switch_skipped_ready=true
        return 0
      fi
    fi
    make_switch_patch "$candidate_current" "$target_object" \
      "$next_active_id" "$next_previous_id" "$next_transition_kind" \
      "$patch_file" || return 1
    if kubectl -n "$namespace" patch \
      kustomization.kustomize.toolkit.fluxcd.io "$kustomization_name" \
      --type=json --patch-file="$patch_file" >/dev/null; then
      return 0
    fi
    api_get kustomization.kustomize.toolkit.fluxcd.io \
      "$kustomization_name" "$observed" || return 1
    if jq -e --arg active "$next_active_id" --arg previous "$next_previous_id" \
      --arg transition "$next_transition_kind" \
      --slurpfile target "$target_object" '
        .spec == $target[0].spec and
        .metadata.annotations["meshr.social/active-release-id"] == $active and
        .metadata.annotations["meshr.social/previous-release-id"] == $previous and
        .metadata.annotations["meshr.social/transition-kind"] == $transition
      ' "$observed" >/dev/null; then
      printf '%s\n' \
        'release pointer reached the intended state despite an ambiguous patch response' >&2
      return 0
    fi
    if ! jq -e --slurpfile original "$current_object" '
      .spec == $original[0].spec and
      .metadata.annotations == $original[0].metadata.annotations
    ' "$observed" >/dev/null; then
      printf '%s\n' \
        'release pointer changed concurrently; refusing to overwrite it' >&2
      return 1
    fi
    candidate_current="$observed"
    attempt=$((attempt + 1))
  done
  printf '%s\n' 'release pointer CAS did not stabilize after five attempts' >&2
  return 1
}

verify_release_by_id() {
  local target_release_id="$1"
  local target_sha runtime_object image_object source_object runtime_data image_data
  local source_expected image_expected runtime_expected computed_release_id
  target_sha="$(release_sha "$target_release_id")" || return 1
  runtime_object="${temporary_directory}/verify-runtime-${target_release_id}.json"
  image_object="${temporary_directory}/verify-images-${target_release_id}.json"
  source_object="${temporary_directory}/verify-source-${target_release_id}.json"
  runtime_data="${temporary_directory}/verify-runtime-data-${target_release_id}.json"
  image_data="${temporary_directory}/verify-image-data-${target_release_id}.json"
  source_expected="${temporary_directory}/verify-source-expected-${target_release_id}.json"
  image_expected="${temporary_directory}/verify-images-expected-${target_release_id}.json"
  runtime_expected="${temporary_directory}/verify-runtime-expected-${target_release_id}.json"

  api_get configmap "meshr-r-${target_release_id}" "$runtime_object" || return 1
  api_get configmap "meshr-pq-images-${target_sha}" "$image_object" || return 1
  api_get gitrepository.source.toolkit.fluxcd.io \
    "meshr-pq-source-${target_sha}" "$source_object" || return 1
  jq '.data' "$runtime_object" >"$runtime_data" || return 1
  jq '.data' "$image_object" >"$image_data" || return 1
  validate_release_inputs "$target_sha" "$image_data" "$runtime_data" || return 1
  computed_release_id="$(runtime_release_id "$target_sha" "$runtime_data")" || return 1
  test "$computed_release_id" = "$target_release_id" || return 1
  make_release_objects "$target_sha" "$target_release_id" "$image_data" \
    "$runtime_data" "$source_expected" "$image_expected" "$runtime_expected" ||
    return 1
  verify_source_object "$source_object" "$source_expected" || return 1
  verify_configmap_object "$image_object" "$image_expected" || return 1
  verify_configmap_object "$runtime_object" "$runtime_expected" || return 1
  wait_for_source "$target_sha" || return 1
}

resume_active_promotion() {
  local current_object="$1"
  local target_release_id="$2"
  local target_sha="$3"
  local image_inputs="$4"
  local runtime_inputs="$5"
  local previous_id previous_phase previous_sha target_bootstrap_id
  local previous_bootstrap_id previous_runtime_object
  local resume_previous_base resume_previous_object transition_kind

  transition_kind="$(jq -r \
    '.metadata.annotations["meshr.social/transition-kind"]' \
    "$current_object")" || return 1

  if verify_kustomization_shape "$current_object" "$target_release_id" true \
    "$transition_kind"; then
    stage_release "$target_sha" "$image_inputs" "$runtime_inputs" || return 1
    test "$staged_release_id" = "$target_release_id" || return 1
    wait_for_source "$target_sha" || return 1
    printf 'qualification is already Ready at %s\n' "$target_release_id"
    return 0
  fi

  test "$transition_kind" = forward || {
    printf '%s\n' \
      'an interrupted promotion can resume only from a forward transition' >&2
    return 1
  }

  previous_id="$(jq -r \
    '.metadata.annotations["meshr.social/previous-release-id"]' \
    "$current_object")" || return 1
  previous_phase="$(release_phase "$previous_id")" || return 1
  test "$previous_phase" = r || {
    printf '%s\n' \
      'an interrupted promotion can resume only with a prior Ready release' >&2
    return 1
  }
  previous_sha="$(release_sha "$previous_id")" || return 1
  test "$previous_sha" != "$target_sha" || {
    printf '%s\n' \
      'an interrupted promotion must retain a distinct-SHA rollback release' >&2
    return 1
  }
  verify_release_by_id "$previous_id" || return 1
  previous_runtime_object="${temporary_directory}/resume-previous-runtime.json"
  api_get configmap "meshr-r-${previous_id}" "$previous_runtime_object" || return 1
  previous_bootstrap_id="$(jq -r \
    '.data.MESHR_EXPECTED_AUTHORITY_BOOTSTRAP_ID' \
    "$previous_runtime_object")" || return 1
  target_bootstrap_id="$(jq -r \
    '.MESHR_EXPECTED_AUTHORITY_BOOTSTRAP_ID' "$runtime_inputs")" || return 1
  test "$target_bootstrap_id" = "$previous_bootstrap_id" || {
    printf '%s\n' \
      'resumed promotion must preserve the prior attested authority bootstrap ID' >&2
    return 1
  }

  resume_previous_base="${temporary_directory}/resume-previous-base.json"
  resume_previous_object="${temporary_directory}/resume-previous.json"
  render_kustomization "$previous_sha" "$previous_id" \
    "$resume_previous_base" || return 1
  jq --arg active "$previous_id" --arg previous "$target_release_id" '
    .metadata.annotations["meshr.social/active-release-id"] = $active |
    .metadata.annotations["meshr.social/previous-release-id"] = $previous |
    .metadata.annotations["meshr.social/transition-kind"] = "rollback"
  ' "$resume_previous_base" >"$resume_previous_object" || return 1

  transaction_target_id="$target_release_id"
  transaction_previous_id="$previous_id"
  transaction_previous_object="$resume_previous_object"
  transaction_target_object="$current_object"
  transaction_armed=true

  stage_release "$target_sha" "$image_inputs" "$runtime_inputs" || return 1
  test "$staged_release_id" = "$target_release_id" || return 1
  wait_for_source "$target_sha" || return 1
  wait_for_kustomization "$target_release_id" forward || return 1
  transaction_complete=true
  printf 'qualification resumed interrupted promotion from %s to %s\n' \
    "$previous_id" "$target_release_id"
}

automatic_rollback() {
  local current rollback_target previous_phase previous_sha previous_transition_kind
  local ready_guard_release_id=
  previous_phase="$(release_phase "$transaction_previous_id")" || return 1
  test "$previous_phase" = r || {
    printf '%s\n' \
      'no prior Ready release is recorded; automatic rollback is unavailable' >&2
    return 1
  }
  verify_release_by_id "$transaction_previous_id" || return 1
  current="${temporary_directory}/automatic-rollback-current.json"
  rollback_target="${temporary_directory}/automatic-rollback-target.json"
  api_get kustomization.kustomize.toolkit.fluxcd.io \
    "$kustomization_name" "$current" || return 1
  if jq -e --slurpfile previous "$transaction_previous_object" '
    .spec == $previous[0].spec and
    .metadata.annotations == $previous[0].metadata.annotations
  ' "$current" >/dev/null; then
    previous_transition_kind="$(jq -r \
      '.metadata.annotations["meshr.social/transition-kind"]' \
      "$transaction_previous_object")" || return 1
    wait_for_kustomization \
      "$transaction_previous_id" "$previous_transition_kind" || return 1
    printf 'release pointer never left %s; no rollback was required\n' \
      "$transaction_previous_id" >&2
    return 0
  fi
  jq -e --arg active "$transaction_target_id" \
    --arg previous "$transaction_previous_id" \
    --slurpfile target "$transaction_target_object" '
      .metadata.annotations["meshr.social/active-release-id"] == $active and
      .metadata.annotations["meshr.social/previous-release-id"] == $previous and
      .metadata.annotations["meshr.social/transition-kind"] == "forward" and
      .spec == $target[0].spec
    ' "$current" >/dev/null || {
      printf '%s\n' \
        'automatic rollback refused because the release pointer changed concurrently' >&2
      return 1
    }
  verify_kustomization_shape \
    "$current" "$transaction_target_id" false forward || return 1
  if test "${transaction_cancelled:-false}" != true &&
    kustomization_is_ready_for_release \
    "$current" "$transaction_target_id"; then
    transaction_succeeded_during_recovery=true
    transaction_complete=true
    printf 'release %s became Ready before automatic rollback; keeping it active\n' \
      "$transaction_target_id" >&2
    return 0
  fi
  previous_sha="$(release_sha "$transaction_previous_id")" || return 1
  render_kustomization "$previous_sha" "$transaction_previous_id" \
    "$rollback_target" || return 1
  if test "${transaction_cancelled:-false}" != true; then
    ready_guard_release_id="$transaction_target_id"
  fi
  apply_switch "$current" "$rollback_target" \
    "$transaction_previous_id" "$transaction_target_id" rollback \
    "$ready_guard_release_id" || return 1
  if test "$switch_skipped_ready" = true; then
    transaction_succeeded_during_recovery=true
    transaction_complete=true
    printf 'release %s became Ready during rollback CAS; keeping it active\n' \
      "$transaction_target_id" >&2
    return 0
  fi
  wait_for_kustomization "$transaction_previous_id" rollback || return 1
  printf 'restored qualification release pointer to %s\n' \
    "$transaction_previous_id" >&2
}

finish() {
  local status=$?
  trap - EXIT INT TERM
  if test "$transaction_armed" = true && test "$transaction_complete" != true; then
    printf 'release %s failed after pointer switch; attempting CAS rollback\n' \
      "$transaction_target_id" >&2
    automatic_rollback || {
      printf 'CRITICAL: automatic rollback failed; run: %q rollback %q %q\n' \
        "$0" "$transaction_target_id" "$transaction_previous_id" >&2
      if test "$transaction_cancelled" != true; then
        status=1
      fi
    }
    if test "$transaction_cancelled" != true &&
      test "$transaction_succeeded_during_recovery" = true; then
      status=0
    fi
  fi
  if test "$transaction_cancelled" = true; then
    status="$transaction_cancel_status"
  fi
  rm -rf -- "$temporary_directory"
  exit "$status"
}

cancel_transaction() {
  transaction_cancelled=true
  transaction_cancel_status="$1"
  exit "$transaction_cancel_status"
}

trap finish EXIT
trap 'cancel_transaction 130' INT
trap 'cancel_transaction 143' TERM

mode="${1:-}"
case "$mode" in
  initialize | bootstrap | promote | validate)
    test "$#" -eq 4 || usage
    target_sha="$2"
    image_inputs="$3"
    runtime_inputs="$4"
    validate_release_inputs "$target_sha" "$image_inputs" "$runtime_inputs"
    ;;
  rollback)
    test "$#" -eq 3 || usage
    expected_active_id="$2"
    expected_previous_id="$3"
    printf '%s' "$expected_active_id" \
      | grep -Eq '^r-[a-f0-9]{40}-[a-f0-9]{12}$' || usage
    printf '%s' "$expected_previous_id" \
      | grep -Eq '^r-[a-f0-9]{40}-[a-f0-9]{12}$' || usage
    test "$expected_active_id" != "$expected_previous_id" || usage
    ;;
  *) usage ;;
esac

if test "$mode" = validate; then
  runtime_release_id "$target_sha" "$runtime_inputs"
  exit 0
fi

cd "$repository_root"
if test "$mode" = rollback; then
  admission_pointer="${temporary_directory}/admission-pointer.json"
  admission_runtime="${temporary_directory}/admission-runtime.json"
  api_get kustomization.kustomize.toolkit.fluxcd.io \
    "$kustomization_name" "$admission_pointer"
  admission_active_id="$(jq -er \
    '.metadata.annotations["meshr.social/active-release-id"]' \
    "$admission_pointer")"
  printf '%s' "$admission_active_id" |
    grep -Eq '^r-[a-f0-9]{40}-[a-f0-9]{12}$'
  api_get configmap "meshr-r-${admission_active_id}" "$admission_runtime"
  export_admission_anchors "$admission_runtime"
else
  export_admission_anchors "$runtime_inputs"
fi
bash deploy/production-qualification/verify-flux-contract.sh gateway

if test "$mode" = rollback; then
  current_object="${temporary_directory}/rollback-current.json"
  api_get kustomization.kustomize.toolkit.fluxcd.io \
    "$kustomization_name" "$current_object"
  active_id="$(jq -r '.metadata.annotations["meshr.social/active-release-id"]' \
    "$current_object")"
  previous_id="$(jq -r '.metadata.annotations["meshr.social/previous-release-id"]' \
    "$current_object")"
  transition_kind="$(jq -r \
    '.metadata.annotations["meshr.social/transition-kind"]' "$current_object")"
  verify_kustomization_shape \
    "$current_object" "$active_id" false "$transition_kind"
  if test "$active_id" != "$expected_active_id"; then
    if test "$active_id" = "$expected_previous_id" &&
      test "$previous_id" = "$expected_active_id" &&
      test "$transition_kind" = rollback; then
      wait_for_kustomization "$active_id" rollback
      printf 'qualification rollback from %s already completed at %s\n' \
        "$expected_active_id" "$active_id"
      exit 0
    fi
    printf 'expected release tuple (%s, %s), found (%s, %s)\n' \
      "$expected_active_id" "$expected_previous_id" \
      "$active_id" "$previous_id" >&2
    exit 1
  fi
  test "$previous_id" = "$expected_previous_id" || {
    printf 'expected previous release %s, found %s\n' \
      "$expected_previous_id" "$previous_id" >&2
    exit 1
  }
  test "$transition_kind" = forward || {
    printf '%s\n' \
      'only a forward transition can be rolled back; refusing release toggle' >&2
    exit 1
  }
  previous_phase="$(release_phase "$previous_id")"
  test "$previous_phase" = r || {
    printf 'the recorded previous tuple is bootstrap-only, not a Ready release\n' >&2
    exit 1
  }
  verify_release_by_id "$previous_id"
  rollback_target="${temporary_directory}/rollback-target.json"
  rollback_sha="$(release_sha "$previous_id")"
  render_kustomization "$rollback_sha" "$previous_id" "$rollback_target"
  apply_switch \
    "$current_object" "$rollback_target" "$previous_id" "$active_id" rollback
  wait_for_kustomization "$previous_id" rollback
  printf 'qualification rolled back from %s to %s\n' "$active_id" "$previous_id"
  exit 0
fi

target_release_id="$(runtime_release_id "$target_sha" "$runtime_inputs")"
target_release_phase="$(release_phase "$target_release_id")"

if test "$mode" = initialize; then
  test "$target_release_phase" = b || {
    printf 'initialization requires pending/force-scan runtime inputs\n' >&2
    exit 1
  }
  initialize_existing=false
  initialize_existing_object="${temporary_directory}/initialize-existing.json"
  if api_get kustomization.kustomize.toolkit.fluxcd.io \
    "$kustomization_name" "$initialize_existing_object" \
    2>/dev/null; then
    initialize_active_id="$(jq -r \
      '.metadata.annotations["meshr.social/active-release-id"]' \
      "$initialize_existing_object")"
    if test "$initialize_active_id" != "$target_release_id" ||
      ! verify_initialization_pointer \
        "$initialize_existing_object" "$target_release_id"; then
      printf '%s\n' \
        'existing qualification reconciliation does not exactly match this initialization' >&2
      exit 1
    fi
    initialize_existing=true
  fi
  stage_release "$target_sha" "$image_inputs" "$runtime_inputs"
  test "$staged_release_id" = "$target_release_id"
  wait_for_source "$target_sha"
  target_kustomization="${temporary_directory}/target-${target_release_id}.json"
  render_kustomization "$target_sha" "$target_release_id" "$target_kustomization"
  initialized_object="${temporary_directory}/initialize-readback.json"
  if test "$initialize_existing" != true; then
    if ! kubectl create \
      -f "${temporary_directory}/kustomization-${target_release_id}.yaml" \
      >/dev/null; then
      api_get kustomization.kustomize.toolkit.fluxcd.io \
        "$kustomization_name" "$initialized_object" || exit 1
      initialized_active_id="$(jq -r \
        '.metadata.annotations["meshr.social/active-release-id"]' \
        "$initialized_object")"
      if test "$initialized_active_id" != "$target_release_id"; then
        printf '%s\n' \
          'initialization create failed and exact b-pointer adoption was impossible' >&2
        exit 1
      fi
      verify_initialization_pointer "$initialized_object" "$target_release_id" || {
        printf '%s\n' \
          'initialization create failed and exact b-pointer adoption was impossible' >&2
        exit 1
      }
      printf '%s\n' \
        'adopted exact initialization after an ambiguous create response' >&2
    fi
  fi
  api_get kustomization.kustomize.toolkit.fluxcd.io \
    "$kustomization_name" "$initialized_object"
  verify_initialization_pointer "$initialized_object" "$target_release_id"
  printf 'qualification initialized for deploy-identity finalization at %s\n' \
    "$target_release_id"
  exit 0
fi

if test "$mode" = bootstrap; then
  test "$target_release_phase" = b || {
    printf 'bootstrap requires pending/force-scan runtime inputs\n' >&2
    exit 1
  }
  current_object="${temporary_directory}/bootstrap-existing.json"
  api_get kustomization.kustomize.toolkit.fluxcd.io \
    "$kustomization_name" "$current_object" 2>/dev/null || {
    printf '%s\n' \
      'qualification is not initialized; private operator must run initialize first' >&2
    exit 1
  }
  verify_bootstrap_pointer "$current_object" "$target_release_id" || {
    printf '%s\n' \
      'existing release pointer is not an admissible bootstrap retry state' >&2
    exit 1
  }
  stage_release "$target_sha" "$image_inputs" "$runtime_inputs"
  test "$staged_release_id" = "$target_release_id"
  wait_for_source "$target_sha"

  bootstrap_id=
  bootstrap_job="${temporary_directory}/bootstrap-job.json"
  attempt=1
  while test "$attempt" -le "$wait_attempts"; do
    if api_get kustomization.kustomize.toolkit.fluxcd.io \
      "$kustomization_name" "$current_object" 2>/dev/null; then
      verify_bootstrap_pointer "$current_object" "$target_release_id" || {
        printf '%s\n' \
          'release pointer left the admissible bootstrap retry state' >&2
        exit 1
      }
    fi
    if kubectl -n meshr get job production-store-bootstrap -o json \
      >"$bootstrap_job" 2>/dev/null; then
      if jq -e 'any(.status.conditions[]?;
        .type == "Failed" and .status == "True")' "$bootstrap_job" >/dev/null; then
        kubectl -n meshr logs job/production-store-bootstrap \
          --all-containers=true --tail=200 >&2 || true
        printf 'production-store-bootstrap failed\n' >&2
        exit 1
      fi
      if jq -e --arg sha "$target_sha" '
        .metadata.labels["kustomize.toolkit.fluxcd.io/name"] ==
          "meshr-production-qualification" and
        .metadata.labels["kustomize.toolkit.fluxcd.io/namespace"] ==
          "flux-system" and
        .status.succeeded == 1 and
        any(.spec.template.spec.containers[].env[]?;
          .name == "MESHR_RELEASE_SHA" and .value == $sha)
      ' "$bootstrap_job" >/dev/null; then
        bootstrap_record="$(kubectl -n meshr logs job/production-store-bootstrap \
          --all-containers=true --tail=200 \
          | jq -Rr 'fromjson? | select(.event == "stores.initialized") |
            [.authorityBootstrapId // "", .projectionBootstrapId // ""] | @tsv' \
          | tail -n 1)"
        IFS=$'\t' read -r authority_bootstrap_id projection_bootstrap_id \
          <<<"$bootstrap_record"
        if test -n "${authority_bootstrap_id:-}" &&
          test "$authority_bootstrap_id" != pending &&
          test "$projection_bootstrap_id" = "$authority_bootstrap_id" &&
          printf '%s' "$authority_bootstrap_id" \
            | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'; then
          bootstrap_id="$authority_bootstrap_id"
          break
        fi
      fi
    fi
    sleep 2
    attempt=$((attempt + 1))
  done
  test -n "$bootstrap_id" || {
    printf 'bootstrap attestation did not become available\n' >&2
    exit 1
  }

  ready_runtime="${temporary_directory}/ready-runtime.json"
  jq --arg bootstrap_id "$bootstrap_id" '
    .MESHR_EXPECTED_AUTHORITY_BOOTSTRAP_ID = $bootstrap_id |
    .MESHR_FORCE_PROJECTION_BOOTSTRAP_SCAN = "0"
  ' "$runtime_inputs" >"$ready_runtime"
  ready_release_id="$(runtime_release_id "$target_sha" "$ready_runtime")"
  ready_release_phase="$(release_phase "$ready_release_id")"
  test "$ready_release_phase" = r
  api_get kustomization.kustomize.toolkit.fluxcd.io \
    "$kustomization_name" "$current_object"
  existing_active_id="$(jq -r \
    '.metadata.annotations["meshr.social/active-release-id"]' "$current_object")"
  verify_kustomization_shape \
    "$current_object" "$existing_active_id" false bootstrap
  existing_active_sha="$(release_sha "$existing_active_id")"
  test "$existing_active_sha" = "$target_sha"
  previous_id="$(jq -r \
    '.metadata.annotations["meshr.social/previous-release-id"]' "$current_object")"
  test "$previous_id" = "$target_release_id"
  existing_active_phase="$(release_phase "$existing_active_id")"
  if test "$existing_active_phase" = r &&
    test "$existing_active_id" != "$ready_release_id"; then
    printf '%s\n' \
      'initial Ready tuple differs from the attestation; private operator rebootstrap is required' >&2
    exit 1
  fi
  stage_release "$target_sha" "$image_inputs" "$ready_runtime"
  test "$staged_release_id" = "$ready_release_id"
  ready_kustomization="${temporary_directory}/target-${ready_release_id}.json"
  render_kustomization "$target_sha" "$ready_release_id" "$ready_kustomization"
  if test "$existing_active_id" != "$ready_release_id"; then
    apply_switch "$current_object" "$ready_kustomization" \
      "$ready_release_id" "$previous_id" bootstrap
  fi
  # A fresh cluster has no previously Ready tuple. A retry is idempotent only
  # when it derives the exact same r tuple; all other repair is operator-only.
  wait_for_kustomization "$ready_release_id" bootstrap
  printf 'qualification bootstrapped at %s\n' "$ready_release_id"
  exit 0
fi

test "$target_release_phase" = r || {
  printf 'normal promotion requires a ready runtime tuple; bootstrap is operator-only\n' >&2
  exit 1
}
current_object="${temporary_directory}/promote-current.json"
api_get kustomization.kustomize.toolkit.fluxcd.io \
  "$kustomization_name" "$current_object"
current_id="$(jq -r '.metadata.annotations["meshr.social/active-release-id"]' \
  "$current_object")"
current_transition_kind="$(jq -r \
  '.metadata.annotations["meshr.social/transition-kind"]' "$current_object")"
verify_kustomization_shape \
  "$current_object" "$current_id" false "$current_transition_kind"
current_phase="$(release_phase "$current_id")"
test "$current_phase" = r
if test "$current_id" = "$target_release_id"; then
  resume_active_promotion "$current_object" "$target_release_id" "$target_sha" \
    "$image_inputs" "$runtime_inputs"
  exit 0
fi
verify_kustomization_shape \
  "$current_object" "$current_id" true "$current_transition_kind"
verify_release_by_id "$current_id"
current_runtime_object="${temporary_directory}/promote-current-runtime.json"
api_get configmap "meshr-r-${current_id}" "$current_runtime_object"
current_bootstrap_id="$(jq -r \
  '.data.MESHR_EXPECTED_AUTHORITY_BOOTSTRAP_ID' "$current_runtime_object")"
target_bootstrap_id="$(jq -r \
  '.MESHR_EXPECTED_AUTHORITY_BOOTSTRAP_ID' "$runtime_inputs")"
test "$target_bootstrap_id" = "$current_bootstrap_id" || {
  printf '%s\n' \
    'normal promotion must preserve the active attested authority bootstrap ID' >&2
  exit 1
}
current_sha="$(release_sha "$current_id")"
test "$current_sha" != "$target_sha" || {
  printf '%s\n' \
    'a ready runtime change requires a distinct protected public commit SHA' >&2
  exit 1
}
current_previous_id="$(jq -r \
  '.metadata.annotations["meshr.social/previous-release-id"]' \
  "$current_object")"
verify_forward_target_not_failed \
  "$current_transition_kind" "$target_release_id" "$current_previous_id"
stage_release "$target_sha" "$image_inputs" "$runtime_inputs"
test "$staged_release_id" = "$target_release_id"
wait_for_source "$target_sha"
target_kustomization="${temporary_directory}/target-${target_release_id}.json"
render_kustomization "$target_sha" "$target_release_id" "$target_kustomization"

transaction_target_id="$target_release_id"
transaction_previous_id="$current_id"
transaction_previous_object="$current_object"
transaction_target_object="$target_kustomization"
transaction_armed=true
apply_switch "$current_object" "$target_kustomization" \
  "$target_release_id" "$current_id" forward
wait_for_kustomization "$target_release_id" forward
transaction_complete=true
printf 'qualification promoted from %s to %s\n' "$current_id" "$target_release_id"
