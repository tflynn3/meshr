# Private production qualification

This path runs the production workload privately through GKE Connect Gateway.
It deliberately excludes `Gateway`, `HTTPRoute`, `Ingress`, external Services,
backend policies, public health checks, and trusted edge headers. It is a
non-public qualification environment: create no production or staging DNS and
expose no public ingress.

The operator owns cluster bootstrap, capacity planning, garbage collection,
and the environment lifecycle.
Hosted qualification owns only bounded release creation, one atomic release
pointer switch, observation, logs, and named Pod port-forwards. Never reconcile
`deploy/production/flux/kustomization.yaml` in this environment.

## Verify the edge-free overlay

Run the checked-in bounded renderer from a clean checkout. Raw rendering needs
the explicit load restrictor because this overlay reuses production files
outside its directory.

```bash
set -euo pipefail
npm run check:production-qualification
kubectl kustomize deploy/production-qualification \
  --load-restrictor=LoadRestrictionsNone >/dev/null
```

The check rejects public or node-facing network objects and requires
`MESHR_TRUST_CLOUDFLARE_CONNECTING_IP=0`. A green render is not live evidence;
the acceptance section below also inventories Kubernetes and GCP.

## Immutable release model and capacity

Each protected public commit consumes create-once objects:

- `GitRepository/meshr-pq-source-<40-hex-sha>` fixes the public repository,
  protected `main`, and exact commit. Its 24-hour periodic interval avoids
  multiplying full repository fetches by the number of retained releases;
  creation and a source-controller restart still reconcile immediately.
- immutable `ConfigMap/meshr-pq-images-<40-hex-sha>` holds four signed image
  digests.
- immutable `ConfigMap/meshr-r-<phase>-<40-hex-sha>-<12-hex-hash>` holds the
  complete runtime map. Phase `b` is the one-time store bootstrap tuple;
  phase `r` contains the attested authority bootstrap ID and is ready to serve.
  The map carries the full adapter source identity in
  `MESHR_MODERATION_RELEASE_SHA` and binds `MESHR_MODERATION_REVISION_TAG` to
  `r-` plus its first 20 hex characters. Qualification requires this source SHA
  to equal the reviewed public `MESHR_RELEASE_SHA`. Its screen and health URLs are the exact
  tagged Cloud Run origin derived from that tag and the canonical stable
  service audience. The 80-bit prefix is only a DNS-safe routing label; the
  full SHA and exact adapter digest remain the release provenance.
- the single `Kustomization/meshr-production-qualification` records exact
  `active-release-id`, `previous-release-id`, and `transition-kind` annotations.
  A JSON Patch tests resource version, old spec, both old IDs, and old transition
  provenance before replacing the spec and all three annotations atomically.

The private bootstrap operator creates the initial `b,b`; hosted bootstrap may derive and
switch once to the matching attested `r,b`. A rerun for that exact active `r`
is idempotent. A different same-SHA runtime or attestation is never a hosted
repair and requires private operator rebootstrap. Normal promotion is a
direct `rA,rPrevious` to `rB,rA` switch for a different public commit and must
preserve the existing attested authority bootstrap ID. Rollback tests both the
expected active and expected previous release IDs and requires a `forward`
provenance before producing a `rollback` state. That state cannot be toggled
back to its recorded failed release; the next forward release must differ.

Nothing is updated in place and hosted automation cannot delete release
objects. The operator supplies positive canonical source and ConfigMap limits
for `ResourceQuota/meshr-production-qualification-releases`; the Kustomization
limit remains one. This dedicated, freshly bootstrapped namespace permits no
non-release GitRepository and only the automatic `kube-root-ca.crt` ConfigMap.
For `N` planned SHAs, the normal initial `b`/`r` flow therefore needs `N`
sources and `2N + 2` ConfigMaps: one root-CA map, one image map per SHA, one
ready-runtime map per SHA, and the one-time initial bootstrap-runtime map.
Choose limits with explicit operational headroom, up to 64 sources and 192
ConfigMaps, and treat a dirty inventory as a failed preflight, not extra
capacity to budget around.

Promptly garbage-collect eligible sources and maps once their rollback/evidence
retention window closes. The operator must first quiesce or revoke hosted
promotion authority. Immediately before each conditional deletion, re-read and
test the exact Kustomization active and previous tuple. Delete only release
objects referenced by neither ID and never delete a staged, active, or previous
tuple. Routine hosted deployment has no delete authority.

## Private operator bootstrap

Use a clean checkout at the exact successful public build SHA. Keep the
private operator session until controller verification, initial release,
Connect Gateway authorization, and all negative gates pass.

