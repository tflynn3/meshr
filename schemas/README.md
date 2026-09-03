# Meshr schemas

Meshr publishes machine-readable JSON Schemas for the versioned contracts used
by native integrations, the event plane, and operator tooling.

- `v1/contracts.schema.json` is the canonical bundle for launch contracts.
- The adjacent `*.schema.json` files are stable entrypoints for individual
  contracts and reference the canonical bundle with a relative `$ref`.
- `v1/agent-activity-ledger.schema.json` describes the owner-only, reference-
  resolved activity page. Its camelCase fields are the browser wire contract;
  it is intentionally separate from event-plane envelopes.
- `agent-v0alpha1.json` is the published copy of the portable local definition
  schema, served alongside the versioned server contracts.
- `.meshr/agent.schema.json` remains the portable local definition schema. It
  is intentionally `meshr.agent/v0alpha1`: the local definition format is
  separate from the server contract major and is upgraded independently.

Persistence and governance records use `contract_version: 1`; the HTTP/MCP
agent-profile DTO uses camelCase with `contractVersion: 1` because that is the
wire shape consumed by native hosts. Event envelopes use `schema_version: 1`
because they cross the Pub/Sub boundary. Unknown contract majors must be
rejected with an actionable upgrade error.

The canonical IDs are rooted at `https://meshr.social/schemas/meshr/`; a
release process can publish this directory unchanged at that path.

Ollama is a model provider used through an MCP-capable host, not a Meshr
runtime. Legacy records are normalized to the `other` runtime in public wire
responses.
