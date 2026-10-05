/**
 * The flow engine.
 *
 * A node is a pure function with declared inputs. The engine runs them in
 * dependency order, hands each one its inputs' values, and keeps the result.
 * That is the whole mechanism - there is no second path by which a number can
 * arrive, which is the point of rebuilding this.
 *
 * WHY THIS EXISTS AT ALL
 *
 * The old DATA FLOW page was a drawing. It was derived from a catalogue of
 * prose describing what the app did elsewhere, so it could describe a
 * pipeline that no longer existed and look perfectly correct doing it. The
 * boxes did not hold values; the arrows did not carry them.
 *
 * Here the arrows ARE the dependencies. A box shows the value its function
 * returned, computed from the boxes feeding it, in this file's own run. If a
 * box is empty, that computation genuinely produced nothing - it cannot be
 * stale, because nothing is cached between runs and nothing is read from
 * anywhere else.
 *
 * WHAT A NODE LOOKS LIKE
 *
 *   {
 *     id:    'gate.perp',
 *     col:   'GATES',               which column it is drawn in
 *     title: 'Perp elsewhere',
 *     deps:  ['norm.identity', 'src.perps'],
 *     run:   ({ 'norm.identity': id, 'src.perps': perps }, ctx) => ...
 *     show:  (value) => [ { k, v, c } ]   rows to print inside the box
 *   }
 *
 * `run` may be async (the source nodes read files). Everything downstream is
 * synchronous arithmetic, which is what makes the whole pipeline inspectable:
 * given the same inputs it produces the same outputs, every time, with no
 * clock and no network in the middle.
 *
 * FAILURE IS A VALUE
 *
 * A node that throws is recorded as `error` and its dependents are marked
 * `blocked` rather than being run with undefined inputs. A node that returns
 * null is `empty` - it ran, and the honest answer was nothing. Those are
 * different states and the page draws them differently, because "we could not
 * measure this" and "this measured zero" are different facts.
 */

/** Node result states, in the order a reader cares about them. */
export const STATE = {
  OK: 'ok',
  EMPTY: 'empty',
  ERROR: 'error',
  BLOCKED: 'blocked',
  SKIPPED: 'skipped',
};

/**
 * Orders nodes so every node runs after its dependencies.
 *
 * Kahn's algorithm. A cycle would mean a value defined in terms of itself,
 * which is a bug in the graph rather than something to lay out around, so it
 * is reported instead of silently broken.
 */
export function topoSort(nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const indegree = new Map(nodes.map((n) => [n.id, 0]));
  const dependents = new Map(nodes.map((n) => [n.id, []]));

  for (const node of nodes) {
    for (const dep of node.deps || []) {
      if (!byId.has(dep)) throw new Error(`${node.id} depends on unknown node ${dep}`);
      indegree.set(node.id, indegree.get(node.id) + 1);
      dependents.get(dep).push(node.id);
    }
  }

  const ready = nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  const order = [];
  while (ready.length) {
    const id = ready.shift();
    order.push(id);
    for (const next of dependents.get(id)) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) ready.push(next);
    }
  }

  if (order.length !== nodes.length) {
    const stuck = nodes.filter((n) => !order.includes(n.id)).map((n) => n.id);
    throw new Error('cycle in the flow graph: ' + stuck.join(', '));
  }
  return order.map((id) => byId.get(id));
}

/**
 * Runs the graph once and returns a result per node.
 *
 * `ctx` is whatever the graph needs that is not a node - the chain and token
 * being traced, and the clock. It is passed to every `run`, never mutated by
 * the engine, and is the only way anything outside gets in.
 */
export async function runFlow(nodes, ctx) {
  const order = topoSort(nodes);
  const results = new Map();
  const startedAll = Date.now();

  for (const node of order) {
    const deps = node.deps || [];
    const blocked = deps.filter((d) => {
      const r = results.get(d);
      return r && (r.state === STATE.ERROR || r.state === STATE.BLOCKED);
    });

    if (blocked.length) {
      results.set(node.id, {
        id: node.id, state: STATE.BLOCKED, value: null, ms: 0,
        error: null, blockedBy: blocked,
      });
      continue;
    }

    const inputs = {};
    for (const dep of deps) {
      const r = results.get(dep);
      inputs[dep] = r ? r.value : null;
    }

    const startedAt = Date.now();
    try {
      const value = await node.run(inputs, ctx);
      const empty = value === null || value === undefined;
      results.set(node.id, {
        id: node.id,
        state: empty ? STATE.EMPTY : STATE.OK,
        value: empty ? null : value,
        ms: Date.now() - startedAt,
        error: null, blockedBy: [],
      });
    } catch (error) {
      results.set(node.id, {
        id: node.id, state: STATE.ERROR, value: null,
        ms: Date.now() - startedAt,
        error: String((error && error.message) || error).slice(0, 200),
        blockedBy: [],
      });
    }
  }

  const counts = { ok: 0, empty: 0, error: 0, blocked: 0 };
  results.forEach((r) => { counts[r.state] = (counts[r.state] || 0) + 1; });

  return {
    at: Date.now(),
    ms: Date.now() - startedAll,
    ctx,
    order: order.map((n) => n.id),
    results,
    counts,
  };
}

/**
 * Columns in draw order, each with the nodes that belong to it.
 *
 * The column is declared on the node rather than inferred from the graph: a
 * layered DAG layout would put a node wherever its longest path lands, which
 * moves boxes around whenever an edge is added. A reader needs the stages to
 * stay where they were yesterday.
 */
export function columnsOf(nodes, columnOrder) {
  return columnOrder
    .map((col) => ({ col, nodes: nodes.filter((n) => n.col === col) }))
    .filter((c) => c.nodes.length);
}

/** Every edge, as {from, to}, for drawing. */
export function edgesOf(nodes) {
  const out = [];
  for (const node of nodes) {
    for (const dep of node.deps || []) out.push({ from: dep, to: node.id });
  }
  return out;
}
