import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { registerPingTool } from "../tools/ping.js";
import { registerExecuteMigrationTool } from "../tools/executeMigration.js";
import { registerRemediationTools } from "../tools/remediation.js";
import { registerAnalyzeIncidentTool } from "../tools/analyzeIncident.js";

export const server = new McpServer({
  name: "omniops",
  version: "1.0.0",
});

// Register tools
registerPingTool(server);
registerExecuteMigrationTool(server);
registerRemediationTools(server);
registerAnalyzeIncidentTool(server);

export async function startServer(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("OmniOps MCP server running on stdio");
}

const isDirectRun =
  Boolean(process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url));

if (isDirectRun) {
  startServer().catch((error) => {
    console.error("Fatal error starting OmniOps MCP server:", error);
    process.exit(1);
  });
}