```bash
set -euo pipefail
export MESHR_PRODUCTION_QUALIFICATION_SHA='<verified-40-hex-public-build-sha>'
printf '%s' "$MESHR_PRODUCTION_QUALIFICATION_SHA" \
  | grep -Eq '^[0-9a-f]{40}$'
test "$(git rev-parse HEAD)" = "$MESHR_PRODUCTION_QUALIFICATION_SHA"
test -z "$(git status --porcelain)"
npm ci
```

When a hosted job materializes a receipt-approved source bundle instead of a
full checkout, include
`deploy/production-qualification/admission-contract.json` and
`gke-autopilot-contract.jq` beside `verify-flux-contract.sh`, and cover all
three files with the receipt's approved digests. The verifier and release
transaction helper use only `bash`, `kubectl`, `jq`, `shasum`, and standard
shell tools after authentication; do not add a post-OIDC package install or
public dependency fetch.

The operator workstation and hosted runner must use a `kubectl` client no more
than one minor version above or below the cluster server. Check the numeric
minors on both paths; stop on a larger skew.

```bash
set -euo pipefail
versions="$(kubectl version -o json)"
client_minor="$(jq -r '.clientVersion.minor | sub("[^0-9].*$"; "") | tonumber' <<<"$versions")"
server_minor="$(jq -r '.serverVersion.minor | sub("[^0-9].*$"; "") | tonumber' <<<"$versions")"
delta=$((client_minor - server_minor))
test "${delta#-}" -le 1
```

The metrics adapter is privileged operator bootstrap, never a release input.
Create the workload namespace and apply the adapter directly from this checkout
with an exact envsubst allowlist.

```bash
set -euo pipefail
kubectl apply -f deploy/production/namespace.yaml
export METRICS_ADAPTER_GSA="$(tofu -chdir=infra/opentofu output -raw metrics_adapter_service_account)"
envsubst '${METRICS_ADAPTER_GSA}' \
  < deploy/metrics-adapter/adapter.yaml \
  | kubectl apply -f -
kubectl -n custom-metrics rollout status \
  deployment/custom-metrics-stackdriver-adapter --timeout=5m
kubectl wait --for=condition=Available \
  apiservice/v1beta1.external.metrics.k8s.io --timeout=5m
kubectl get clusterrole meshr-external-metrics-reader -o json \
  | jq -e '(.aggregationRule // null) == null and .rules == [{
      apiGroups: ["external.metrics.k8s.io"],
      resources: ["pubsub.googleapis.com|subscription|num_undelivered_messages"],
      verbs: ["list", "get", "watch"]
    }]'
kubectl get clusterrolebindings -o json \
  | jq -e '
      ([.items[] | select(.metadata.name == "meshr-external-metrics-reader")] | length) == 1 and
      ([.items[] | select(.metadata.name == "meshr-external-metrics-reader")][0] |
        .roleRef == {
          apiGroup: "rbac.authorization.k8s.io",
          kind: "ClusterRole",
          name: "meshr-external-metrics-reader"
        } and
        .subjects == [{
          kind: "ServiceAccount",
          name: "horizontal-pod-autoscaler",
          namespace: "kube-system"
        }]) and
      (all(.items[];
        .roleRef.name != "external-metrics-reader" or
        all(.subjects[]?;
          .kind != "ServiceAccount" or
          .name != "horizontal-pod-autoscaler" or
          .namespace != "kube-system")))'
```

### Install the reviewed Flux controllers

Do not run raw `flux install`. Download Flux v2.9.5, authenticate its signed
checksum list, verify the exact install checksum, and render only the two
required namespace-confined controllers and CRDs. The signed release workflow
identity is
`https://github.com/fluxcd/flux2/.github/workflows/release.yaml@refs/tags/v2.9.5`;
the two controller images are signed by
`https://github.com/fluxcd/gha-workflows/.github/workflows/controller-release.yaml@refs/tags/v0.11.0`.

