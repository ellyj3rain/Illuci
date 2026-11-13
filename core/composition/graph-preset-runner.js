/**
 * Graph preset planning and execution bridge.
 *
 * A4.4 makes graph presets executable by compiling them into the existing
 * runNode topology/company/pipeline tree. This module is not a graph
 * interpreter; it is a typed bridge into illuci's current recursive runtime.
 */

import { runNode as realRunNode } from "../orchestrate/node.js";
import { getGraphPreset, resolveGraphPresetById } from "./graph-preset-store.js";
import {
  appendGraphPresetRecord,
  newGraphPresetRecordId,
  writeGraphPresetTranscript,
} from "./graph-preset-record-store.js";

export const GRAPH_PRESET_PLAN_SCHEMA = "illuci.graphPreset.plan/1";
export const GRAPH_PRESET_RUN_SCHEMA = "illuci.graphPreset.run/1";

const EXECUTION_TYPES = new Set(["topology", "company", "pipeline"]);
const CONTAINER_EDGE_TYPES = new Set(["contains", "delegates-to"]);
const ASSIGN_EDGE_TYPES = new Set(["assigns", "uses", "resolves-to"]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value || {}).filter(([, item]) => item !== undefined));
}

function normalizeLineup(lineup = {}) {
  if (!isObject(lineup)) return {};
  return Object.fromEntries(
    Object.entries(lineup)
      .filter(([seatId]) => typeof seatId === "string" && seatId.trim())
      .map(([seatId, value]) => [seatId.trim(), value]),
  );
}

function mergeLineups(...lineups) {
  return lineups.reduce((acc, lineup) => ({ ...acc, ...normalizeLineup(lineup) }), {});
}

function modelValueFromNode(node) {
  if (!node) return null;
  const spec = node.spec || {};
  const customization = node.customization || {};
  return (
    spec.model ||
    spec.modelId ||
    spec.modelRef ||
    spec.providerModel ||
    customization.model ||
    customization.modelId ||
    customization.modelRef ||
    node.ref ||
    null
  );
}

function seatIdForNode(node) {
  const spec = node.spec || {};
  const raw = spec.seatId || spec.seat || spec.id || node.ref || node.id;
  return String(raw).replace(/^seat[._-]/, "");
}

function collectDefaultLineup(preset) {
  const byId = new Map(asArray(preset.nodes).map((node) => [node.id, node]));
  let defaults = {};

  for (const node of asArray(preset.nodes)) {
    if (node?.spec?.lineup) defaults = mergeLineups(defaults, node.spec.lineup);
    if (node?.type === "topology" && node?.customization?.lineup) {
      defaults = mergeLineups(defaults, node.customization.lineup);
    }
    if (node?.type === "seat") {
      const direct = modelValueFromNode(node);
      if (direct) defaults[seatIdForNode(node)] = direct;
    }
  }

  for (const edge of asArray(preset.edges)) {
    if (!ASSIGN_EDGE_TYPES.has(edge.type)) continue;
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (from?.type === "seat" && (to?.type === "model" || to?.type === "provider")) {
      const model = modelValueFromNode(to);
      if (model) defaults[seatIdForNode(from)] = model;
    }
    if ((from?.type === "model" || from?.type === "provider") && to?.type === "seat") {
      const model = modelValueFromNode(from);
      if (model) defaults[seatIdForNode(to)] = model;
    }
  }

  return defaults;
}

function sequenceForEdge(edge, fallback) {
  return Number.isFinite(edge.metadata?.sequence) ? edge.metadata.sequence : fallback;
}

function childrenFor(nodeId, preset, byId) {
  return asArray(preset.edges)
    .map((edge, index) => ({ edge, index }))
    .filter(({ edge }) => CONTAINER_EDGE_TYPES.has(edge.type) && edge.from === nodeId && EXECUTION_TYPES.has(byId.get(edge.to)?.type))
    .sort((a, b) => sequenceForEdge(a.edge, a.index) - sequenceForEdge(b.edge, b.index))
    .map(({ edge }) => byId.get(edge.to));
}

