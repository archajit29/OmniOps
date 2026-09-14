import { describe, it, expect } from "vitest";
import { writeFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import {
  loadWorkspace,
  loadAllWorkspaces,
  parseWorkspaces,
  WorkspaceConfigError,
} from "../src/config/loadWorkspace.js";

describe("Phase 2: Workspace & Topology Config Loader", () => {
  it("loads valid workspaces.json and retrieves the 'hichat' workspace", () => {
    const config = loadWorkspace("hichat");
    expect(config).toBeDefined();
    expect(config.db_url_env).toBe("HICHAT_DB_URL");
    expect(config.topology.nodes).toEqual([
      "hichat-web",
      "alb",
      "ecs-task",
      "redis",
      "postgres",
    ]);
    expect(config.topology.edges).toHaveLength(4);
    expect(config.topology.edges).toEqual([
      { from: "hichat-web", to: "alb" },
      { from: "alb", to: "ecs-task" },
      { from: "ecs-task", to: "redis" },
      { from: "ecs-task", to: "postgres" },
    ]);
  });

  it("throws a clear, specific error when an edge references an undeclared node (negative test 1)", () => {
    const invalidConfig = {
      workspaces: {
        badApp: {
          db_url_env: "BAD_APP_DB_URL",
          topology: {
            nodes: ["service-a", "service-b"],
            edges: [
              { from: "service-a", to: "ghost-node" },
            ],
          },
        },
      },
    };

    expect(() => parseWorkspaces(invalidConfig)).toThrowError(WorkspaceConfigError);

    try {
      parseWorkspaces(invalidConfig);
      expect.fail("Should have thrown WorkspaceConfigError");
    } catch (err: any) {
      expect(err).toBeInstanceOf(WorkspaceConfigError);
      expect(err.message).toContain('Edge references undeclared target node "ghost-node"');
      expect(err.message).not.toContain("[object Object]");
    }
  });

  it("throws a clear, specific error when an edge has an undeclared source node", () => {
    const invalidConfig = {
      workspaces: {
        badApp: {
          db_url_env: "BAD_APP_DB_URL",
          topology: {
            nodes: ["service-b"],
            edges: [
              { from: "ghost-sender", to: "service-b" },
            ],
          },
        },
      },
    };

    try {
      parseWorkspaces(invalidConfig);
      expect.fail("Should have thrown WorkspaceConfigError");
    } catch (err: any) {
      expect(err).toBeInstanceOf(WorkspaceConfigError);
      expect(err.message).toContain('Edge references undeclared source node "ghost-sender"');
    }
  });

  it("throws a clear, specific error when duplicate node names exist in topology (negative test 2)", () => {
    const duplicateNodesConfig = {
      workspaces: {
        badApp: {
          db_url_env: "BAD_APP_DB_URL",
          topology: {
            nodes: ["web", "cache", "web"],
            edges: [{ from: "web", to: "cache" }],
          },
        },
      },
    };

    expect(() => parseWorkspaces(duplicateNodesConfig)).toThrowError(WorkspaceConfigError);

    try {
      parseWorkspaces(duplicateNodesConfig);
      expect.fail("Should have thrown WorkspaceConfigError");
    } catch (err: any) {
      expect(err).toBeInstanceOf(WorkspaceConfigError);
      expect(err.message).toContain('Duplicate node name detected in topology: "web"');
    }
  });

  it("throws a clear error when requested workspace does not exist", () => {
    expect(() => loadWorkspace("nonexistent-app")).toThrowError(WorkspaceConfigError);

    try {
      loadWorkspace("nonexistent-app");
      expect.fail("Should have thrown WorkspaceConfigError");
    } catch (err: any) {
      expect(err).toBeInstanceOf(WorkspaceConfigError);
      expect(err.message).toContain('Workspace "nonexistent-app" not found in configuration');
      expect(err.message).toContain("hichat");
    }
  });

  it("loads a temp config file containing an undeclared node via loadWorkspace and rejects with clear error", () => {
    const tempConfigPath = resolve(process.cwd(), "config/test-invalid-workspaces.json");
    const invalidContent = JSON.stringify({
      workspaces: {
        brokenApp: {
          db_url_env: "BROKEN_DB_URL",
          topology: {
            nodes: ["api", "db"],
            edges: [{ from: "api", to: "unknown-queue" }],
          },
        },
      },
    });

    writeFileSync(tempConfigPath, invalidContent, "utf-8");
    try {
      expect(() => loadWorkspace("brokenApp", tempConfigPath)).toThrowError(WorkspaceConfigError);
      try {
        loadWorkspace("brokenApp", tempConfigPath);
      } catch (err: any) {
        expect(err.message).toContain('Edge references undeclared target node "unknown-queue"');
      }
    } finally {
      unlinkSync(tempConfigPath);
    }
  });
});
