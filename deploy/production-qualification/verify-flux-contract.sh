#!/usr/bin/env bash
set -euo pipefail

# These multi-architecture image-index digests were resolved from the signed
# Flux v2.9.5 release images. Keep them aligned with the install manifest,
# signature checks, and complete CRD contract digests in this repository.
readonly source_controller_image='ghcr.io/fluxcd/source-controller@sha256:6f20d232d596a758c923d2861f23511718fc303b8a2e36a1434a7c736b9f4268'
readonly kustomize_controller_image='ghcr.io/fluxcd/kustomize-controller@sha256:a3a955eb2bc432c2eaa94d2d3714e3beae7fdf17586fd23aadf71ab597ac3339'
script_directory="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

verification_mode="${1:-operator}"
case "$verification_mode" in
  operator | gateway) ;;
  *)
    printf 'usage: %s [operator|gateway]\n' "$0" >&2
    exit 64
    ;;
esac

# Hash the execution and security contract from the signed Pod template after
# removing Kubernetes API default spellings and the exact reviewed GKE
# Autopilot mutations. This deliberately retains every other scheduling
# constraint and security context plus initContainers, command, env/envFrom,
# volumes/mounts, probes, resources, host settings, and service-account
# identity, so broader injected execution fields fail.
pod_template_contract_sha() {
  jq -L "$script_directory" -cS '
    include "gke-autopilot-contract";
    def strip_default($key; $value):
      if (has($key) | not) or .[$key] == $value then
        del(.[$key])
      else
        .
      end;
    .spec.template
    | meshr_normalize_flux_pod_template
    | del(.metadata.creationTimestamp)
    | .metadata.annotations = (.metadata.annotations // {})
    | .metadata.annotations |= with_entries(
        select(.key | IN(
          "autopilot.gke.io/resource-adjustment",
          "autopilot.gke.io/warden-version"
        ) | not)
      )
    | .metadata.labels = (.metadata.labels // {})
    | .spec |= (
        if (.serviceAccount // .serviceAccountName) == .serviceAccountName then
          del(.serviceAccount)
        else
          .
        end
        | strip_default("dnsPolicy"; "ClusterFirst")
        | strip_default("restartPolicy"; "Always")
        | strip_default("schedulerName"; "default-scheduler")
        | strip_default("enableServiceLinks"; true)
        | .containers |= map(
            strip_default("terminationMessagePath"; "/dev/termination-log")
            | strip_default("terminationMessagePolicy"; "File")
            | .env = ((.env // []) | map(
                if has("valueFrom") and .valueFrom.fieldRef? then
                  .valueFrom.fieldRef |= strip_default("apiVersion"; "v1")
                elif has("valueFrom") and .valueFrom.resourceFieldRef? then
                  .valueFrom.resourceFieldRef |= strip_default("divisor"; "0")
                else
                  .
                end
              ))
            | if .livenessProbe? then
                .livenessProbe |= (
                  strip_default("failureThreshold"; 3)
                  | strip_default("initialDelaySeconds"; 0)
                  | strip_default("periodSeconds"; 10)
                  | strip_default("successThreshold"; 1)
                  | strip_default("timeoutSeconds"; 1)
                  | .httpGet |= strip_default("scheme"; "HTTP")
                )
              else . end
            | if .readinessProbe? then
                .readinessProbe |= (
                  strip_default("failureThreshold"; 3)
                  | strip_default("initialDelaySeconds"; 0)
                  | strip_default("periodSeconds"; 10)
                  | strip_default("successThreshold"; 1)
                  | strip_default("timeoutSeconds"; 1)
                  | .httpGet |= strip_default("scheme"; "HTTP")
                )
              else . end
          )
      )
  ' | shasum -a 256 | awk '{print $1}'
}

# Service IP allocation and API-default routing fields are cluster-specific;
# all signed metadata labels and the rest of the Service spec, including the
# exact selector and port mapping, remain in the normalized hash.
source_service_contract_sha() {
  jq -L "$script_directory" -cS '
    include "gke-autopilot-contract";
    def strip_default($key; $value):
      if (has($key) | not) or .[$key] == $value then
        del(.[$key])
      else
        .
      end;
    {
      apiVersion,
      kind,
      metadata: {
        annotations: ((.metadata.annotations // {}) |
          del(."kubectl.kubernetes.io/last-applied-configuration") |
          meshr_normalize_flux_source_service_annotations),
        labels: (.metadata.labels // {}),
        name: .metadata.name,
        namespace: .metadata.namespace
      },
      spec: (
        .spec
        | del(.clusterIP, .clusterIPs, .ipFamilies, .ipFamilyPolicy)
        | strip_default("internalTrafficPolicy"; "Cluster")
        | strip_default("sessionAffinity"; "None")
      )
    }
  ' | shasum -a 256 | awk '{print $1}'
}

source_deployment="$(kubectl -n flux-system get deployment/source-controller -o json)"
jq -e --arg image "$source_controller_image" '
  .spec.replicas == 1 and
  (.spec.paused // false) == false and
  .spec.selector == {matchLabels: {app: "source-controller"}} and
  .spec.strategy == {type: "Recreate"} and
  (.spec.minReadySeconds // 0) == 0 and
  .spec.progressDeadlineSeconds == 600 and
  .spec.revisionHistoryLimit == 10 and
  .spec.template.spec.serviceAccountName == "source-controller" and
  (.spec.template.spec.containers | length) == 1 and
  .spec.template.spec.containers[0].name == "manager" and
  .spec.template.spec.containers[0].image == $image and
  .spec.template.spec.containers[0].args == [
    "--watch-all-namespaces=false",
    "--log-level=info",
    "--log-encoding=json",
    "--enable-leader-election",
    "--storage-path=/data",
    "--storage-adv-addr=source-controller.$(RUNTIME_NAMESPACE).svc.cluster.local."
  ] and
  .spec.template.spec.containers[0].resources == {
    limits: {cpu: "500m", memory: "1Gi", "ephemeral-storage": "1Gi"},
    requests: {cpu: "500m", memory: "1Gi", "ephemeral-storage": "1Gi"}
  }
' <<<"$source_deployment" >/dev/null
test "$(pod_template_contract_sha <<<"$source_deployment")" = \
  '719f952c1353c1f1f491b67f069ffb737ae2353a560e997d2f04db97437acdc0'

kustomize_deployment="$(kubectl -n flux-system get deployment/kustomize-controller -o json)"
jq -e --arg image "$kustomize_controller_image" '
  .spec.replicas == 1 and
  (.spec.paused // false) == false and
  .spec.selector == {matchLabels: {app: "kustomize-controller"}} and
  .spec.strategy == {
    type: "RollingUpdate",
    rollingUpdate: {maxSurge: "25%", maxUnavailable: "25%"}
  } and
  (.spec.minReadySeconds // 0) == 0 and
  .spec.progressDeadlineSeconds == 600 and
  .spec.revisionHistoryLimit == 10 and
  .spec.template.spec.serviceAccountName == "kustomize-controller" and
  (.spec.template.spec.containers | length) == 1 and
  .spec.template.spec.containers[0].name == "manager" and
  .spec.template.spec.containers[0].image == $image and
  .spec.template.spec.containers[0].args == [
    "--watch-all-namespaces=false",
    "--log-level=info",
    "--log-encoding=json",
    "--enable-leader-election",
    "--feature-gates=DisableConfigWatchers=true",
    "--no-cross-namespace-refs=true",
    "--no-remote-bases=true"
  ] and
  .spec.template.spec.containers[0].resources == {
    limits: {cpu: "500m", memory: "1Gi", "ephemeral-storage": "1Gi"},
    requests: {cpu: "500m", memory: "1Gi", "ephemeral-storage": "1Gi"}
  }
' <<<"$kustomize_deployment" >/dev/null
test "$(pod_template_contract_sha <<<"$kustomize_deployment")" = \
  'ee3c79522cc9d04b7ac05569b749f4174d37363a200a7b6170c08f9ed87560d9'

source_service="$(kubectl -n flux-system get service/source-controller -o json)"
jq -e '
  (.metadata.annotations // {}) as $annotations |
  ($annotations | keys | all(
    . == "kubectl.kubernetes.io/last-applied-configuration" or
    . == "cloud.google.com/neg"
  )) and
  (($annotations | has("cloud.google.com/neg") | not) or
    $annotations["cloud.google.com/neg"] == "{\"ingress\":true}") and
  ((($annotations."kubectl.kubernetes.io/last-applied-configuration" // null)
      | if . == null then null else fromjson end) as $applied |
    $applied == null or
    ($applied.apiVersion == "v1" and
      $applied.kind == "Service" and
      $applied.metadata.name == "source-controller" and
      $applied.metadata.namespace == "flux-system" and
      ($applied.metadata.annotations // {}) == {} and
      $applied.metadata.labels == .metadata.labels and
      $applied.spec == {
        ports: [{name: "http", port: 80, protocol: "TCP", targetPort: "http"}],
        selector: {app: "source-controller"},
        type: "ClusterIP"
      })) and
  .spec.type == "ClusterIP" and
  .spec.selector == {app: "source-controller"} and
  .spec.ports == [{
    name: "http", port: 80, protocol: "TCP", targetPort: "http"
  }] and
  (.spec.clusterIP | type == "string" and length > 0 and . != "None") and
  .spec.clusterIPs == [.spec.clusterIP] and
  .spec.ipFamilies == ["IPv4"] and
  .spec.ipFamilyPolicy == "SingleStack"
' <<<"$source_service" >/dev/null
test "$(source_service_contract_sha <<<"$source_service")" = \
  '0b6cd626606449dbfea09c15163d02313117dbc35566215fc53b9e1919983493'

crd_contract_sha() {
  kubectl get customresourcedefinition "$1" -o json | jq -cS '
    .spec as $spec |
    {
      group: $spec.group,
      names: $spec.names,
      scope: $spec.scope,
      conversion: {
        strategy: ($spec.conversion.strategy // "None"),
        webhook: ($spec.conversion.webhook // null)
      },
      preserveUnknownFields: ($spec.preserveUnknownFields // false),
      versions: [
        $spec.versions[] | {
          name,
          served,
          storage,
          deprecated: (.deprecated // false),
          deprecationWarning: (.deprecationWarning // null),
          schema,
          subresources: (.subresources // null),
          additionalPrinterColumns: (.additionalPrinterColumns // null)
        }
      ]
    }
  ' | shasum -a 256 | awk '{print $1}'
}

test "$(crd_contract_sha gitrepositories.source.toolkit.fluxcd.io)" = \
  '4d69eeaf45eb532d73caeeeab7dc84c087f7f2bc0284fd1614834d6fbc35a2ce'
test "$(crd_contract_sha kustomizations.kustomize.toolkit.fluxcd.io)" = \
  '742bfae846f62747bba32bea88e266497aa573fed51ee28ab3bae66afbca8797'

verify_admission_contract() {
  local anchor_name contract_directory expected_contract
  local policy_name resource_type expected_kind live_object
  for anchor_name in \
    CONNECT_GATEWAY_DEPLOY_SERVICE_ACCOUNT_EMAIL \
    GCP_PROJECT_ID \
    MESHR_FIRESTORE_DATABASE \
    MESHR_TOPOLOGY_FIRESTORE_DATABASE \
    MESHR_EVENT_AUDIT_FIRESTORE_DATABASE \
    MESHR_NOTIFICATIONS_FIRESTORE_DATABASE \
    MESHR_MODERATION_FIRESTORE_DATABASE \
    MESHR_MODERATION_AUDIENCE; do
    test -n "${!anchor_name:-}" || {
      printf 'required admission anchor is unset: %s\n' "$anchor_name" >&2
      return 1
    }
  done
  printf '%s' "$CONNECT_GATEWAY_DEPLOY_SERVICE_ACCOUNT_EMAIL" |
    grep -Eq '^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9][.]iam[.]gserviceaccount[.]com$' || {
      printf '%s\n' 'deploy service account anchor is not an exact GSA email' >&2
      return 1
    }
  printf '%s' "$GCP_PROJECT_ID" |
    grep -Eq '^[a-z][a-z0-9-]{4,28}[a-z0-9]$' || {
      printf '%s\n' 'project anchor is not a canonical GCP project ID' >&2
      return 1
    }
  for anchor_name in \
    MESHR_FIRESTORE_DATABASE \
    MESHR_TOPOLOGY_FIRESTORE_DATABASE \
    MESHR_EVENT_AUDIT_FIRESTORE_DATABASE \
    MESHR_NOTIFICATIONS_FIRESTORE_DATABASE \
    MESHR_MODERATION_FIRESTORE_DATABASE; do
    printf '%s' "${!anchor_name}" |
      grep -Eq '^(\(default\)|[A-Za-z][A-Za-z0-9_-]{0,62})$' || {
        printf 'invalid Firestore database anchor: %s\n' "$anchor_name" >&2
        return 1
      }
  done
  printf '%s' "$MESHR_MODERATION_AUDIENCE" |
    grep -Eq '^https://[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?([.][a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*[.]run[.]app$' || {
      printf '%s\n' 'moderation audience anchor is not a canonical Cloud Run service origin' >&2
      return 1
    }
  case "${MESHR_MODERATION_AUDIENCE#https://}" in
    *---*)
      printf '%s\n' 'moderation audience anchor must be the stable service origin, not a traffic-tag origin' >&2
      return 1
      ;;
  esac

  contract_directory="$(mktemp -d)"
  expected_contract="${contract_directory}/admission-contract.json"
  test -f "${script_directory}/admission-contract.json" || return 1
  jq \
    --arg deploy_gsa "$CONNECT_GATEWAY_DEPLOY_SERVICE_ACCOUNT_EMAIL" \
    --arg project "$GCP_PROJECT_ID" \
    --arg authority_database "$MESHR_FIRESTORE_DATABASE" \
    --arg topology_database "$MESHR_TOPOLOGY_FIRESTORE_DATABASE" \
    --arg event_audit_database "$MESHR_EVENT_AUDIT_FIRESTORE_DATABASE" \
    --arg notifications_database "$MESHR_NOTIFICATIONS_FIRESTORE_DATABASE" \
    --arg moderation_database "$MESHR_MODERATION_FIRESTORE_DATABASE" \
    --arg moderation_audience "$MESHR_MODERATION_AUDIENCE" '
      def replace($needle; $value): split($needle) | join($value);
      walk(
        if type == "string" then
          replace("${CONNECT_GATEWAY_DEPLOY_SERVICE_ACCOUNT_EMAIL}"; $deploy_gsa) |
          replace("${GCP_PROJECT_ID}"; $project) |
          replace("${MESHR_FIRESTORE_DATABASE}"; $authority_database) |
          replace("${MESHR_TOPOLOGY_FIRESTORE_DATABASE}"; $topology_database) |
          replace("${MESHR_EVENT_AUDIT_FIRESTORE_DATABASE}"; $event_audit_database) |
          replace("${MESHR_NOTIFICATIONS_FIRESTORE_DATABASE}"; $notifications_database) |
          replace("${MESHR_MODERATION_FIRESTORE_DATABASE}"; $moderation_database) |
          replace("${MESHR_MODERATION_AUDIENCE}"; $moderation_audience)
        else
          .
        end
      )
    ' "${script_directory}/admission-contract.json" >"$expected_contract" || return 1
  jq -e '
    length == 8 and
    ([.[].kind] |
      map(select(. == "ValidatingAdmissionPolicy")) | length == 4) and
    ([.[].kind] |
      map(select(. == "ValidatingAdmissionPolicyBinding")) | length == 4) and
    (tostring | contains("${") | not)
  ' "$expected_contract" >/dev/null || return 1

  for policy_name in \
    meshr-production-qualification-source.meshr.social \
    meshr-production-qualification-inputs.meshr.social \
    meshr-production-qualification-reconciliation.meshr.social \
    meshr-production-qualification-private-services.meshr.social; do
    for resource_type in \
      validatingadmissionpolicies.admissionregistration.k8s.io \
      validatingadmissionpolicybindings.admissionregistration.k8s.io; do
      if test "$resource_type" = \
        validatingadmissionpolicies.admissionregistration.k8s.io; then
        expected_kind=ValidatingAdmissionPolicy
      else
        expected_kind=ValidatingAdmissionPolicyBinding
      fi
      live_object="$(kubectl get "$resource_type" "$policy_name" -o json)"
      jq -L "$script_directory" -e \
        --arg kind "$expected_kind" --arg name "$policy_name" \
        --slurpfile expected "$expected_contract" '
          include "gke-autopilot-contract";
          def normalized_spec:
            .spec | meshr_normalize_admission_spec;
          . as $actual |
          ($expected[0][] |
            select(.kind == $kind and .metadata.name == $name)) as $contract |
          $actual.apiVersion == $contract.apiVersion and
          $actual.kind == $contract.kind and
          $actual.metadata.name == $contract.metadata.name and
          ($actual.metadata.deletionTimestamp // null) == null and
          ($kind != "ValidatingAdmissionPolicy" or
            ($actual.status.observedGeneration ==
              $actual.metadata.generation and
              (($actual.status.typeChecking.expressionWarnings // []) |
                length == 0))) and
          ($actual | normalized_spec) == ($contract | normalized_spec)
        ' <<<"$live_object" >/dev/null
    done
  done
  rm -rf -- "$contract_directory"
}

verify_admission_contract

# Gateway mode deliberately stops after controller, Service, CRD, and admission
# contracts. The hosted identity can get those exact objects but cannot inspect
# RBAC. Operator mode runs before direct control-plane access is closed and
# verifies the complete live controller authorization graph.
test "$verification_mode" = operator || exit 0

source_role="$(kubectl -n flux-system get \
  role.rbac.authorization.k8s.io/source-controller -o json)"
jq -e '
  .apiVersion == "rbac.authorization.k8s.io/v1" and
  .kind == "Role" and
  .metadata.name == "source-controller" and
  .metadata.namespace == "flux-system" and
  .rules == [
    {
      apiGroups: ["source.toolkit.fluxcd.io"],
      resources: [
        "buckets", "externalartifacts", "gitrepositories", "helmcharts",
        "helmrepositories", "ocirepositories", "buckets/status",
        "externalartifacts/status", "gitrepositories/status",
        "helmcharts/status", "helmrepositories/status",
        "ocirepositories/status", "buckets/finalizers",
        "externalartifacts/finalizers", "gitrepositories/finalizers",
        "helmcharts/finalizers", "helmrepositories/finalizers",
        "ocirepositories/finalizers"
      ],
      verbs: ["get", "list", "watch", "update", "patch"]
    },
    {apiGroups: [""], resources: ["events"], verbs: ["create", "patch"]},
    {
      apiGroups: ["coordination.k8s.io"], resources: ["leases"],
      verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
    }
  ]
' <<<"$source_role" >/dev/null

source_binding="$(kubectl -n flux-system get \
  rolebinding.rbac.authorization.k8s.io/source-controller -o json)"
jq -e '
  .apiVersion == "rbac.authorization.k8s.io/v1" and
  .kind == "RoleBinding" and
  .metadata.name == "source-controller" and
  .metadata.namespace == "flux-system" and
  .subjects == [{
    kind: "ServiceAccount", name: "source-controller", namespace: "flux-system"
  }] and
  .roleRef == {
    apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: "source-controller"
  }
' <<<"$source_binding" >/dev/null

kustomize_role="$(kubectl -n flux-system get \
  role.rbac.authorization.k8s.io/kustomize-controller -o json)"
jq -e '
  .apiVersion == "rbac.authorization.k8s.io/v1" and
  .kind == "Role" and
  .metadata.name == "kustomize-controller" and
  .metadata.namespace == "flux-system" and
  .rules == [
    {
      apiGroups: ["kustomize.toolkit.fluxcd.io"],
      resources: [
        "kustomizations", "kustomizations/status", "kustomizations/finalizers"
      ],
      verbs: ["get", "list", "watch", "update", "patch"]
    },
    {
      apiGroups: ["source.toolkit.fluxcd.io"],
      resources: ["buckets", "externalartifacts", "gitrepositories", "ocirepositories"],
      verbs: ["get", "list", "watch"]
    },
    {apiGroups: [""], resources: ["configmaps"], verbs: ["get"]},
    {apiGroups: [""], resources: ["events"], verbs: ["create", "patch"]},
    {
      apiGroups: ["coordination.k8s.io"], resources: ["leases"],
      verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
    }
  ]
' <<<"$kustomize_role" >/dev/null

kustomize_binding="$(kubectl -n flux-system get \
  rolebinding.rbac.authorization.k8s.io/kustomize-controller -o json)"
jq -e '
  .apiVersion == "rbac.authorization.k8s.io/v1" and
  .kind == "RoleBinding" and
  .metadata.name == "kustomize-controller" and
  .metadata.namespace == "flux-system" and
  .subjects == [{
    kind: "ServiceAccount", name: "kustomize-controller", namespace: "flux-system"
  }] and
  .roleRef == {
    apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: "kustomize-controller"
  }
' <<<"$kustomize_binding" >/dev/null

workload_role="$(kubectl -n meshr get role.rbac.authorization.k8s.io \
  meshr-production-qualification-reconciler -o json)"
jq -e '
  .apiVersion == "rbac.authorization.k8s.io/v1" and
  .kind == "Role" and
  .metadata.name == "meshr-production-qualification-reconciler" and
  .metadata.namespace == "meshr" and
  .rules == [
    {
      apiGroups: [""], resources: ["serviceaccounts", "configmaps", "services"],
      verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
    },
    {
      apiGroups: ["apps"], resources: ["deployments"],
      verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
    },
    {
      apiGroups: ["autoscaling"], resources: ["horizontalpodautoscalers"],
      verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
    },
    {
      apiGroups: ["batch"], resources: ["jobs"],
      verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
    },
    {
      apiGroups: ["networking.k8s.io"], resources: ["networkpolicies"],
      verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
    },
    {
      apiGroups: ["policy"], resources: ["poddisruptionbudgets"],
      verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
    },
    {
      apiGroups: ["secrets-store.csi.x-k8s.io"],
      resources: ["secretproviderclasses"],
      verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
    }
  ]
' <<<"$workload_role" >/dev/null

workload_binding="$(kubectl -n meshr get \
  rolebinding.rbac.authorization.k8s.io \
  meshr-production-qualification-reconciler -o json)"
jq -e '
  .apiVersion == "rbac.authorization.k8s.io/v1" and
  .kind == "RoleBinding" and
  .metadata.name == "meshr-production-qualification-reconciler" and
  .metadata.namespace == "meshr" and
  .subjects == [{
    kind: "ServiceAccount", name: "kustomize-controller", namespace: "flux-system"
  }] and
  .roleRef == {
    apiGroup: "rbac.authorization.k8s.io", kind: "Role",
    name: "meshr-production-qualification-reconciler"
  }
' <<<"$workload_binding" >/dev/null

all_role_bindings="$(kubectl get rolebindings.rbac.authorization.k8s.io \
  --all-namespaces -o json)"
jq -e '
  [
    .items[] |
    select(any(.subjects[]?;
      .kind == "ServiceAccount" and .namespace == "flux-system" and
      (.name == "source-controller" or .name == "kustomize-controller"))) |
    (.metadata.namespace + "/" + .metadata.name)
  ] | sort == [
    "flux-system/kustomize-controller",
    "flux-system/source-controller",
    "meshr/meshr-production-qualification-reconciler"
  ]
' <<<"$all_role_bindings" >/dev/null

all_cluster_role_bindings="$(kubectl get \
  clusterrolebindings.rbac.authorization.k8s.io -o json)"
jq -e '
  [
    .items[] |
    select(any(.subjects[]?;
      .kind == "ServiceAccount" and .namespace == "flux-system" and
      (.name == "source-controller" or .name == "kustomize-controller")))
  ] | length == 0
' <<<"$all_cluster_role_bindings" >/dev/null

assert_cannot() {
  local principal="$1"
  shift
  local decision decision_status
  local denial_reason_pattern='^no - [[:print:]]+$'
  if decision="$(kubectl auth can-i "$@" --as="$principal")"; then
    decision_status=0
  else
    decision_status=$?
  fi
  if test "$decision_status" -eq 1 &&
    { test "$decision" = no || [[ "$decision" =~ $denial_reason_pattern ]]; }; then
    return 0
  fi
  if test "$decision_status" -eq 0; then
    printf 'controller authorization unexpectedly allowed %s: %s\n' \
      "$principal" "$*" >&2
    return 1
  fi
  printf 'controller authorization review failed for %s: %s (exit %s, output %q)\n' \
    "$principal" "$*" "$decision_status" "$decision" >&2
  return 1
}

namespace_inventory="$(kubectl get namespaces -o json)"
namespace_names="$(jq -r '.items[].metadata.name' <<<"$namespace_inventory")"
test -n "$namespace_names"

for controller in source-controller kustomize-controller; do
  controller_principal="system:serviceaccount:flux-system:${controller}"

  for cluster_resource in \
    clusterroles.rbac.authorization.k8s.io \
    clusterrolebindings.rbac.authorization.k8s.io \
    customresourcedefinitions.apiextensions.k8s.io \
    apiservices.apiregistration.k8s.io \
    mutatingwebhookconfigurations.admissionregistration.k8s.io \
    validatingwebhookconfigurations.admissionregistration.k8s.io \
    validatingadmissionpolicies.admissionregistration.k8s.io \
    validatingadmissionpolicybindings.admissionregistration.k8s.io \
    certificatesigningrequests.certificates.k8s.io \
    nodes persistentvolumes storageclasses.storage.k8s.io \
    priorityclasses.scheduling.k8s.io \
    namespaces; do
    for verb in get list watch create update patch delete; do
      assert_cannot "$controller_principal" "$verb" "$cluster_resource"
    done
  done
  for escalation_resource in \
    clusterroles.rbac.authorization.k8s.io \
    clusterrolebindings.rbac.authorization.k8s.io; do
    assert_cannot "$controller_principal" bind "$escalation_resource"
    assert_cannot "$controller_principal" escalate "$escalation_resource"
  done
  for impersonation_resource in users groups serviceaccounts; do
    assert_cannot "$controller_principal" impersonate "$impersonation_resource"
  done

  while IFS= read -r candidate_namespace; do
    for secret_verb in get list watch create update patch delete; do
      assert_cannot "$controller_principal" "$secret_verb" secrets \
        -n "$candidate_namespace"
    done
    assert_cannot "$controller_principal" create serviceaccounts \
      --subresource=token -n "$candidate_namespace"
    for namespaced_rbac in \
      roles.rbac.authorization.k8s.io \
      rolebindings.rbac.authorization.k8s.io; do
      for verb in get list watch create update patch delete bind escalate; do
        assert_cannot "$controller_principal" "$verb" "$namespaced_rbac" \
          -n "$candidate_namespace"
      done
    done
    for forbidden_resource in \
      pods pods/exec pods/attach pods/portforward \
      persistentvolumeclaims resourcequotas limitranges; do
      for verb in get list watch create update patch delete; do
        assert_cannot "$controller_principal" "$verb" "$forbidden_resource" \
          -n "$candidate_namespace"
      done
    done

    if test "$controller" != kustomize-controller ||
      test "$candidate_namespace" != meshr; then
      for workload_resource in \
        configmaps serviceaccounts services deployments.apps \
        horizontalpodautoscalers.autoscaling jobs.batch \
        networkpolicies.networking.k8s.io \
        poddisruptionbudgets.policy \
        secretproviderclasses.secrets-store.csi.x-k8s.io; do
        for verb in create update patch delete; do
          assert_cannot "$controller_principal" "$verb" "$workload_resource" \
            -n "$candidate_namespace"
        done
      done
    fi

    if test "$candidate_namespace" != flux-system; then
      for controller_resource in \
        gitrepositories.source.toolkit.fluxcd.io \
        kustomizations.kustomize.toolkit.fluxcd.io; do
        for verb in create update patch delete; do
          assert_cannot "$controller_principal" "$verb" "$controller_resource" \
            -n "$candidate_namespace"
        done
      done
    elif test "$controller" = source-controller; then
      for verb in create update patch delete; do
        assert_cannot "$controller_principal" "$verb" \
          kustomizations.kustomize.toolkit.fluxcd.io -n flux-system
      done
      for verb in create delete; do
        assert_cannot "$controller_principal" "$verb" \
          gitrepositories.source.toolkit.fluxcd.io -n flux-system
      done
    else
      for verb in create update patch delete; do
        assert_cannot "$controller_principal" "$verb" \
          gitrepositories.source.toolkit.fluxcd.io -n flux-system
      done
      for verb in create delete; do
        assert_cannot "$controller_principal" "$verb" \
          kustomizations.kustomize.toolkit.fluxcd.io -n flux-system
      done
    fi
  done <<<"$namespace_names"
done
