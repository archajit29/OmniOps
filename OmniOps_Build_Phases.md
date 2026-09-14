# OmniOps — Phase-by-Phase Build Spec

Written to be handed to a coding agent (Claude Code, Cursor, etc.) one phase at a time.
Each phase has a goal, exact steps, file structure, and acceptance criteria. Do not
start a phase until the previous phase's acceptance criteria pass.

Stack: TypeScript 7, `@modelcontextprotocol/sdk`, Zod, Node.js, `pgsql-ast-parser`.

---

## PHASE 0 — Project Setup

**Goal:** a running project skeleton, nothing functional yet.

**Steps:**
1. `npm init -y`, install: `typescript@7`, `@modelcontextprotocol/sdk`, `zod`,
   `pgsql-ast-parser`, `vitest` (testing).
2. Create folder structure:
   ```
   /src
     /mcp        -> server entrypoint, tool registration
     /tools      -> one file per MCP tool
     /core       -> pure business logic (no MCP/Zod imports here)
     /config     -> workspace + topology config loading
   /tests
   /config
     workspaces.json
   ```
3. `tsconfig.json` targeting TS7 native compiler, strict mode on.
4. `src/mcp/server.ts` — boots an MCP server over stdio, registers zero tools yet.

**Acceptance criteria:**
- `npm run build` compiles with no errors.
- Server starts and connects to Claude Desktop (visible in Claude Desktop's MCP
  server list) with zero tools registered.

---

## PHASE 1 — First Tool: Health Check (prove the transport works)

**Goal:** one trivial tool round-trips through Claude → server → back, before any
real logic is written.

**Steps:**
1. `src/tools/ping.ts`: define one tool `ping_service_health` using Zod schema
   `{ service: z.string() }`, returns `{ status: "ok", service, timestamp }`.
2. Register it in `src/mcp/server.ts`.
3. Test manually: ask Claude Desktop "ping the hichat service" and confirm the tool
   fires and returns correctly.

**Acceptance criteria:**
- Claude can invoke the tool and receive a structured response.
- No hardcoded service names — `service` comes from the Zod-validated input.

---

## PHASE 2 — Workspace / Topology Config (build before Phases 3–5, they depend on it)

**Goal:** generic, app-agnostic config so every later pillar works on any app, not
just HiChat.

**Steps:**
1. `config/workspaces.json` shape:
   ```json
   {
     "workspaces": {
       "hichat": {
         "db_url_env": "HICHAT_DB_URL",
         "topology": {
           "nodes": ["hichat-web", "alb", "ecs-task", "redis", "postgres"],
           "edges": [
             {"from": "hichat-web", "to": "alb"},
             {"from": "alb", "to": "ecs-task"},
             {"from": "ecs-task", "to": "redis"},
             {"from": "ecs-task", "to": "postgres"}
           ]
         }
       }
     }
   }
   ```
2. `src/config/loadWorkspace.ts` — loads and Zod-validates this file. Schema must
   enforce: unique node names, edges reference only declared nodes.
3. Every tool built from here on takes a `workspace: z.string()` param and pulls its
   config through this loader — never hardcode "hichat" inside tool logic.

**Acceptance criteria:**
- Invalid config (edge referencing unknown node) fails validation with a clear error.
- Adding a second workspace (the other app) requires only editing this JSON file,
  zero code changes.

---

## PHASE 3 — AST SQL Blast-Radius Engine (highest priority pillar)

**Goal:** reject dangerous SQL before it reaches Postgres.

**Steps:**
1. `src/core/blastRadius.ts`, pure function:
   `checkBlastRadius(sql: string): { allowed: boolean; reason?: string }`.
2. Parse `sql` with `pgsql-ast-parser`.
3. Rules to implement, each returning a specific rejection reason:
   - Any `DELETE`/`UPDATE` with no `WHERE` clause → `BLAST_RADIUS_EXCEEDED: no WHERE clause`.
   - `WHERE` clause present but not bound to a known indexed column (pass indexed
     column list per table as a second arg) → `BLAST_RADIUS_EXCEEDED: unindexed WHERE`.
   - `DROP TABLE` / `TRUNCATE` in any form → always rejected, no exceptions.
   - `WITH ... DELETE`/`UPDATE` CTEs → recursively check the inner statement, not
     just the outer `SELECT`.
   - Multiple statements in one string (split on top-level `;`, check each).
   - `WHERE 1=1` or other always-true conditions → treat as equivalent to no `WHERE`.
4. `src/tools/executeMigration.ts` — MCP tool `execute_database_migration`, Zod
   schema `{ workspace: z.string(), sql: z.string() }`. Calls `checkBlastRadius`
   before ever touching a real DB connection. On rejection, returns the reason to
   Claude without executing anything.
5. `tests/blastRadius.test.ts` — one test per rule above, plus 3 "should allow"
   cases (a proper `SELECT`, a `DELETE ... WHERE id = $1` on an indexed PK, a safe
   `UPDATE` with indexed `WHERE`).

**Acceptance criteria:**
- All test cases pass.
- A hallucinated `DROP TABLE users;` is rejected with a clear, specific reason
  string, never silently ignored or executed.

---

