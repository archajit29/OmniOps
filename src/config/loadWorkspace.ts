import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const EdgeSchema = z.object({
  from: z.string().min(1, "Source node name cannot be empty"),
  to: z.string().min(1, "Target node name cannot be empty"),
});

export const TopologySchema = z
  .object({
    nodes: z.array(z.string().min(1, "Node name cannot be empty")),
    edges: z.array(EdgeSchema),
  })
  .superRefine((topology, ctx) => {
    // Enforce uniqueness of node names
    const seenNodes = new Set<string>();
    for (let i = 0; i < topology.nodes.length; i++) {
      const node = topology.nodes[i];
      if (seenNodes.has(node)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate node name detected in topology: "${node}"`,
          path: ["nodes", i],
        });
      }
      seenNodes.add(node);
    }

    // Enforce no dangling edge references
    const declaredNodes = new Set(topology.nodes);
    for (let i = 0; i < topology.edges.length; i++) {
      const edge = topology.edges[i];
      if (!declaredNodes.has(edge.from)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Edge references undeclared source node "${edge.from}"`,
          path: ["edges", i, "from"],
        });
      }
      if (!declaredNodes.has(edge.to)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Edge references undeclared target node "${edge.to}"`,
          path: ["edges", i, "to"],
        });
      }
    }
  });

export const WorkspaceSchema = z.object({
  db_url_env: z.string().min(1, "db_url_env must be a non-empty string"),
  topology: TopologySchema,
});

export const WorkspacesFileSchema = z.object({
  workspaces: z.record(z.string(), WorkspaceSchema),
});

export type TopologyEdge = z.infer<typeof EdgeSchema>;
export type Topology = z.infer<typeof TopologySchema>;
export type WorkspaceConfig = z.infer<typeof WorkspaceSchema>;
export type WorkspacesFile = z.infer<typeof WorkspacesFileSchema>;

export class WorkspaceConfigError extends Error {
  public issues?: z.ZodIssue[];

  constructor(message: string, issues?: z.ZodIssue[]) {
    super(message);
    this.name = "WorkspaceConfigError";
    this.issues = issues;
  }
}

export function getDefaultWorkspacesFilePath(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const candidateFromModule = resolve(currentDir, "../../config/workspaces.json");
  if (existsSync(candidateFromModule)) {
    return candidateFromModule;
  }
  return resolve(process.cwd(), "config/workspaces.json");
}

export function parseWorkspaces(raw: unknown): WorkspacesFile {
  const result = WorkspacesFileSchema.safeParse(raw);
  if (!result.success) {
    const errorDetails = result.error.issues
      .map((issue) => {
        const pathSuffix = issue.path.length > 0 ? ` at [${issue.path.join(".")}]` : "";
        return `${issue.message}${pathSuffix}`;
      })
      .join("; ");
    throw new WorkspaceConfigError(
      `Workspace configuration validation failed: ${errorDetails}`,
      result.error.issues
    );
  }
  return result.data;
}

export function loadAllWorkspaces(filePath?: string): Record<string, WorkspaceConfig> {
  const targetPath = filePath ?? getDefaultWorkspacesFilePath();
  if (!existsSync(targetPath)) {
    throw new WorkspaceConfigError(`Workspace configuration file not found at: ${targetPath}`);
  }

  let rawContent: string;
  try {
    rawContent = readFileSync(targetPath, "utf-8");
  } catch (err: any) {
    throw new WorkspaceConfigError(`Failed to read workspace config file at "${targetPath}": ${err.message}`);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawContent);
  } catch (err: any) {
    throw new WorkspaceConfigError(`Invalid JSON in workspace config file at "${targetPath}": ${err.message}`);
  }

  const validated = parseWorkspaces(parsedJson);
  return validated.workspaces;
}

export function loadWorkspace(workspaceName: string, filePath?: string): WorkspaceConfig {
  const workspaces = loadAllWorkspaces(filePath);
  const config = workspaces[workspaceName];
  if (!config) {
    const available = Object.keys(workspaces).join(", ");
    throw new WorkspaceConfigError(
      `Workspace "${workspaceName}" not found in configuration. Available workspaces: [${available}]`
    );
  }
  return config;
}