function rootNodeFor(preset, byId, requestedRootId = null) {
  if (requestedRootId && EXECUTION_TYPES.has(byId.get(requestedRootId)?.type)) return byId.get(requestedRootId);
  const governedRoot = preset.governance?.rootNodeId;
  if (governedRoot && EXECUTION_TYPES.has(byId.get(governedRoot)?.type)) return byId.get(governedRoot);

  const delegated = asArray(preset.edges)
    .map((edge, index) => ({ edge, index }))
    .filter(({ edge }) => edge.type === "delegates-to" && byId.get(edge.from)?.type === "orchestrator" && EXECUTION_TYPES.has(byId.get(edge.to)?.type))
    .sort((a, b) => sequenceForEdge(a.edge, a.index) - sequenceForEdge(b.edge, b.index))[0];
  if (delegated) return byId.get(delegated.edge.to);

  const childIds = new Set(asArray(preset.edges)
    .filter((edge) => CONTAINER_EDGE_TYPES.has(edge.type) && EXECUTION_TYPES.has(byId.get(edge.from)?.type))
    .map((edge) => edge.to));
  const root = asArray(preset.nodes).find((node) => EXECUTION_TYPES.has(node.type) && !childIds.has(node.id));
  return root || asArray(preset.nodes).find((node) => EXECUTION_TYPES.has(node.type)) || null;
}

function nodeTopologyId(node) {
  return node.spec?.topologyId || node.spec?.id || node.ref || node.id;
}

function compileExecutionNode(node, preset, ctx, stack = []) {
  if (!node || !EXECUTION_TYPES.has(node.type)) {
    throw new Error(`graph preset node "${node?.id || "unknown"}" is not executable`);
  }
  if (stack.includes(node.id)) {
    throw new Error(`graph preset execution cycle: ${[...stack, node.id].join(" -> ")}`);
  }

  const children = childrenFor(node.id, preset, ctx.byId);
  const spec = node.spec || {};
  const isRoot = node.id === ctx.rootNodeId;
  const inheritedPrompt = isRoot ? ctx.prompt : undefined;
  const nodeLineup = mergeLineups(spec.lineup, ctx.resolvedLineup);
  const base = compactObject({ id: node.id, prompt: inheritedPrompt });

  if (node.type === "topology") {
    return {
      ...base,
      kind: "topology",
      topologyId: nodeTopologyId(node),
      lineup: nodeLineup,
      options: isObject(spec.options) ? spec.options : {},
    };
  }

  if (node.type === "company") {
    const members = children.map((child) => compileExecutionNode(child, preset, ctx, [...stack, node.id]));
    if (members.length === 0 && Array.isArray(spec.members)) members.push(...compileInlineMembers(spec.members, ctx));
    // [A106]/DR-199 — company-level member defaults, fanned into each LEAF
    // member's options at compile (a member's own spec.options wins per key;
    // composite members pass through untouched). Strictly opt-in: absent
    // memberDefaults compiles byte-identically to the pre-[A106] shape.
    const memberDefaults = isObject(spec.memberDefaults) ? spec.memberDefaults : null;
    const fanned = memberDefaults
      ? members.map((member) => (member.kind === "topology"
        ? { ...member, options: { ...memberDefaults, ...member.options } }
        : member))
      : members;
    return compactObject({
      ...base,
      kind: "company",
      members: fanned,
      concurrency: spec.concurrency,
      awareness: spec.awareness,
      maxConcurrent: spec.maxConcurrent,
      tokenCeiling: spec.tokenCeiling,
      // [A106]/DR-199 — a shared-world preamble the company prepends to the
      // effective member prompt (the Foundry world doc pattern).
      preamble: typeof spec.preamble === "string" && spec.preamble.trim() ? spec.preamble : undefined,
    });
  }

  const stages = children.map((child) => compileExecutionNode(child, preset, ctx, [...stack, node.id]));
  if (stages.length === 0 && Array.isArray(spec.stages)) stages.push(...compileInlineMembers(spec.stages, ctx));
  return compactObject({
    ...base,
    kind: "pipeline",
    stages,
  });
}