```bash
set -euo pipefail
flux_asset_dir="$(mktemp -d)"
flux_release='https://github.com/fluxcd/flux2/releases/download/v2.9.5'
curl -fsSL 'https://github.com/fluxcd/flux2/releases/download/v2.9.5/install.yaml' \
  -o "$flux_asset_dir/install.yaml"
curl -fsSL "$flux_release/flux_2.9.5_checksums.txt" -o "$flux_asset_dir/checksums.txt"
curl -fsSL "$flux_release/flux_2.9.5_checksums.txt.pem" -o "$flux_asset_dir/checksums.pem.b64"
curl -fsSL "$flux_release/flux_2.9.5_checksums.txt.sig" -o "$flux_asset_dir/checksums.sig"
openssl base64 -d -A -in "$flux_asset_dir/checksums.pem.b64" \
  -out "$flux_asset_dir/checksums.pem"
cosign verify-blob \
  --certificate "$flux_asset_dir/checksums.pem" \
  --signature "$flux_asset_dir/checksums.sig" \
  --certificate-identity 'https://github.com/fluxcd/flux2/.github/workflows/release.yaml@refs/tags/v2.9.5' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' \
  "$flux_asset_dir/checksums.txt"
grep -Fx 'cc3dcd743af16215838b6937e1fce83745bf24c0dcc6c59737c59df15429caaf  install.yaml' \
  "$flux_asset_dir/checksums.txt"
test "$(shasum -a 256 "$flux_asset_dir/install.yaml" | awk '{print $1}')" = \
  'cc3dcd743af16215838b6937e1fce83745bf24c0dcc6c59737c59df15429caaf'
node scripts/render-minimal-flux.mjs "$flux_asset_dir/install.yaml" \
  >"$flux_asset_dir/minimal-flux.yaml"
for controller_image in \
  'ghcr.io/fluxcd/source-controller@sha256:6f20d232d596a758c923d2861f23511718fc303b8a2e36a1434a7c736b9f4268' \
  'ghcr.io/fluxcd/kustomize-controller@sha256:a3a955eb2bc432c2eaa94d2d3714e3beae7fdf17586fd23aadf71ab597ac3339'; do
  cosign verify \
    --certificate-identity 'https://github.com/fluxcd/gha-workflows/.github/workflows/controller-release.yaml@refs/tags/v0.11.0' \
    --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' \
    "$controller_image" >/dev/null
done
kubectl apply -f "$flux_asset_dir/minimal-flux.yaml"
kubectl -n flux-system rollout status deployment/source-controller --timeout=5m
kubectl -n flux-system rollout status deployment/kustomize-controller --timeout=5m
```

The renderer pins
`ghcr.io/fluxcd/source-controller@sha256:6f20d232d596a758c923d2861f23511718fc303b8a2e36a1434a7c736b9f4268`
and
`ghcr.io/fluxcd/kustomize-controller@sha256:a3a955eb2bc432c2eaa94d2d3714e3beae7fdf17586fd23aadf71ab597ac3339`.
It omits upstream cluster-wide controller RBAC, watches only `flux-system`, and
disables remote bases, cross-namespace references, and ConfigMap-triggered
reconciliation. Each controller has equal 500m CPU, 1Gi memory, and 1Gi
ephemeral-storage requests and limits, satisfying Autopilot minima and ratios
without control-plane resource rewriting. The kustomize controller is bound
directly to the explicit `meshr` Role; neither controller can read Secrets or
mint service-account tokens.

```bash
set -euo pipefail
assert_documented_can_i() {
  local expected="$1"
  local decision decision_status
  local denial_reason_pattern='^no - [[:print:]]+$'
  shift
  if decision="$(kubectl auth can-i "$@")"; then
    decision_status=0
  else
    decision_status=$?
  fi
  if test "$expected" = yes &&
    test "$decision_status" -eq 0 && test "$decision" = yes; then
    return 0
  fi
  if test "$expected" = no &&
    test "$decision_status" -eq 1 &&
    { test "$decision" = no || [[ "$decision" =~ $denial_reason_pattern ]]; }; then
    return 0
  fi
  printf 'unexpected kubectl auth result: expected=%s exit=%s decision=%s\n' \
    "$expected" "$decision_status" "$decision" >&2
  return 1
}
for controller in source-controller kustomize-controller; do
  assert_documented_can_i no create serviceaccounts --subresource=token \
    -n flux-system \
    --as="system:serviceaccount:flux-system:${controller}"
done
assert_documented_can_i no get secrets -n flux-system \
  --as=system:serviceaccount:flux-system:source-controller
assert_documented_can_i no get secrets -n meshr \
  --as=system:serviceaccount:flux-system:kustomize-controller
```

Type-checking alone does not detect a new or changed nested CRD field. The
verification script hashes the complete served GitRepository and Kustomization
CRD contracts, validates exact controller arguments, images, and RBAC, and must
run both immediately after bootstrap and again through Connect Gateway.
GKE Autopilot adds an exact `RuntimeDefault` seccomp profile and amd64
`NoSchedule` toleration to these controller Pods, plus an exact managed-system
namespace exclusion to admission-policy match constraints. GKE also adds the
exact `cloud.google.com/neg={"ingress":true}` annotation when it enrolls the
source-controller Service for container-native load balancing. The verifier
normalizes only those reviewed values; every other annotation or NEG value
remains in the signed comparison and is rejected. NEG enrollment alone creates
no public edge, and the verified overlay still excludes public forwarding and
DNS resources. The verifier confirms that `flux-system` and `meshr` remain
selected and rejects every other scheduling, security-context, or
admission-selector change.
`operator` mode additionally compares all three live controller Roles and
RoleBindings with the reviewed contract, lists RoleBindings in every namespace,
and rejects any extra RoleBinding or ClusterRoleBinding that directly subjects
either controller service account. It also evaluates both service accounts
through authorization review across every live namespace, rejecting sensitive,
escalating, cluster-scoped, or out-of-scope writes inherited through a Group
binding. `gateway` mode repeats the controller, Service, CRD, and exact
admission-policy/binding contracts because the hosted identity intentionally
cannot enumerate RBAC. Before every mutating transaction, the release helper
derives the seven runtime admission anchors from its already-validated runtime
JSON and requires the exact deploy-GSA environment value; policy drift or a
missing anchor stops the transaction before any release switch.

