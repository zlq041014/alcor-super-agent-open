import type {
  GraphNode, GraphPlan, GraphProposal, GraphRole, GraphVersion, GraphWait,
} from "../shared/native-graph";
import { overlaps } from "./policy";

export function assertDisjointOutputs(paths: readonly string[]) {
  for (const [index, path] of paths.entries())
    if (paths.slice(0, index).some((p) => overlaps(p, path)))
      throw new Error("成果输出路径重复或重叠：" + path);
}

export function assertGraph(nodes: readonly Pick<GraphNode, "key" | "dependencies" | "outputs">[]) {
  if (nodes.length > 12) throw new Error("成果节点超过 12 项");
  const byKey = new Map(nodes.map((node) => [node.key, node]));
  if (byKey.size !== nodes.length) throw new Error("成果节点编号重复");
  assertDisjointOutputs(nodes.flatMap((node) => node.outputs));
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (key: string) => {
    if (visiting.has(key)) throw new Error("成果依赖不能成环");
    if (visited.has(key)) return;
    const node = byKey.get(key);
    if (!node) throw new Error("成果依赖不存在：" + key);
    visiting.add(key);
    node.dependencies.forEach(visit);
    visiting.delete(key);
    visited.add(key);
  };
  nodes.forEach((node) => visit(node.key));
}

export function validateProposal(
  existing: readonly GraphNode[],
  proposed: GraphProposal["nodes"],
  inheritedInputs: readonly string[],
) {
  assertGraph([...existing, ...proposed]);
  assertDisjointOutputs([...inheritedInputs, ...proposed.flatMap((n) => n.outputs)]);
}

export function affectedGraphNodes(nodes: readonly GraphNode[], key: string) {
  const affected = new Set([key]);
  let size: number;
  do {
    size = affected.size;
    for (const node of nodes)
      if (node.dependencies.some((dep) => affected.has(dep))) affected.add(node.key);
  } while (affected.size !== size);
  return nodes.filter((node) => affected.has(node.key));
}

export function requiredGraphNodes(nodes: readonly GraphNode[]) {
  const required = new Set<string>();
  const index = new Map(nodes.map((n) => [n.key, n]));
  const visit = (node: GraphNode) => {
    if (required.has(node.key)) return;
    required.add(node.key);
    for (const key of node.dependencies) visit(index.get(key)!);
  };
  nodes.filter((node) => node.required).forEach(visit);
  return nodes.filter((node) => required.has(node.key));
}

export function acceptedGraphVersion(node: GraphNode): GraphVersion {
  return { nodeId: node.id, revision: node.revision, reviewRunId: node.accepted!.reviewRunId };
}

export function sameGraphVersions(a: readonly GraphVersion[], b: readonly GraphVersion[]) {
  return a.length === b.length && a.every((ref, i) =>
    ref.nodeId === b[i].nodeId && ref.revision === b[i].revision &&
    ref.reviewRunId === b[i].reviewRunId);
}

type GraphNodeJob = { role: "execute" | "review" | "research"; node: GraphNode; inputs: GraphVersion[] };
export type GraphJob =
  | GraphNodeJob
  | { role: "assemble" | "final"; inputs: GraphVersion[] };

export function planGraph(
  plan: GraphPlan,
  nodes: readonly GraphNode[],
  runs: ReadonlyMap<string, { state: string; role: GraphRole; nodeRevision: number }>,
  held: ReadonlySet<string>,
  options: { paused: boolean; expired: boolean; remaining: number; previews?: ReadonlyMap<string, string> },
) {
  const index = new Map(nodes.map((node) => [node.key, node]));
  const required = requiredGraphNodes(nodes);
  const requiredKeys = new Set(required.map((node) => node.key));
  const waiting = new Map<string, GraphWait>();
  const branches: GraphNodeJob[] = [];
  const finalReserve = plan.finalAccepted || plan.finalRunId ? 0 : 1;
  const minimum = required.reduce((sum, node) => {
    if (node.accepted) return sum;
    const run = node.activeRunId ? runs.get(node.activeRunId) : undefined;
    if (run?.nodeRevision === node.revision) return sum + (run.role === "execute" ? 1 : 0);
    if (node.previewJobId && options.previews?.has(node.previewJobId)) return sum + 1;
    return sum + (node.research || node.draft ? 1 : 2);
  }, finalReserve);
  for (const node of nodes) {
    if (node.accepted) continue;
    const active = node.activeRunId ? runs.get(node.activeRunId) : undefined;
    const deps = node.dependencies.map((dep) => index.get(dep)!);
    const research = node.research?.spec;
    if (active) {
      if (active.state === "unknown") waiting.set(node.key, "receipt");
    } else if (node.previewJobId && options.previews?.has(node.previewJobId))
      waiting.set(node.key, options.previews.get(node.previewJobId) === "unknown" ? "receipt" : "preview");
    else if (options.paused) waiting.set(node.key, "paused");
    else if (node.blocked) waiting.set(node.key, "blocked");
    else if (research?.mode === "local" ||
        (research?.mode === "parallel" && index.get(research.consumer)!.accepted))
      waiting.set(node.key, "blocked");
    else if (deps.some((dep) => !dep.accepted)) waiting.set(node.key, "input");
    else if (node.resources.some((resource) => held.has(resource))) waiting.set(node.key, "resource");
    else if ((plan.assembled && !plan.assembled.stale) || plan.finalAccepted) waiting.set(node.key, "blocked");
    else if (options.expired || options.remaining < minimum ||
        (!requiredKeys.has(node.key) && options.remaining < minimum + (node.research || node.draft ? 1 : 2)))
      waiting.set(node.key, "budget");
    else branches.push({
      role: node.research ? "research" : node.draft ? "review" : "execute", node,
      inputs: deps.map(acceptedGraphVersion),
    });
  }
  const compare = (a: GraphNode, b: GraphNode) => {
    const requiredFirst = Number(requiredKeys.has(b.key)) - Number(requiredKeys.has(a.key));
    return requiredFirst || a.updatedAt.localeCompare(b.updatedAt) || a.key.localeCompare(b.key);
  };
  const jobs: GraphJob[] = branches.sort((a, b) => compare(a.node, b.node));
  if (!options.paused && !options.expired && options.remaining >= finalReserve &&
      !plan.finalRunId && !plan.finalAccepted && !plan.finalFailure &&
      required.every((node) => node.accepted) &&
      nodes.every((node) => (!node.activeRunId || node.research?.spec.mode === "parallel") &&
        (!node.previewJobId || !options.previews?.has(node.previewJobId)))) {
    const inputs = nodes.filter((node) => node.accepted && !node.research && node.kind !== "standard")
      .map(acceptedGraphVersion);
    if (!plan.assembled) jobs.unshift({ role: "assemble", inputs });
    else if (plan.assembled.state === "ready" && !plan.assembled.stale &&
        sameGraphVersions(plan.assembled.versions, inputs))
      jobs.unshift({ role: "final", inputs });
  }
  return { jobs, waiting, minimum };
}
