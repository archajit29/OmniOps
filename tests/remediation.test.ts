import { describe, it, expect, beforeEach } from "vitest";
import {
  stageIntent,
  commitIntent,
  hashState,
  signPayload,
  InMemoryRedisBackend,
  type RemediationAction,
} from "../src/core/remediation.js";

describe("Phase 4: Two-Phase Dry-Run Commit (HMAC-Signed)", () => {
  let backend: InMemoryRedisBackend;
  const testSecret = "test-remediation-secret-42";
  const namespace = "cache:sessions";
  const action: RemediationAction = {
    type: "redis_flush_namespace",
    target: namespace,
  };

  beforeEach(() => {
    backend = new InMemoryRedisBackend();
    backend.set("cache:sessions:u1", JSON.stringify({ user: "alice", token: "tok_1" }));
    backend.set("cache:sessions:u2", JSON.stringify({ user: "bob", token: "tok_2" }));
  });

  // Test 1: Valid stage -> commit within expiry -> executes
  it("Test 1: Valid stage -> commit within expiry -> executes successfully", () => {
    const currentState = backend.getStateSnapshot(namespace);
    expect(currentState.keyCount).toBe(2);

    const staged = stageIntent(action, currentState, 300_000, testSecret);

    expect(staged.payload.action).toEqual(action);
    expect(staged.payload.stateSnapshot).toBe(hashState(currentState));
    expect(staged.signature).toBeDefined();
    expect(typeof staged.signature).toBe("string");
    expect(staged.expiresAt).toBeGreaterThan(Date.now());

    let wasExecuted = false;
    const commitResult = commitIntent(
      staged.payload,
      staged.signature,
      backend.getStateSnapshot(namespace),
      (act) => {
        wasExecuted = true;
        backend.flushNamespace(act.target);
      },
      testSecret
    );

    expect(commitResult.executed).toBe(true);
    expect(commitResult.reason).toBeUndefined();
    expect(wasExecuted).toBe(true);
    // Keys were flushed
    expect(backend.getKeysByNamespace(namespace)).toHaveLength(0);
  });

  // Test 2: Commit after expiry -> rejected
  it("Test 2: Commit after expiry -> rejected", () => {
    const currentState = backend.getStateSnapshot(namespace);

    // Staged with negative TTL (already expired)
    const staged = stageIntent(action, currentState, -1000, testSecret);

    let wasExecuted = false;
    const commitResult = commitIntent(
      staged.payload,
      staged.signature,
      backend.getStateSnapshot(namespace),
      () => {
        wasExecuted = true;
      },
      testSecret
    );

    expect(commitResult.executed).toBe(false);
    expect(commitResult.reason).toBe("REMEDIATION_REJECTED: intent expired");
    expect(wasExecuted).toBe(false);
    // State remains untouched
    expect(backend.getKeysByNamespace(namespace)).toHaveLength(2);
  });

  // Test 3: Commit with tampered signature -> rejected
  it("Test 3: Commit with tampered signature -> rejected", () => {
    const currentState = backend.getStateSnapshot(namespace);
    const staged = stageIntent(action, currentState, 300_000, testSecret);

    // Tamper with signature
    const tamperedSig = staged.signature.replace(/^[0-9a-f]{8}/, "deadbeef");

    let wasExecuted = false;
    const resultTamperedSig = commitIntent(
      staged.payload,
      tamperedSig,
      backend.getStateSnapshot(namespace),
      () => {
        wasExecuted = true;
      },
      testSecret
    );

    expect(resultTamperedSig.executed).toBe(false);
    expect(resultTamperedSig.reason).toBe(
      "REMEDIATION_REJECTED: invalid or tampered signature"
    );
    expect(wasExecuted).toBe(false);

    // Also verify payload tampering (e.g. target namespace altered from cache:sessions to cache:system)
    const tamperedPayload = {
      ...staged.payload,
      action: {
        ...staged.payload.action,
        target: "cache:system",
      },
    };

    const resultTamperedPayload = commitIntent(
      tamperedPayload,
      staged.signature,
      backend.getStateSnapshot(namespace),
      () => {
        wasExecuted = true;
      },
      testSecret
    );

    expect(resultTamperedPayload.executed).toBe(false);
    expect(resultTamperedPayload.reason).toBe(
      "REMEDIATION_REJECTED: invalid or tampered signature"
    );
    expect(wasExecuted).toBe(false);
  });

  // Test 4: Commit where live state drifted from staged snapshot -> rejected
  it("Test 4: Commit where live state drifted from staged snapshot -> rejected (State Drift Protection)", () => {
    // 1. Initial State A: 2 keys present
    const stagedStateA = backend.getStateSnapshot(namespace);
    expect(stagedStateA.keyCount).toBe(2);
    expect(stagedStateA.keys).toEqual(["cache:sessions:u1", "cache:sessions:u2"]);

    // 2. Stage intent on State A
    const staged = stageIntent(action, stagedStateA, 300_000, testSecret);

    // 3. State drift occurs: A concurrent request or racing command writes a new session
    backend.set("cache:sessions:u3", JSON.stringify({ user: "charlie", token: "tok_3" }));

    // 4. Live State B now has 3 keys
    const driftedLiveStateB = backend.getStateSnapshot(namespace);
    expect(driftedLiveStateB.keyCount).toBe(3);
    expect(driftedLiveStateB.keys).toEqual([
      "cache:sessions:u1",
      "cache:sessions:u2",
      "cache:sessions:u3",
    ]);
    expect(hashState(driftedLiveStateB)).not.toBe(hashState(stagedStateA));

    // 5. Attempt to commit staged intent against drifted live state
    let wasExecuted = false;
    const commitResult = commitIntent(
      staged.payload,
      staged.signature,
      driftedLiveStateB,
      (act) => {
        wasExecuted = true;
        backend.flushNamespace(act.target);
      },
      testSecret
    );

    expect(commitResult.executed).toBe(false);
    expect(commitResult.reason).toContain("live state drifted from staged snapshot");
    expect(commitResult.reason).toContain("state drift detected");
    expect(wasExecuted).toBe(false);

    // Destructive flush was prevented: all 3 keys are preserved
    expect(backend.getKeysByNamespace(namespace)).toHaveLength(3);
  });
});

describe("MCP Tools: stage_remediation_intent & commit_remediation", () => {
  it("allows staging and committing remediation through the tool pipeline", async () => {
    const { server } = await import("../src/mcp/server.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    // 1. Verify tools are listed
    const tools = await client.listTools();
    expect(tools.tools.find((t) => t.name === "stage_remediation_intent")).toBeDefined();
    expect(tools.tools.find((t) => t.name === "commit_remediation")).toBeDefined();

    // 2. Stage intent via MCP tool
    const stageRes = await client.callTool({
      name: "stage_remediation_intent",
      arguments: {
        workspace: "hichat",
        actionType: "redis_flush_namespace",
        target: "cache:sessions",
      },
    });

    const stageContent = JSON.parse((stageRes.content as any)[0].text);
    expect(stageContent.status).toBe("staged");
    expect(stageContent.signature).toBeDefined();
    expect(stageContent.payload).toBeDefined();

    // 3. Commit intent via MCP tool
    const commitRes = await client.callTool({
      name: "commit_remediation",
      arguments: {
        workspace: "hichat",
        payload: stageContent.payload,
        signature: stageContent.signature,
      },
    });

    const commitContent = JSON.parse((commitRes.content as any)[0].text);
    expect(commitContent.status).toBe("executed");
    expect(commitContent.message).toContain("Successfully executed destructive remediation");
  });
});
