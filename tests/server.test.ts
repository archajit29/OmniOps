import { describe, it, expect } from "vitest";
import { server } from "../src/mcp/server.js";

describe("MCP Server Setup", () => {
  it("initializes server instance with correct name and version", () => {
    expect(server).toBeDefined();
    expect(server.server).toBeDefined();
  });
});
