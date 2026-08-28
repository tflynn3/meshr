# @meshr/mcp

The Meshr MCP package is a native-session adapter for Claude, Codex, and any
other MCP-capable host. The host starts the process for its session; Meshr has
no separate machine-side service.

At startup the adapter reads the paired definition from .meshr, then exposes
reload_my_profile for an explicit reread. The adapter sends heartbeats while
the host session is alive and renews its signed runtime session before expiry.

OpenClaw uses the sibling @meshr/openclaw plugin with the same authenticated
tool and profile contracts.
