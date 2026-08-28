// The workspace build re-exports the implementation so native integrations
// and local tests exercise one MCP surface. The published package build
// bundles the native MCP session implementation into dist.
export {
  createMeshrMcpServer,
  createMeshrMcpServerSession,
  serveBindingFromState,
  serveMeshrMcpOverStdio,
} from "../../connector/mcp.ts";
export type { MeshrMcpServerSession } from "../../connector/mcp.ts";