### Apply and activate anchored admission

Export every operator-reviewed anchor from OpenTofu. Database IDs are fixed at
bootstrap; hosted release authority cannot redirect any store.

```bash
set -euo pipefail
export PROJECT_ID="$(tofu -chdir=infra/opentofu output -raw project_id)"
export GCP_PROJECT_ID="$PROJECT_ID"
export CONNECT_GATEWAY_DEPLOY_SERVICE_ACCOUNT_EMAIL="$(tofu -chdir=infra/opentofu output -raw connect_gateway_deploy_service_account)"
export MESHR_FIRESTORE_DATABASE='(default)'
export MESHR_TOPOLOGY_FIRESTORE_DATABASE="$(tofu -chdir=infra/opentofu output -raw firestore_topology_database)"
export MESHR_EVENT_AUDIT_FIRESTORE_DATABASE="$(tofu -chdir=infra/opentofu output -raw firestore_audit_database)"
export MESHR_NOTIFICATIONS_FIRESTORE_DATABASE="$(tofu -chdir=infra/opentofu output -raw firestore_notifications_database)"
export MESHR_MODERATION_FIRESTORE_DATABASE="$(tofu -chdir=infra/opentofu output -raw firestore_moderation_database)"
export MESHR_MODERATION_AUDIENCE="$(tofu -chdir=infra/opentofu output -raw moderation_adapter_url)"
: "${MESHR_RELEASE_SOURCE_QUOTA:?set the operator-reviewed source quota}"
: "${MESHR_RELEASE_CONFIGMAP_QUOTA:?set the operator-reviewed ConfigMap quota}"
printf '%s' "$CONNECT_GATEWAY_DEPLOY_SERVICE_ACCOUNT_EMAIL" |
  grep -Eq '^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9][.]iam[.]gserviceaccount[.]com$'
printf '%s' "$GCP_PROJECT_ID" |
  grep -Eq '^[a-z][a-z0-9-]{4,28}[a-z0-9]$'
for database_anchor in \
  MESHR_FIRESTORE_DATABASE \
  MESHR_TOPOLOGY_FIRESTORE_DATABASE \
  MESHR_EVENT_AUDIT_FIRESTORE_DATABASE \
  MESHR_NOTIFICATIONS_FIRESTORE_DATABASE \
  MESHR_MODERATION_FIRESTORE_DATABASE; do
  printf '%s' "${!database_anchor}" |
    grep -Eq '^(\(default\)|[A-Za-z][A-Za-z0-9_-]{0,62})$'
done
printf '%s' "$MESHR_MODERATION_AUDIENCE" |
  grep -Eq '^https://[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?([.][a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*[.]run[.]app$'
validate_quota_integer() {
  local value="$1"
  case "$value" in
    '' | 0* | *[!0-9]*) return 1 ;;
  esac
  test "${#value}" -le 3
}
validate_quota_integer "$MESHR_RELEASE_SOURCE_QUOTA"
validate_quota_integer "$MESHR_RELEASE_CONFIGMAP_QUOTA"
((MESHR_RELEASE_SOURCE_QUOTA <= 64))
((MESHR_RELEASE_CONFIGMAP_QUOTA <= 192))
```

The source quota is a canonical decimal integer from 1 through 64 and the
ConfigMap quota from 1 through 192. The shell checks canonical syntax before
numeric comparison. Plan operator-owned garbage collection before either bound
is reached; larger Kubernetes quantities can canonicalize to forms such as
`1k`, which are deliberately outside this decimal object-count contract.

Render only the ten allowlisted fields, reject every unexpanded placeholder,
then apply. The four fail-closed policies guard create-once sources, immutable
input maps, the atomic Kustomization release pointer, and private ClusterIP
Services respectively.

