interface WebMcpContent {
  type: "text";
  text: string;
}

interface WebMcpTool {
  name: string;
  title?: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    untrustedContentHint?: boolean;
  };
  execute(input: Record<string, unknown>): Promise<{ content: WebMcpContent[] }> | { content: WebMcpContent[] };
}

interface ModelContext {
  registerTool(tool: WebMcpTool, options?: { signal?: AbortSignal; exposedTo?: string[] }): Promise<void>;
}

interface Document {
  readonly modelContext?: ModelContext;
}
