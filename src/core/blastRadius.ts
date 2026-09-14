import { parse, type Statement, type Expr } from "pgsql-ast-parser";

export interface BlastRadiusResult {
  allowed: boolean;
  reason?: string;
}

function isAlwaysTrue(expr: Expr | null | undefined): boolean {
  if (!expr) return false;

  if (expr.type === "boolean") {
    return expr.value === true;
  }

  if (expr.type === "unary") {
    if (expr.op === "NOT") {
      if (expr.operand.type === "boolean") {
        return expr.operand.value === false;
      }
    }
  }

  if (expr.type === "binary") {
    const op = expr.op.toUpperCase();
    if (op === "=") {
      if (expr.left.type === "integer" && expr.right.type === "integer") {
        return expr.left.value === expr.right.value;
      }
      if (expr.left.type === "string" && expr.right.type === "string") {
        return expr.left.value === expr.right.value;
      }
      if (expr.left.type === "boolean" && expr.right.type === "boolean") {
        return expr.left.value === expr.right.value;
      }
      if (expr.left.type === "ref" && expr.right.type === "ref") {
        return expr.left.name.toLowerCase() === expr.right.name.toLowerCase();
      }
    }

    if (op === "!=") {
      if (expr.left.type === "integer" && expr.right.type === "integer") {
        return expr.left.value !== expr.right.value;
      }
      if (expr.left.type === "string" && expr.right.type === "string") {
        return expr.left.value !== expr.right.value;
      }
    }

    if (op === "OR") {
      return isAlwaysTrue(expr.left) || isAlwaysTrue(expr.right);
    }

    if (op === "AND") {
      return isAlwaysTrue(expr.left) && isAlwaysTrue(expr.right);
    }
  }

  return false;
}

function extractReferencedColumns(expr: any): string[] {
  const columns: string[] = [];

  function traverse(node: any) {
    if (!node || typeof node !== "object") return;
    if (node.type === "ref" && typeof node.name === "string") {
      columns.push(node.name);
    }
    for (const key of Object.keys(node)) {
      const val = node[key];
      if (Array.isArray(val)) {
        for (const item of val) {
          traverse(item);
        }
      } else if (val && typeof val === "object") {
        traverse(val);
      }
    }
  }

  traverse(expr);
  return columns;
}

function checkStatement(
  statement: Statement,
  indexedColumnsByTable?: Record<string, string[]>
): BlastRadiusResult {
  const type = statement.type;

  // 1. DROP TABLE / TRUNCATE in any form — always rejected, no exceptions
  if (
    type === "drop table" ||
    type === "truncate table" ||
    type.startsWith("drop ") ||
    type.startsWith("truncate")
  ) {
    return {
      allowed: false,
      reason: "BLAST_RADIUS_EXCEEDED: DROP TABLE / TRUNCATE statements are strictly forbidden",
    };
  }

  // 2. WITH ... DELETE/UPDATE CTEs — recursively check inner and outer statements
  if (type === "with") {
    const withStmt = statement as any;
    if (Array.isArray(withStmt.bind)) {
      for (const binding of withStmt.bind) {
        if (binding.statement) {
          const innerCheck = checkStatement(binding.statement, indexedColumnsByTable);
          if (!innerCheck.allowed) {
            return innerCheck;
          }
        }
      }
    }
    if (withStmt.in) {
      const outerCheck = checkStatement(withStmt.in, indexedColumnsByTable);
      if (!outerCheck.allowed) {
        return outerCheck;
      }
    }
    return { allowed: true };
  }

  // 3. DELETE or UPDATE statements
  if (type === "delete" || type === "update") {
    const deleteOrUpdate = statement as any;

    // Check for missing WHERE clause
    if (!deleteOrUpdate.where) {
      return {
        allowed: false,
        reason: "BLAST_RADIUS_EXCEEDED: no WHERE clause",
      };
    }

    // Check for WHERE 1=1 or other always-true conditions
    if (isAlwaysTrue(deleteOrUpdate.where)) {
      return {
        allowed: false,
        reason: "BLAST_RADIUS_EXCEEDED: no WHERE clause",
      };
    }

    // Check for indexed column binding if indexedColumnsByTable is provided
    if (indexedColumnsByTable) {
      const tableName =
        type === "delete" ? deleteOrUpdate.from?.name : deleteOrUpdate.table?.name;

      if (tableName) {
        const matchingKey = Object.keys(indexedColumnsByTable).find(
          (k) => k.toLowerCase() === tableName.toLowerCase()
        );
        const knownIndexedCols = (
          matchingKey ? indexedColumnsByTable[matchingKey] : []
        ).map((c) => c.toLowerCase());

        const referencedCols = extractReferencedColumns(deleteOrUpdate.where);
        const isBound = referencedCols.some((c) =>
          knownIndexedCols.includes(c.toLowerCase())
        );

        if (!isBound) {
          return {
            allowed: false,
            reason: "BLAST_RADIUS_EXCEEDED: unindexed WHERE",
          };
        }
      }
    }

    return { allowed: true };
  }

  // Other statements (e.g. SELECT, INSERT) are allowed
  return { allowed: true };
}

export function checkBlastRadius(
  sql: string,
  indexedColumnsByTable?: Record<string, string[]>
): BlastRadiusResult {
  if (!sql || sql.trim().length === 0) {
    return {
      allowed: false,
      reason: "BLAST_RADIUS_EXCEEDED: empty SQL statement",
    };
  }

  let statements: Statement[];
  try {
    statements = parse(sql);
  } catch (err: any) {
    const upper = sql.toUpperCase();
    if (upper.includes("DROP TABLE") || upper.includes("TRUNCATE")) {
      return {
        allowed: false,
        reason: "BLAST_RADIUS_EXCEEDED: DROP TABLE / TRUNCATE statements are strictly forbidden",
      };
    }
    return {
      allowed: false,
      reason: `BLAST_RADIUS_EXCEEDED: failed to parse SQL: ${err.message}`,
    };
  }

  if (statements.length === 0) {
    return {
      allowed: false,
      reason: "BLAST_RADIUS_EXCEEDED: empty SQL statement",
    };
  }

  // Check each statement in sequence
  for (const stmt of statements) {
    const result = checkStatement(stmt, indexedColumnsByTable);
    if (!result.allowed) {
      return result;
    }
  }

  return { allowed: true };
}