function compileInlineMembers(items, ctx) {
  return items.map((item, index) => compileInlineItem(item, ctx, index));
}

function compileInlineItem(item, ctx, index) {
  if (typeof item === "string") {
    return { kind: "topology", id: `inline-${index}`, topologyId: item, lineup: ctx.resolvedLineup, options: {} };
  }
  if (!isObject(item)) throw new Error("inline graph preset member/stage must be an object or topology id string");
  if (item.kind === "company") {
    return compactObject({ ...item, members: compileInlineMembers(asArray(item.members), ctx), prompt: undefined });
  }
  if (item.kind === "pipeline") {
    return compactObject({ ...item, stages: compileInlineMembers(asArray(item.stages), ctx), prompt: undefined });
  }
  return {
    ...item,
    kind: "topology",
    id: item.id || `inline-${index}`,
    topologyId: item.topologyId || item.ref || item.id,
    lineup: mergeLineups(item.lineup, ctx.resolvedLineup),
    options: isObject(item.options) ? item.options : {},
  };
}

function metaOrchestratorSummary(preset) {
  return asArray(preset.nodes)
    .filter((node) => node.type === "orchestrator")
    .map((node) => ({
      id: node.id,
      label: node.label,
      privileged: true,
      layer: "meta-orchestrator",
      customization: node.customization || {},
      metadata: node.metadata || {},
    }));
}

function permissionBoundaryRefs(preset) {
  return asArray(preset.nodes)
    .filter((node) => node.type === "permission-boundary")
    .map((node) => node.ref || node.id);
}

function summarizeNodeTree(node) {
  if (!node || typeof node !== "object") {
    return { kind: "unknown", nodeCount: 0, topologyCount: 0, companyCount: 0, pipelineCount: 0 };
  }
  const children = node.kind === "company" ? node.members : node.kind === "pipeline" ? node.stages : [];
  const childSummaries = asArray(children).map(summarizeNodeTree);
  const counts = childSummaries.reduce((acc, summary) => ({
    nodeCount: acc.nodeCount + summary.nodeCount,
    topologyCount: acc.topologyCount + summary.topologyCount,
    companyCount: acc.companyCount + summary.companyCount,
    pipelineCount: acc.pipelineCount + summary.pipelineCount,
  }), {
    nodeCount: 1,
    topologyCount: node.kind === "topology" ? 1 : 0,
    companyCount: node.kind === "company" ? 1 : 0,
    pipelineCount: node.kind === "pipeline" ? 1 : 0,
  });
  return { kind: node.kind, ...counts };
}

export function compileGraphPresetToNodeTree(preset, options = {}) {
  if (!preset || typeof preset !== "object") throw new Error("graph preset compile requires a preset object");
  const byId = new Map(asArray(preset.nodes).map((node) => [node.id, node]));
  const root = rootNodeFor(preset, byId, options.rootNodeId || null);
  if (!root) throw new Error(`graph preset "${preset.id}" has no executable topology/company/pipeline root`);

  const defaultLineup = collectDefaultLineup(preset);
  const invocationLineup = normalizeLineup(options.lineup || {});
  const resolvedLineup = mergeLineups(defaultLineup, invocationLineup);
  const ctx = {
    byId,
    prompt: options.prompt || "",
    rootNodeId: root.id,
    defaultLineup,
    invocationLineup,
    resolvedLineup,
  };
  const compiledNode = compileExecutionNode(root, preset, ctx);
  return {
    presetId: preset.id,
    rootNodeId: root.id,
    rootKind: root.type,
    defaultLineup,
    invocationLineup,
    resolvedLineup,
    compiledNode,
    metaOrchestrator: metaOrchestratorSummary(preset),
    permissionBoundaryRefs: permissionBoundaryRefs(preset),
    summary: summarizeNodeTree(compiledNode),
  };
}

