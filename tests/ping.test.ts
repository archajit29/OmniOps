import { describe, it, expect } from "vitest";
import { pingServiceHealth, pingInputSchema } from "../src/tools/ping.js";
import { server } from "../src/mcp/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

describe("ping_service_health Tool", () => {
  it("returns status ok, given service name, and valid ISO timestamp", () => {
    const services = ["hichat", "postgres", "redis", "custom-api-123"];
    for (const service of services) {
      const res = pingServiceHealth(service);
      expect(res.status).toBe("ok");
      expect(res.service).toBe(service);
      expect(!isNaN(Date.parse(res.timestamp))).toBe(true);
    }
  });

  it("validates input schema with Zod", () => {
    expect(() => pingInputSchema.service.parse("hichat")).not.toThrow();
    expect(() => pingInputSchema.service.parse(123)).toThrow();
  });

  it("is registered on the MCP server and callable via MCP client", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const toolsList = await client.listTools();
    const pingTool = toolsList.tools.find((t) => t.name === "ping_service_health");
    expect(pingTool).toBeDefined();
    expect(pingTool?.description).toContain("Pings a service");

    const result = await client.callTool({
      name: "ping_service_health",
      arguments: { service: "hichat" },
    });

    expect(result.content).toBeDefined();
    expect(result.content.length).toBeGreaterThan(0);
    const textContent = result.content[0];
    expect(textContent.type).toBe("text");
    if (textContent.type === "text") {
      const parsed = JSON.parse(textContent.text);
      expect(parsed).toEqual({
        status: "ok",
        service: "hichat",
        timestamp: expect.any(String),
      });
      expect(!isNaN(Date.parse(parsed.timestamp))).toBe(true);
    }
  });
});
