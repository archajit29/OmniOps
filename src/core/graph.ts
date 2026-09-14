export interface Edge {
  from: string;
  to: string;
}

export interface CondensedNode {
  id: string;
  originalNodes: string[];
}

export interface CondensedGraph {
  nodes: CondensedNode[];
  edges: Edge[];
  nodeToSuperNode: Record<string, string>;
  forwardAdj: Record<string, string[]>;
  reverseAdj: Record<string, string[]>;
}

/**
 * Tarjan's Strongly Connected Components (SCC) algorithm.
 * Runs unconditionally on every graph, regardless of whether cycles are expected.
 * Returns an array of SCCs, where each SCC is an array of node identifiers.
 */
export function tarjanSCC(nodes: string[], edges: Edge[]): string[][] {
  let index = 0;
  const indices = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];

  const adj = new Map<string, string[]>();
  for (const node of nodes) {
    adj.set(node, []);
  }
  for (const edge of edges) {
    if (adj.has(edge.from)) {
      adj.get(edge.from)!.push(edge.to);
    }
  }

  function strongConnect(v: string): void {
    indices.set(v, index);
    lowlink.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);

    for (const w of adj.get(v) || []) {
      if (!indices.has(w)) {
        strongConnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, indices.get(w)!));
      }
    }

    if (lowlink.get(v) === indices.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      sccs.push(scc);
    }
  }

  for (const node of nodes) {
    if (!indices.has(node)) {
      strongConnect(node);
    }
  }

  return sccs;
}

/**
 * Condenses a directed graph given its Strongly Connected Components.
 * - When all SCCs are singletons (no cycles exist), this operation is a structural
 *   no-op returning the original nodes and edges unchanged.
 * - When cycles exist, each multi-node SCC is collapsed into a single super-node,
 *   remapping edges and eliminating internal cycle self-loops.
 */
export function condenseGraph(
  nodes: string[],
  edges: Edge[],
  sccs: string[][]
): CondensedGraph {
  const hasCycle = sccs.some((scc) => scc.length > 1);

  if (!hasCycle) {
    // No-op: return graph structurally unchanged
    const nodeToSuperNode: Record<string, string> = {};
    const forwardAdj: Record<string, string[]> = {};
    const reverseAdj: Record<string, string[]> = {};

    for (const n of nodes) {
      nodeToSuperNode[n] = n;
      forwardAdj[n] = [];
      reverseAdj[n] = [];
    }

    for (const e of edges) {
      if (forwardAdj[e.from]) forwardAdj[e.from].push(e.to);
      if (reverseAdj[e.to]) reverseAdj[e.to].push(e.from);
    }

    return {
      nodes: nodes.map((n) => ({ id: n, originalNodes: [n] })),
      edges: edges.map((e) => ({ from: e.from, to: e.to })),
      nodeToSuperNode,
      forwardAdj,
      reverseAdj,
    };
  }

  // Cyclic: collapse multi-node SCCs into super-nodes
  const nodeToSuperNode: Record<string, string> = {};
  const superNodes: CondensedNode[] = [];

  for (const scc of sccs) {
    const sorted = [...scc].sort();
    const id = sorted.length === 1 ? sorted[0] : sorted.join("+");
    superNodes.push({ id, originalNodes: sorted });
    for (const n of sorted) {
      nodeToSuperNode[n] = id;
    }
  }

  const edgeSet = new Set<string>();
  const condensedEdges: Edge[] = [];
  const forwardAdj: Record<string, string[]> = {};
  const reverseAdj: Record<string, string[]> = {};

  for (const sn of superNodes) {
    forwardAdj[sn.id] = [];
    reverseAdj[sn.id] = [];
  }

  for (const e of edges) {
    const fromSuper = nodeToSuperNode[e.from];
    const toSuper = nodeToSuperNode[e.to];

    if (fromSuper && toSuper && fromSuper !== toSuper) {
      const edgeKey = `${fromSuper}->${toSuper}`;
      if (!edgeSet.has(edgeKey)) {
        edgeSet.add(edgeKey);
        condensedEdges.push({ from: fromSuper, to: toSuper });
        forwardAdj[fromSuper].push(toSuper);
        reverseAdj[toSuper].push(fromSuper);
      }
    }
  }

  return {
    nodes: superNodes,
    edges: condensedEdges,
    nodeToSuperNode,
    forwardAdj,
    reverseAdj,
  };
}