export function presetRunEnabled(env = process.env) {
  return /^(1|true|yes|on)$/i.test(String(env.ILLUCI_PRESET_RUN_ENABLED || ""));
}

export function planGraphPreset(presetId, options = {}) {
  const preset = typeof presetId === "object" ? presetId : getGraphPreset(presetId, options);
  const id = typeof presetId === "string" ? presetId : preset?.id || null;
  if (!preset) {
    return {
      schema: GRAPH_PRESET_PLAN_SCHEMA,
      planned: false,
      presetId: id,
      reason: "unknown-graph-preset",
      errors: [`unknown graph preset: ${id}`],
    };
  }

  try {
    const compiled = compileGraphPresetToNodeTree(preset, options);
    const resolution = resolveGraphPresetById(preset.id, options);
    const envelope = {
      schema: GRAPH_PRESET_PLAN_SCHEMA,
      planned: true,
      presetId: preset.id,
      prompt: options.prompt || "",
      resolution,
      ...compiled,
    };
    if (options.record !== false) {
      envelope.record = appendGraphPresetRecord("plan", {
        presetId: preset.id,
        prompt: envelope.prompt,
        resolution,
        compiledNode: envelope.compiledNode,
        defaultLineup: envelope.defaultLineup,
        resolvedLineup: envelope.resolvedLineup,
        status: "planned",
        resultSummary: envelope.summary,
      }, options);
    }
    return envelope;
  } catch (error) {
    return {
      schema: GRAPH_PRESET_PLAN_SCHEMA,
      planned: false,
      presetId: preset.id,
      reason: "graph-preset-plan-failed",
      errors: [String(error?.message || error)],
    };
  }
}

function summarizeRunResult(result) {
  return {
    ok: Boolean(result?.ok),
    kind: result?.kind || null,
    status: result?.status || (result?.halted ? "halted" : "unknown"),
    sessionId: result?.sessionId || result?.runId || null,
    halted: Boolean(result?.halted),
    haltReason: result?.haltReason || null,
  };
}

function resolveRunNode(deps = {}) {
  if (deps.runNode) return deps.runNode;
  if (process.env.ILLUCI_PRESET_RUN_TEST_STUB === "1") {
    return async (node, ctx = {}) => ({
      ok: true,
      kind: node.kind,
      status: "complete",
      sessionId: ctx.sessionId || "preset-run-test-stub",
      node,
    });
  }
  return realRunNode;
}

// Persist a run record plus its full transcript. The compact record indexes the
// run (status + resultSummary + a transcript pointer); the transcript file holds
// the complete trace at full length so the deliverable is recoverable from disk.
// DR-129: on by default, disclosed via the printed transcript path, opted out
// with `--record-trace false` (options.recordTrace === false). Transcript I/O
// never fails the run — the compact record still lands if the write throws.
function persistRunRecord(recordId, payload, trace, options = {}) {
  let tracePath;
  let traceBytes;
  if (options.recordTrace !== false) {
    try {
      const written = writeGraphPresetTranscript(recordId, trace, options);
      tracePath = written.path;
      traceBytes = written.bytes;
    } catch {
      tracePath = undefined;
    }
  }
  return appendGraphPresetRecord(
    "run",
    { ...payload, ...(tracePath ? { tracePath, traceBytes } : {}) },
    { ...options, recordId },
  );
}

