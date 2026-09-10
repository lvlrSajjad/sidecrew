// `sidecrew mcp` — stdio MCP server. Tools wired in Phase 4:
// sidecrew_status, sidecrew_generate, sidecrew_verify, sidecrew_run_batch, sidecrew_plan_validate
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

export async function runMcp(): Promise<void> {
  const server = new McpServer({ name: "sidecrew", version: "0.0.1" });
  server.tool("sidecrew_status", "Is the local worker up, which model, free RAM, verifier tools present.", async () => ({
    content: [{ type: "text", text: JSON.stringify({ implemented: false, phase: 4 }) }],
  }));
  await server.connect(new StdioServerTransport());
}
