import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  stageIntent,
  commitIntent,
  InMemoryRedisBackend,
  type RemediationPayload,
} from "../core/remediation.js";
import { loadWorkspace } from "../config/loadWorkspace.js";

// In-Memory mock Redis backend for safe local sandboxing
export const defaultRedisBackend = new InMemoryRedisBackend();

// Seed initial sample keys in cache:sessions namespace
defaultRedisBackend.set(
  "cache:sessions:sess_001",
  JSON.stringify({ userId: "u123", role: "admin" })
);
defaultRedisBackend.set(
  "cache:sessions:sess_002",
  JSON.stringify({ userId: "u456", role: "user" })
);

export const stageIntentInputSchema = {
  workspace: z.string().describe("Target workspace"),
  actionType: z
    .enum(["redis_flush_namespace"])
    .describe("Remediation action type"),
  target: z.string().describe("Target namespace (e.g. cache:sessions)"),
};

export const commitIntentInputSchema = {
  workspace: z.string().describe("Target workspace"),
  payload: z
    .object({
      action: z.object({
        type: z.string(),
        target: z.string(),
        parameters: z.record(z.string(), z.unknown()).optional(),
      }),
      stateSnapshot: z.string(),
      expiresAt: z.number(),
    })
    .describe("Staged intent payload"),
  signature: z.string().describe("HMAC-SHA256 signature"),
};

export function registerRemediationTools(
  server: McpServer,
  backend: InMemoryRedisBackend = defaultRedisBackend
): void {
  // Tool 1: stage_remediation_intent
  server.registerTool(
    "stage_remediation_intent",
    {
      description:
        "Stages a destructive remediation intent and returns a cryptographic HMAC-signed payload",
      inputSchema: stageIntentInputSchema,
    },
    async ({ workspace, actionType, target }) => {
      try {
        loadWorkspace(workspace);

        const currentState = backend.getStateSnapshot(target);
        const staged = stageIntent({ type: actionType, target }, currentState);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                status: "staged",
                workspace,
                payload: staged.payload,
                signature: staged.signature,
                expiresAt: new Date(staged.expiresAt).toISOString(),
                stateSummary: {
                  target,
                  keyCount: currentState.keyCount,
                },
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

  // Tool 2: commit_remediation
  server.registerTool(
    "commit_remediation",
    {
      description:
        "Verifies HMAC signature and live state snapshot, then commits the destructive action",
      inputSchema: commitIntentInputSchema,
    },
    async ({ workspace, payload, signature }) => {
      try {
        loadWorkspace(workspace);

        const target = payload.action.target;
        const liveState = backend.getStateSnapshot(target);

        const commitResult = commitIntent(
          payload as RemediationPayload,
          signature,
          liveState,
          (action) => {
            if (action.type === "redis_flush_namespace") {
              backend.flushNamespace(action.target);
            }
          }
        );

        if (!commitResult.executed) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  status: "rejected",
                  workspace,
                  reason: commitResult.reason,
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
                status: "executed",
                workspace,
                action: commitResult.action,
                executedAt: commitResult.executedAt,
                message: `Successfully executed destructive remediation on ${target}`,
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