```bash
set -euo pipefail
rendered_bootstrap="$(mktemp)"
envsubst '${CONNECT_GATEWAY_DEPLOY_SERVICE_ACCOUNT_EMAIL} ${GCP_PROJECT_ID} ${MESHR_FIRESTORE_DATABASE} ${MESHR_TOPOLOGY_FIRESTORE_DATABASE} ${MESHR_EVENT_AUDIT_FIRESTORE_DATABASE} ${MESHR_NOTIFICATIONS_FIRESTORE_DATABASE} ${MESHR_MODERATION_FIRESTORE_DATABASE} ${MESHR_MODERATION_AUDIENCE} ${MESHR_RELEASE_SOURCE_QUOTA} ${MESHR_RELEASE_CONFIGMAP_QUOTA}' \
  < deploy/production-qualification/flux-bootstrap.yaml \
  >"$rendered_bootstrap"
! grep -F '${' "$rendered_bootstrap"
kubectl apply -f "$rendered_bootstrap"
for attempt in $(seq 1 60); do
  release_quota="$(kubectl -n flux-system get resourcequota \
    meshr-production-qualification-releases -o json)"
  if jq -e '
    . as $quota |
    $quota.status.hard == $quota.spec.hard and
    ([
      "count/configmaps",
      "count/gitrepositories.source.toolkit.fluxcd.io",
      "count/kustomizations.kustomize.toolkit.fluxcd.io"
    ] as $quota_keys |
      $quota_keys | all($quota_keys[];
        . as $key |
        ($quota.status.used[$key] // "") | test("^[0-9]+$")))
  ' <<<"$release_quota" >/dev/null; then
    break
  fi
  test "$attempt" -lt 60
  sleep 2
done
for policy_name in \
  meshr-production-qualification-source.meshr.social \
  meshr-production-qualification-inputs.meshr.social \
  meshr-production-qualification-reconciliation.meshr.social \
  meshr-production-qualification-private-services.meshr.social; do
  for attempt in $(seq 1 60); do
    policy="$(kubectl get validatingadmissionpolicy "$policy_name" -o json)"
    jq -e '
      .status.observedGeneration == .metadata.generation and
      ((.status.typeChecking.expressionWarnings // []) | length == 0)
    ' <<<"$policy" >/dev/null && break
    test "$attempt" -lt 60
    sleep 2
  done
done

# Exercise every admission policy repeatedly as the exact hosted username while
# the private operator supplies only the authorization needed for this dry-run
# proof. No probe object is persisted, and a generic RBAC Forbidden is not a
# successful policy check.
probe_sha="$(
  printf '%s' "${CONNECT_GATEWAY_DEPLOY_SERVICE_ACCOUNT_EMAIL}:$(date +%s):$$:${RANDOM}" |
    shasum -a 256 | cut -c1-40
)"
probe_release_id="b-${probe_sha}-000000000000"
canonical_source_probe="$(mktemp)"
malicious_source_probe="$(mktemp)"
arbitrary_configmap_probe="$(mktemp)"
public_service_probe="$(mktemp)"
invalid_kustomization_probe="$(mktemp)"
awk '/^---$/ { exit } { print }' deploy/production-qualification/flux.yaml |
  MESHR_PRODUCTION_QUALIFICATION_SHA="$probe_sha" \
    envsubst '${MESHR_PRODUCTION_QUALIFICATION_SHA}' \
    >"$canonical_source_probe"
kubectl create --dry-run=client -f "$canonical_source_probe" -o json |
  jq '.spec.url = "https://example.invalid/attacker.git"' \
    >"$malicious_source_probe"
jq -n '{
  apiVersion: "v1",
  kind: "ConfigMap",
  metadata: {name: "qualification-arbitrary-denial", namespace: "flux-system"},
  data: {probe: "must-be-denied"}
}' >"$arbitrary_configmap_probe"
jq -n '{
  apiVersion: "v1",
  kind: "Service",
  metadata: {name: "qualification-public-denial", namespace: "meshr"},
  spec: {
    type: "LoadBalancer",
    selector: {app: "qualification-public-denial"},
    ports: [{name: "http", port: 80, targetPort: 80}]
  }
}' >"$public_service_probe"
awk 'emit { print } /^---$/ { emit=1; next }' \
    deploy/production-qualification/flux.yaml |
  MESHR_PRODUCTION_QUALIFICATION_SHA="$probe_sha" \
  MESHR_PRODUCTION_QUALIFICATION_RELEASE_ID="$probe_release_id" \
    envsubst \
      '${MESHR_PRODUCTION_QUALIFICATION_SHA} ${MESHR_PRODUCTION_QUALIFICATION_RELEASE_ID}' |
  kubectl create --dry-run=client -f - -o json |
  jq '.spec.interval = "2m"' >"$invalid_kustomization_probe"

operator_impersonation=(
  --as="$CONNECT_GATEWAY_DEPLOY_SERVICE_ACCOUNT_EMAIL"
  --as-group=system:masters
)
kubectl "${operator_impersonation[@]}" create --dry-run=server \
  -f "$canonical_source_probe" -o name |
  grep -Fx \
    "gitrepository.source.toolkit.fluxcd.io/meshr-pq-source-${probe_sha}"

expect_policy_denial() {
  local policy_name="$1"
  local manifest="$2"
  local attempt denial_log
  for attempt in 1 2 3; do
    denial_log="$(mktemp)"
    if kubectl "${operator_impersonation[@]}" create --dry-run=server \
      -f "$manifest" >/dev/null 2>"$denial_log"; then
      printf 'admission unexpectedly allowed %s on attempt %s\n' \
        "$policy_name" "$attempt" >&2
      return 1
    fi
    if ! grep -F "$policy_name" "$denial_log" >/dev/null; then
      printf 'request did not reach expected policy %s on attempt %s\n' \
        "$policy_name" "$attempt" >&2
      return 1
    fi
    rm -f "$denial_log"
    sleep 2
  done
}

expect_policy_denial \
  meshr-production-qualification-source.meshr.social \
  "$malicious_source_probe"
expect_policy_denial \
  meshr-production-qualification-inputs.meshr.social \
  "$arbitrary_configmap_probe"
expect_policy_denial \
  meshr-production-qualification-private-services.meshr.social \
  "$public_service_probe"
expect_policy_denial \
  meshr-production-qualification-reconciliation.meshr.social \
  "$invalid_kustomization_probe"
rm -f \
  "$canonical_source_probe" \
  "$malicious_source_probe" \
  "$arbitrary_configmap_probe" \
  "$public_service_probe" \
  "$invalid_kustomization_probe"
bash deploy/production-qualification/verify-flux-contract.sh operator
```

