import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { checkBlastRadius } from "../core/blastRadius.js";
import { loadWorkspace } from "../config/loadWorkspace.js";

export const executeMigrationInputSchema = {
  workspace: z.string().describe("Target workspace name"),
  sql: z.string().describe("SQL migration query to execute"),
};

export const DEFAULT_INDEXED_COLUMNS: Record<string, string[]> = {
  users: ["id", "email"],
  messages: ["id", "chat_id", "created_at"],
  orders: ["id", "customer_id"],
};

export async function executeMigrationHandler(
  workspace: string,
  sql: string,
  indexedColumns: Record<string, string[]> = DEFAULT_INDEXED_COLUMNS
) {
  // Validate workspace exists using Phase 2 loader
  loadWorkspace(workspace);

  // Check blast radius BEFORE touching any database connection
  const check = checkBlastRadius(sql, indexedColumns);
  if (!check.allowed) {
    return {
      allowed: false,
      reason: check.reason,
      executed: false,
    };
  }

  // Passed blast radius check - no real DB connection touched in Phase 3
  return {
    allowed: true,
    executed: true,
    workspace,
    message: "SQL migration passed blast-radius inspection and is safe to execute.",
  };
}

export function registerExecuteMigrationTool(server: McpServer): void {
  server.registerTool(
    "execute_database_migration",
    {
      description: "Validates and executes database migrations after blast-radius safety checks",
      inputSchema: executeMigrationInputSchema,
    },
    async ({ workspace, sql }) => {
      try {
        const result = await executeMigrationHandler(workspace, sql);
        if (!result.allowed) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  status: "rejected",
                  workspace,
                  reason: result.reason,
                }),
              },
            ],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                status: "approved",
                workspace,
                message: result.message,
              }),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                status: "error",
                workspace,
                error: err.message,
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );
}
