import type { CondensedGraph } from "./graph.js";

export interface Alert {
  node: string;
  timestamp: number;
}

export interface RootCauseResult {
  rootCause: string | string[];
  rootCauses: string[];
  symptoms: string[];
  possibleMultipleCauses: boolean;
  explanation: string;
}

/**
 * Identifies the root cause among a set of simultaneous or out-of-order alerts.
 *
 * ALGORITHM:
 * 1. Map each alerting node to its corresponding super-node in the condensed graph.
 * 2. For each alerting super-node, reverse-traverse incoming edges to identify all
 *    alerting ancestors.
 * 3. Candidate roots are alerting super-nodes with zero alerting ancestors of their own.
 * 4. If multiple candidate roots exist with no ancestor relationship between them,
 *    all candidate roots are returned under `possibleMultipleCauses: true`.
 * 5. Within a cyclic component (super-node), the node with the earliest alert
 *    timestamp is designated as the root trigger.
 * 6. Downstream alerting nodes are classified as symptoms.
 *
 * KNOWN LIMITATION (v1):
 * If the true upstream root node never fires an alert (e.g. total silent failure,
 * unmonitored component, or missing telemetry), the algorithm will identify the
 * earliest alerting downstream node as the root cause among available observations.
 * Metric-fallback or anomaly detection for silent nodes is deferred beyond v1.
 */
export function findRootCause(
  condensedGraph: CondensedGraph,
  alerts: Alert[]
): RootCauseResult {
  if (!alerts || alerts.length === 0) {
    return {
      rootCause: [],
      rootCauses: [],
      symptoms: [],
      possibleMultipleCauses: false,
      explanation: "No alerts were provided for incident analysis.",
    };
  }

  // 1. Group alerts by super-node
  const alertingSuperNodes = new Map<
    string,
    {
      superId: string;
      earliestTimestamp: number;
      alerts: Alert[];
    }
  >();

  for (const alert of alerts) {
    const superId = condensedGraph.nodeToSuperNode[alert.node];
    if (!superId) continue;

    let entry = alertingSuperNodes.get(superId);
    if (!entry) {
      entry = {
        superId,
        earliestTimestamp: alert.timestamp,
        alerts: [],
      };
      alertingSuperNodes.set(superId, entry);
    }
    entry.alerts.push(alert);
    if (alert.timestamp < entry.earliestTimestamp) {
      entry.earliestTimestamp = alert.timestamp;
    }
  }

  // 2. Reverse-traverse condensed graph to find alerting ancestors
  function getAlertingAncestors(startSuperId: string): Set<string> {
    const ancestors = new Set<string>();
    const visited = new Set<string>();
    const queue = [...(condensedGraph.reverseAdj[startSuperId] || [])];

    while (queue.length > 0) {
      const curr = queue.shift()!;
      if (visited.has(curr)) continue;
      visited.add(curr);

      if (alertingSuperNodes.has(curr)) {
        ancestors.add(curr);
      }

      for (const parent of condensedGraph.reverseAdj[curr] || []) {
        if (!visited.has(parent)) {
          queue.push(parent);
        }
      }
    }

    return ancestors;
  }

  // 3. Find candidate roots: alerting super-nodes with no alerting ancestors
  const candidateRoots: {
    superId: string;
    earliestTimestamp: number;
    alerts: Alert[];
  }[] = [];

  for (const [superId, entry] of alertingSuperNodes.entries()) {
    const ancestors = getAlertingAncestors(superId);
    if (ancestors.size === 0) {
      candidateRoots.push(entry);
    }
  }

  // 4. Fallback if no root has 0 ancestors
  if (candidateRoots.length === 0) {
    let earliest = Array.from(alertingSuperNodes.values())[0];
    for (const entry of alertingSuperNodes.values()) {
      if (entry.earliestTimestamp < earliest.earliestTimestamp) {
        earliest = entry;
      }
    }
    candidateRoots.push(earliest);
  }

  // 5. Check if multiple independent root causes exist
  const possibleMultipleCauses = candidateRoots.length > 1;

  // 6. Within each root super-node, pick the earliest alerting node
  const rootCauses = candidateRoots.map((candidate) => {
    candidate.alerts.sort((a, b) => a.timestamp - b.timestamp);
    return candidate.alerts[0].node;
  });

  // 7. Collect symptoms: all alerting nodes except the root causes
  const rootSet = new Set(rootCauses);
  const symptoms = alerts
    .map((a) => a.node)
    .filter((n, idx, arr) => arr.indexOf(n) === idx && !rootSet.has(n));

  const explanation = possibleMultipleCauses
    ? `Multiple independent root causes identified: [${rootCauses.join(", ")}]. These nodes have no upstream alerting ancestors in the dependency topology. Downstream symptoms: [${symptoms.join(", ")}].`
    : `Primary root cause identified: "${rootCauses[0]}". Downstream symptoms caused by cascading failure: [${symptoms.join(", ")}].`;

  return {
    rootCause: possibleMultipleCauses ? rootCauses : rootCauses[0],
    rootCauses,
    symptoms,
    possibleMultipleCauses,
    explanation,
  };
}
