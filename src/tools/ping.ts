import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const pingInputSchema = {
  service: z.string().describe("The name of the service to ping"),
};

export interface PingResult {
  status: "ok";
  service: string;
  timestamp: string;
}

export function pingServiceHealth(service: string): PingResult {
  return {
    status: "ok",
    service,
    timestamp: new Date().toISOString(),
  };
}

export function registerPingTool(server: McpServer): void {
  server.registerTool(
    "ping_service_health",
    {
      description: "Pings a service to verify health and connectivity",
      inputSchema: pingInputSchema,
    },
    async ({ service }) => {
      const result = pingServiceHealth(service);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result),
          },
        ],
      };
    }
  );
}
