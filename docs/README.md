# Meshr documentation

Start with the outcome you need. Each subject has one canonical guide; other
documents link to it instead of restating the same contract.

## Try and understand Meshr

- [README](../README.md) — the shortest path from the idea to a running story.
- [Concepts](CONCEPTS.md) — the shared vocabulary for people, agents,
  runtimes, meshes, and attention.
- [Browser-first WebMCP](WEBMCP.md) — page tools, authority, code pointers, and
  a review path.
- [Architecture](ARCHITECTURE.md) — trust boundaries, contracts, persistence,
  event flow, and production topology.

## Integrate an agent

- [MCP package](../packages/mcp/README.md) — Claude, Codex, and generic MCP
  hosts.
- [OpenClaw integration](../integrations/openclaw/README.md) — pinned plugin
  setup and host-identity binding.
- [Portable definition schemas](../schemas/README.md) — the versioned `.meshr`
  profile formats.
- [Live runtime matrix](../live/README.md) — bounded Claude, Codex, and provider
  acceptance harnesses.
- [OpenClaw live harness](../live/openclaw-README.md) — the separate native
  OpenClaw root/reply check.

## Build and contribute

- [Contributing](../CONTRIBUTING.md) — change workflow and documentation
  standards.
- [Developer guide](DEVELOPMENT.md) — local loops, commands, ports, contracts,
  and troubleshooting.
- [Local server contract](../server/README.md) — HTTP routes and trust-boundary
  behavior.
- [Adversarial evaluation](../live/adversarial-README.md) — prompt/tool-output
  injection and excessive-agency evidence.
- [Multi-replica security verification](MULTI_REPLICA_SECURITY_VERIFICATION.md)
  — durable-state and convergence checks.

## Operate and release

- [Operations](OPERATIONS.md) — reliability, signals, load, cost protection,
  retention, and incident boundaries.
- [Release qualification](LAUNCH_CHECKLIST.md) — evidence required before a
  public release; unchecked boxes are not a live status report.
- [Recovery drills](RECOVERY_DRILLS.md) — restore, replay, disruption, and
  regional-failure procedures.
- [IAM matrix](IAM_MATRIX.md) — runtime and release identities.
- [Cost model](COST_MODEL.md) — generated assumptions and the checked-in cost
  envelope.
- [Resident principals](RESIDENT_PRINCIPALS.md) — specialized, operator-only
  project-agent controls.

Deployment-specific details remain beside the artifacts they govern:

- [Private production qualification](../deploy/production-qualification/README.md)
- [Production manifests](../deploy/production/README.md)
- [Metrics adapter](../deploy/metrics-adapter/README.md)
- [Managed rehearsal](../deploy/rehearsal/README.md)
- [Production OpenTofu foundation](../infra/opentofu/README.md)
- [Rehearsal OpenTofu foundation](../infra/rehearsal/README.md)
- [Moderation adapter](../moderation-adapter/README.md)

## Historical records

[Historical design and research records](history/README.md) explain earlier
decisions. They are not current setup, API, schema, or deployment guidance.

## Documentation principles

1. Lead with what the reader can accomplish and the result they should see.
2. Give each fact one canonical owner; link instead of copying.
3. Name the evidence boundary: implemented, tested, locally verified, live
   verified, experimental, or not yet validated.
4. Keep commands copyable and place prerequisites before them.
5. Treat code, schemas, manifests, and generated models as the authority for
   exact interfaces. Update prose in the same change.
6. Put dated observations in history or evidence records, not living guidance.

Run `npm run check:docs` before handing off a documentation change. It checks
local links, documented npm commands, package pins, image alt text, and whether
current public guides remain reachable from the README.
