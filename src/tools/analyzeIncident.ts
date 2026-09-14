import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadWorkspace } from "../config/loadWorkspace.js";
import { tarjanSCC, condenseGraph } from "../core/graph.js";
import { findRootCause, type Alert } from "../core/rootCause.js";

export const alertSchema = z.object({
  node: z.string().describe("Alerting node identifier"),
  timestamp: z.number().describe("Alert timestamp in epoch milliseconds"),
});

export const analyzeNetworkInputSchema = {
  workspace: z.string().describe("Target workspace name"),
  alerts: z.array(alertSchema).describe("List of firing alert events"),
};

export function analyzeIncident(workspace: string, alerts: Alert[]) {
  // Load workspace topology via Phase 2 config loader
  const config = loadWorkspace(workspace);
  const { nodes, edges } = config.topology;

  // Run full causal analysis pipeline: Tarjan SCC -> Condense -> Root Cause
  const sccs = tarjanSCC(nodes, edges);
  const condensed = condenseGraph(nodes, edges, sccs);
  const result = findRootCause(condensed, alerts);

  return {
    workspace,
    ...result,
  };
}

export function registerAnalyzeIncidentTool(server: McpServer): void {
  server.registerTool(
    "analyze_network",
    {
      description:
        "Analyzes cascading incidents across workspace topology using Tarjan SCC and reverse causal traversal",
      inputSchema: analyzeNetworkInputSchema,
    },
    async ({ workspace, alerts }) => {
      try {
        const analysis = analyzeIncident(workspace, alerts);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "success",
                  workspace: analysis.workspace,
                  rootCause: analysis.rootCause,
                  symptoms: analysis.symptoms,
                  possibleMultipleCauses: analysis.possibleMultipleCauses,
                  explanation: analysis.explanation,
                },
                null,
                2
              ),
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
