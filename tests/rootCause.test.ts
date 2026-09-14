import { describe, it, expect } from "vitest";
import { tarjanSCC, condenseGraph } from "../src/core/graph.js";
import { findRootCause } from "../src/core/rootCause.js";
import { analyzeIncident } from "../src/tools/analyzeIncident.js";

describe("Phase 5: Causal Dependency Graph / Root Cause", () => {
  // Case 1: No-cycle case: 3-node chain, alerts fire out of order in time
  it("Case 1: No-cycle chain with out-of-order alert timestamps correctly identifies upstream root", () => {
    const nodes = ["serviceA", "serviceB", "serviceC"];
    const edges = [
      { from: "serviceA", to: "serviceB" },
      { from: "serviceB", to: "serviceC" },
    ];

    // Out of order: serviceC alerts first, serviceA alerts last
    const alerts = [
      { node: "serviceC", timestamp: 1000 },
      { node: "serviceB", timestamp: 1020 },
      { node: "serviceA", timestamp: 1050 },
    ];

    const sccs = tarjanSCC(nodes, edges);
    // In acyclic graph, every SCC is a singleton
    expect(sccs).toHaveLength(3);

    const condensed = condenseGraph(nodes, edges, sccs);
    // Structural no-op on acyclic graphs
    expect(condensed.nodes).toHaveLength(3);
    expect(condensed.edges).toHaveLength(2);

    const result = findRootCause(condensed, alerts);

    expect(result.rootCause).toBe("serviceA");
    expect(result.rootCauses).toEqual(["serviceA"]);
    expect(result.symptoms).toEqual(["serviceC", "serviceB"]);
    expect(result.possibleMultipleCauses).toBe(false);
    expect(result.explanation).toContain('Primary root cause identified: "serviceA"');
  });

  // Case 2: Cycle case: graph with artificial cycle among some nodes
  it("Case 2: Graph with cycle terminates promptly, condenses correctly, and produces a sane root cause", () => {
    const startTime = performance.now();

    // Cycle between cycle1 <-> cycle2 <-> cycle3, with downstream serviceD
    const nodes = ["cycle1", "cycle2", "cycle3", "serviceD"];
    const edges = [
      { from: "cycle1", to: "cycle2" },
      { from: "cycle2", to: "cycle3" },
      { from: "cycle3", to: "cycle1" },
      { from: "cycle3", to: "serviceD" },
    ];

    const alerts = [
      { node: "cycle2", timestamp: 1010 },
      { node: "cycle1", timestamp: 1030 },
      { node: "serviceD", timestamp: 1050 },
    ];

    const sccs = tarjanSCC(nodes, edges);
    // Tarjan's condenses the 3-node cycle into 1 SCC, plus 1 singleton for serviceD
    expect(sccs).toHaveLength(2);
    const multiNodeSCC = sccs.find((s) => s.length === 3);
    expect(multiNodeSCC).toBeDefined();
    expect(multiNodeSCC?.sort()).toEqual(["cycle1", "cycle2", "cycle3"]);

    const condensed = condenseGraph(nodes, edges, sccs);
    // 2 super-nodes in condensed DAG
    expect(condensed.nodes).toHaveLength(2);
    expect(condensed.edges).toHaveLength(1);
    expect(condensed.edges[0]).toEqual({
      from: "cycle1+cycle2+cycle3",
      to: "serviceD",
    });

    // Traversal must terminate without infinite looping
    const result = findRootCause(condensed, alerts);
    const durationMs = performance.now() - startTime;

    // Explicit confirmation: test did not hang and finished in < 50ms
    expect(durationMs).toBeLessThan(50);
    expect(result.rootCause).toBe("cycle2");
    expect(result.rootCauses).toEqual(["cycle2"]);
    expect(result.symptoms).toEqual(["cycle1", "serviceD"]);
    expect(result.possibleMultipleCauses).toBe(false);
  });

  // Case 3: Missing-alert case (known limitation)
  it("Case 3: Missing-alert case identifies earliest observable upstream ancestor (known v1 limitation)", () => {
    // True root node "gateway" never alerts; only downstream nodes alert
    const nodes = ["gateway", "apiService", "database"];
    const edges = [
      { from: "gateway", to: "apiService" },
      { from: "apiService", to: "database" },
    ];

    const alerts = [
      { node: "database", timestamp: 1000 },
      { node: "apiService", timestamp: 1020 },
    ];

    const sccs = tarjanSCC(nodes, edges);
    const condensed = condenseGraph(nodes, edges, sccs);
    const result = findRootCause(condensed, alerts);

    // Known limitation: because gateway never alerted, apiService is identified as earliest observable root
    expect(result.rootCause).toBe("apiService");
    expect(result.rootCauses).toEqual(["apiService"]);
    expect(result.symptoms).toEqual(["database"]);
    expect(result.possibleMultipleCauses).toBe(false);
  });

  // Case 4: Multiple independent roots case
  it("Case 4: Multiple independent roots detected without ancestral relationship (possibleMultipleCauses = true)", () => {
    // Two parallel root databases feeding their respective services, then converging on webApp
    const nodes = ["authDb", "authService", "paymentDb", "paymentService", "webApp"];
    const edges = [
      { from: "authDb", to: "authService" },
      { from: "authService", to: "webApp" },
      { from: "paymentDb", to: "paymentService" },
      { from: "paymentService", to: "webApp" },
    ];

    const alerts = [
      { node: "authDb", timestamp: 1000 },
      { node: "authService", timestamp: 1050 },
      { node: "paymentDb", timestamp: 1020 },
      { node: "paymentService", timestamp: 1070 },
      { node: "webApp", timestamp: 1100 },
    ];

    const sccs = tarjanSCC(nodes, edges);
    const condensed = condenseGraph(nodes, edges, sccs);
    const result = findRootCause(condensed, alerts);

    expect(result.possibleMultipleCauses).toBe(true);
    expect(result.rootCauses).toHaveLength(2);
    expect(result.rootCauses).toContain("authDb");
    expect(result.rootCauses).toContain("paymentDb");
    expect(Array.isArray(result.rootCause)).toBe(true);
    expect(result.symptoms).toEqual(["authService", "paymentService", "webApp"]);
    expect(result.explanation).toContain("Multiple independent root causes identified: [authDb, paymentDb]");
  });

  // Tool integration: analyze_network on hichat workspace
  it("Tool Integration: analyzeIncident loads hichat workspace and identifies root cause", () => {
    // hichat topology: hichat-web -> alb -> ecs-task -> redis / postgres
    const alerts = [
      { node: "alb", timestamp: 1020 },
      { node: "ecs-task", timestamp: 1040 },
      { node: "hichat-web", timestamp: 1060 },
      { node: "redis", timestamp: 1080 },
    ];

    const result = analyzeIncident("hichat", alerts);
    expect(result.workspace).toBe("hichat");
    expect(result.rootCause).toBe("hichat-web");
    expect(result.symptoms).toEqual(["alb", "ecs-task", "redis"]);
    expect(result.possibleMultipleCauses).toBe(false);
  });
});
