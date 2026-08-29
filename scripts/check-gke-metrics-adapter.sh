#!/usr/bin/env bash
set -euo pipefail

namespace=${1:?usage: check-gke-metrics-adapter.sh <namespace> <hpa> <subscription>}
hpa=${2:?usage: check-gke-metrics-adapter.sh <namespace> <hpa> <subscription>}
subscription=${3:?usage: check-gke-metrics-adapter.sh <namespace> <hpa> <subscription>}

if [[ ! "$namespace" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]]; then
  echo "invalid namespace: $namespace" >&2
  exit 2
fi
if [[ ! "$hpa" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]]; then
  echo "invalid HPA name: $hpa" >&2
  exit 2
fi
if [[ ! "$subscription" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]]; then
  echo "invalid Pub/Sub subscription: $subscription" >&2
  exit 2
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "missing required command: jq" >&2
  exit 2
fi

attempts=${METRICS_ADAPTER_CHECK_ATTEMPTS:-60}
interval_seconds=${METRICS_ADAPTER_CHECK_INTERVAL_SECONDS:-5}
if [[ ! "$attempts" =~ ^[1-9][0-9]*$ || ! "$interval_seconds" =~ ^[0-9]+$ ]]; then
  echo "METRICS_ADAPTER_CHECK_ATTEMPTS must be positive and METRICS_ADAPTER_CHECK_INTERVAL_SECONDS must be non-negative" >&2
  exit 2
fi

for attempt in $(seq 1 "$attempts"); do
  if kubectl get --raw '/apis/external.metrics.k8s.io/v1beta1' >/dev/null 2>&1 &&
    kubectl -n "$namespace" get hpa "$hpa" >/dev/null 2>&1; then
    break
  fi
  if [[ "$attempt" == "$attempts" ]]; then
    echo "external.metrics.k8s.io is not available for $namespace/$hpa" >&2
    exit 1
  fi
  sleep "$interval_seconds"
done

spec_metrics=$(kubectl -n "$namespace" get hpa "$hpa" \
  -o jsonpath='{range .spec.metrics[*]}{.type}={.external.metric.name}{"\n"}{end}')
expected_metric='External=pubsub.googleapis.com|subscription|num_undelivered_messages'
if ! grep -Fqx "$expected_metric" <<<"$spec_metrics"; then
  echo "HPA $namespace/$hpa does not declare the expected Pub/Sub external metric" >&2
  exit 1
fi

# Query the same aggregated API endpoint used by the HPA controller. A
# non-empty, correctly-labelled items list proves that the adapter can
# authenticate to Cloud Monitoring and resolve this subscription's resource
# label. Checking only for an `items` key would accept an empty response and
# make a broken adapter look healthy.
metric_path="/apis/external.metrics.k8s.io/v1beta1/namespaces/${namespace}/pubsub.googleapis.com%7Csubscription%7Cnum_undelivered_messages?labelSelector=resource.labels.subscription_id%3D${subscription}"
for attempt in $(seq 1 "$attempts"); do
  metric_response=$(kubectl get --raw "$metric_path" 2>/dev/null || true)
  hpa_status=$(kubectl -n "$namespace" get hpa "$hpa" -o json 2>/dev/null || true)
  conditions=$(jq -r '.status.conditions[]? | "\(.type)=\(.status)"' <<<"$hpa_status" 2>/dev/null || true)
  metric_ready=$(jq -e --arg subscription "$subscription" '
    (.items? // null) as $items
    | ($items | type == "array")
    and ($items | length > 0)
    and all($items[];
        ((.metricLabels // {})["resource.labels.subscription_id"] == $subscription)
        and (((.value // "") | tostring) | test("^[0-9]+([.][0-9]+)?m?$")))
  ' <<<"$metric_response" 2>/dev/null || true)
  hpa_metric_ready=$(jq -e --arg expected_name "${expected_metric#External=}" '
    any((.status.currentMetrics // [])[]?;
      .type == "External"
      and .external.metric.name == $expected_name
      and ((.external.current.value? // .external.current.averageValue?) != null))
  ' <<<"$hpa_status" 2>/dev/null || true)
  if [[ "$metric_ready" == "true" && "$hpa_metric_ready" == "true" ]] &&
    grep -Fqx 'ScalingActive=True' <<<"$conditions"; then
    break
  fi
  if [[ "$attempt" == "$attempts" ]]; then
    echo "HPA $namespace/$hpa is not actively consuming the $subscription external metric" >&2
    printf '%s\n' "$conditions" >&2
    printf '%s\n' "$metric_response" >&2
    printf '%s\n' "$hpa_status" >&2
    exit 1
  fi
  sleep "$interval_seconds"
done

echo "GKE external metric ready: $namespace/$hpa -> $subscription"
