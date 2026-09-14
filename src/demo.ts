import { checkBlastRadius } from "./core/blastRadius.js";
import {
  InMemoryRedisBackend,
  stageIntent,
  commitIntent,
} from "./core/remediation.js";
import { analyzeIncident } from "./tools/analyzeIncident.js";
import { DEFAULT_INDEXED_COLUMNS } from "./tools/executeMigration.js";

async function runDemo() {
  console.log("================================================================================");
  console.log("                       OMNIOPS LIVE END-TO-END DEMO                           ");
  console.log("================================================================================\n");

  // ---------------------------------------------------------------------------
  // FLOW 1: AST SQL Blast-Radius Engine (Phase 3)
  // ---------------------------------------------------------------------------
  console.log("--- FLOW 1: AST SQL Blast-Radius Engine ---");
  console.log("Testing safety rules against incoming SQL queries before any DB is touched:\n");

  const queries = [
    { name: "Destructive DROP TABLE", sql: "DROP TABLE users;" },
    { name: "Unindexed DELETE", sql: "DELETE FROM users WHERE name = 'bob';" },
    { name: "Tautological WHERE 1=1", sql: "DELETE FROM users WHERE 1=1;" },
    { name: "Safe Indexed UPDATE", sql: "UPDATE users SET email = 'alice@example.com' WHERE id = 1;" },
  ];

  for (const q of queries) {
    console.log(`[QUERY] ${q.name}: "${q.sql}"`);
    const check = checkBlastRadius(q.sql, DEFAULT_INDEXED_COLUMNS);
    if (check.allowed) {
      console.log(`  -> RESULT: APPROVED (Safe to execute)\n`);
    } else {
      console.log(`  -> RESULT: REJECTED`);
      console.log(`     Reason: "${check.reason}"\n`);
    }
  }

  // ---------------------------------------------------------------------------
  // FLOW 2: Two-Phase Dry-Run Commit with HMAC Signature & State Drift (Phase 4)
  // ---------------------------------------------------------------------------
  console.log("--------------------------------------------------------------------------------");
  console.log("--- FLOW 2: Two-Phase Dry-Run Commit & State-Drift Protection ---");
  console.log("Testing cryptographic intent staging, execution, and state-drift rejection:\n");

  const backend = new InMemoryRedisBackend();
  const namespace = "cache:sessions";
  backend.set("cache:sessions:sess_001", JSON.stringify({ userId: "u123", role: "admin" }));
  backend.set("cache:sessions:sess_002", JSON.stringify({ userId: "u456", role: "user" }));

  // Step 2.1: Stage Intent
  const stateA = backend.getStateSnapshot(namespace);
  console.log("[STAGE 1] Staging intent to flush namespace:", namespace);
  console.log("  Initial Live State A:", {
    keyCount: stateA.keyCount,
    keys: stateA.keys,
    digest: stateA.digest.slice(0, 16) + "...",
  });

  const staged = stageIntent(
    { type: "redis_flush_namespace", target: namespace },
    stateA
  );

  console.log("  Generated Staged Payload:", {
    action: staged.payload.action,
    stateSnapshot: staged.payload.stateSnapshot.slice(0, 16) + "...",
    expiresAt: new Date(staged.expiresAt).toISOString(),
  });
  console.log("  HMAC-SHA256 Signature:", staged.signature.slice(0, 24) + "...\n");

  // Step 2.2: Commit Intent (Valid, untouched state)
  console.log("[COMMIT 1] Committing intent with valid signature and matching live state...");
  const commit1 = commitIntent(
    staged.payload,
    staged.signature,
    backend.getStateSnapshot(namespace),
    (action) => {
      backend.flushNamespace(action.target);
    }
  );
  console.log("  Commit 1 Executed?", commit1.executed);
  console.log("  Action executed on target:", commit1.action?.target);
  console.log("  Namespace state after flush: keyCount =", backend.getKeysByNamespace(namespace).length, "\n");

  // Step 2.3: Demonstrate State Drift Rejection (Replay / Racing drift)
  console.log("[COMMIT 2] Replay/Race condition: re-attempting commit using the old staged payload...");
  const commit2 = commitIntent(
    staged.payload,
    staged.signature,
    backend.getStateSnapshot(namespace),
    (action) => {
      backend.flushNamespace(action.target);
    }
  );
  console.log("  Commit 2 Executed?", commit2.executed);
  console.log("  Rejection Reason:", commit2.reason);

  // Step 2.4: Demonstrate Racing Mutation State Drift
  console.log("\n[STATE DRIFT DEMO] Simulating concurrent mutation before commit:");
  backend.set("cache:sessions:sess_new", JSON.stringify({ userId: "u789" }));
  const stageNew = stageIntent({ type: "redis_flush_namespace", target: namespace }, backend.getStateSnapshot(namespace));
  // Racing insert happens here
  backend.set("cache:sessions:sess_racing", JSON.stringify({ userId: "u999" }));
  const commitDrift = commitIntent(
    stageNew.payload,
    stageNew.signature,
    backend.getStateSnapshot(namespace),
    (action) => {
      backend.flushNamespace(action.target);
    }
  );
  console.log("  Racing Commit Executed?", commitDrift.executed);
  console.log("  Rejection Reason:", commitDrift.reason, "\n");

  // ---------------------------------------------------------------------------
  // FLOW 3: Causal Dependency Graph & Incident Root-Cause Analysis (Phase 5)
  // ---------------------------------------------------------------------------
  console.log("--------------------------------------------------------------------------------");
  console.log("--- FLOW 3: Causal Dependency Graph & Root Cause Analysis ---");
  console.log("Analyzing cascading incident on workspace 'hichat':\n");
  console.log("  Topology: hichat-web -> alb -> ecs-task -> redis / postgres");

  // Out of order alerts: downstream symptoms alert first, root alerts last
  const incidentAlerts = [
    { node: "alb", timestamp: 1020 },
    { node: "ecs-task", timestamp: 1040 },
    { node: "hichat-web", timestamp: 1060 },
    { node: "redis", timestamp: 1080 },
  ];

  console.log("  Incoming Alerts (simulated out of order):");
  for (const a of incidentAlerts) {
    console.log(`    - [t=${a.timestamp}ms] Alert fired on node: "${a.node}"`);
  }

  const analysis = analyzeIncident("hichat", incidentAlerts);
  console.log("\n[ANALYSIS RESULT]");
  console.log(`  Identified Root Cause   : "${analysis.rootCause}"`);
  console.log(`  Identified Symptoms     : [${analysis.symptoms.join(", ")}]`);
  console.log(`  Possible Multiple Roots : ${analysis.possibleMultipleCauses}`);
  console.log(`  Plain Language Report   : "${analysis.explanation}"\n`);

  console.log("================================================================================");
  console.log("                       ALL FLOWS COMPLETED SUCCESSFULLY                         ");
  console.log("================================================================================");
}

runDemo().catch((err) => {
  console.error("Demo failed with error:", err);
  process.exit(1);
});
