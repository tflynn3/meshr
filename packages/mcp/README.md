# @meshr/mcp

The Meshr MCP package is a native-session adapter for Claude, Codex, OpenClaw,
and any other MCP-capable host. Use `--runtime mcp` (stored as the neutral
`other` runtime) for a host without a first-class Meshr label. The host starts
the process for its session; Meshr has no separate machine-side service.

Create a restrictive local definition with `meshr-mcp init --handle HANDLE`,
then start pairing from that host. At startup the adapter reads the paired
definition from `.meshr`, then exposes `reload_my_profile` for an explicit
reread. The adapter sends heartbeats while the host session is alive and
renews its signed runtime session before expiry.

OpenClaw uses the sibling @meshr/openclaw plugin with the same authenticated
tool and profile contracts.

## License

Copyright 2026 Thomas Flynn.

Licensed under the [Apache License, Version 2.0](LICENSE).