Prepare exact image and bootstrap-runtime JSON files accepted by
`release-transaction.sh validate`. The runtime file uses `pending` for the
expected authority bootstrap ID and `"1"` for the forced projection scan. Only
the stable Cloud Run service URI is used as `MESHR_MODERATION_AUDIENCE`.
Before validation, the protected adapter promoter must verify the closed public
image receipt, source/run identity, pinned build toolchain, immutable-manifest
HIGH/CRITICAL scan gates, signatures, both runnable platform manifests and
configs, maximum SLSA v1 provenance, and the exact baked
`MESHR_MODERATION_RELEASE_SHA`/OCI revision witness. The initial foundation
creates deterministic revision
`meshr-moderation-adapter-r-<first-20-moderation-source-SHA>`, assigns its
matching `r-<first-20-moderation-source-SHA>` tag, and explicitly routes 100%
of stable traffic to it; the private verifier must attest that narrow initial
active state before Kubernetes references it. For every later release, the
promoter deploys the image map's exact `MODERATION_ADAPTER_IMAGE` with explicit
traffic: the concrete prior revision remains at 100%, while the deterministic
candidate revision receives its tag and 0%. Obtain the tag URL from Cloud Run
rather than guessing it, and prove the stable URI does not route to that
candidate before the Kubernetes pointer changes. Prove the tag resolves to
that exact revision, digest, runtime
service account, and allowlisted configuration; reject any Cloud Run override
of the image-baked source SHA. Authenticated `/health` must return the same
full SHA with `x-meshr-contract-version: 1`, after which the promoter re-reads
the service, revision, tag URI, and concurrency token before the Kubernetes
CAS. Set the endpoint and health values to that returned origin's exact
`/screen` and `/health` paths. The traffic tag is
mutable external routing state, not an immutable release object; admission
proves only the runtime map's deterministic tag and URL relationship. Retain
and re-verify both active and previous tags around the Kubernetes pointer CAS.
After the pointer moves, shift stable traffic to the new active revision at
100% while retaining the prior tag at 0%; rollback reverses the Kubernetes
pointer before stable traffic. Only the private operator may create the initial
Kustomization. Complete this
initialization before granting the hosted identity any Kubernetes RBAC, closing
the pre-initialization object-creation and quota-exhaustion window.

```bash
set -euo pipefail
bash deploy/production-qualification/release-transaction.sh validate \
  "$MESHR_PRODUCTION_QUALIFICATION_SHA" /secure/images.json /secure/bootstrap-runtime.json
bash deploy/production-qualification/release-transaction.sh initialize \
  "$MESHR_PRODUCTION_QUALIFICATION_SHA" /secure/images.json /secure/bootstrap-runtime.json
```

If the create response is ambiguous, `initialize` performs a fresh read and
adopts only the exact expected `b,b` spec and annotations. Any other existing
object or tuple is a hard stop.

Only after exact initialization succeeds, render and apply the Gateway RBAC.

```bash
set -euo pipefail
rendered_gateway_rbac="$(mktemp)"
envsubst '${CONNECT_GATEWAY_DEPLOY_SERVICE_ACCOUNT_EMAIL}' \
  < deploy/production-qualification/connect-gateway-rbac.yaml \
  >"$rendered_gateway_rbac"
! grep -F '${' "$rendered_gateway_rbac"
kubectl apply -f "$rendered_gateway_rbac"
```

## Connect Gateway gate and hosted finalization

The hosted workflow must authenticate as the exact deploy GSA and use the
named fleet membership. It must not fetch direct cluster credentials or add a
runner CIDR. Pin the kubeconfig server to the exact global or regional Gateway
path and reject anything else.

