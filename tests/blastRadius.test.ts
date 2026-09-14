import { describe, it, expect } from "vitest";
import { checkBlastRadius } from "../src/core/blastRadius.js";
import {
  executeMigrationHandler,
  DEFAULT_INDEXED_COLUMNS,
} from "../src/tools/executeMigration.js";

describe("Phase 3: AST SQL Blast-Radius Engine", () => {
  const indexedColumns = {
    users: ["id", "email"],
    orders: ["id", "customer_id"],
  };

  // Rule 1: DELETE/UPDATE with no WHERE clause
  describe("Rule: DELETE/UPDATE with no WHERE clause", () => {
    it("rejects DELETE without WHERE clause", () => {
      const result = checkBlastRadius("DELETE FROM users;", indexedColumns);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("BLAST_RADIUS_EXCEEDED: no WHERE clause");
    });

    it("rejects UPDATE without WHERE clause", () => {
      const result = checkBlastRadius("UPDATE users SET name = 'foo';", indexedColumns);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("BLAST_RADIUS_EXCEEDED: no WHERE clause");
    });
  });

  // Rule 2: WHERE clause present but not bound to a known indexed column
  describe("Rule: WHERE clause not bound to a known indexed column", () => {
    it("rejects DELETE where WHERE column is unindexed", () => {
      const result = checkBlastRadius("DELETE FROM users WHERE name = 'bob';", indexedColumns);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("BLAST_RADIUS_EXCEEDED: unindexed WHERE");
    });

    it("rejects UPDATE where WHERE column is unindexed", () => {
      const result = checkBlastRadius(
        "UPDATE users SET name = 'foo' WHERE age > 30;",
        indexedColumns
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("BLAST_RADIUS_EXCEEDED: unindexed WHERE");
    });
  });

  // Rule 3: DROP TABLE / TRUNCATE in any form — always rejected, no exceptions
  describe("Rule: DROP TABLE / TRUNCATE in any form", () => {
    it("rejects DROP TABLE users;", () => {
      const result = checkBlastRadius("DROP TABLE users;", indexedColumns);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe(
        "BLAST_RADIUS_EXCEEDED: DROP TABLE / TRUNCATE statements are strictly forbidden"
      );
    });

    it("rejects DROP TABLE IF EXISTS users CASCADE;", () => {
      const result = checkBlastRadius("DROP TABLE IF EXISTS users CASCADE;", indexedColumns);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe(
        "BLAST_RADIUS_EXCEEDED: DROP TABLE / TRUNCATE statements are strictly forbidden"
      );
    });

    it("rejects TRUNCATE users;", () => {
      const result = checkBlastRadius("TRUNCATE users;", indexedColumns);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe(
        "BLAST_RADIUS_EXCEEDED: DROP TABLE / TRUNCATE statements are strictly forbidden"
      );
    });

    it("rejects TRUNCATE TABLE users;", () => {
      const result = checkBlastRadius("TRUNCATE TABLE users;", indexedColumns);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe(
        "BLAST_RADIUS_EXCEEDED: DROP TABLE / TRUNCATE statements are strictly forbidden"
      );
    });
  });

  // Rule 4: WITH ... DELETE/UPDATE CTEs — recursively check inner statement
  describe("Rule: WITH CTE recursive checking", () => {
    it("rejects CTE with inner unconstrained DELETE", () => {
      const sql =
        "WITH deleted AS (DELETE FROM users RETURNING *) SELECT * FROM deleted;";
      const result = checkBlastRadius(sql, indexedColumns);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("BLAST_RADIUS_EXCEEDED: no WHERE clause");
    });

    it("rejects CTE with inner unindexed WHERE", () => {
      const sql =
        "WITH deleted AS (DELETE FROM users WHERE name = 'bob' RETURNING *) SELECT * FROM deleted;";
      const result = checkBlastRadius(sql, indexedColumns);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("BLAST_RADIUS_EXCEEDED: unindexed WHERE");
    });

    it("allows CTE with safe indexed DELETE", () => {
      const sql =
        "WITH deleted AS (DELETE FROM users WHERE id = $1 RETURNING *) SELECT * FROM deleted;";
      const result = checkBlastRadius(sql, indexedColumns);
      expect(result.allowed).toBe(true);
    });
  });

  // Rule 5: Multiple statements in one string (split on top-level ;, check each)
  describe("Rule: Multiple statements in one string", () => {
    it("rejects if any statement is a DROP TABLE", () => {
      const sql = "SELECT * FROM users; DROP TABLE users;";
      const result = checkBlastRadius(sql, indexedColumns);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe(
        "BLAST_RADIUS_EXCEEDED: DROP TABLE / TRUNCATE statements are strictly forbidden"
      );
    });

    it("rejects if any statement has an unconstrained DELETE", () => {
      const sql = "SELECT 1; DELETE FROM users;";
      const result = checkBlastRadius(sql, indexedColumns);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("BLAST_RADIUS_EXCEEDED: no WHERE clause");
    });
  });

  // Rule 6: WHERE 1=1 or other always-true conditions
  describe("Rule: WHERE 1=1 or always-true conditions", () => {
    it("rejects WHERE 1=1", () => {
      const result = checkBlastRadius("DELETE FROM users WHERE 1=1;", indexedColumns);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("BLAST_RADIUS_EXCEEDED: no WHERE clause");
    });

    it("rejects WHERE TRUE", () => {
      const result = checkBlastRadius("UPDATE users SET name = 'foo' WHERE TRUE;", indexedColumns);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("BLAST_RADIUS_EXCEEDED: no WHERE clause");
    });

    it("rejects tautological column equality WHERE id = id", () => {
      const result = checkBlastRadius("DELETE FROM users WHERE id = id;", indexedColumns);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("BLAST_RADIUS_EXCEEDED: no WHERE clause");
    });

    it("rejects WHERE 'a' = 'a'", () => {
      const result = checkBlastRadius("UPDATE users SET name = 'foo' WHERE 'a' = 'a';", indexedColumns);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("BLAST_RADIUS_EXCEEDED: no WHERE clause");
    });
  });

  // 3 Explicit "should allow" cases
  describe("Explicit 'should allow' cases", () => {
    it("should allow Case 1: a proper SELECT", () => {
      const sql = "SELECT id, name FROM users WHERE active = true;";
      const result = checkBlastRadius(sql, indexedColumns);
      expect(result.allowed).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it("should allow Case 2: a DELETE ... WHERE id = $1 on an indexed PK", () => {
      const sql = "DELETE FROM users WHERE id = $1;";
      const result = checkBlastRadius(sql, indexedColumns);
      expect(result.allowed).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it("should allow Case 3: a safe UPDATE with indexed WHERE", () => {
      const sql = "UPDATE users SET email = 'alice@example.com' WHERE id = 42;";
      const result = checkBlastRadius(sql, indexedColumns);
      expect(result.allowed).toBe(true);
      expect(result.reason).toBeUndefined();
    });
  });

  // MCP Tool Integration: execute_database_migration
  describe("Tool Integration: execute_database_migration", () => {
    it("rejects DROP TABLE users through the tool with specific reason without touching DB", async () => {
      const res = await executeMigrationHandler("hichat", "DROP TABLE users;");
      expect(res.allowed).toBe(false);
      expect(res.executed).toBe(false);
      expect(res.reason).toBe(
        "BLAST_RADIUS_EXCEEDED: DROP TABLE / TRUNCATE statements are strictly forbidden"
      );
    });

    it("approves safe indexed migration query", async () => {
      const res = await executeMigrationHandler(
        "hichat",
        "UPDATE users SET email = 'safe@example.com' WHERE id = 1;"
      );
      expect(res.allowed).toBe(true);
      expect(res.executed).toBe(true);
      expect(res.workspace).toBe("hichat");
      expect(res.message).toContain("safe to execute");
    });
  });
});