export async function runGraphPreset(presetId, options = {}, deps = {}) {
  const env = options.env || process.env;
  if (!presetRunEnabled(env)) {
    const envelope = {
      schema: GRAPH_PRESET_RUN_SCHEMA,
      ran: false,
      presetId,
      reason: "preset-run-disabled",
      requiredEnv: "ILLUCI_PRESET_RUN_ENABLED=1",
    };
    if (options.recordRefusal !== false) {
      envelope.record = appendGraphPresetRecord("run", {
        presetId,
        prompt: options.prompt || "",
        status: "refused",
        resultSummary: { reason: envelope.reason, requiredEnv: envelope.requiredEnv },
      }, options);
    }
    return envelope;
  }

  const plan = planGraphPreset(presetId, { ...options, record: false });
  if (!plan.planned) {
    return {
      schema: GRAPH_PRESET_RUN_SCHEMA,
      ran: false,
      presetId,
      reason: plan.reason,
      errors: plan.errors || [],
      plan,
    };
  }

  // Pre-generate the record id so the transcript filename (<recordId>.json)
  // matches the record both success and error paths append.
  const recordId = options.recordId || newGraphPresetRecordId("run");

  try {
    const runNode = resolveRunNode(deps);
    const result = await runNode(plan.compiledNode, {
      sessionId: options.sessionId,
      busScope: options.busScope,
      // [A107]/F-138 — the mandate convention (runner.js intake): an
      // explicitly-passed mandate is the parent's MANDATE OBJECT; a flat run
      // passes none and the runner builds from `prompt`. Defaulting this to
      // the prompt STRING sent every real preset run to a crash at
      // `mandate.intent.revision` — the first live dispatch through the
      // foundry canon found it.
      mandate: options.mandate,
      signal: options.signal,
      awareness: options.awareness,
      // [A106]/F-137 — the [A91] identity carry was declared on this path but
      // never fed: runCompanyNode/runTopologyNode read ctx.genome/ctx.agents,
      // and this call site dropped them. Thread the caller's identity context;
      // absent options stay absent (byte-identical un-armed).
      ...(options.genome != null ? { genome: options.genome } : {}),
      ...(options.agents != null ? { agents: options.agents } : {}),
    }, deps);
    const resultSummary = summarizeRunResult(result);
    const envelope = {
      schema: GRAPH_PRESET_RUN_SCHEMA,
      ran: true,
      presetId: plan.presetId,
      prompt: plan.prompt,
      plan,
      result,
      resultSummary,
    };
    if (options.record !== false) {
      envelope.record = persistRunRecord(recordId, {
        presetId: plan.presetId,
        prompt: plan.prompt,
        resolution: plan.resolution,
        compiledNode: plan.compiledNode,
        defaultLineup: plan.defaultLineup,
        resolvedLineup: plan.resolvedLineup,
        status: resultSummary.status,
        resultSummary,
      }, {
        schema: GRAPH_PRESET_RUN_SCHEMA,
        presetId: plan.presetId,
        prompt: plan.prompt,
        plan,
        result,
        resultSummary,
      }, options);
    }
    return envelope;
  } catch (error) {
    const resultSummary = { ok: false, status: "error", error: String(error?.message || error) };
    const envelope = {
      schema: GRAPH_PRESET_RUN_SCHEMA,
      ran: false,
      presetId: plan.presetId,
      prompt: plan.prompt,
      reason: "graph-preset-run-failed",
      errors: [resultSummary.error],
      plan,
      resultSummary,
    };
    if (options.record !== false) {
      envelope.record = persistRunRecord(recordId, {
        presetId: plan.presetId,
        prompt: plan.prompt,
        resolution: plan.resolution,
        compiledNode: plan.compiledNode,
        defaultLineup: plan.defaultLineup,
        resolvedLineup: plan.resolvedLineup,
        status: "error",
        resultSummary,
      }, {
        schema: GRAPH_PRESET_RUN_SCHEMA,
        presetId: plan.presetId,
        prompt: plan.prompt,
        plan,
        reason: "graph-preset-run-failed",
        errors: [resultSummary.error],
        resultSummary,
      }, options);
    }
    return envelope;
  }
}

export default {
  GRAPH_PRESET_PLAN_SCHEMA,
  GRAPH_PRESET_RUN_SCHEMA,
  compileGraphPresetToNodeTree,
  planGraphPreset,
  runGraphPreset,
  presetRunEnabled,
};