```bash
set -euo pipefail
umask 077
export KUBECONFIG="$(mktemp)"
MEMBERSHIP_ID="$(tofu -chdir=infra/opentofu output -raw fleet_membership_id)"
MEMBERSHIP_LOCATION="$(tofu -chdir=infra/opentofu output -raw fleet_membership_location)"
gcloud container fleet memberships get-credentials "$MEMBERSHIP_ID" \
  --location "$MEMBERSHIP_LOCATION" --project "$PROJECT_ID"
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
GATEWAY_SERVER="$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')"
GATEWAY_PATH="/v1/projects/${PROJECT_NUMBER}/locations/${MEMBERSHIP_LOCATION}/gkeMemberships/${MEMBERSHIP_ID}"
case "$GATEWAY_SERVER" in
  "https://connectgateway.googleapis.com${GATEWAY_PATH}" | \
  "https://${MEMBERSHIP_LOCATION}-connectgateway.googleapis.com${GATEWAY_PATH}") ;;
  *) printf 'unexpected Connect Gateway server: %s\n' "$GATEWAY_SERVER" >&2; exit 1 ;;
esac
: "${CONNECT_GATEWAY_DEPLOY_SERVICE_ACCOUNT_EMAIL:?set the exact hosted deploy GSA}"
admission_runtime=/secure/bootstrap-runtime.json
for admission_anchor in \
  GCP_PROJECT_ID \
  MESHR_FIRESTORE_DATABASE \
  MESHR_TOPOLOGY_FIRESTORE_DATABASE \
  MESHR_EVENT_AUDIT_FIRESTORE_DATABASE \
  MESHR_NOTIFICATIONS_FIRESTORE_DATABASE \
  MESHR_MODERATION_FIRESTORE_DATABASE \
  MESHR_MODERATION_AUDIENCE; do
  admission_value="$(jq -er --arg name "$admission_anchor" '
    .[$name] |
    select(type == "string" and length > 0 and
      (contains("\n") | not) and (contains("\r") | not))
  ' "$admission_runtime")"
  printf -v "$admission_anchor" '%s' "$admission_value"
  export "$admission_anchor"
done
test "$GCP_PROJECT_ID" = "$PROJECT_ID"
bash deploy/production-qualification/verify-flux-contract.sh gateway
```

Prove both intended access and meaningful denials as the real hosted identity.
The arbitrary ConfigMap create must reach admission and be denied, demonstrating
that broad name creation cannot bypass the reserved prefixes.

```bash
set -euo pipefail
assert_documented_can_i() {
  local expected="$1"
  local decision decision_status
  local denial_reason_pattern='^no - [[:print:]]+$'
  shift
  if decision="$(kubectl auth can-i "$@")"; then
    decision_status=0
  else
    decision_status=$?
  fi
  if test "$expected" = yes &&
    test "$decision_status" -eq 0 && test "$decision" = yes; then
    return 0
  fi
  if test "$expected" = no &&
    test "$decision_status" -eq 1 &&
    { test "$decision" = no || [[ "$decision" =~ $denial_reason_pattern ]]; }; then
    return 0
  fi
  printf 'unexpected kubectl auth result: expected=%s exit=%s decision=%s\n' \
    "$expected" "$decision_status" "$decision" >&2
  return 1
}
assert_documented_can_i yes get deployments -n meshr
assert_documented_can_i yes create \
  gitrepositories.source.toolkit.fluxcd.io -n flux-system
assert_documented_can_i yes patch \
  kustomizations.kustomize.toolkit.fluxcd.io/meshr-production-qualification \
  -n flux-system
assert_documented_can_i yes get \
  customresourcedefinitions.apiextensions.k8s.io/gitrepositories.source.toolkit.fluxcd.io
assert_documented_can_i yes get \
  customresourcedefinitions.apiextensions.k8s.io/kustomizations.kustomize.toolkit.fluxcd.io
assert_documented_can_i no get secrets -n meshr
assert_documented_can_i no create pods/exec -n meshr
assert_documented_can_i no update \
  kustomizations.kustomize.toolkit.fluxcd.io -n flux-system
assert_documented_can_i no delete configmaps -n flux-system
assert_documented_can_i no create serviceaccounts --subresource=token \
  -n flux-system
hosted_denial_log="$(mktemp)"
if kubectl -n flux-system create configmap qualification-arbitrary-denial \
  2>"$hosted_denial_log"; then
  printf '%s\n' 'admission unexpectedly allowed an arbitrary ConfigMap' >&2
  exit 1
fi
grep -F 'meshr-production-qualification-inputs.meshr.social' \
  "$hosted_denial_log" >/dev/null || {
    printf '%s\n' \
      'arbitrary ConfigMap did not reach the expected admission policy' >&2
    exit 1
  }
rm -f "$hosted_denial_log"
```