## PHASE 4 — Two-Phase Dry-Run Commit (HMAC-signed)

**Goal:** destructive actions require stage → verify → commit, with a real
cryptographic guarantee, not a plain hash.

**Steps:**
1. `src/core/remediation.ts`:
   - `stageIntent(action, currentState): { payload, signature, expiresAt }`
     — builds a payload `{ action, stateSnapshot: hash(currentState), expiresAt: now+5min }`,
     signs it with `crypto.createHmac('sha256', SERVER_SECRET)`.
   - `commitIntent(payload, signature, liveState): { executed: boolean; reason?: string }`
     — verifies signature matches, checks `expiresAt` hasn't passed, re-hashes
     `liveState` and confirms it still matches `stateSnapshot` (i.e. nothing changed
     since staging) — only then proceeds to execute.
2. `SERVER_SECRET` from env var, never hardcoded, never sent to the client.
3. Two MCP tools: `stage_remediation_intent` and `commit_remediation`, wired to a
   real destructive action (pick one for v1: ECS task restart via AWS SDK, or a
   Redis `FLUSHDB` on a specific key namespace).
4. `tests/remediation.test.ts`:
   - Valid stage → commit within expiry → executes.
   - Commit after expiry → rejected.
   - Commit with tampered signature → rejected.
   - Commit where live state drifted from the staged snapshot → rejected
     (this is the core "protects against stale/racing commands" test — most important
     one to have working and demoable).

**Acceptance criteria:**
- All four test cases pass, especially the state-drift rejection.
- You can explain in one sentence why this is actually cryptographic: the signature
  can't be forged without the server secret, unlike a plain hash.

---

## PHASE 5 — Causal Dependency Graph / Root Cause

**Goal:** given multiple simultaneous alerts, identify the earliest upstream cause.

**Steps:**
1. `src/core/graph.ts`:
   - `tarjanSCC(nodes, edges): SuperNode[]` — standard Tarjan's implementation,
     always run regardless of whether cycles are expected.
   - `condenseGraph(nodes, edges, sccs): CondensedGraph` — collapses each SCC into
     one super-node; no-op (returns graph unchanged) if no cycles were found.
2. `src/core/rootCause.ts`:
   - `findRootCause(condensedGraph, alerts: {node, timestamp}[]): { rootCause, symptoms[] }`
   - For each alerting node, reverse-traverse the condensed graph collecting
     alerting ancestors.
   - Root cause = alerting node with earliest timestamp among ancestors, with no
     alerting ancestors of its own.
   - If two candidate roots have no ancestor relationship between them, return both
     under a `possibleMultipleCauses` flag rather than forcing one answer.
3. `src/tools/analyzeIncident.ts` — MCP tool `analyze_network`, takes
   `{ workspace, alerts: [{node, timestamp}] }`, loads that workspace's topology
   from Phase 2's config, runs the pipeline above, returns root cause + symptom list
   in plain language for Claude to relay.
4. `tests/rootCause.test.ts`:
   - No-cycle case: 3-node chain, alerts fire out of order, correct root identified.
   - Cycle case: construct a graph with an artificial cycle, confirm Tarjan's
     condenses it and the traversal still terminates and gives a sane answer.
   - Missing-alert case: root node never alerts, only downstream nodes do — document
     this as a known limitation if you don't implement metric-fallback in v1.

**Acceptance criteria:**
- Both no-cycle and cycle test cases pass on the same code path (no branching logic
  based on "is this a DAG or not" — the normalization step handles it automatically).

---

## PHASE 6 — Integration Test + Demo

**Goal:** everything works together, end-to-end, recorded.

**Steps:**
1. Full run-through in Claude Desktop:
   - Ask Claude to run a destructive migration → watch Phase 3 reject it.
   - Ask Claude to restart a service → watch Phase 4's stage/commit flow execute
     correctly, then simulate state drift and watch it reject.
   - Feed a simulated incident (3 alerts, out of order) → watch Phase 5 return the
     correct root cause.
2. Record a 90-second screen capture covering all three flows.
3. Write `README.md`: one-paragraph honest pitch (no hype language), architecture
   diagram, setup instructions, and a clearly labeled "Roadmap / not yet built:
   DuckDB + OpenTelemetry analytics" section for the deferred pillar.

**Acceptance criteria:**
- Demo video exists and shows all three flows working live, not narrated over slides.
- README makes no claim that isn't actually demonstrated in the video.

---

## PHASE 7 (deferred / roadmap, optional) — DuckDB + OpenTelemetry

Only start this after Phases 0–6 are complete and demoed. Lowest priority, cut
entirely from v1 if time-constrained.

**Steps (when you get here):**
1. Emit OTel traces from the MCP server itself (span per tool call).
2. Write traces to local Parquet files.
3. `src/tools/queryLogs.ts` — MCP resource that runs DuckDB queries directly over
   the Parquet files, exposed as a read-only MCP resource for Claude to query.

---

## Order of work, restated simply
0 → 1 → 2 → 3 → 4 → 5 → 6 → (7 optional later)

Do not skip ahead. Each phase's acceptance criteria must pass before starting the
next — this is what makes the eventual demo honest instead of half-working.
