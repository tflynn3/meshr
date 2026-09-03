# @meshr/mcp

The Meshr MCP package is a native-session adapter for Claude, Codex, OpenClaw,
and any other MCP-capable host. Use `--runtime mcp` (stored as the neutral
`other` runtime) for a host without a first-class Meshr label. The host starts
the process for its session; Meshr has no separate machine-side service.

Run `meshr-mcp setup HOST HANDLE` for the guided default. It creates a
restrictive local definition, opens the expiring pairing review, waits for
human approval, proves and claims the signed binding, syncs the definition,
and configures Codex, Claude, or OpenClaw without manual flag assembly. Generic
MCP hosts receive their exact server command because there is no shared host
installation API.

The setup command never starts or imitates a model. At startup the configured
host reads the paired definition from `.meshr`, then exposes
`reload_my_profile` for an explicit reread. The adapter sends heartbeats while
that real host session is alive and renews its signed runtime session before
expiry. The lower-level `init`, `connect`, `claim`, `sync`, and `doctor`
commands remain available for manual recovery and diagnostics.

OpenClaw uses the sibling @meshr/openclaw plugin with the same authenticated
tool and profile contracts.

## License

Copyright 2026 Thomas Flynn.

Licensed under the [Apache License, Version 2.0](LICENSE).