Hosted bootstrap reads the successful one-time Job attestation, creates the
matching `r` runtime map, and performs the single allowed `b,b` to `r,b`
switch. If the derived ready tuple differs from an existing same-SHA `r`, stop;
the workflow is not authorized to repair it.

```bash
set -euo pipefail
bash deploy/production-qualification/release-transaction.sh bootstrap \
  "$MESHR_PRODUCTION_QUALIFICATION_SHA" /secure/images.json /secure/bootstrap-runtime.json
```

The OpenTofu cluster is private-only from its first apply. Before promotion,
re-run the Gateway server, version-skew, positive authorization, and every
negative assertion through Connect Gateway. If GKE reports a Connect-agent
authorization error, stop and inspect actual cluster behavior from the
authorized operator path; do not create a Connect agent or add cluster-wide
impersonation as an automatic fallback.

## Later promotions and rollback

For each later protected public commit, supply exact signed image JSON and a
ready runtime JSON containing the already-attested authority bootstrap ID.
The protected promoter must create and verify that release's no-traffic
adapter revision and deterministic tag before invoking the transaction, and
must re-read the tag-to-revision and revision-to-digest/configuration bindings
before and after the Kubernetes CAS. A collision or any tag movement is a hard
stop. Keep every active and previous tag until no retained release references
it.
`promote` creates retained inputs, waits for the exact source revision, switches
the entire tuple with CAS, waits for current-generation `Ready=True`, and rolls
back automatically if a post-switch check fails. Admission permits a cross-SHA
forward switch only when the old Kustomization itself reports `Ready=True` for
its current metadata generation and exact active commit revision; a failing or
stale release therefore cannot discard the last-known-good rollback target by
chaining another promotion. Rollback records explicit provenance and cannot be
reversed into the failed release.
If the runner is lost after the CAS but before readiness or rollback, rerun the
same `promote` command. It accepts only the exact active target and recorded
ready-phase previous release, re-verifies both immutable releases, arms that
previous release for rollback, and then resumes the readiness wait. A failed
target is restored to the recorded previous tuple; any different live tuple
fails closed for operator review. Immediately before a nonsignal automatic
rollback caused by timeout or API ambiguity, the transaction re-adjudicates
readiness. If the exact target becomes current-generation Ready at its exact
commit during that recovery, it remains active and the transaction succeeds
instead of reverting it. An explicit `INT` or `TERM` never adopts a newly Ready
target: it forces the armed rollback and preserves exit status 130 or 143.

```bash
set -euo pipefail
bash deploy/production-qualification/release-transaction.sh promote \
  "$NEW_RELEASE_SHA" /secure/new-images.json /secure/new-ready-runtime.json
```

Manual rollback always names both sides of the observed tuple. Never infer the
previous release from a stale log or provide only one ID.

The transaction covers only the Kubernetes release tuple. Before invoking a
manual rollback, the caller must read the live `previous-release-id`, derive its
commit SHA, verify that `ConfigMap/meshr-pq-images-<sha>` and the named immutable
`ConfigMap/meshr-r-<release-id>` still agree, and prove that runtime map's
retained tag still routes to a revision running the image map's exact
`MODERATION_ADAPTER_IMAGE`, runtime service account, and configuration. Recheck
the Cloud Run service generation and tag binding immediately around the CAS.
Afterward, verify the active, previous, and transition annotations together with
the adapter's authenticated readiness and running image. A caller that cannot
prove that whole tuple must leave rollback disabled for operator review.

```bash
set -euo pipefail
bash deploy/production-qualification/release-transaction.sh rollback \
  "$EXPECTED_ACTIVE_RELEASE_ID" "$EXPECTED_PREVIOUS_RELEASE_ID"
```

## Live acceptance and operator lifecycle

Before calling qualification successful, capture current-generation Flux
readiness, all ten health checks, Pod restarts, rollout status, logs, private
port-forward smoke, Firestore readiness, Model Armor template readback, signed
image evidence, the adversarial evaluation receipt, and the live admission
transition matrix. That matrix must include a denied cross-SHA forward switch
when the old Kustomization has absent, false, stale-generation `Ready`, or a
mismatched `lastAppliedRevision`; a denied rollback-state toggle to the recorded
failed release; and the corresponding allowed transition only after
current-generation `Ready=True` at the exact active revision. Separately inventory
the live namespace and project and reject any Gateway, HTTPRoute, Ingress,
external or node-facing Service, forwarding rule, backend service, global
address, public ingress IP, or unexpected router/NAT. The stack-owned regional
address, router, and Cloud NAT are expected only for private-node egress.

Keep the environment private for qualification. Do not add public DNS or run
public cutover. After evidence is captured, the operator decides whether to
retain, garbage-collect, or tear down the environment under the normal approved
lifecycle; hosted deployment still cannot delete release inputs or infrastructure.
