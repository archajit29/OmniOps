import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export interface RemediationAction {
  type: string;
  target: string;
  parameters?: Record<string, unknown>;
}

export interface RemediationPayload {
  action: RemediationAction;
  stateSnapshot: string;
  expiresAt: number;
}

export interface StagedIntent {
  payload: RemediationPayload;
  signature: string;
  expiresAt: number;
}

export interface CommitResult {
  executed: boolean;
  reason?: string;
  action?: RemediationAction;
  executedAt?: number;
}

/**
 * Deterministically serializes objects by sorting keys to ensure
 * canonical hash and signature generation.
 */
export function stableSerialize(obj: unknown): string {
  if (obj === null || typeof obj !== "object") {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return "[" + obj.map(stableSerialize).join(",") + "]";
  }
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  return (
    "{" +
    keys
      .map(
        (k) =>
          JSON.stringify(k) + ":" + stableSerialize((obj as Record<string, unknown>)[k])
      )
      .join(",") +
    "}"
  );
}

export function hashState(state: unknown): string {
  return createHash("sha256").update(stableSerialize(state)).digest("hex");
}

export function getServerSecret(): string {
  const envSecret = process.env.OMNIOPS_SERVER_SECRET || process.env.SERVER_SECRET;
  if (envSecret && envSecret.trim().length > 0) {
    return envSecret.trim();
  }

  // Load from local .env file if available
  try {
    const envPath = resolve(process.cwd(), ".env");
    if (existsSync(envPath)) {
      const content = readFileSync(envPath, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("OMNIOPS_SERVER_SECRET=")) {
          const val = trimmed.slice("OMNIOPS_SERVER_SECRET=".length).trim();
          if (val) return val;
        }
        if (trimmed.startsWith("SERVER_SECRET=")) {
          const val = trimmed.slice("SERVER_SECRET=".length).trim();
          if (val) return val;
        }
      }
    }
  } catch {}

  throw new Error(
    "SERVER_SECRET is not configured in process.env or local .env file"
  );
}

export function signPayload(payload: RemediationPayload, secret?: string): string {
  const key = secret ?? getServerSecret();
  const serialized = stableSerialize(payload);
  return createHmac("sha256", key).update(serialized).digest("hex");
}

export function verifySignature(
  payload: RemediationPayload,
  signature: string,
  secret?: string
): boolean {
  try {
    const key = secret ?? getServerSecret();
    const expected = createHmac("sha256", key)
      .update(stableSerialize(payload))
      .digest("hex");

    if (expected.length !== signature.length) {
      return false;
    }

    return timingSafeEqual(
      Buffer.from(expected, "hex"),
      Buffer.from(signature, "hex")
    );
  } catch {
    return false;
  }
}

export function stageIntent(
  action: RemediationAction,
  currentState: unknown,
  ttlMs: number = 5 * 60 * 1000,
  secret?: string
): StagedIntent {
  const expiresAt = Date.now() + ttlMs;
  const stateSnapshot = hashState(currentState);

  const payload: RemediationPayload = {
    action,
    stateSnapshot,
    expiresAt,
  };

  const signature = signPayload(payload, secret);

  return {
    payload,
    signature,
    expiresAt,
  };
}

export function commitIntent(
  payload: RemediationPayload,
  signature: string,
  liveState: unknown,
  executor?: (action: RemediationAction) => void | Promise<void>,
  secret?: string
): CommitResult {
  // 1. Verify HMAC signature matches
  if (!verifySignature(payload, signature, secret)) {
    return {
      executed: false,
      reason: "REMEDIATION_REJECTED: invalid or tampered signature",
    };
  }

  // 2. Verify expiresAt hasn't passed
  if (Date.now() > payload.expiresAt) {
    return {
      executed: false,
      reason: "REMEDIATION_REJECTED: intent expired",
    };
  }

  // 3. Verify live state has not drifted from staged snapshot
  const liveSnapshot = hashState(liveState);
  if (liveSnapshot !== payload.stateSnapshot) {
    return {
      executed: false,
      reason:
        "REMEDIATION_REJECTED: live state drifted from staged snapshot (state drift detected)",
    };
  }

  // 4. State matches and signature verified: execute action
  if (executor) {
    executor(payload.action);
  }

  return {
    executed: true,
    action: payload.action,
    executedAt: Date.now(),
  };
}

/**
 * In-Memory Redis Mock Backend for Local Testing and Safe Demonstration
 * Implements namespaced key storage and namespace flushing (simulating Redis FLUSHDB for a namespace).
 */
export class InMemoryRedisBackend {
  private store: Map<string, string> = new Map();

  set(key: string, value: string): void {
    this.store.set(key, value);
  }

  get(key: string): string | undefined {
    return this.store.get(key);
  }

  delete(key: string): boolean {
    return this.store.delete(key);
  }

  getKeysByNamespace(namespace: string): string[] {
    const prefix = namespace.endsWith(":") ? namespace : `${namespace}:`;
    return Array.from(this.store.keys())
      .filter((k) => k.startsWith(prefix))
      .sort();
  }

  getStateSnapshot(namespace: string): {
    namespace: string;
    keyCount: number;
    keys: string[];
    digest: string;
  } {
    const keys = this.getKeysByNamespace(namespace);
    const pairs = keys.map((k) => `${k}=${this.store.get(k)}`).join(";;");
    const digest = createHash("sha256").update(pairs).digest("hex");

    return {
      namespace,
      keyCount: keys.length,
      keys,
      digest,
    };
  }

  flushNamespace(namespace: string): { flushedCount: number; namespace: string } {
    const keys = this.getKeysByNamespace(namespace);
    for (const key of keys) {
      this.store.delete(key);
    }
    return {
      flushedCount: keys.length,
      namespace,
    };
  }
}
