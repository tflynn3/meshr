# GKE Autopilot adds these two safe Pod fields after admission. Normalize only
# the exact observed values so any broader toleration or changed Pod security
# context remains part of the signed runtime contract and fails verification.
def meshr_normalize_flux_pod_template:
  if .spec.securityContext.seccompProfile? == {type: "RuntimeDefault"} then
    del(.spec.securityContext.seccompProfile)
  else
    .
  end
  | if .spec.tolerations? == [{
      effect: "NoSchedule",
      key: "kubernetes.io/arch",
      operator: "Equal",
      value: "amd64"
    }] then
      del(.spec.tolerations)
    else
      .
    end;

# GKE adds this annotation to Services that it enrolls in container-native
# load balancing. Normalize only the exact observed ingress enrollment; a
# different value or any additional annotation remains in the signed contract.
def meshr_normalize_flux_source_service_annotations:
  if .["cloud.google.com/neg"]? == "{\"ingress\":true}" then
    del(.["cloud.google.com/neg"])
  else
    .
  end;

# GKE adds this selector to ValidatingAdmissionPolicy match constraints so
# tenant policies cannot affect its managed namespaces. The Meshr release
# namespaces must remain selected by the NotIn expression.
def meshr_gke_autopilot_admission_namespace_selector:
  {
    matchExpressions: [{
      key: "kubernetes.io/metadata.name",
      operator: "NotIn",
      values: [
        "kube-system",
        "gke-gmp-system",
        "gke-managed-cim",
        "gke-managed-volumepopulator",
        "gke-managed-checkpointing",
        "gke-managed-parallelstorecsi",
        "gke-managed-lustrecsi",
        "gke-managed-otel",
        "gke-managed-mldiagnostics",
        "gke-managed-networking-dra-driver",
        "gke-managed-pod-snapshots"
      ]
    }]
  };

def meshr_gke_selector_keeps_release_namespaces:
  (.matchExpressions[0].values | index("flux-system")) == null
  and (.matchExpressions[0].values | index("meshr")) == null;

def meshr_normalize_admission_spec:
  if has("matchConstraints") then
    .matchConstraints.matchPolicy //= "Equivalent"
    | .matchConstraints.namespaceSelector //= {}
    | .matchConstraints.namespaceSelector |= (
        if . == meshr_gke_autopilot_admission_namespace_selector
          and meshr_gke_selector_keeps_release_namespaces
        then {}
        else .
        end
      )
    | .matchConstraints.objectSelector //= {}
  elif has("matchResources") then
    .matchResources.matchPolicy //= "Equivalent"
    | .matchResources.namespaceSelector //= {}
    | .matchResources.objectSelector //= {}
  else
    .
  end;
