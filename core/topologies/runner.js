import {rejectUnsupportedBoundWork} from '../agent/work-boundary.js';
/**
 * illuci — Topology Runner
 *
 * Executes a topology with an operator-provided lineup.
 *
 * The topology defines seats and phase relationships.
 * The lineup maps seats to models. Every seat is independently
 * assignable. The same model can sit in different seats across
 * different phases of the same task.
 *
 * The capability matrix provides roleHint-based auto-fill ONLY
 * for seats the operator leaves unassigned. Explicit assignment
 * always wins.
 *
 * Every seat assignment and phase execution is provenance-stamped.
 */

import { getTopology, validateLineup, getSeatFireControl, compileGraph } from "./index.js";
import { buildMandate, reviseMandate } from "./mandate.js";
import { composeSeatFrame, buildSeatLabels, renderYouBlock } from "./frame.js";
import { resolveAgenda, createCursor, createArrangementTimeline } from "./agenda.js";
import { buildExecuteCommandPrompt } from "./execute-prompt.js";
import { stepFiringMode, needsCheckpoint, resolveCheckpoint } from "./checkpoint.js";
import { loadOrg, applyKindPolicy, extractPersonaModelResource } from "../projects/org.js";
import { buildSessionRecord, appendSessionRecord, distillSession, loadAgentDigest, buildAgentContinuityBlocks, createAgentContinuityObserver } from "../sessions/record.js";
import { createHash } from "node:crypto";
import { getSkill } from "../agents/skill-registry.js";
import { renderSkillsBlock, resolveSeatGrants } from "../skills/grants.js";
import { resolveSkillFrameworkBlocksForTopology } from "../roles/skill-frameworks/frame.js";
import {
  appendCognitiveClassificationTrace,
  buildCognitiveClassification,
  renderCognitiveBlock,
} from "../governance/classifiers/cognitive-classifier.js";
import { resolveCapabilityGrants, intersectResolutions } from "../governance/grants/resolve.js";
import {
  deriveRunToolAutonomy,
  normalizeRunControl,
  phaseModeForRunControl,
  runControlAgendaMode,
} from "../orchestrate/run-control.js";

// [A39]/CAP-3: one resolution per seat dispatch — the seat's own record-backed
// resolution (R4: store only), intersected with any parent chain (R1: a parent
// without a capability can never confer it on a child). Fail-closed to null.
// [A40]/CAP-4 R2 session-pinning: ONE frozen resolution per (run, seat),
// resolved at the seat's first dispatch and reused for the run's lifetime —
// mid-run record changes take effect at the NEXT run (the ratified
// revocation-at-next-resolution semantic), and no TOCTOU re-reads exist.
const capabilityResolutionPins = new WeakMap();
// Process-owned observation ports survive internal option spreads, then are
// removed before crossing the buffered dispatch boundary. Wire fields cannot
// select these symbols or manufacture an observer for a run.
const continuityObserverKey = Symbol("continuityObserver");
const continuityPhaseKey = Symbol("continuityPhase");
const assignedAgentRequirementKey = Symbol("assignedAgentRequirement");
function capabilityResolutionFor(dispatchOpts, seatId) {
  try {
    let pins = capabilityResolutionPins.get(dispatchOpts);
    if (!pins) {
      pins = new Map();
      capabilityResolutionPins.set(dispatchOpts, pins);
    }
    const key = seatId || "";
    if (!pins.has(key)) {
      const own = resolveCapabilityGrants(
        {
          seatId: seatId || null,
          runId: dispatchOpts?.runId || null,
          tenantId: dispatchOpts?.tenantId || null,
        },
        // Run-control tools.autonomy "governed" enables the per-run mandatory-permit switch.
        { runPermitMandatory: dispatchOpts?.capabilityPermitMandatory === true || process.env.ILLUCI_CAPABILITY_PERMIT_MANDATORY === "1" },
      );
      pins.set(
        key,
        dispatchOpts?.parentCapabilityResolution
          ? intersectResolutions(dispatchOpts.parentCapabilityResolution, own)
          : own,
      );
    }
    return pins.get(key);
  } catch {
    return null;
  }
}
import { setActiveSession } from "../events/sse-server.js";
import { queryModel } from "../dispatch/dispatch.js";
import { logDecision } from "../decisions/logger.js";
import { deriveFromTask, clearApprovalContext } from "../gates/approval-context.js";
import { calibrate } from "../analysis/calibration.js";
import { detectCorrelation } from "../analysis/correlation.js";
import { computeMarginalValue } from "../analysis/marginal-value.js";
import { createBudget } from "../throttle/budget.js";
import { createSeatBudget } from "../throttle/seat-budget.js";
import { executeTool } from "../bridges/tools.js";
import { existsSync, readdirSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import { composeBehavioralDisposition, buildSeatAssignments } from "../composition/disposition-resolver.js";
import { collectGraderInput } from "../agents/grader-measurement.js";
import { loadPersonaKernel } from "../agents/persona-kernel.js";
import { applyGradeFromRecord } from "../agents/genome-grade.js";
import { normalizeChildIdentity, carryChildIdentity } from "../orchestrate/child-identity.js";
import { collectRunTreeIds } from "../agents/grader-measurement.js";

// A84/DR-177: warn ONCE per process when the genome control is on but the
// mutation kernel is not built — learning inactive must be visible, not silent.
let warnedKernelAbsent = false;
import { composeModelDelegation } from "../composition/model-delegation.js";
import { preflightLineup, PreflightError } from "../preflight/index.js";
import {
  resolveAgentLineup,
  bindResolvedModelsToAgents,
  agentDispositionMap,
  publicAgentAssignments,
  buildAgentSeatAssignments,
  mergeSeatAssignmentMetadata,
} from "../agents/assignment.js";

/**
 * AMD-8 — classify a gated phase's outcome into an HONEST status + reason.
 *
 * The bug this closes: the runner collapsed three distinct content-gate failure
 * modes into one hardcoded "Gate check failed" haltReason, so a downstream reader
 * could not tell a dead seat from an all-empty phase from a low-confidence vote.
 * This pure helper computes the three booleans and returns the distinct reason for
 * whichever fired, in OR-precedence order (errors → emptiness → confidence floor):
 *
 *   hasErrors       -> "seat-error"   (≥1 seat threw / errored / timed out)
 *   allEmpty        -> "all-empty"    (every seat returned an empty response)
 *   belowConfidence -> "systemConfidence X < min Y"
 *
 * It is the CONTENT gate (responses failed a quality check). It is NOT the operator
 * dispatch gate — a real gate DENIAL is decided at the dispatch/enforcement layer and
 * keeps its own distinct reason there; this helper never relabels a dispatch denial.
 *
 * @param {{ responses?: Array<{response?:any, error?:any}>, calibration?: {systemConfidence:number|null} }} phaseResult
 * @param {number|null} minConfidence — the confidence floor (falsy ⇒ floor not enforced)
 * @returns {{ status: "pass"|"fail", reason: string|null }}
 */
export function classifyGateResult(phaseResult = {}, minConfidence = null) {
  const responses = Array.isArray(phaseResult.responses) ? phaseResult.responses : [];
  const hasErrors = responses.some((r) => r && r.error);
  // An empty phase (no responses at all) is "all-empty"; .every([]) is vacuously true,
  // matching the prior inline semantics where a no-response phase failed the gate.
  const allEmpty = responses.every((r) => !r || !r.response);
  const belowConfidence = !!minConfidence
    && phaseResult.calibration?.systemConfidence !== null
    && phaseResult.calibration?.systemConfidence !== undefined
    && phaseResult.calibration.systemConfidence < minConfidence;

  if (!(hasErrors || allEmpty || belowConfidence)) {
    return { status: "pass", reason: null };
  }
  let reason;
  if (hasErrors) reason = "seat-error";
  else if (allEmpty) reason = "all-empty";
  else reason = `systemConfidence ${phaseResult.calibration.systemConfidence.toFixed(2)} < min ${minConfidence}`;
  return { status: "fail", reason };
}

/**
 * M1: resolve a seat's [Behavioral Disposition] block as a STRING (or null),
 * without appending it to any message. The frame composer (frame.js) places
 * it in the fixed block order. Explicit pipeline modifiers override seat
 * disposition. Emits disposition_resolved telemetry.
 *
 * @returns {Promise<string|null>} "[Behavioral Disposition]\n…" or null
 */
async function resolveDispositionBlock({ modelId, seatId, agentId = null, seatDef, dispatchOpts, sessionId, topologyId, phaseId }) {
  // Pipeline modifiers are explicit per-model instruction overlays.
  const mods = dispatchOpts?.modifiers?.[modelId];
  if (mods?.length) {
    return `[Behavioral Disposition]\n${mods.join("\n")}`;
  }
  const { block, engine, audit, meta, graderProfile } = await composeBehavioralDisposition({
    modelId, seatId, agentId, seatDef, dispatchOpts,
  });
  let graderRecord = null; // hoisted: the C1 learning step below consumes it
  try {
    telemetryStore.recordEvent({
      run_id: topologyId,
      session_id: sessionId,
      project_id: dispatchOpts?.projectId || null,
      event_type: "disposition_resolved",
      phase_id: phaseId,
      seat_id: seatId,
      model_id: modelId,
      payload: { engine, audit, meta },
    });
    // Moat intake (W3): persist the composition ACT as queryable ontology
    // metadata — the node+edge record (topology -> seat -> persona/model ->
    // preset -> role -> skills) plus the disposition fingerprint (captured from
    // meta.identity as of A76/DR-169 — the composed identity was produced here
    // but dropped before). Capturing it into the telemetry store is the first,
    // dependency-free step of the composition-metadata moat.
    // The graph and any semantic layer grow into this once the firehose fills it.
    telemetryStore.recordEvent({
      run_id: topologyId,
      session_id: sessionId,
      project_id: dispatchOpts?.projectId || null,
      event_type: "composition_resolved",
      phase_id: phaseId,
      seat_id: seatId,
      model_id: modelId,
      payload: {
        engine,
        edges: {
          topologyId: topologyId || null,
          // [A90]/DR-182 P1 (D5.1 + the D2 prerequisite): the persona + lineage
          // coordinates — the MINTED run id (the run_id column above carries the
          // topology id, kept for compatibility), the spawn parent, the tree
          // depth, and the seated durable agent. Phase 2's composite measurement
          // partition keys on these edges.
          runId: dispatchOpts?.runId ?? null,
          parentRunId: dispatchOpts?.parentRunId ?? null,
          depth: dispatchOpts?.spawnDepth ?? 0,
          agentId: agentId ?? null,
          seatId,
          modelId,
          presetId: meta?.presetId ?? null,
          role: meta?.role ?? null,
          skills: Array.isArray(meta?.skills) ? meta.skills : [],
        },
        disposition: {
          fingerprint: meta?.identity?.composed?.fingerprint ?? null,
          baseFingerprint: meta?.identity?.base?.fingerprint ?? null,
          slug: meta?.identity?.composed?.slug ?? null,
          activeFacets: meta?.activeFacets ?? null,
          activeDarkTriad: meta?.activeDarkTriad ?? null,
          activePid5: meta?.activePid5 ?? null,
          activeValues: meta?.activeValues ?? null,
          enneagramCore: meta?.enneagramCore ?? null,
          directiveCount: meta?.directiveCount ?? null,
        },
      },
    });
    // A78/DR-171 (Phase A1 of DR-170): the multi-lens grader-input record — the
    // measurement the Rust `grade` consumes. A80 (Phase A3) joined the inline
    // (preset-less) seats via the resolver's graderProfile; bounded advisory
    // read, same never-block-dispatch posture as the events above.
    if (engine === "dimensional" && (meta?.presetId || graderProfile)) {
      const priorPayloads = telemetryStore
        .getEvents({ event_type: "composition_resolved", limit: 200 })
        .map((e) => e && e.payload)
        .filter(Boolean)
        // F-127 ([A90]/DR-182 P1): getEvents returns newest-first; the lenses'
        // contract is chronological (latest LAST — the provenance lens reads
        // [len-1]). Un-reversed, "the latest fingerprint" was the window's
        // OLDEST row and the consistency trend ran backwards.
        .reverse();
      // [A91]/DR-184 (the D2 COMPOSITE partition, ratified DR-182): persona-
      // primary — the population measured IS the population mutated (the
      // window filters by the seated durable agentId; the per-seat lenses
      // then narrow within the persona's history). No seated agent -> the
      // fallback is seatId × THIS RUN TREE (runIds connected through the
      // parentRunId edges the window itself carries) — seat-name pooling
      // across unrelated runs/history is dead either way.
      const windowEvents = agentId
        ? priorPayloads.filter((p) => p?.edges?.agentId === agentId)
        : (() => {
            const treeIds = collectRunTreeIds(priorPayloads, dispatchOpts?.runId ?? null, dispatchOpts?.parentRunId ?? null);
            return priorPayloads.filter((p) => p?.edges?.seatId === seatId && treeIds.has(p?.edges?.runId));
          })();
      // [A102]/DR-195: the persona's accrued prior OUTCOME evidence for the
      // behavioral lens — queried here (like windowEvents) and passed pure into
      // collectGraderInput. Only meaningful when a durable agentId is seated;
      // empty for preset-less / first-run personas (behavioral honestly nulls).
      const priorOutcomes = agentId
        ? telemetryStore
            .getEvents({ event_type: "phase_outcome", limit: 200 })
            .map((e) => e && e.payload)
            .filter((p) => p && p.agentId === agentId && p.seatId === seatId)
        : [];
      graderRecord = collectGraderInput({
        seatId,
        presetId: meta?.presetId || null,
        events: windowEvents,
        profile: graderProfile || null,
        outcomes: priorOutcomes,
        // The run-tree lens tag (D2): every grader record carries its tree
        lineage: {
          runId: dispatchOpts?.runId ?? null,
          parentRunId: dispatchOpts?.parentRunId ?? null,
          depth: dispatchOpts?.spawnDepth ?? 0,
        },
      });
      telemetryStore.recordEvent({
        run_id: topologyId,
        session_id: sessionId,
        project_id: dispatchOpts?.projectId || null,
        event_type: "grader_input",
        phase_id: phaseId,
        seat_id: seatId,
        model_id: modelId,
        payload: graderRecord,
      });
    }
  } catch {
    // Telemetry must never block dispatch.
  }

  // A84/DR-177 (Phase C1): the loop CLOSES. When the genome seated THIS
  // composition (meta.genome — the A80 explicit control was on) and the
  // mutation kernel is present, grade the record and append the delta; the
  // persona's NEXT composition replays it (run N's signals shape run N+1).
  // Learning never blocks dispatch, but it degrades LOUDLY, never silently.
  if (graderRecord && meta?.genome && dispatchOpts?.genome?.projectDir) {
    try {
      const kernel = loadPersonaKernel();
      if (!kernel.available) {
        if (!warnedKernelAbsent) {
          warnedKernelAbsent = true;
          console.warn(`[genome] learning inactive: ${kernel.reason}`);
        }
      } else {
        const learned = applyGradeFromRecord({
          kernel,
          graderInput: graderRecord,
          projectDir: dispatchOpts.genome.projectDir,
          slug: meta.genome.slug,
          // [A101]/DR-194: which lenses DIRECT the delta. Default ["tension"]
          // (byte-identical); the disclosed control arms "salient" per the run.
          gradingSources: dispatchOpts.genome.gradingSources,
          provenance: {
            // [A90]/DR-182 P1 (D5.1): the MINTED run id (pre-A90 this carried
            // the topology id) + spawn lineage — extra top-level delta fields
            // by the validateDelta contract (replay ignores them).
            runId: dispatchOpts?.runId ?? topologyId ?? null,
            parentRunId: dispatchOpts?.parentRunId ?? null,
            depth: dispatchOpts?.spawnDepth ?? 0,
            seatId,
            fingerprint: meta?.identity?.composed?.fingerprint ?? null,
          },
          // A85/DR-178: the opportunistic seal trigger rides the same control.
          sealThreshold: dispatchOpts.genome.sealThreshold,
        });
        if (learned?.noDelta) {
          // [A100]/DR-193 (F-133): no-learning is a typed observation. A seat
          // that composes and is measured but derives no delta was SILENT
          // pre-A100 (no event of any kind) — a structurally-mute disposition
          // (zero tension pairs) was indistinguishable from a young one. The
          // reason + gate signals feed the DR-176 re-weighting analysis.
          try {
            telemetryStore.recordEvent({
              run_id: topologyId,
              session_id: sessionId,
              project_id: dispatchOpts?.projectId || null,
              event_type: "genome_no_delta",
              phase_id: phaseId,
              seat_id: seatId,
              model_id: modelId,
              payload: {
                slug: meta.genome.slug,
                reason: learned.noDelta,
                stabilityScore: learned.stabilityScore,
                runCount: learned.runCount,
              },
            });
          } catch {
            // Telemetry must never block dispatch.
          }
        } else if (learned) {
          try {
            telemetryStore.recordEvent({
              run_id: topologyId,
              session_id: sessionId,
              project_id: dispatchOpts?.projectId || null,
              event_type: "genome_appended",
              phase_id: phaseId,
              seat_id: seatId,
              model_id: modelId,
              payload: {
                slug: meta.genome.slug,
                gradedFacets: learned.gradedFacets,
                // [A101]/DR-194: which lens(es) directed this delta — ["tension"]
                // on a default run; ["salient"]/["behavioral"] when armed.
                lenses: learned.lenses,
                // [A102]/DR-195: behavioral's capped confidence + method, when it directed.
                ...(learned.attribution ? { attribution: learned.attribution } : {}),
                activeLedgerLen: learned.activeLedgerLen,
                baseRef: learned.baseRef,
              },
            });
            if (learned.sealed) {
              telemetryStore.recordEvent({
                run_id: topologyId,
                session_id: sessionId,
                project_id: dispatchOpts?.projectId || null,
                event_type: "genome_sealed",
                phase_id: phaseId,
                seat_id: seatId,
                model_id: modelId,
                payload: {
                  slug: meta.genome.slug,
                  baseRef: learned.sealed.baseRef,
                  deltasSealed: learned.sealed.deltasSealed,
                },
              });
            }
          } catch {
            // Telemetry must never block dispatch.
          }
        }
      }
    } catch (err) {
      console.warn(`[genome] learning append failed for "${meta.genome.slug}": ${err.message}`);
      try {
        telemetryStore.recordEvent({
          run_id: topologyId,
          session_id: sessionId,
          project_id: dispatchOpts?.projectId || null,
          event_type: "genome_append_failed",
          phase_id: phaseId,
          seat_id: seatId,
          model_id: modelId,
          payload: { slug: meta.genome.slug, error: err.message },
        });
      } catch {
        // Telemetry must never block dispatch.
      }
    }
  }
  return block || null;
}
import { isModelPaused, drainInjections } from "../events/sse-server.js";
import { queryWithWrite } from "../bridges/codex.js";
import { createStageArtifact, ArtifactType } from "../pipelines/pipeline-types.js";
import {
  emitTopologyStart, emitTopologyComplete,
  emitPhaseStart, emitPhaseComplete,
  emitPhaseHandoff, emitPhaseReturn,
  emitGateHalt, emitBudgetUpdate,
  runWithContext, nextRunId,
} from "../events/emitter.js";
// Phase 2 — opt-in loop-capable seats. Off by default: a seat dispatches single-shot
// via queryModel unless it is marked loop-capable, in which case it runs the agent
// loop and can call in-context tools (query_sibling).
import { runSeatLoop } from "../orchestrate/seat-loop.js";
import { siblingTool } from "../orchestrate/sibling.js";
// Phase 3 — the awareness bus. Off by default: a seat recalls a cross-team digest
// into its frame and publishes its outcome only when dispatchOpts.awareness is set.
import { recallBlock, publish } from "../awareness/store.js";
import { computeAwarenessBudget, estTokens } from "../awareness/budget.js";
// Phase 5 — recursive spawn. Off by default: a loop-capable seat gains spawn_topology
// (a bounded, gated child-topology tool) only when dispatchOpts.spawn is set.
import { getOrCreateTree, makeSpawnTool, conveneChildTopology } from "../orchestrate/spawn.js";
// Phase 7 — same-loop detached runs. Off by default: when dispatchOpts.spawnDetached is
// armed (and spawn is on), spawn_topology returns a childRunId immediately and a sibling
// collect_topology tool polls/awaits it. getOrCreateRegistry mirrors getOrCreateTree.
import { getOrCreateRegistry } from "../orchestrate/detached-registry.js";
import { requestApproval } from "../gates/gate-controller.js";
// Model-resource — resolve a seat's lineup value (a flat id OR a family.variant.reasoning
// selection like "claude.sonnet.medium") to a concrete dispatch target + reasoning params.
import { resolve as resolveSelection, getEntry } from "../model-resource.js";
import { getEntry as getBridgeRegistryEntry } from '../bridges/model-registry.js';
import { applyReasoningParamMap } from "../model-resource-reasoning-map.js";
import { compileDispatchTarget, getModelResource, resolveModelResource } from "../fleet/resource-gateway.js";
import { createSandbox, cleanupAllSandboxes, getSandboxDiff, commitSandbox } from "../sandbox/workspace.js";
import { createPR, formatPRsForReview } from "../sandbox/pr-manager.js";
import * as telemetryStore from '../telemetry/store.js';
// [A17.4] Adaptive control cycle — the deterministic routing floor. A gate FAIL
// is routed (loop the phase, bounded) instead of unconditionally halting; a
// clean run never consults it and a pinned-linear run (adaptive:false) keeps
// today's halt byte-identical. Topology-level; distinct from adaptiveFallback.
// [A17.5] The loop edge re-enters at T, not A (TAOR, DR-114): the re-inserted
// step carries the failure observation and the retry's input opens with it.
import { resolveAdaptivePolicy, classifyPhaseOutcome, buildRetryAnnotation, composeAdaptiveRetryInput, buildBranchAnnotation, composeAdaptiveBranchInput, composeAdaptiveRecurseInput, composeEscalationPrompt, interpretEscalationVerdict } from "./adaptive-route.js";
// [A17.6] Run-start T (TAOR, DR-114): conducted is the default agenda
// disposition, and when neither the caller nor the org names a delegated
// anchor, the topology-derived default (first seat of the first phase) plans.
import { defaultAnchorModel } from "./anchor.js";

// ─── VALID EXECUTION MODES ───
const VALID_MODES = ["respond", "write", "read", "execute", "delegate"];

/**
 * Execute a topology with a lineup.
 *
 * @param {string} topologyId — which topology pattern to run
 * @param {object} lineup — { seatId: modelId | [modelId, ...] } — the coach's lineup
 * @param {string} prompt — the task
 * @param {object} options
 * @param {string} options.humanStatus — provenance
 * @param {string} options.context — provenance
 * @param {number} options.tokenBudget — max tokens for the run (null = unlimited)
 * @param {number} options.minConfidence — halt if systemConfidence below this (0-1)
 * @param {number} options.minMarginalValue — flag phases below this threshold
 * @param {Object.<string, string[]>} [options.modifiers] — per-model prompt modifiers.
 *   Keys are model IDs, values are arrays of strings appended to the prompt as
 *   [Behavioral Disposition]. When present, these replace seat-scoped disposition
 *   composition for that model.
 * @param {Object.<string, object>} [options.seatDispositions] — per-seat disposition configs.
 *   Keys are seat IDs. Active config accepts presetId/profile plus role and skills.
 * @returns {object} Full execution trace
 */
export async function runTopology(topologyId, lineup, prompt, options = {}, parentSessionId = null) {
  rejectUnsupportedBoundWork(options,'topology and spawned child execution');
  if (options.spawnFeedbackHost) throw new Error('The requested host feedback adapter is not included in this build');
  if (Object.hasOwn(options, "requireAssignedAgent") && typeof options.requireAssignedAgent !== "boolean") {
    throw new TypeError("requireAssignedAgent must be a boolean");
  }
  // Establish the per-run context scope BEFORE any execution, so concurrent runs
  // (the company) and recursively-spawned children each get an isolated run_id and
  // clock. sessionId is the parent session for pipeline/spawn children, else fresh.
  const sessionId = parentSessionId || `illuci-${Date.now()}`;
  const runCtx = {
    runId: nextRunId(topologyId),
    sessionId,
    projectId: options.projectId ?? null,
    topologyName: getTopology(topologyId).name,
  };
  const trace = await runWithContext(runCtx, () => runTopologyInner(topologyId, lineup, prompt, options, sessionId, runCtx.runId));
  // Surface the run scope's identity on the returned trace so callers (runCompany
  // members, the ACP adapter) report the REAL runId/sessionId rather than pre-minting
  // a guess that would desync from the actual AsyncLocalStorage scope.
  if (trace && typeof trace === "object") {
    if (trace.runId === undefined) trace.runId = runCtx.runId;
    if (trace.sessionId === undefined) trace.sessionId = sessionId;
  }
  // ── [A16.2] Datastore capture (dark behind ILLUCI_DATASTORE_ENABLED). Persists this
  //    run's seat outputs + synthesis to the durable trunk so they are no longer lost
  //    on exit — captures direct runs AND every company member (which runs here).
  //    Non-fatal: a failed write never fails the run. ──
  try {
    // Cheap env pre-gate: when disabled (the default) the seam does ZERO imports —
    // byte-identical to before. Only an armed flag pulls in the datastore module.
    if (/^(1|true|on|yes)$/i.test(String(process.env.ILLUCI_DATASTORE_ENABLED || "").trim())) {
      const { datastoreEnabled } = await import("../datastore/index.js");
      if (datastoreEnabled()) {
        (await import("../datastore/run-writer.js")).persistRun(trace);
      }
    }
  } catch { /* persistence never fails a run */ }
  return trace;
}

async function runTopologyInner(topologyId, lineup, prompt, options, sessionId, runId) {
  const topology = getTopology(topologyId);
  const humanStatus = options.humanStatus || "operator-initiated";
  const context = options.context || `Council: ${topology.name}`;
  const runControl = normalizeRunControl(options);

  // ── M5: the STANDING ORG (tier 2). When the run is project-scoped, the
  //    project's org.json supplies lineup defaults, persona bindings, the
  //    anchor binding, and the session KIND policy. Caller args always win
  //    over org defaults; the org wins over auto-fill. ──
  const projectDir = options.projectDir || null;
  const org = projectDir ? loadOrg(projectDir) : null;
  const orgApplies = org && org.charterId === topologyId ? org : null;

  // ── Step 1: Fill empty seats — org lineup as base, caller overrides, then auto-fill ──
  const rawBaseLineup = orgApplies ? { ...(orgApplies.lineup || {}), ...(lineup || {}) } : (lineup || {});
  const agentBinding = resolveAgentLineup({
    topologyId,
    lineup: rawBaseLineup,
    agentManifest: options.agents || options.agentManifest || null,
    seatAgents: options.seatAgents || null,
    org: orgApplies,
  });
  const baseLineup = agentBinding.lineup;
  const modelDelegation = autoFill(topology, baseLineup, {
    harnessModelResource: options.harnessModelResource || process.env.ILLUCI_HARNESS_MODEL_RESOURCE || null,
    preferHarnessInference: options.preferHarnessInference === true || process.env.ILLUCI_PREFER_HARNESS_INFERENCE === "1",
    allowHarnessRoleBypass: options.allowHarnessRoleBypass === true,
  });
  const filledLineup = modelDelegation.lineup;

  // ── Step 2: Validate the lineup ──
  const validation = validateLineup(topologyId, filledLineup);
  if (!validation.valid) {
    throw new Error(`Invalid lineup for ${topology.name}:\n  ${validation.errors.join("\n  ")}`);
  }

  // ── Step 3: Normalize lineup to arrays ──
  const normalized = {};
  for (const [seatId, models] of Object.entries(filledLineup)) {
    normalized[seatId] = Array.isArray(models) ? models : [models];
  }

  // ── Step 3.5: Preflight readiness gate (dark behind ILLUCI_PREFLIGHT_ENABLED) ──
  //    Proactive PCC/PCI pre-task assessment: validate run-config (and, under
  //    ILLUCI_PREFLIGHT_PROBE, seat liveness) over the fully-resolved lineup BEFORE
  //    any side effect. Flag off => inert, byte-identical. A blocking readiness
  //    failure HALTs here — strictly before logDecision/setActiveSession/emit —
  //    so nothing is journaled, registered, or emitted (a clean abort).
  const preflightReport = await preflightLineup(topologyId, normalized, options);
  if (!preflightReport.ready) {
    throw new PreflightError(preflightReport);
  }
  // Authoritative-lineup contract: the dispatched lineup IS the inspected lineup
  // (a Phase-3 reseat may heal it). Flag-off returns no `lineup`, so this is
  // skipped and the path stays byte-identical.
  if (preflightReport.lineup) {
    for (const [seatId, models] of Object.entries(preflightReport.lineup)) {
      normalized[seatId] = Array.isArray(models) ? models : [models];
    }
  }
  const resolvedSeatAgents = bindResolvedModelsToAgents(normalized, agentBinding.seatAgents);
  const publicAgents = publicAgentAssignments(resolvedSeatAgents);

  // ── Fire control — resolve per-seat firing modes ──
  const fireControl = {};
  for (const seat of topology.seats) {
    fireControl[seat.id] = getSeatFireControl(topologyId, seat.id);
  }

  // ── Log lineup decision ──
  logDecision({
    humanStatus,
    modelStatus: Object.entries(normalized).flatMap(([seat, models]) =>
      models.map((m) => ({ model: m, seat }))
    ),
    context,
    type: "lineup",
    decision: `Seated ${Object.values(normalized).flat().length} model(s) across ${Object.keys(normalized).length} seat(s) in ${topology.name}`,
    inputs: { topologyId, prompt: prompt.substring(0, 200) },
    metadata: {
      lineup: normalized,
      agentAssignments: publicAgents,
      autoFilled: getAutoFilledSeats(topology, rawBaseLineup, filledLineup),
      fireControl,
      modelDelegation: modelDelegation.audit,
    },
  });

  // ── Compile relationship graph for visualizer and routing ──
  const graph = compileGraph(topologyId, normalized);

  // ── Register active session so visualizer commands can mutate it ──
  // sessionId was minted by the run wrapper (parent session for pipeline/spawn children, else fresh).
  setActiveSession(topologyId, normalized, sessionId);

  // Build visualizer assignment metadata from seat-scoped disposition configs
  // plus public agent identity. Private memory and permit payloads never enter
  // this display lane.
  const dispositionAssignments = options.seatDispositions ? buildSeatAssignments(options.seatDispositions) : null;
  const agentSeatAssignments = buildAgentSeatAssignments(resolvedSeatAgents);
  const seatAssignments = mergeSeatAssignmentMetadata(options.seatAssignments || dispositionAssignments, agentSeatAssignments);
  const skillFrameworkResolution = resolveSkillFrameworkBlocksForTopology({
    topology,
    topologyId,
    skillFrameworks: options.skillFrameworks || options.skillFrameworkUses || null,
    seatSkillFrameworks: options.seatSkillFrameworks || options.skillFrameworksBySeat || null,
  });

  // ── Emit topology start (includes graph for visualizer layout) ──
  await emitTopologyStart(topologyId, topology.name, normalized, prompt, sessionId, options.projectId, graph, seatAssignments);

  // ── Step 4: Execute phases ──
  const budget = createBudget(options.tokenBudget || null);
  // [A96]/DR-189 (WO-2 ruling): the seat/member budget cascade. OFF unless the
  // run-control envelope carries a budget stanza — then it tracks per-seat spend
  // for OBSERVATION (always) and enforces member caps + non-borrowable seat
  // floors + seat caps (when configured). companyRemaining bridges to the flat
  // per-run budget so the derived dispatch cap is min(seat, member, company).
  const seatBudget = createSeatBudget(runControl.budget || null, {
    companyRemaining: () => budget.remaining,
  });
  const minConfidence = options.minConfidence || null;
  const minMarginalValue = options.minMarginalValue || 0.001;
  // [A17.4] Adaptive policy (options.adaptive beats topology.adaptive beats
  // conservative defaults) + per-run routing state. Consulted only on gate FAIL.
  const adaptivePolicy = resolveAdaptivePolicy(topology, options);
  const adaptiveState = { loopsByPhase: {}, branchesByPhase: {}, recursesByPhase: {}, escalationsByPhase: {}, totalReroutes: 0 };

  // ── Derive approval context from the task ──
  // Models can write within scope. Out-of-scope writes get gated to the operator.
  deriveFromTask(prompt, { topology: topologyId });

  // ── M1: the operator anchor. Built once, threaded to every dispatch, rendered
  //    as the first token-reserved block of every seat message (frame.js). This is
  //    what makes the operator's verbatim ask survive past phase 1 in every seat,
  //    regardless of a phase's input spec. ──
  // `let` because an operator redirect at a fire-control checkpoint (M4a) revises
  // the mandate for this and all later steps via reviseMandate.
  //
  // Mandate-convention heal (colosseum Condition 5): honor an explicitly-passed
  // options.mandate over rebuilding from `prompt`. A NESTED run — a company member
  // (company.js threads the carried mandate), a pipeline stage (whose `prompt` is
  // the PRIOR stage's PRODUCT, not the operator's ask), or a spawned child (spawn.js
  // passes the inherited mandate) — supplies its parent's operator mandate so the
  // verbatim ask survives the handoff instead of being erased and rebuilt from the
  // intermediate product. A FLAT run passes no options.mandate, so it builds from
  // `prompt` exactly as before (byte-identical). An accepted mandate object flows
  // verbatim into the frame's reserved [Mandate] block via renderMandateBlock — the
  // ONE rendering path — so a nested child never also needs the ask prepended into
  // its prompt text (spawn.js's old prepend is retired in the same change).
  // [A107]/F-138 — the convention heal, hardened: a STRING options.mandate is
  // the operator's verbatim ask from a caller that never built the object
  // (the graph-preset path shipped one); it normalizes through buildMandate
  // instead of crashing at `mandate.intent.revision` downstream.
  let mandate = (options.mandate && typeof options.mandate === "object")
    ? options.mandate
    : buildMandate({
      prompt: typeof options.mandate === "string" && options.mandate.trim() ? options.mandate : prompt,
      operator: options.operator || "the operator",
      projectId: options.projectId || null,
      topologyId,
      fireControl,
      stabilityThreshold: options.stabilityThreshold ?? null,
      repoLineage: options.repoLineage ?? null,
    });
  const seatLabels = buildSeatLabels(topology);

  // ── Build dispatch context for governance injection ──
  const allModelIds = peerIdsForLineup(normalized);
  // Run-control derives governed tool execution from the canonical envelope:
  // seat-loop activation, mandatory permits, and checkpoint-port requirements.
  const runAutonomy = deriveRunToolAutonomy(runControl, options);
  // [A91]/DR-184: the childIdentity state validates at ARM time — an unknown
  // value or a Phase-3 state (derive|explicit) dies loudly before anything
  // runs, never silently degrading to `none`.
  if (options.genome) normalizeChildIdentity(options.genome);
  const dispatchOpts = {
    topology: topology.name,
    peerIds: allModelIds,
    // M1: the run mandate + seat-label lookup, read by every executor's frame.
    mandate,
    seatLabels,
    projectId: options.projectId || null,
    // [A39]/CAP-3 R1: a spawning parent's capability resolution rides down so
    // every child seat's exercisable set INTERSECTS with it (no laundering).
    parentCapabilityResolution: options.parentCapabilityResolution || null,
    cwd: options.cwd || options.workspaceRoot || options.projectDir || process.cwd(),
    workspaceRoot: options.workspaceRoot || options.cwd || options.projectDir || process.cwd(),
    workspaceContext: options.workspaceContext,
    modifiers: options.modifiers || null,
    reasoning: options.reasoning || null,
    thinking: typeof options.thinking === "boolean" ? options.thinking : null,
    cognitiveControlsEnabled: options.cognitiveControlsEnabled === true,
    computePosture: computePostureFromOptions(options),
    modelDelegation: modelDelegation.audit,
    adaptiveFallback: options.adaptiveFallback,
    reasoningFloor: options.reasoningFloor || null,
    // Generation + dispatch controls threaded to every seat dispatch. params
    // (e.g. { num_predict }) reaches the bridge's option bag; timeoutMs overrides
    // the per-dispatch timeout race + the bridge fetch AbortSignal. Both null
    // unless the caller (e.g. `illuci run --num-predict/--timeout`) set them.
    params: options.params || null,
    timeoutMs: options.timeoutMs || null,
    runControl,
    // Per-seat disposition configs compose the [Behavioral Disposition] block.
    seatDispositions: options.seatDispositions || null,
    agentDispositions: agentDispositionMap(resolvedSeatAgents),
    agentAssignments: resolvedSeatAgents,
    publicAgentAssignments: publicAgents,
    skillFrameworkBlocks: skillFrameworkResolution.blocks,
    skillFrameworkUses: skillFrameworkResolution.usesBySeat,
    workPermits: options.workPermits || options.permits || null,
    workPermitRequired: options.workPermitRequired === true,
    // Run-scoped ids threaded through to every dispatch so applyDisposition
    // can emit disposition_resolved telemetry tied to the right run/session.
    sessionId,
    topologyId,
    // Phase 2 — loop-capable seats. seatLoop selects which seats run the agent
    // loop (true = all, or a list/Set of seat ids); null = every seat single-shot
    // (current behavior). onPermission/signal thread the operator gate + cancellation
    // into a looping seat's tool calls.
    seatLoop: runAutonomy ? runAutonomy.seatLoop || null : options.seatLoop || null,
    seatLoopMaxSteps: options.seatLoopMaxSteps || null,
    // Opt-in strict routing distinguishes assigned instances from legacy
    // model-only seats. This selection is not identity authentication.
    [assignedAgentRequirementKey]: options.requireAssignedAgent === true,
    // [A42]: "governed" makes the run permit MANDATORY for THIS run — no
    // run-layer permit records -> every capability denies (CAP-4, per-run).
    capabilityPermitMandatory: runAutonomy?.capabilityPermitMandatory === true,
    onPermission: options.onPermission || null,
    signal: options.signal || null,
    // Phase 3 — awareness bus. null = off (no recall, no publish, existing behavior).
    // Set true (Phase 4's runCompany does) to make seats mutually aware. seatTags
    // optionally biases recall toward a seat's declared interest tags.
    awareness: options.awareness || null,
    ...(Object.hasOwn(options, "awarenessAssignment") ? { awarenessAssignment: options.awarenessAssignment } : {}),
    seatTags: options.seatTags || null,
    // Cond 11 — the AWARENESS scope key, ORTHOGONAL to sessionId (the spawn-tree key).
    // null (default) -> the recall/publish scope falls back to sessionId, so a flat run
    // and a company member are byte-identical to today (siblings share the company bus).
    // The orchestrate node (orchestrate/node.js) sets this per pipeline stage so a stage's
    // awareness traffic is isolated from sibling stages even though they share the
    // pipeline-wide sessionId; a spawn child inherits the parent's value via options.busScope.
    busScope: options.busScope || null,
    // Phase 5 — recursive spawn. runId is this run's node id in the TopologyTree;
    // spawn/spawnTree gate + carry the bounded spawn_topology tool to loop-capable seats.
    runId,
    directAttemptJournalRoot: options.directAttemptJournalRoot || null,
    // [A90]/DR-182 P1: the genome control crosses the public run seam (its
    // defaults-registry disclosure preceded the plumbing — the resolver's
    // fail-closed projectDir law still guards arming), and spawn lineage rides
    // every dispatch so telemetry outlives the in-memory TopologyTree.
    genome: options.genome || null,
    // [A91]/DR-184: the RAW agents manifest, retained for childIdentity
    // threading (agentAssignments above is the BOUND form; a child topology
    // has different seats, so children re-bind from the raw manifest).
    agentManifest: options.agents || options.agentManifest || null,
    parentRunId: options.spawnContext?.parentRunId || null,
    spawnDepth: Array.isArray(options.spawnContext?.ancestorTopologyIds)
      ? options.spawnContext.ancestorTopologyIds.length
      : 0,
    spawn: options.spawn || null,
    spawnTree: null,
    // Phase 7 — same-loop detached spawn. null (default) = today's awaited behavior. When
    // set (and spawn is on), spawn_topology returns a childRunId immediately and a sibling
    // collect_topology tool is pushed to the seat to poll/await the detached run.
    spawnDetached: options.spawnDetached || null,
  };

  // Phase 5 — register this run in the per-company TopologyTree so its loop-capable
  // seats can convene bounded child topologies. A spawned child (options.spawnContext)
  // registers under its parent for multi-level recursion; a root seeds depth from policy.
  if (options.spawn) {
    const spawnTree = getOrCreateTree(sessionId, options.spawnPolicy);
    if (options.spawnContext) await spawnTree.registerNode(runId, { ...options.spawnContext, topologyId });
    else spawnTree.registerRoot(runId, topologyId);
    dispatchOpts.spawnTree = spawnTree;
  }

  // ── M2: the agenda is a first-class, recorded object. Ritual mode = the
  //    charter's defaultAgenda (authored phases) verbatim — today's order
  //    bit-for-bit. The cursor is where M3 (derived) / M4 (conducted) and the
  //    operator's steering surface (M4.5) will reorder/insert/skip, every
  //    mutation recorded into the arrangement timeline. ──
  // Conducted mode delegates planning to a lead anchor model. The anchor's plan
  // is validated against the charter bounds (anchor.js / DR-110) and falls back
  // conducted→derived→ritual on any failure. raw:true — the planning call is a
  // meta dispatch (its prompt already carries the operator's ask), not a seat turn.
  const anchorDispatch = (mid, p) =>
    // Phase 6 — the raw planning call now carries the [Mandate] anchor too (the
    // carried tier is unconditional): no dispatch, not even a raw meta-dispatch,
    // escapes the law. raw:true still skips only the VERBOSE governance preamble.
    querySeat(mid, p, { ...dispatchOpts, raw: true, mandate, topology: topology.name, projectId: options.projectId || null, metaDispatch: "agenda" }).then((r) => r?.response || "");
  // [A17.9] The escalation reviewer's raw meta-dispatch (mirrors anchorDispatch): a
  // judgment call, not a seat turn — it decides the route, it does not do the phase's
  // work. Carries the [Mandate] anchor, skips only the verbose preamble. Injectable at
  // the escalate arm via options.escalateFn for hermetic tests.
  const escalationDispatch = (mid, p) =>
    querySeat(mid, p, { ...dispatchOpts, raw: true, mandate, topology: topology.name, projectId: options.projectId || null, metaDispatch: "escalation" }).then((r) => r?.response || "");
  // ── M5: session-kind policy. A 'fixed' org pins the arrangement: conducted
  //    replanning downgrades to derived, recorded. The org's anchor binding is
  //    the default when the caller names none. ──
  // [A17.6] Run-start T (TAOR, DR-114): "conducted" is the DEFAULT disposition —
  // every run opens with the anchor planning the agenda under the charter's
  // authority bounds (+1 planning dispatch per run; conducted → derived → ritual
  // fallback keeps a run without a workable plan from stranding). A caller pins
  // today's authored order with runControl.agenda.strategy: "ritual"; a 'fixed' org
  // still downgrades to derived via kindPolicy.
  const requestedAgendaMode = runControlAgendaMode(runControl);
  const kindPolicy = orgApplies ? applyKindPolicy(orgApplies.kind, requestedAgendaMode) : { agendaMode: requestedAgendaMode, downgraded: false, reason: null };
  // [A17.6] Anchor precedence ladder: caller → org binding → topology-derived
  // default (the first seat of the first authored phase — the seat that would
  // act first plans first).
  const anchorModelId =
    options.anchor?.modelId ||
    (orgApplies?.anchor?.mode === "delegated" ? orgApplies.anchor.modelId : null) ||
    defaultAnchorModel(topology, normalized) ||
    null;
  const agenda = await resolveAgenda(topology, {
    mode: kindPolicy.agendaMode,
    mandate,
    anchorModelId,
    dispatch: anchorDispatch,
  });
  // The anchor's working brief enters the mandate so every seat reads it (it is
  // the initial brief, not an operator redirect — no revision bump).
  if (agenda.brief) {
    mandate.intent.brief = agenda.brief;
    dispatchOpts.mandate = mandate;
  }
  const cursor = createCursor(agenda);
  const arrangement = createArrangementTimeline();
  arrangement.record("run_started", {
    charter: topologyId,
    agendaMode: agenda.mode,
    requestedMode: requestedAgendaMode,
    fallback: !!agenda.fallback,
    rationale: agenda.rationale,
    steps: agenda.steps.map((s) => s.id),
    lineup: normalized,
    fireControl,
    mandateRevision: mandate.intent.revision,
    // M5: the standing-org context this run executed under.
    kind: orgApplies?.kind || null,
    ...(kindPolicy.downgraded ? { kindDowngrade: kindPolicy.reason } : {}),
    org: orgApplies ? { charterId: orgApplies.charterId, anchor: orgApplies.anchor || null } : null,
  });

  // ── M5/A8: agent [You] blocks (stratum-3 recall). Each bound agent uses
  //    agentSlug as the memory key, so a model hotswap preserves identity.
  // ── M6: skill layer per agent/seat. Skill grants ride with the assigned
  //    agent and fall back to the seat only for older org.json records. ──
  dispatchOpts.youBlocks = {};
  dispatchOpts.youBlocksByAgent = Object.create(null);
  dispatchOpts.skillBlocks = {};
  dispatchOpts.skillBlocksByAgent = Object.create(null);
  dispatchOpts.seatGrants = {};
  dispatchOpts.seatGrantsByAgent = Object.create(null);
  const continuityBlocks = buildAgentContinuityBlocks(projectDir, resolvedSeatAgents, options.agentContinuity);
  const continuityObserver = continuityBlocks ? createAgentContinuityObserver(continuityBlocks) : null;
  if (continuityObserver) dispatchOpts[continuityObserverKey] = continuityObserver;
  // ── Persona model-resource overlay (additive, greenfield). Rung 2 of the seat
  //    precedence ladder, consumed inside resolveSeatModel via the spread dispatchOpts.
  //    The eligibility rule (a persona seats its seat only when that seat is not pinned
  //    explicitly by the caller OR the org lineup) lives in buildSeatModelResource. ──
  dispatchOpts.seatModelResource = buildSeatModelResource(orgApplies?.personas, lineup, orgApplies?.lineup);
  for (const [seatId, agents] of Object.entries(resolvedSeatAgents || {})) {
    for (const [index, agent] of agents.entries()) {
      if (!agent) continue;
      if (projectDir && agent.agentSlug) {
        const digest = continuityBlocks ? { summary: continuityBlocks[agent.agentId] } : loadAgentDigest(projectDir, agent.agentSlug);
        const block = renderYouBlock(agent.agentSlug, digest);
        if (block) {
          dispatchOpts.youBlocksByAgent[agent.agentId] = block;
          if (index === 0) dispatchOpts.youBlocks[seatId] = block;
        }
      }
      const skillIds = Array.isArray(agent.skills) ? agent.skills : [];
      if (skillIds.length > 0) {
        try {
          const skills = skillIds.map(getSkill);
          const skillsBlock = renderSkillsBlock(skills);
          if (skillsBlock) {
            dispatchOpts.skillBlocksByAgent[agent.agentId] = skillsBlock;
            if (index === 0) dispatchOpts.skillBlocks[seatId] = skillsBlock;
          }
          dispatchOpts.seatGrantsByAgent[agent.agentId] = resolveSeatGrants(skills);
          if (index === 0) dispatchOpts.seatGrants[seatId] = dispatchOpts.seatGrantsByAgent[agent.agentId];
          telemetryStore.recordEvent({
            run_id: topologyId, session_id: sessionId, project_id: options.projectId || null,
            event_type: "skills_resolved", seat_id: seatId,
            payload: {
              agentId: agent.agentId,
              skillIds,
              mcpBridges: [...dispatchOpts.seatGrantsByAgent[agent.agentId].mcpBridges],
              autonomy: dispatchOpts.seatGrantsByAgent[agent.agentId].autonomy,
            },
          });
        } catch (err) {
          console.warn(`[Runner] skill resolution failed for agent "${agent.agentId}" in seat "${seatId}" (non-fatal): ${err.message}`);
        }
      }
    }
  }

  const trace = {
    topologyId,
    topologyName: topology.name,
    startedAt: new Date().toISOString(),
    prompt,
    lineup: normalized,
    agentAssignments: publicAgents,
    skillFrameworkUses: skillFrameworkResolution.usesBySeat,
    agentContinuity: continuityBlocks ? {
      preparedFrames: Object.entries(continuityBlocks).map(([recipientId, block]) => ({ recipientId,
        sha256: createHash("sha256").update(block).digest("hex"), references: JSON.parse(block.slice(block.indexOf("\n") + 1)) })),
      dispatch: continuityObserver.state,
      scope: "prepared references plus observed engine call inputs/settlement; not provider receipt, model use or applied competence",
    } : null,
    fireControl,
    graph,
    agenda: { mode: agenda.mode, rationale: agenda.rationale, steps: agenda.steps.map((s) => s.id) },
    arrangement: arrangement.events,
    phases: {},
    decisions: [],
    budget: budget.status(),
    runControl,
  };

  let previousPhase = null;

  // [A17.9] Escalation enablement. OFF by default (D1: clean/reviewer-less runs exit
  // exactly as before). Enabled per-run via options.escalate === true or an explicit
  // options.escalationReviewer; the reviewer defaults to the run's anchor (its designated
  // judgment model). Enabled requires a resolvable reviewer — no model, no escalation.
  const escalationReviewer = options.escalationReviewer || anchorModelId || null;
  const escalationEnabled = (options.escalate === true || !!options.escalationReviewer) && !!escalationReviewer;

  while (cursor.hasNext()) {
    const phase = cursor.next();
    // Budget check before phase execution
    if (budget.enforced && budget.exhausted) {
      trace.halted = true;
      trace.haltedAt = phase.id;
      trace.haltReason = "Token budget exhausted";
      arrangement.record("halted", { at: phase.id, reason: "Token budget exhausted" });
      break;
    }

    // ── M4a: fire-control checkpoint. semi/burst seats pause for an operator
    //    decision (proceed / redirect / skip / abort) before the step runs;
    //    auto runs free. Absent a checkpoint port the decision is "proceed",
    //    so headless/CLI runs are never blocked (fire-control is pacing, not
    //    the safety gate). Every checkpoint is recorded on the timeline. ──
    if (options.checkpoint && needsCheckpoint(phase, fireControl)) {
      const firingMode = stepFiringMode(phase, fireControl);
      const decision = await resolveCheckpoint({ step: phase, firingMode, mandate, port: options.checkpoint });
      arrangement.record("checkpoint", { stepId: phase.id, firingMode, action: decision.action, ...(decision.intent ? { intent: decision.intent } : {}) });
      if (decision.action === "abort") {
        trace.halted = true;
        trace.haltedAt = phase.id;
        trace.haltReason = "Operator aborted at fire-control checkpoint";
        arrangement.record("halted", { at: phase.id, reason: "operator abort" });
        break;
      }
      if (decision.action === "skip") {
        arrangement.record("step_skipped", { stepId: phase.id });
        continue;
      }
      if (decision.action === "redirect") {
        mandate = reviseMandate(mandate, decision.intent);
        dispatchOpts.mandate = mandate; // every later dispatch reads the revised ask
        arrangement.record("mandate_revised", { revision: mandate.intent.revision, at: phase.id });
      }
    }

    arrangement.record("step_started", { stepId: phase.id, type: phase.type, seats: phase.seats || (phase.seat ? [phase.seat] : []) });
    const phaseStart = Date.now();
    // [A17.5] Proxy-T (TAOR, DR-114): a re-inserted step carries adaptiveRetry
    // (the failure observation); the retry's input opens with it + a think-first
    // directive, so the seats diagnose-then-revise inside the same dispatch.
    // First attempts resolve exactly as before.
    let phaseInput = resolveInput(phase.input, prompt, trace.phases);
    if (phase.adaptiveRetry) {
      phaseInput = composeAdaptiveRetryInput(phaseInput, phase.adaptiveRetry);
    } else if (phase.adaptiveBranch) {
      // [A17.7] A branched-in step opens with WHY the run routed here (the branch
      // edge re-enters at T, DR-114): the origin phase's failure observation above
      // the target's own input, preserved verbatim below.
      phaseInput = composeAdaptiveBranchInput(phaseInput, phase.adaptiveBranch);
    }

    // Emit phase start
    const phaseSeats = phase.seats || (phase.seat ? [phase.seat] : []);
    emitPhaseStart(phase.id, phase.type, phaseSeats, sessionId);

    // Emit handoff from previous phase
    const completedPhaseKeys = Object.keys(trace.phases);
    if (completedPhaseKeys.length > 0) {
      emitPhaseHandoff(completedPhaseKeys[completedPhaseKeys.length - 1], phase.id, sessionId);
    }

    // ── W3: Resolve execution mode for this phase ──
    const phaseMode = resolvePhaseMode(phase, { runControl });
    const modeContext = {
      sessionId,
      topologyId,
      phaseInput,
      projectId: options.projectId || null,
      workspaceRoot: dispatchOpts.workspaceRoot || process.cwd(),
      workPermits: dispatchOpts.workPermits || null,
      workPermitRequired: dispatchOpts.workPermitRequired === true,
    };

    // ── Gate posture from the phase's execution mode ──
    // write/execute/delegate phases auto-approve the seat's own tool calls (they MUST produce
    // file/command operations); respond/read phases run GATED (writeMode:false), so a
    // non-writing seat cannot silently auto-approve a write inside a sub-CLI bridge.
    // Since DR-204 the bridges themselves fail CLOSED (auto-approve requires an explicit
    // writeMode === true — core/bridges/write-mode.js), so this phase mapping is the one
    // place that OPTS WRITERS IN; the seat-executors below inherit it via phaseOpts.
    const phaseWriteMode = phaseMode === "write" || phaseMode === "execute" || phaseMode === "delegate";
    const phaseOpts = { ...dispatchOpts, writeMode: phaseWriteMode,
      ...(continuityObserver ? { [continuityPhaseKey]: phase.id } : {}) };

    // ── Resolve ALL referenced phase artifacts for mode-aware executors ──
    // Parse the phase.input spec to find all referenced phases, not just the last one.
    // This fixes devops-pipeline "stage" which needs build+test+scan artifacts.
    const referencedArtifacts = resolveReferencedArtifacts(phase.input, trace.phases, completedPhaseKeys);

    let phaseResult;

    // Modes that replace the standard concurrency executor entirely
    if (phaseMode === "read") {
      const readResult = await executeReadMode(phase, phaseInput, referencedArtifacts, normalized, topology, phaseOpts, modeContext);
      phaseResult = readResult.phaseResult;
      phaseResult.artifact = readResult.artifact;
    } else if (phaseMode === "execute") {
      const execResult = await executeExecuteMode(phase, phaseInput, normalized, topology, phaseOpts, modeContext);
      phaseResult = execResult.phaseResult;
      phaseResult.artifact = execResult.artifact;
    } else if (phaseMode === "delegate") {
      const delegateResult = await executeDelegateMode(phase, phaseInput, normalized, topology, phaseOpts);
      phaseResult = delegateResult.phaseResult;
      phaseResult.artifact = delegateResult.artifact;
    } else {
      // ── Sandbox creation for parallel write phases ──
      // When phase.mode === "write" and phase.type === "parallel", create
      // sandboxes per seat so each agent writes in its own isolated worktree.
      const useSandboxes = phaseMode === "write" && phase.type === "parallel";
      let sandboxes = null;
      let sandboxPRIds = null;

      if (useSandboxes) {
        try {
          const baseBranch = options.baseBranch || "HEAD";
          sandboxes = {};
          const seatIds = phase.seats || [phase.seat];
          for (const seatId of seatIds) {
            const models = normalized[seatId] || [];
            for (const modelId of models) {
              const sb = createSandbox(seatId, modelId, baseBranch);
              sandboxes[seatId] = sb;
            }
          }
        } catch (err) {
          console.warn(`[Runner] Sandbox creation failed, falling back to standard execution: ${err.message}`);
          sandboxes = null;
        }
      }

      // "respond" and "write" modes use standard concurrency executors first
      switch (phase.type) {
        case "parallel":
          phaseResult = await executeParallel(phase, normalized, phaseInput, topology, phaseOpts);
          break;
        case "single":
          phaseResult = await executeSingle(phase, normalized, phaseInput, topology, phaseOpts);
          break;
        case "sequential":
          phaseResult = await executeSequential(phase, normalized, phaseInput, prompt, topology, phaseOpts);
          break;
        case "rotating":
          phaseResult = await executeRotating(phase, normalized, phaseInput, topology, phaseOpts);
          break;
        default:
          throw new Error(`Unknown phase type: ${phase.type}`);
      }

      // W4: Post-process write mode — execute file operations from model output
      if (phaseMode === "write") {
        if (sandboxes) modeContext.sandboxes = sandboxes;
        phaseResult.artifact = await executeWriteMode(phase, phaseResult, modeContext);

        // ── Sandbox PR creation for parallel write phases ──
        // After write phase completes, each sandbox becomes a PR.
        // The next phase (review/QA) receives the PR list, not concatenated text.
        if (sandboxes) {
          sandboxPRIds = [];
          const seatIds = phase.seats || [phase.seat];
          for (const seatId of seatIds) {
            const sb = sandboxes[seatId];
            if (!sb) continue;
            const models = normalized[seatId] || [];
            const modelId = models[0] || seatId;
            try {
              const pr = createPR(seatId, modelId, sb.branch, `Phase ${phase.id}: ${seatId}`);
              sandboxPRIds.push(pr.prId);
              telemetryStore.recordEvent({
                run_id: topologyId,
                session_id: context.sessionId,
                project_id: dispatchOpts.projectId,
                event_type: "pr_created",
                phase_id: phase.id,
                seat_id: seatId,
                model_id: modelId,
                payload: { pr_id: pr.prId, branch: sb.branch },
              });
            } catch (err) {
              console.warn(`[Runner] PR creation failed for seat ${seatId}: ${err.message}`);
              telemetryStore.recordEvent({
                run_id: topologyId,
                session_id: context.sessionId,
                project_id: dispatchOpts.projectId,
                event_type: "pr_creation_failed",
                phase_id: phase.id,
                seat_id: seatId,
                model_id: modelId,
                payload: { error: err.message },
              });
            }
          }

          // Emit sandbox_complete with branch names and diffs
          if (sandboxPRIds.length > 0) {
            emitPhaseComplete(`${phase.id}:sandbox`, {
              type: "sandbox_complete",
              prIds: sandboxPRIds,
              branches: Object.values(sandboxes).map(s => s.branch),
            }, sessionId);

            // Attach PR metadata to the artifact for downstream phases
            phaseResult.artifact = phaseResult.artifact || {};
            phaseResult.artifact.sandboxPRIds = sandboxPRIds;
            phaseResult.artifact.sandboxPRReview = formatPRsForReview(sandboxPRIds);
          }
        }
      } else {
        // W1: Default text artifact for respond mode
        phaseResult.artifact = buildTextArtifact(phaseResult);
      }
    }

    phaseResult.latency = Date.now() - phaseStart;

    // Aggregate token usage across all responses in this phase
    phaseResult.totalTokens = (phaseResult.responses || []).reduce((sum, r) => {
      return sum + (r.usage?.total_tokens || 0);
    }, 0);

    // Record token spend against budget
    budget.spend(phaseResult.totalTokens);

    // [A96]/DR-189: charge each response's tokens to its seat (observation always;
    // enforcement when a cascade is configured). A seat/member crossing its cap
    // records a TYPED exhaustion trace — composing with, never replacing, the
    // company-level "Token budget exhausted" halt. Observation-only when off.
    for (const r of phaseResult.responses || []) {
      if (!r.seat) continue;
      seatBudget.charge(r.seat, r.usage?.total_tokens || 0);
      if (seatBudget.enforced && seatBudget.seatExhausted(r.seat)) {
        arrangement.record("seat_budget_exhausted", { at: phase.id, seat: r.seat, spent: seatBudget.seatSpent(r.seat) });
      }
    }
    if (seatBudget.enforced && seatBudget.memberExhausted()) {
      arrangement.record("member_budget_exhausted", { at: phase.id, spent: seatBudget.memberSpent() });
    }

    // ── Analysis hooks ──

    // Calibration: compute system confidence on parallel phases with 2+ responses
    if (phaseResult.responses.length >= 2 && !phase.raw) {
      phaseResult.calibration = calibrate(phaseResult.responses);
    }

    // Correlation: detect shared-lineage agreement on parallel phases
    if (phase.type === "parallel" && phaseResult.responses.length >= 2) {
      phaseResult.correlation = detectCorrelation(phaseResult.responses);
    }

    // Marginal value: did this phase add anything over the previous?
    phaseResult.marginalValue = computeMarginalValue(phaseResult, previousPhase, minMarginalValue);
    previousPhase = phaseResult;

    // Gate evaluation — AMD-8: classify the gated outcome into an HONEST status +
    // reason via the pure classifyGateResult helper, which populates gateReason for
    // ALL THREE fail branches (seat-error / all-empty / belowConfidence), not just
    // belowConfidence. This is the CONTENT gate; the operator dispatch gate keeps its
    // own reason at its own layer.
    if (phase.gate) {
      const gate = classifyGateResult(phaseResult, minConfidence);
      phaseResult.gateStatus = gate.status;
      if (gate.reason) phaseResult.gateReason = gate.reason;
    }

    // [A102]/DR-195: persist per-response OUTCOME evidence to the queryable store
    // — the pipeline the engine lacked (phase outcome quality was SSE-only). The
    // behavioral attribution lens reads a persona's PRIOR phase_outcomes to
    // condition learning on whether its expression actually earned good results.
    // Advisory telemetry: a failed write never blocks dispatch. Keyed by
    // seat + agentId so the grade seam can query per-persona.
    try {
      const gatePassed = phase.gate ? phaseResult.gateStatus === "passed" : null;
      const phaseMarginal = typeof phaseResult.marginalValue === "number" ? phaseResult.marginalValue : null;
      const phaseConfidence = phaseResult.calibration?.systemConfidence ?? null;
      for (const r of phaseResult.responses || []) {
        if (!r || !r.seat || !r.agentId) continue; // behavioral needs a durable persona
        const chars = typeof r.response === "string" ? r.response.length : 0;
        telemetryStore.recordEvent({
          run_id: topologyId,
          session_id: sessionId,
          project_id: dispatchOpts?.projectId || null,
          event_type: "phase_outcome",
          phase_id: phase.id,
          seat_id: r.seat,
          model_id: r.model || null,
          payload: {
            runId: dispatchOpts?.runId ?? null,
            seatId: r.seat,
            agentId: r.agentId,
            substantive: chars >= 200 && !r.error,
            chars,
            gatePassed,
            marginalValue: phaseMarginal,
            systemConfidence: phaseConfidence,
          },
        });
      }
    } catch { /* telemetry never blocks dispatch */ }

    // ── [A17.4] Adaptive route decision. The deterministic table (D2 floor)
    //    consumes the classified gate outcome and decides ONCE — the halt emit
    //    below and the act block after the decision log both read this. A
    //    passing gate (or no gate) is always "advance"; only an exit route may
    //    emit/record a halt, so a looped retry never reports a false halt. ──
    const uncertainDelegate = phaseMode === "delegate" && (phaseResult.responses || []).some(
      response => response?.code === "ILLUCI_CODEX_WRITE_OUTCOME_UNCONFIRMED" && response.retrySafe === false,
    );
    if (uncertainDelegate) phaseResult.gateReason = "delegate-outcome-unconfirmed";
    const routed = uncertainDelegate ? { route: "exit", reason: "delegate-outcome-unconfirmed" } : classifyPhaseOutcome(phaseResult, phase, {
      policy: adaptivePolicy,
      state: adaptiveState,
      budgetExhausted: budget.enforced && budget.exhausted,
      escalation: escalationEnabled,
    });

    // ── Emit events ──
    emitPhaseComplete(phase.id, phaseResult, sessionId);
    emitBudgetUpdate(budget.status(), sessionId);
    emitPhaseReturn(phase.id, topology.name, sessionId);

    if (routed.route === "exit") {
      emitGateHalt(phase.id, phaseResult.gateReason || "Gate check failed", sessionId);
    }

    const decision = logDecision({
      humanStatus: phase.gate ? "operator-approved" : humanStatus,
      modelStatus: phaseResult.participants.map((p) => ({ model: p.model, seat: p.seat })),
      context: `${context} — phase: ${phase.id}`,
      type: "phase-execution",
      decision: `Phase "${phase.id}" (${phase.type}) — ${phaseResult.responses.length} response(s) in ${phaseResult.latency}ms`,
      inputs: { phaseInput: phaseInput.substring(0, 200) },
      outputs: {
        responseCount: phaseResult.responses.length,
        latency: phaseResult.latency,
        totalTokens: phaseResult.totalTokens,
        gateStatus: phaseResult.gateStatus || null,
        systemConfidence: phaseResult.calibration?.systemConfidence || null,
        agreementRatio: phaseResult.calibration?.agreementRatio || null,
        marginalValue: phaseResult.marginalValue?.marginalValue || null,
      },
      metadata: {
        phaseId: phase.id,
        gate: phase.gate || false,
        topologyId,
        mode: phaseMode,
        artifactType: phaseResult.artifact?.type || null,
        malformed: phaseResult.malformed || false,
        correlationFlags: phaseResult.correlation?.flags || [],
        isLowValue: phaseResult.marginalValue?.isLowValue || false,
        budget: budget.status(),
      },
    });

    trace.phases[phase.id] = phaseResult;
    trace.decisions.push(decision);

    arrangement.record("step_completed", {
      stepId: phase.id,
      latency: phaseResult.latency,
      responseCount: phaseResult.responses.length,
      gateStatus: phaseResult.gateStatus || null,
    });

    if (routed.route === "loop") {
      // [A17.4] Loop the failed phase: re-insert the step at the cursor so it
      // re-executes next iteration (a retry may recover a transient seat error
      // or an empty sweep; the bounds in classifyPhaseOutcome guarantee
      // termination). The retry's phaseResult overwrites trace.phases[phase.id]
      // — the retry IS the phase's result; the reroute record below preserves
      // that an earlier attempt failed. trace.adaptive is attached lazily so a
      // never-rerouted run keeps today's trace shape byte-identical.
      // [A17.5] The re-inserted step is an annotated copy (same id, same shape,
      // + adaptiveRetry): the loop edge re-enters at T (DR-114) — the retry's
      // input opens with this failure observation at input resolution.
      adaptiveState.loopsByPhase[phase.id] = (adaptiveState.loopsByPhase[phase.id] || 0) + 1;
      adaptiveState.totalReroutes += 1;
      if (!trace.adaptive) trace.adaptive = { policy: adaptivePolicy, reroutes: [] };
      const reroute = { at: phase.id, route: "loop", reason: routed.reason, attempt: adaptiveState.loopsByPhase[phase.id] };
      trace.adaptive.reroutes.push(reroute);
      arrangement.record("adaptive_route", reroute);
      cursor.insert({ ...phase, adaptiveRetry: buildRetryAnnotation(phaseResult, routed.reason, adaptiveState.loopsByPhase[phase.id]) });
    } else if (routed.route === "branch") {
      // [A17.7] Branch (DR-113 "cursor insert"): the failed phase AUTHORED an
      // alternative (`onFailBranch`); insert the declared target — an authored
      // phase of this topology, never an invented one — at the cursor. The
      // branched step carries the origin failure (adaptiveBranch) so its input
      // opens informed (T re-entry, DR-114). Once per phase per run, counted
      // against the same reroute cap (classifyPhaseOutcome enforces both). A
      // missing target is an HONEST halt, never a silent advance.
      const branchTarget = (topology.phases || []).find((p) => p && p.id === routed.target);
      if (!branchTarget) {
        trace.halted = true;
        trace.haltedAt = phase.id;
        trace.haltReason = phaseResult.gateReason || "Gate check failed";
        arrangement.record("halted", {
          at: phase.id,
          reason: phaseResult.gateReason || "Gate check failed",
          routeReason: `branch-target-missing:${routed.target}`,
        });
        break;
      }
      adaptiveState.branchesByPhase[phase.id] = (adaptiveState.branchesByPhase[phase.id] || 0) + 1;
      adaptiveState.totalReroutes += 1;
      if (!trace.adaptive) trace.adaptive = { policy: adaptivePolicy, reroutes: [] };
      const reroute = { at: phase.id, route: "branch", reason: routed.reason, to: branchTarget.id };
      trace.adaptive.reroutes.push(reroute);
      arrangement.record("adaptive_route", reroute);
      cursor.insert({ ...branchTarget, adaptiveBranch: buildBranchAnnotation(phaseResult, routed.reason, phase.id) });
    } else if (routed.route === "recurse") {
      // [A17.7 → A17.8] Recurse (DR-113 "recurse (spawn/TopologyTree)"): the failed phase
      // AUTHORED a deeper escape (`onFailRecurse: <topologyId>`) — decompose it into a
      // sub-topology run, bounded by the session TopologyTree (depth/cycle/fan-out/active/
      // total caps ARE the runaway guard, fail-closed). The child seed opens with the origin
      // failure (T re-entry, DR-114). The child's product becomes THIS phase's result and the
      // run ADVANCES (recurse resolves the phase — it is not a re-insert). Executor is
      // injectable (options.recurseFn) for hermetic tests; the default is the real
      // conveneChildTopology → runTopology. A refusal or a halted sub-run is an HONEST halt.
      const tree = getOrCreateTree(sessionId, options.spawnPolicy);
      if (!tree.nodes.has(runId)) tree.registerRoot(runId, topologyId); // the recursing run must be a tree node
      const recurse = options.recurseFn || conveneChildTopology;
      const seed = composeAdaptiveRecurseInput(phaseInput, buildBranchAnnotation(phaseResult, routed.reason, phase.id));
      const child = await recurse({
        tree,
        parentRunId: runId,
        topologyId: routed.target,
        prompt: seed,
        sessionId,
        lineup: {},
        childOptions: {
          projectId: options.projectId ?? null,
          spawnPolicy: options.spawnPolicy,
          // [A39]/CAP-3 R1: the parent chain propagates into the child run.
          parentCapabilityResolution: options.parentCapabilityResolution || null,
          // [A91]/DR-184: the childIdentity carry at the ENGINE-initiated
          // recurse edge — same policy as the seat-spawn edge.
          ...carryChildIdentity({ genome: options.genome || null, agentManifest: options.agents || options.agentManifest || null }),
          // Keep strict awareness selection and its stage boundary across engine
          // recursion. Legacy unselected recursion retains its previous options.
          ...(Object.hasOwn(options, "awarenessAssignment") ? {
            awarenessAssignment: options.awarenessAssignment,
            awareness: options.awareness || null,
            busScope: options.busScope ?? null,
          } : {}),
        },
      });
      if (!child || child.ok !== true) {
        trace.halted = true;
        trace.haltedAt = phase.id;
        trace.haltReason = child?.halted ? (child.trace?.haltReason || phaseResult.gateReason || "recurse child halted") : (phaseResult.gateReason || "Gate check failed");
        arrangement.record("halted", { at: phase.id, reason: trace.haltReason, routeReason: `recurse-refused:${child?.refusal?.reason || "unknown"}` });
        break;
      }
      adaptiveState.recursesByPhase[phase.id] = (adaptiveState.recursesByPhase[phase.id] || 0) + 1;
      adaptiveState.totalReroutes += 1;
      if (!trace.adaptive) trace.adaptive = { policy: adaptivePolicy, reroutes: [] };
      const reroute = { at: phase.id, route: "recurse", reason: routed.reason, into: routed.target, childRunId: child.childRunId || null };
      trace.adaptive.reroutes.push(reroute);
      arrangement.record("adaptive_route", reroute);
      // Fold: the sub-run's product IS this phase's output; mark it resolved-via-recursion so
      // downstream resolveInput reads the recursed result (gateStatus pass — recursion resolved it).
      const childKeys = Object.keys(child.trace?.phases || {});
      const productKey = childKeys[childKeys.length - 1];
      const productPhase = productKey ? child.trace.phases[productKey] : null;
      const productText = productPhase ? formatPhaseOutput(productKey, productPhase) : `[recurse into "${routed.target}" produced no phases]`;
      const folded = {
        ...phaseResult,
        gateStatus: "pass",
        gateReason: null,
        responses: [{ seat: `recurse:${routed.target}`, model: routed.target, response: productText }],
        recursed: { topologyId: routed.target, childRunId: child.childRunId || null },
      };
      if (productPhase?.artifact) folded.artifact = productPhase.artifact;
      trace.phases[phase.id] = folded;
      // advance — no cursor.insert; the sub-run resolved the phase.
    } else if (routed.route === "escalate") {
      // [A17.9] Escalate (DR-113 "review-seat model judgment"; DR-114 the explicit
      // think-step's proper home): the floor reached an ambiguous failure with no cheaper
      // authored route and escalation is enabled. An INDEPENDENT review seat judges it —
      // retry-with-a-directive or honest exit — instead of the floor blind-exiting. The
      // executor is injectable (options.escalateFn) for hermetic tests; the default is a raw
      // meta-dispatch to the reviewer model. A judgment is bounded (once per phase, counted
      // against the reroute cap); a garbled or failed judgment falls back to an honest exit,
      // so escalation never widens authority nor loops unbounded.
      const observation = buildBranchAnnotation(phaseResult, routed.reason, phase.id);
      const escalatePrompt = composeEscalationPrompt(observation, phase, routed.reason);
      const escalateFn = options.escalateFn
        || (async ({ modelId, prompt }) => escalationDispatch(modelId, prompt));
      let verdict;
      try {
        const raw = await escalateFn({ modelId: escalationReviewer, prompt: escalatePrompt, observation, phase, reason: routed.reason });
        verdict = interpretEscalationVerdict(raw);
      } catch (e) {
        verdict = { verdict: "exit", directive: null, reason: `escalation-error:${e?.message || e}` };
      }
      adaptiveState.escalationsByPhase[phase.id] = (adaptiveState.escalationsByPhase[phase.id] || 0) + 1;
      adaptiveState.totalReroutes += 1;
      if (!trace.adaptive) trace.adaptive = { policy: adaptivePolicy, reroutes: [] };
      const reroute = { at: phase.id, route: "escalate", reason: routed.reason, verdict: verdict.verdict, reviewer: escalationReviewer };
      trace.adaptive.reroutes.push(reroute);
      arrangement.record("adaptive_route", reroute);
      if (verdict.verdict === "retry") {
        // The reviewer's directive IS the explicit think-step: it rides the re-inserted step
        // (T re-entry, DR-114) so the retry acts on the judgment, not a blind re-roll. The
        // escalation-directed retry consumes the phase's loop budget so it cannot also loop
        // normally on top of the judgment.
        const attempt = (adaptiveState.loopsByPhase[phase.id] || 0) + 1;
        adaptiveState.loopsByPhase[phase.id] = attempt;
        cursor.insert({ ...phase, adaptiveRetry: { ...buildRetryAnnotation(phaseResult, routed.reason, attempt), directive: verdict.directive } });
      } else {
        // The reviewer confirmed the halt: an honest exit carrying the judgment as the route reason.
        trace.halted = true;
        trace.haltedAt = phase.id;
        trace.haltReason = phaseResult.gateReason || "Gate check failed";
        arrangement.record("halted", { at: phase.id, reason: trace.haltReason, routeReason: `escalation-exit:${verdict.reason || "reviewer-confirmed"}` });
        break;
      }
    } else if (routed.route === "exit") {
      trace.halted = true;
      trace.haltedAt = phase.id;
      // AMD-8: report the REAL halt cause, not a flattened literal. gateReason is now
      // populated for every fail branch (seat-error / all-empty / belowConfidence), so
      // the trace carries which of the three modes halted the run. The fallback string
      // survives only as a defensive default if a future fail branch forgets a reason.
      // [A17.4] routed.reason (why the router chose exit — adaptive-disabled /
      // budget-exhausted / loop-bound-exhausted / below-confidence) rides on the
      // halted record; trace.haltReason stays the CONTENT gate reason.
      trace.haltReason = phaseResult.gateReason || "Gate check failed";
      arrangement.record("halted", { at: phase.id, reason: phaseResult.gateReason || "Gate check failed", routeReason: routed.reason });
      break;
    }
  }

  arrangement.record("run_completed", {
    halted: !!trace.halted,
    executed: cursor.snapshot().executed,
  });
  trace.completedAt = new Date().toISOString();
  trace.totalLatency = new Date(trace.completedAt) - new Date(trace.startedAt);
  trace.budget = budget.status();
  // [A96]/DR-189: the per-seat / per-member observation surface (Rosa's "ship now").
  // Always present; enforced:false when no cascade was configured (zero control effect).
  trace.seatBudget = seatBudget.snapshot();

  // ── M5: session record + distillation (strata 4 → 2/3). The record is the
  //    immutable join (mandate + arrangement timeline + outcome); distillation
  //    appends the mechanical lesson to project memory and each bound
  //    persona's experience to its per-project history. Non-fatal: a failed
  //    write never fails the run. ──
  if (projectDir) {
    try {
      const record = buildSessionRecord({ sessionId, runId, trace, mandate, org: orgApplies });
      const publication = options.sessionPublication ?? null;
      const sealed = appendSessionRecord(projectDir, record, { publication });
      const distilled = distillSession(projectDir, sealed, orgApplies);
      logDecision({
        humanStatus,
        modelStatus: Object.entries(normalized).flatMap(([seat, models]) => models.map((m) => ({ model: m, seat }))),
        context: `${context} — session distilled`,
        type: "session-distill",
        decision: `Session ${sessionId} recorded; project memory +1 lesson; persona memory +${Object.keys(distilled.personas).length} experience(s)`,
        metadata: { sessionId, projectDir, personas: Object.keys(distilled.personas) },
      });
    } catch (err) {
      console.warn(`[Runner] session record/distill failed (non-fatal): ${err.message}`);
    }
  }

  // ── Emit topology complete ──
  emitTopologyComplete(topologyId, topology.name, trace, sessionId);

  // ── Post-run perception: trigger batchPerceive if multiple models participated ──
  const participatingModels = [...new Set(
    Object.values(normalized).flat()
  )];
  if (participatingModels.length >= 2 && options.perceive !== false) {
    try {
      const { batchPerceive } = await import("../agents/identity.js");
      await batchPerceive(participatingModels, {
        context: `Post-topology perception after "${topologyId}" run`,
        sessionId,
      });
    } catch (err) {
      // Perception is non-critical — log but don't fail the run
      console.warn(`[Runner] batchPerceive failed: ${err.message}`);
    }
  }

  // ── Clear approval context ──
  clearApprovalContext();

  return trace;
}

/**
 * Execute a mixed topology — multiple topology patterns composed in sequence.
 *
 * @param {object[]} phases — [{ topologyId, lineup, label }]
 * @param {string} prompt — the task
 * @param {object} options
 */
export async function runMixed(phases, prompt, options = {}) {
  const humanStatus = options.humanStatus || "operator-initiated";
  const context = options.context || "Mixed topology execution";

  logDecision({
    humanStatus,
    modelStatus: { model: "system", seat: "orchestrator" },
    context,
    type: "mixed-topology",
    decision: `Composing ${phases.length} topology phases: ${phases.map((p) => `${p.label || p.topologyId}`).join(" → ")}`,
    inputs: { prompt: prompt.substring(0, 200) },
    metadata: { phases: phases.map((p) => ({ topology: p.topologyId, label: p.label })) },
  });

  const traces = [];
  let currentInput = prompt;

  for (const phase of phases) {
    const trace = await runTopology(phase.topologyId, phase.lineup, currentInput, {
      humanStatus,
      context: `${context} — ${phase.label || phase.topologyId}`,
    });

    traces.push({ label: phase.label || phase.topologyId, trace });

    // Feed the last phase's output as input to the next topology
    const lastPhaseKey = Object.keys(trace.phases).pop();
    const lastPhase = trace.phases[lastPhaseKey];
    if (lastPhase?.responses?.length > 0) {
      currentInput = lastPhase.responses.map((r) =>
        `[${r.model} — ${r.seat || ""}]\n${r.response || r.error || "[no response]"}`
      ).join("\n\n---\n\n");
    }

    if (trace.halted) break;
  }

  return {
    type: "mixed",
    startedAt: traces[0]?.trace.startedAt,
    completedAt: traces[traces.length - 1]?.trace.completedAt,
    phases: traces,
    prompt,
  };
}

// ─── AUTO-FILL ───

function autoFill(topology, lineup, options = {}) {
  return composeModelDelegation(topology, lineup, options);
}

function getAutoFilledSeats(topology, original, filled) {
  const auto = {};
  for (const seat of topology.seats) {
    if (!original[seat.id] && filled[seat.id]) {
      auto[seat.id] = filled[seat.id];
    }
  }
  return auto;
}

// ─── INPUT RESOLUTION (ARTIFACT-AWARE) ───

function resolveInput(inputSpec, originalPrompt, completedPhases) {
  if (!inputSpec || inputSpec === "prompt") return originalPrompt;

  // "previous" — return the last completed phase's output, not the original prompt
  if (inputSpec === "previous" || inputSpec === "shared-artifact") {
    const phaseKeys = Object.keys(completedPhases);
    if (phaseKeys.length === 0) return originalPrompt;
    const lastKey = phaseKeys[phaseKeys.length - 1];
    return formatPhaseOutput(lastKey, completedPhases[lastKey]);
  }

  const parts = inputSpec.split("+");
  return parts.map((part) => {
    const trimmed = part.trim();
    if (trimmed === "prompt") return originalPrompt;

    const phaseMatch = trimmed.match(/^phase:(.+)$/);
    if (phaseMatch) {
      const phaseId = phaseMatch[1];
      const phase = completedPhases[phaseId];
      if (!phase) return `[Phase "${phaseId}" not yet completed]`;
      return formatPhaseOutput(phaseId, phase);
    }
    return trimmed;
  }).join("\n\n---\n\n");
}

function formatPhaseOutput(phaseId, phase) {
  if (!phase.responses || phase.responses.length === 0) return `[Phase "${phaseId}" produced no output]`;

  // W2: Artifact-aware handoff — if the phase produced a structured artifact,
  // format the handoff based on artifact type instead of dumping raw text.
  const artifact = phase.artifact;
  if (artifact) {
    switch (artifact.type) {
      case "files": {
        // File artifact: list what was written, not the full response text
        const fileList = (artifact.files || []).map(f =>
          `  - ${f.path} (${f.operation}, ${f.hash ? f.hash.slice(0, 8) : "no-hash"})`
        ).join("\n");
        const header = `Phase "${phaseId}" wrote the following files:\n${fileList}`;
        // Include content summaries for files under 200 lines
        const contentSections = (artifact.files || [])
          .filter(f => f.content && f.content.split("\n").length < 200)
          .map(f => `--- ${f.path} ---\n${f.content}`);
        return contentSections.length > 0
          ? `${header}\n\n${contentSections.join("\n\n")}`
          : header;
      }

      case "commands": {
        // Command execution artifact: pass the execution log
        const cmdLog = (artifact.commands || []).map(c =>
          `$ ${c.cmd} — exit ${c.exitCode}\n${c.stdout || ""}${c.stderr ? `\nSTDERR: ${c.stderr}` : ""}`
        ).join("\n\n");
        return `Phase "${phaseId}" executed commands:\n\n${cmdLog}${artifact.summary ? `\n\nSummary: ${artifact.summary}` : ""}`;
      }

      case "assessment": {
        // Assessment artifact: pass the assessment text with files-read context
        const readList = (artifact.filesRead || []).map(f => `  - ${f}`).join("\n");
        const prefix = readList ? `Files reviewed:\n${readList}\n\n` : "";
        return `${prefix}Assessment from phase "${phaseId}":\n${artifact.content}`;
      }

      case "delegate": {
        // Delegate artifact: include both response and file changes
        const changes = (artifact.fileChanges || []).map(c =>
          `  - ${c.path} (${c.kind || c.operation})`
        ).join("\n");
        return changes
          ? `Phase "${phaseId}" (delegated) produced:\n${changes}\n\n${artifact.content || ""}`
          : artifact.content || formatPhaseOutputText(phaseId, phase);
      }

      case "text":
      default:
        // Text artifact: fall through to standard text formatting
        break;
    }
  }

  return formatPhaseOutputText(phaseId, phase);
}

/** Standard text-based phase output formatting (original behavior) */
function formatPhaseOutputText(phaseId, phase) {
  return phase.responses.map((r) => {
    const header = `[${r.model} — ${r.seat || phaseId}]`;
    return `${header}\n${r.response || r.error || "[no response]"}`;
  }).join("\n\n");
}

// ─── PHASE EXECUTORS ───

// ─── MODE-SPECIFIC PROMPT SUFFIXES ───
// Tell the model what format to produce based on phase execution mode.
// Without this, write-mode phases produce prose instead of file manifests.

/**
 * Resolve all artifacts referenced by a phase's input spec.
 * Returns an array of { phaseId, artifact } for all phases with artifacts.
 * Falls back to the immediate predecessor if no input spec.
 */
function resolveReferencedArtifacts(inputSpec, completedPhases, completedPhaseKeys) {
  const artifacts = [];

  if (!inputSpec || inputSpec === "prompt") {
    // No references — check last phase
    const lastKey = completedPhaseKeys[completedPhaseKeys.length - 1];
    if (lastKey && completedPhases[lastKey]?.artifact) {
      artifacts.push({ phaseId: lastKey, artifact: completedPhases[lastKey].artifact });
    }
    return artifacts;
  }

  if (inputSpec === "previous" || inputSpec === "shared-artifact") {
    const lastKey = completedPhaseKeys[completedPhaseKeys.length - 1];
    if (lastKey && completedPhases[lastKey]?.artifact) {
      artifacts.push({ phaseId: lastKey, artifact: completedPhases[lastKey].artifact });
    }
    return artifacts;
  }

  // Parse "phase:build+phase:test+phase:scan" → collect all referenced artifacts
  const parts = inputSpec.split("+");
  for (const part of parts) {
    const trimmed = part.trim();
    const phaseMatch = trimmed.match(/^phase:(.+)$/);
    if (phaseMatch) {
      const phaseId = phaseMatch[1];
      if (completedPhases[phaseId]?.artifact) {
        artifacts.push({ phaseId, artifact: completedPhases[phaseId].artifact });
      }
    }
  }

  // Fall back to last phase if no explicit references resolved
  if (artifacts.length === 0) {
    const lastKey = completedPhaseKeys[completedPhaseKeys.length - 1];
    if (lastKey && completedPhases[lastKey]?.artifact) {
      artifacts.push({ phaseId: lastKey, artifact: completedPhases[lastKey].artifact });
    }
  }

  return artifacts;
}

function getModePromptSuffix(mode) {
  switch (mode) {
    case "write":
      return `\n\nIMPORTANT: Produce your output as a JSON file operation manifest. Format:
{"operations":[{"type":"create","path":"relative/path.js","content":"file content here"},{"type":"edit","path":"existing/file.js","content":"full new content"}]}

If you cannot produce JSON, write code blocks with \`// file: path/to/file.js\` annotations above each block. Do NOT produce prose descriptions of what you would write — produce the actual file contents.`;
    case "read":
      return `\n\nYou are reviewing actual file contents provided below. Produce a structured assessment: what works, what's broken, what to fix. Be specific with line numbers and code references.`;
    case "execute":
      return `\n\nProduce commands to run as a JSON array: [{"cmd":"npm test"}]
The system will execute these commands and show you the results for interpretation.`;
    default:
      return "";
  }
}

// ── Phase 2: route one seat to the agent loop or a single-shot dispatch ──
function seatLoopEnabled(seatLoop, seatId) {
  if (!seatLoop) return false;
  if (seatLoop === true) return true;
  if (Array.isArray(seatLoop)) return seatLoop.includes(seatId);
  if (seatLoop instanceof Set) return seatLoop.has(seatId);
  return false;
}

// ── model-resource dispatch choke-point (the ONE place a queryModel call is made) ──
//
// Every dispatch site in this module routes through querySeat. It reads ONLY opts.seat and
// opts.seatModelResource (both ride in via the spread dispatchOpts); it never touches
// roleHint/skillGrants/raw/topology/projectId, so each call site keeps its exact opts object
// byte-for-byte and the only textual change at a site is queryModel -> querySeat.
//
// BACK-COMPAT (mechanical, not promised): for a flat id, select() pins the known id via
// getEntry BEFORE any dot/colon sugar parse (model-resource.js:65-68) with reasoning:null,
// so resolve() returns params={} and applyReasoningParamMap returns
// {universalReasoning:undefined, bridgeOptions:{}} -> reasoningOpts={} -> queryModel(flatId,
// msg, {...opts}), byte-identical to the prior direct call. For a real SELECTION, reasoningOpts
// collapses to at most {reasoning} (the universal dial only — the per-provider knob now lives in
// each bridge, not in this opts object), so the dispatch opts shape is strictly smaller than
// before. The persona overlay is inert when no persona modelResource exists (the universal
// case — the field is greenfield).

const WORKSPACE_CONTEXT_EXCLUDED = new Set([
  ".git",
  ".illuci",
  ".illuci-sandboxes",
  ".illuci-bridge",
  "node_modules",
  "vendor",
  "dist",
  "build",
]);

function workspaceEntries(root, limit = 40) {
  try {
    if (!existsSync(root)) return [];
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => !workspaceEntryExcluded(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, limit)
      .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`);
  } catch {
    return [];
  }
}

function workspaceEntryExcluded(name) {
  if (WORKSPACE_CONTEXT_EXCLUDED.has(name)) return true;
  const lowered = String(name).toLowerCase();
  return lowered === ".env"
    || lowered.startsWith(".env.")
    || lowered.endsWith(".pem")
    || lowered.endsWith(".key")
    || lowered.endsWith(".p12")
    || lowered.includes("secret");
}

export function buildWorkspaceContextBlock({ dispatchOpts = {}, seatId = null, mode = "respond" } = {}) {
  const setting = dispatchOpts.workspaceContext;
  if (setting === false || setting === "off") return null;

  const root = pathResolve(dispatchOpts.workspaceRoot || process.cwd());
  const governedToolBoundary = seatLoopEnabled(dispatchOpts.seatLoop, seatId);
  const runnerMediated = mode === "read" || mode === "execute" || mode === "delegate";
  const entries = setting === "minimal" ? [] : workspaceEntries(root);

  const lines = ["[Workspace context]", `Workspace root: ${root}`];
  if (governedToolBoundary) {
    lines.push("Tool access: governed tool boundary active; built-in file/search/shell/git tools are available only through run-control-owned tool execution.");
  } else if (runnerMediated) {
    lines.push(`Tool access: runner-mediated ${mode} phase; inspect only the files, commands, or artifacts the runner supplies in this phase.`);
  } else {
    lines.push("Tool access: model-only single-shot; no live filesystem tools are available in this seat. Do not claim file inspection unless file content is present in the prompt.");
  }
  if (entries.length > 0) {
    lines.push(`Top-level entries (bounded): ${entries.join(", ")}`);
  }
  return lines.join("\n");
}

const _seatModelWarned = new Set();
function warnOnce(msg) { if (!_seatModelWarned.has(msg)) { _seatModelWarned.add(msg); console.warn(msg); } }

// Rung 2 of the seat precedence ladder: which seats receive a persona's declared
// modelResource overlay. A persona seats its seat ONLY when that seat is not pinned
// EXPLICITLY — by the caller lineup OR the org's own lineup (both win over auto-fill,
// so guarding only the caller would let a persona override an explicit org pin =
// inversion). A persona with no modelResource contributes nothing (greenfield no-op).
export function buildSeatModelResource(personas, callerLineup, orgLineup) {
  const out = {};
  if (!personas) return out;
  const explicitlyPinned = new Set([
    ...Object.keys(orgLineup || {}),
    ...Object.keys(callerLineup || {}),
  ]);
  for (const [seatId, p] of Object.entries(personas)) {
    if (explicitlyPinned.has(seatId)) continue;
    const mr = extractPersonaModelResource(p);
    if (mr != null) out[seatId] = mr;
  }
  return out;
}

// Resolve a seat's selection (lineup value OR persona overlay) to a concrete dispatch
// target + the reasoning params (dial -> per-provider knob) + normalized runtime
// provenance. Precedence: a persona-declared modelResource (opts.seatModelResource[opts.seat])
// is consulted ONLY when present, via the single load-bearing expression
// `personaSel ?? modelOrSelection`; otherwise modelOrSelection flows untouched.
function isPublicModelResourceId(value) {
  return typeof value === "string" && value.startsWith("model.");
}

function channelFromTarget(modelResource, dispatchTarget) {
  const resourceChannel = modelResource?.channels?.find((channel) => channel.id === dispatchTarget?.channelId) || null;
  if (!resourceChannel) return null;
  return {
    transport: resourceChannel.transport || null,
    bridge: resourceChannel.bridge || null,
    provider: dispatchTarget?.diagnostics?.providerKey || null,
    auth: dispatchTarget?.diagnostics?.auth || null,
    model: dispatchTarget?.providerModel || null,
  };
}

function runtimeRecord({ requested, source, modelResource, dispatchTarget, params = {} }) {
  return {
    requested,
    source,
    modelResourceId: dispatchTarget.modelResourceId || modelResource?.id || null,
    modelLabel: modelResource?.label || null,
    dispatchId: dispatchTarget.dispatchId || null,
    providerResourceId: dispatchTarget.providerResourceId || null,
    channelId: dispatchTarget.channelId || null,
    bridge: dispatchTarget.bridge || null,
    transport: dispatchTarget.transport || null,
    providerModel: dispatchTarget.providerModel || null,
    controls: {
      ...(params.reasoning ? { reasoning: params.reasoning } : {}),
    },
  };
}

function withRuntimeControls(runtime, opts = {}) {
  if (!runtime) return null;
  const controls = { ...(runtime.controls || {}) };
  if (opts.reasoning) controls.reasoning = opts.reasoning;
  if (typeof opts.thinking === "boolean") controls.thinking = opts.thinking;
  if (opts.params?.think !== undefined) controls.thinking = opts.params.think;
  if (opts.params?.num_predict !== undefined) controls.num_predict = opts.params.num_predict;
  if (opts.timeoutMs !== undefined && opts.timeoutMs !== null) controls.timeoutMs = opts.timeoutMs;
  return { ...runtime, controls };
}

function resolveRuntimeSelection(selectionInput) {
  if (isPublicModelResourceId(selectionInput)) {
    const resolved = resolveModelResource(selectionInput);
    const channel = channelFromTarget(resolved.model, resolved.dispatchTarget);
    return {
      model: resolved.dispatchTarget.dispatchId,
      params: resolved.params || {},
      channel,
      runtime: runtimeRecord({
        requested: selectionInput,
        source: "public-model-resource",
        modelResource: resolved.model,
        dispatchTarget: resolved.dispatchTarget,
        params: resolved.params || {},
      }),
    };
  }

  const resolved = resolveSelection(selectionInput);
  const dispatchTarget = compileDispatchTarget(resolved);
  const modelResource = getModelResource(resolved.entry.id);
  const channel = channelFromTarget(modelResource, dispatchTarget);
  const flatKnownString = typeof selectionInput === "string" && getEntry(selectionInput);
  return {
    model: flatKnownString ? selectionInput : resolved.entry.id,
    params: resolved.params || {},
    channel,
    runtime: runtimeRecord({
      requested: selectionInput,
      source: flatKnownString ? "legacy-dispatch-id" : "model-selection",
      modelResource,
      dispatchTarget,
      params: resolved.params || {},
    }),
  };
}

export function resolveSeatModel(modelOrSelection, opts = {}) {
  const personaSel = opts.seat ? opts.seatModelResource?.[opts.seat] : null;
  const selectionInput = personaSel ?? modelOrSelection;
  try {
    const resolved = resolveRuntimeSelection(selectionInput);
    const mapped = applyReasoningParamMap(getEntry(resolved.model) || getEntry(resolved.runtime?.dispatchId), resolved.params);
    const reasoningOpts = mapped.universalReasoning ? { reasoning: mapped.universalReasoning } : {};
    const dispatchOptions = {
      ...(resolved.channel ? { channel: resolved.channel } : {}),
      ...(resolved.runtime ? { modelRuntime: resolved.runtime } : {}),
    };
    return { model: resolved.model, reasoningOpts, dispatchOptions };
  } catch (e) {
    if (personaSel != null) warnOnce(`[Runner] persona modelResource "${personaSel}" for seat "${opts.seat}" did not resolve; falling back (${e.message})`);
    // Never String()-coerce a selection object here: that yields "[object Object]" and leaks
    // into the seat's own "Model:" governance line (injector.js). Route through the same stable
    // label used for the peer roster so the seat self-id and roster id agree for unresolved selections.
    return { model: stableSelectionLabel(selectionInput), reasoningOpts: {} };
  }
}

function stableSelectionLabel(selectionInput) {
  if (selectionInput && typeof selectionInput === "object") {
    const parts = [
      selectionInput.id ? `id:${selectionInput.id}` : null,
      selectionInput.family,
      selectionInput.variant,
      selectionInput.reasoning,
      selectionInput.transport,
    ].filter((part) => part !== null && part !== undefined && String(part).trim() !== "");
    if (parts.length) return parts.map(String).join(".");
    try {
      const serialized = JSON.stringify(selectionInput);
      if (serialized) return serialized;
    } catch {
      // Fall through to the generic marker; peer labels must never leak object coercion.
    }
    return "model-selection";
  }
  return String(selectionInput);
}

function peerIdForSelection(selectionInput) {
  try {
    const resolved = resolveRuntimeSelection(selectionInput);
    const model = resolved?.model == null ? "" : String(resolved.model);
    if (model && model !== "[object Object]") return model;
  } catch {
    // Unresolved selections still need stable display labels for the peer frame.
  }
  return stableSelectionLabel(selectionInput);
}

export function peerIdsForLineup(lineup = {}) {
  const ids = [];
  for (const models of Object.values(lineup || {})) {
    const modelList = Array.isArray(models) ? models : [models];
    for (const model of modelList) {
      const id = peerIdForSelection(model);
      if (id) ids.push(id);
    }
  }
  return [...new Set(ids)];
}

// The single legitimate queryModel call site. Resolves the selection (+ persona overlay),
// then dispatches with a selection's explicit reasoning dial layered AFTER opts so it
// overrides a global --reasoning. opts-shape-agnostic: every caller keeps its opts verbatim.
async function querySeat(modelOrSelection, msg, opts = {}) {
  const { [continuityObserverKey]: observer, [continuityPhaseKey]: phaseId,
    [assignedAgentRequirementKey]: requireAssignedAgent, ...forwarded } = opts;
  if (requireAssignedAgent && (typeof opts.agentId !== "string" || !opts.agentId.trim())) {
    throw Object.assign(new Error("An explicit assigned agent is required"), { code: "ILLUCI_ASSIGNED_AGENT_REQUIRED" });
  }
  const { model, reasoningOpts, dispatchOptions = {} } = resolveSeatModel(modelOrSelection, forwarded);
  const mergedOpts = { ...forwarded, ...dispatchOptions, ...reasoningOpts };
  if (requireAssignedAgent && mergedOpts.agentId !== opts.agentId) {
    throw Object.assign(new Error("Assigned agent changed during model resolution"), { code: "ILLUCI_ASSIGNED_AGENT_CHANGED" });
  }
  if (mergedOpts.modelRuntime) mergedOpts.modelRuntime = withRuntimeControls(mergedOpts.modelRuntime, mergedOpts);
  const invoke = () => queryModel(model, msg, mergedOpts);
  return observer ? observer.invoke({ recipientId: opts.agentId, phaseId, seat: opts.seat, model, route: "query-model" }, msg, invoke) : invoke();
}

// Phase 7 — the collect side of the detached spawn. mcpTools-shaped (like siblingTool /
// spawn_topology), so a loop-capable seat reaches it through the same surface. Bound to one
// seat's run via the per-session DetachedRunRegistry + this run's parentRunId.
//
// collect_topology({ childRunId, waitMs? }):
//   - no childRunId -> list this parent's detached runs (a non-blocking roster snapshot)
//   - waitMs <= 0 (default) -> a non-blocking poll of one run
//   - waitMs  > 0           -> await one run up to waitMs (the entry SURVIVES a timeout)
// On a terminal read (done/failed) the entry is RELEASED from the registry so a long
// company run does not accumulate settled entries unbounded. The childRunId is the registry
// key; the real run id (trace.runId) rides the returned trace separately (they can differ —
// the key is minted before the run mints its real id, mirroring runner.js:160-163).
export function collectTopologyTool({ registry, parentRunId = null }) {
  async function handler(args = {}) {
    if (!registry) return { ok: false, reason: "no-registry", detail: "collect called with no detached registry" };
    const childRunId = args.childRunId ? String(args.childRunId) : null;
    if (!childRunId) {
      // Roster mode — every detached run this parent kicked, terminal or running.
      return { ok: true, runs: registry.list(parentRunId) };
    }
    const waitMs = Number(args.waitMs) || 0;
    const snap = waitMs > 0 ? await registry.await(childRunId, { timeoutMs: waitMs }) : registry.poll(childRunId);

    if (snap.status === "unknown") {
      return { ok: false, reason: "unknown-child", detail: `no detached run "${childRunId}"`, childRunId };
    }
    if (snap.status === "running") {
      return { ok: true, status: "running", childRunId, topologyId: snap.topologyId };
    }
    if (snap.status === "failed") {
      registry.release(childRunId); // terminal read -> free the entry
      return { ok: false, status: "failed", childRunId, topologyId: snap.topologyId, error: snap.error || "child failed" };
    }
    // done
    const trace = snap.result || null;
    registry.release(childRunId); // terminal read -> free the entry
    if (trace && trace.halted) {
      return { ok: false, status: "done", childRunId, topologyId: snap.topologyId, runId: trace.runId || null, reason: "child-halted", haltReason: trace.haltReason || null, trace };
    }
    return { ok: true, status: "done", childRunId, topologyId: snap.topologyId, runId: (trace && trace.runId) || null, trace };
  }

  return {
    name: "collect_topology",
    description: "Collect the result of a child topology you spawned detached. Pass childRunId to poll (or await with waitMs ms) a specific run; omit it to list your detached runs. A still-running run reports status:'running'; a finished run returns its trace.",
    parameters: {
      type: "object",
      properties: {
        childRunId: { type: "string", description: "the childRunId returned by a detached spawn_topology; omit to list your detached runs" },
        waitMs: { type: "number", description: "optional: await up to this many ms for the run to finish (0/omitted = non-blocking poll)" },
      },
      required: [],
    },
    handler,
  };
}

// One seat dispatch. seatLoop off (default) → single-shot querySeat, byte-identical
// to the prior behavior. seatLoop on for this seat → the agent loop with in-context
// tools (query_sibling). Both return the same { model, response, usage, error } shape,
// so the phase executors treat them identically. Both branches share resolveSeatModel so
// there is no split-brain and no double-resolution that could drop a dial.
async function dispatchSeat(modelId, msg, seatId, seatDef, dispatchOpts, agent = null) {
  if (dispatchOpts[assignedAgentRequirementKey] && (typeof agent?.agentId !== "string" || !agent.agentId.trim())) {
    throw Object.assign(new Error("An explicit assigned agent is required"), { code: "ILLUCI_ASSIGNED_AGENT_REQUIRED" });
  }
  if (seatLoopEnabled(dispatchOpts.seatLoop, seatId)) {
    // The seat-loop branch needs the RESOLVED model id for makeSpawnTool + runSeatLoop;
    // resolveSeatModel is the same path querySeat uses, so the two branches never diverge.
    const { model, dispatchOptions = {} } = resolveSeatModel(modelId, { ...dispatchOpts, seat: seatId });
    if (dispatchOpts.directAttemptJournalRoot && (dispatchOptions.channel?.bridge || getBridgeRegistryEntry(model)?.bridge) === 'codex.js') {
      throw Object.assign(Error('Direct Codex seat-loop requires journal integration before execution'),{code:'ILLUCI_ATTEMPT_UNCONFIRMED',retrySafe:false});
    }
    const tools = [siblingTool];
    // Phase 5 — a loop-capable seat in a spawn-enabled run gains the bounded, gated
    // spawn_topology tool, parented at this run's node in the TopologyTree.
    if (dispatchOpts.spawn && dispatchOpts.spawnTree && dispatchOpts.runId) {
      // Phase 7 — when spawnDetached is armed, the seat's spawn returns a childRunId
      // immediately (same-loop, not awaited) and a sibling collect_topology tool reads it.
      // The registry is the per-session DetachedRunRegistry (mirrors the per-session tree).
      const detached = dispatchOpts.spawnDetached || false;
      const registry = detached ? getOrCreateRegistry(dispatchOpts.sessionId) : null;
      const spawnTool=makeSpawnTool({
        sessionId: dispatchOpts.sessionId,
        parentRunId: dispatchOpts.runId,
        tree: dispatchOpts.spawnTree,
        // Mandate-convention heal (colosseum Condition 5): carry the mandate OBJECT
        // verbatim, NOT JSON-stringified. The stringify existed only to splice the
        // mandate into the child's prompt text (the now-retired prepend); the child
        // runner consumes this as options.mandate and renders it through the single
        // [Mandate] frame block (renderMandateBlock), which reads mandate.intent.raw /
        // mandate.operator.name — a stringified mandate would not render and would throw.
        carriedMandate: dispatchOpts.mandate || null,
        // [A41]/R1: the spawning seat's pinned resolution binds its children.
        parentCapabilityResolution: capabilityResolutionFor(dispatchOpts, seatId),
        signal: dispatchOpts.signal,
        seat: seatId, model,
        detached, registry,
        // [A91]/DR-184: the childIdentity carry — {} under `none` (the
        // byte-identity law); the manifest + genome control under
        // `inherit`/`derive`; the control alone under `explicit`.
        childCarry: carryChildIdentity({ genome: dispatchOpts.genome, agentManifest: dispatchOpts.agentManifest }),
        // [A92]/DR-185: the normalized state gates explicit-mode spawn args.
        childIdentityState: normalizeChildIdentity(dispatchOpts.genome),
        // Cond 11 — carry the AWARENESS key into the child EXPLICITLY (the spawn-tree key
        // is sessionId, passed separately). The child publishes/recalls under the same
        // busScope this run dispatched under, so a spawned sub-team stays in its parent's
        // awareness window. null on a flat/company run -> the child's runner falls back to
        // sessionId (byte-identical to today's company-wide bus). The tree key never changes.
        busScope: dispatchOpts.busScope || null,
        ...(Object.hasOwn(dispatchOpts, "awarenessAssignment") ? { awarenessAssignment: dispatchOpts.awarenessAssignment } : {}),
      }, { requestApproval });
      tools.push(spawnTool);
      // The collect tool is pushed ONLY when detached is armed — without it the tool is
      // inert (there are no detached runs to collect), so an unarmed run is unchanged.
      if (detached && registry) {
        tools.push(collectTopologyTool({ registry, parentRunId: dispatchOpts.runId }));
      }
    }
    const loopOptions = {
      model, message: msg, seat: seatId, roleHint: seatDef?.roleHint,
      agentId: agent?.agentId || null,
      agentSlug: agent?.agentSlug || null,
      requireAssignedAgent: dispatchOpts[assignedAgentRequirementKey] === true,
      cwd: dispatchOpts.cwd || dispatchOpts.workspaceRoot || process.cwd(),
      topology: dispatchOpts.topology, projectId: dispatchOpts.projectId, sessionId: dispatchOpts.sessionId,
      // The seat-loop is the ONLY path where a seat actually calls tools, so it is
      // the only path where the DR-112 skill-license gate can bite. It must carry the
      // same resolved grants the single-shot path passes below, or off-floor MCP access
      // goes ungated on precisely the branch that reaches tools.
      skillGrants: seatGrantFor(dispatchOpts, seatId, agent),
      // [A39]/CAP-3: the record-backed capability resolution rides the same path
      // as skillGrants — the tool seam warns on unlicensed labeled affordances.
      capabilityResolution: capabilityResolutionFor(dispatchOpts, seatId),
      workPermit: workPermitFor(dispatchOpts, agent),
      workPermitRequired: dispatchOpts.workPermitRequired === true,
      onPermission: dispatchOpts.onPermission, signal: dispatchOpts.signal,
      tools, maxSteps: dispatchOpts.seatLoopMaxSteps || undefined,
    };
    // Preparation failures precede the observed entry; the operation contains
    // only the actual call, so an uncalled loop cannot acquire an entry record.
    const invoke = () => runSeatLoop(loopOptions);
    const observer = dispatchOpts[continuityObserverKey];
    return observer ? observer.invoke({ recipientId: agent?.agentId, phaseId: dispatchOpts[continuityPhaseKey],
      seat: seatId, model, route: "seat-loop-entry" }, msg, invoke) : invoke();
  }
  // Single-shot: route the RAW modelId through querySeat — it resolves the selection
  // (+ persona overlay) and layers the reasoning dial after these opts itself.
  return querySeat(modelId, msg, {
    ...dispatchOpts,
    seat: seatId,
    roleHint: seatDef?.roleHint,
    agentId: agent?.agentId || null,
    agentSlug: agent?.agentSlug || null,
    skillGrants: seatGrantFor(dispatchOpts, seatId, agent),
    capabilityResolution: capabilityResolutionFor(dispatchOpts, seatId),
    workPermit: workPermitFor(dispatchOpts, agent),
    workPermitRequired: dispatchOpts.workPermitRequired === true,
  });
}

// ── Phase 3: awareness recall (into the frame) + publish (after the dispatch) ──
// Both gated on dispatchOpts.awareness; off → null/no-op, so existing councils are
// byte-identical. Best-effort: awareness never throws into a dispatch. The budget is
// scaled to the seat model (computeAwarenessBudget).
//
// Cond 11 — the awareness store's `company` field is the AWARENESS SCOPE key, which is
// busScope when one is set, ELSE the sessionId. This `?? sessionId` fallback is what
// keeps the company case byte-identical (a member sets no busScope, so siblings recall
// under the shared sessionId exactly as before) AND lets an orchestrate pipeline stage
// publish/recall under a per-stage key (`${sessionId}:stage:i`) so stage 2 cannot see
// stage 1's traffic — even though both stages share the sessionId-keyed spawn tree.
// The scope key NEVER aliases the spawn-tree key (getOrCreateTree stays on sessionId).
function awarenessScope(dispatchOpts) {
  return dispatchOpts.busScope ?? dispatchOpts.sessionId ?? null;
}

function awarenessBlockFor(modelId, seatId, dispatchOpts) {
  if (!dispatchOpts.awareness) return null;
  try {
    return recallBlock({
      company: awarenessScope(dispatchOpts),
      excludeTopologyId: dispatchOpts.topologyId || null,
      tags: dispatchOpts.seatTags?.[seatId] || [],
      budget: computeAwarenessBudget(modelId),
      ...(Object.hasOwn(dispatchOpts, "awarenessAssignment") ? { assignment: dispatchOpts.awarenessAssignment } : {}),
    });
  } catch { return null; }
}

function publishSeatOutcome(seatId, result, dispatchOpts) {
  if (!dispatchOpts.awareness || !result) return;
  try {
    const summary = String(result.response || result.error || "").slice(0, 1536);
    if (!summary) return;
    publish({
      company: awarenessScope(dispatchOpts),
      topologyId: dispatchOpts.topologyId || null,
      seatId,
      kind: result.error ? "dispatch.error" : "dispatch.out",
      summary,
      tags: dispatchOpts.seatTags?.[seatId] || [],
      tokens: estTokens(result.response || result.error || ""),
      ...(Object.hasOwn(dispatchOpts, "awarenessAssignment") ? { assignment: dispatchOpts.awarenessAssignment } : {}),
    });
  } catch { /* awareness is best-effort */ }
}

function agentForSeat(dispatchOpts, seatId, index = 0) {
  const agents = dispatchOpts.agentAssignments?.[seatId] || [];
  return agents[index] || null;
}

function youBlockFor(dispatchOpts, seatId, agent = null) {
  return (agent?.agentId && ownEntry(dispatchOpts.youBlocksByAgent, agent.agentId)) || ownEntry(dispatchOpts.youBlocks, seatId) || null;
}

function skillBlockFor(dispatchOpts, seatId, agent = null) {
  return (agent?.agentId && ownEntry(dispatchOpts.skillBlocksByAgent, agent.agentId)) || ownEntry(dispatchOpts.skillBlocks, seatId) || null;
}

function skillFrameworkBlockFor(dispatchOpts, seatId) {
  return ownEntry(dispatchOpts.skillFrameworkBlocks, seatId) || null;
}

function seatGrantFor(dispatchOpts, seatId, agent = null) {
  return (agent?.agentId && ownEntry(dispatchOpts.seatGrantsByAgent, agent.agentId)) || ownEntry(dispatchOpts.seatGrants, seatId) || null;
}

function ownEntry(map, key) { return map && Object.hasOwn(map, key) ? map[key] : null; }

function skillGrantsForCognitivePreflight(grants = null) {
  if (!grants || typeof grants !== "object") return null;
  return {
    skillIds: Array.isArray(grants.skillIds) ? grants.skillIds.map(String) : [],
    mcpBridges: grants.mcpBridges instanceof Set ? [...grants.mcpBridges].map(String) : [],
    autonomy: {
      sandboxRequired: grants.autonomy?.sandboxRequired === true,
      requiresIntrospector: grants.autonomy?.requiresIntrospector === true,
    },
  };
}

function toolChannelsForCognitivePreflight(dispatchOpts = {}, seatId, agent = null) {
  const channels = new Set();
  for (const value of [
    ...(Array.isArray(dispatchOpts.toolChannels) ? dispatchOpts.toolChannels : []),
    ...(Array.isArray(dispatchOpts.enabledToolChannels) ? dispatchOpts.enabledToolChannels : []),
  ]) {
    if (value) channels.add(String(value));
  }
  const grants = seatGrantFor(dispatchOpts, seatId, agent);
  if (grants?.mcpBridges instanceof Set && grants.mcpBridges.size > 0) channels.add("mcp");
  for (const use of dispatchOpts.skillFrameworkUses?.[seatId] || []) {
    for (const channel of use?.resolved?.enabledToolChannels || []) {
      if (channel) channels.add(String(channel));
    }
  }
  return [...channels];
}

function workPermitFor(dispatchOpts, agent = null) {
  const permits = dispatchOpts.workPermits;
  if (!permits || !agent) return null;
  if (Array.isArray(permits)) {
    return permits.find((permit) => permit?.agentId === agent.agentId || permit?.agentId === agent.agentSlug) || null;
  }
  if (typeof permits === "object") {
    return permits[agent.agentId] || permits[agent.agentSlug] || permits.default || null;
  }
  return null;
}

function envFalse(name) {
  return String(process.env[name] || "").trim().toLowerCase() === "false";
}

function envTrue(name) {
  return ["1", "true", "yes", "on"].includes(String(process.env[name] || "").trim().toLowerCase());
}

const COMPUTE_POSTURES = new Set(["abundant", "bounded", "constrained", "unknown"]);

function computePostureFromOptions(options = {}) {
  const explicit = options.computePosture || options.orchestratorComputePosture || process.env.ILLUCI_COMPUTE_POSTURE;
  if (typeof explicit === "string" && COMPUTE_POSTURES.has(explicit)) return explicit;
  if (options.tokenBudget !== undefined && options.tokenBudget !== null) return "bounded";
  return "unknown";
}

function cognitivePreflightEnabled(dispatchOpts = {}) {
  return dispatchOpts.cognitivePreflight !== false && !envFalse("ILLUCI_COGNITIVE_PREFLIGHT");
}

function cognitiveControlsEnabled(dispatchOpts = {}) {
  return dispatchOpts.cognitiveControlsEnabled === true || envTrue("ILLUCI_COGNITIVE_CONTROLS_ENABLED");
}

function currentThinkingControl(dispatchOpts = {}) {
  if (typeof dispatchOpts.thinking === "boolean") return dispatchOpts.thinking;
  if (typeof dispatchOpts.params?.think === "boolean") return dispatchOpts.params.think;
  return null;
}

function modelResourceForCognitivePreflight(modelId, resolved = {}) {
  const runtimeResource = resolved.dispatchOptions?.modelRuntime?.modelResourceId;
  return getModelResource(runtimeResource) || getModelResource(resolved.model) || getModelResource(modelId);
}

function selectionProvenanceForSeat(dispatchOpts = {}, seatId, modelId) {
  const personaModelResource = dispatchOpts.seatModelResource?.[seatId] ?? null;
  const audit = Array.isArray(dispatchOpts.modelDelegation)
    ? dispatchOpts.modelDelegation.find((entry) => entry?.seatId === seatId)
    : null;
  const selected = Array.isArray(audit?.selected)
    ? audit.selected.map(String)
    : (modelId ? [String(modelId)] : []);

  return {
    source: personaModelResource != null ? "persona-model-resource" : (audit?.source || "not-recorded"),
    selected,
    roleHint: audit?.roleHint || null,
    requiredMode: audit?.requiredMode || null,
    candidateCount: Number.isFinite(audit?.candidateCount) ? audit.candidateCount : null,
    harnessModel: audit?.harnessModel || null,
  };
}

function cognitiveDispatchOptions(record) {
  const advisory = record?.dimensions?.controlAdvisory || {};
  const opts = {};
  if (advisory.reasoning?.apply && advisory.reasoning.recommended) {
    opts.reasoning = advisory.reasoning.recommended;
  }
  if (advisory.thinking?.apply && typeof advisory.thinking.recommended === "boolean") {
    opts.thinking = advisory.thinking.recommended;
  }
  return opts;
}

export async function buildCognitiveSeatFrame({
  modelId,
  seatId,
  agent = null,
  seatDef = null,
  dispatchOpts = {},
  task = "",
  assignment = null,
  dispositionBlock = null,
  modeSuffix = "",
  injections = [],
  awarenessBlock = null,
  includeLens = true,
  phase = null,
} = {}) {
  const baseFrame = (cognitiveBlock = null) => composeSeatFrame({
    mandate: dispatchOpts.mandate,
    seatDef,
    seatLabels: dispatchOpts.seatLabels,
    youBlock: youBlockFor(dispatchOpts, seatId, agent),
    cognitiveBlock,
    skillsBlock: skillBlockFor(dispatchOpts, seatId, agent),
    skillFrameworksBlock: skillFrameworkBlockFor(dispatchOpts, seatId),
    awarenessBlock,
    workspaceBlock: buildWorkspaceContextBlock({
      dispatchOpts,
      seatId,
      mode: phase?.mode || "respond",
    }),
    assignment,
    dispositionBlock,
    task,
    modeSuffix,
    injections,
    includeLens,
  });

  if (!cognitivePreflightEnabled(dispatchOpts)) {
    return { msg: baseFrame(null), dispatchOptions: {}, cognitiveRecord: null, trace: null };
  }

  const seatOpts = { ...dispatchOpts, seat: seatId };
  const resolved = resolveSeatModel(modelId, seatOpts);
  const modelResource = modelResourceForCognitivePreflight(modelId, resolved);
  const modelRuntime = resolved.dispatchOptions?.modelRuntime || null;
  const youBlock = youBlockFor(dispatchOpts, seatId, agent);
  const skillsBlock = skillBlockFor(dispatchOpts, seatId, agent);
  const skillGrants = skillGrantsForCognitivePreflight(seatGrantFor(dispatchOpts, seatId, agent));
  const controlsEnabled = cognitiveControlsEnabled(dispatchOpts);
  const record = buildCognitiveClassification({
    topologyId: dispatchOpts.topologyId,
    topologyName: dispatchOpts.topology,
    phaseId: phase?.id || null,
    seatId,
    seatLabel: seatDef?.label || seatId,
    roleHint: seatDef?.roleHint || null,
    modelId: resolved.model || String(modelId),
    requestedModel: typeof modelId === "string" ? modelId : JSON.stringify(modelId),
    agentId: agent?.agentId || null,
    agentSlug: agent?.agentSlug || null,
    runId: dispatchOpts.runId || null,
    sessionId: dispatchOpts.sessionId || null,
    projectId: dispatchOpts.projectId || null,
    task,
    mode: phase?.mode || "respond",
    hasDisposition: !!dispositionBlock,
    hasPersona: !!youBlock || !!agent?.agentSlug,
    hasRuntimeMemory: !!youBlock || !!awarenessBlock,
    companyScope: !!dispatchOpts.awareness,
    computePosture: dispatchOpts.computePosture || null,
    selectionProvenance: selectionProvenanceForSeat(dispatchOpts, seatId, modelId),
    toolAffordancePosture: dispatchOpts.toolAffordancePosture || dispatchOpts.toolAffordance || null,
    toolSurface: dispatchOpts.toolSurface || null,
    surfaceHints: dispatchOpts.surfaceHints || null,
    toolHints: dispatchOpts.toolHints || null,
    toolChannels: toolChannelsForCognitivePreflight(dispatchOpts, seatId, agent),
    skillGrants,
    apiEvidenceSufficient: dispatchOpts.apiEvidenceSufficient === true,
    interfaceEvidence: dispatchOpts.interfaceEvidence || null,
    // [A38]/CAP-2: the caller-supplied grant booleans (computerUseGrant /
    // frontendGrant) are DEAD — the runner no longer forwards them; grants
    // resolve from the operator-authenticated record store via the resolver
    // below (R4: nothing consumed by resolution comes from dispatch input).
    sandboxAvailable: dispatchOpts.sandboxAvailable === true,
    modelRuntime,
    modelResource,
    modelControls: modelResource?.controls || null,
    currentControls: {
      reasoning: dispatchOpts.reasoning || resolved.reasoningOpts?.reasoning || null,
      thinking: currentThinkingControl(dispatchOpts),
    },
    controlsEnforcementEnabled: controlsEnabled,
  }, {
    capabilityResolver: (subject) => capabilityResolutionFor(dispatchOpts, subject.seatId),
  });

  let trace = null;
  try {
    trace = appendCognitiveClassificationTrace(record);
  } catch {
    trace = null;
  }

  return {
    msg: baseFrame(renderCognitiveBlock(record)),
    dispatchOptions: cognitiveDispatchOptions(record),
    cognitiveRecord: record,
    trace,
  };
}

async function executeParallel(phase, lineup, input, topology, dispatchOpts = {}) {
  const seatIds = phase.seats || [phase.seat];
  const participants = [];

  for (const seatId of seatIds) {
    const models = lineup[seatId] || [];
    for (const [modelIndex, modelId] of models.entries()) {
      const agent = agentForSeat(dispatchOpts, seatId, modelIndex);
      participants.push({ model: modelId, seat: seatId, agentId: agent?.agentId || null, agentSlug: agent?.agentSlug || null, agentIndex: modelIndex });
    }
  }

  if (participants.length === 0) {
    return { responses: [], participants: [] };
  }

  const results = await Promise.allSettled(
    participants.map(async (p, i) => {
      const seatDef = topology.seats.find((s) => s.id === p.seat);
      const assignment = phase.assignments?.[i] || null;
      const modeSuffix = getModePromptSuffix(phase.mode);

      let msg;
      let cognitiveDispatch = {};
      if (phase.raw) {
        msg = input;
      } else {
        const dispositionBlock = await resolveDispositionBlock({
          modelId: p.model, seatId: p.seat, agentId: p.agentId, seatDef, dispatchOpts,
          sessionId: dispatchOpts.sessionId, topologyId: dispatchOpts.topologyId, phaseId: phase.id,
        });
        const injections = drainInjections(p.model).map((inj) => inj.content);
        const agent = agentForSeat(dispatchOpts, p.seat, p.agentIndex);
        const framed = await buildCognitiveSeatFrame({
          modelId: p.model, seatId: p.seat, agent, seatDef, dispatchOpts,
          assignment, dispositionBlock, task: input, modeSuffix, injections,
          awarenessBlock: awarenessBlockFor(p.model, p.seat, dispatchOpts),
          phase,
        });
        msg = framed.msg;
        cognitiveDispatch = framed.dispatchOptions;
      }

      const agent = agentForSeat(dispatchOpts, p.seat, p.agentIndex);
      const result = await dispatchSeat(p.model, msg, p.seat, seatDef, { ...dispatchOpts, ...cognitiveDispatch }, agent);
      publishSeatOutcome(p.seat, result, dispatchOpts);
      return { ...result, seat: p.seat, agentId: p.agentId, agentSlug: p.agentSlug };
    })
  );

  const responses = results.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    const participant = participants[i];
    return { model: participant.model, seat: participant.seat, agentId: participant.agentId, agentSlug: participant.agentSlug,
      error: typeof r.reason?.message === "string" && r.reason.message ? r.reason.message : "Parallel seat dispatch rejected", response: null };
  });

  return { responses, participants };
}

async function executeSingle(phase, lineup, input, topology, dispatchOpts = {}) {
  const seatId = phase.seat;
  const models = lineup[seatId] || [];

  if (models.length === 0) {
    return {
      responses: [{ model: "none", seat: seatId, error: `No model in seat "${seatId}"`, response: null }],
      participants: [],
    };
  }

  const modelId = models[0];
  const seatDef = topology.seats.find((s) => s.id === seatId);
  const modeSuffix = getModePromptSuffix(phase.mode);
  const agent = agentForSeat(dispatchOpts, seatId, 0);

  const dispositionBlock = await resolveDispositionBlock({
    modelId, seatId, agentId: agent?.agentId || null, seatDef, dispatchOpts,
    sessionId: dispatchOpts.sessionId, topologyId: dispatchOpts.topologyId, phaseId: phase.id,
  });
  const injections = drainInjections(modelId).map((inj) => inj.content);
  const framed = await buildCognitiveSeatFrame({
    modelId, seatId, agent, seatDef, dispatchOpts,
    dispositionBlock, task: input, modeSuffix, injections,
    awarenessBlock: awarenessBlockFor(modelId, seatId, dispatchOpts),
    phase,
  });
  const msg = framed.msg;

  try {
    const result = await dispatchSeat(modelId, msg, seatId, seatDef, { ...dispatchOpts, ...framed.dispatchOptions }, agent);
    publishSeatOutcome(seatId, result, dispatchOpts);
    return {
      responses: [{ ...result, seat: seatId, agentId: agent?.agentId || null, agentSlug: agent?.agentSlug || null }],
      participants: [{ model: modelId, seat: seatId, agentId: agent?.agentId || null, agentSlug: agent?.agentSlug || null }],
    };
  } catch (err) {
    return {
      responses: [{ model: modelId, seat: seatId, agentId: agent?.agentId || null, agentSlug: agent?.agentSlug || null, error: err.message, failed:true, ...(err.code?{code:err.code}:{}), ...(err.retrySafe===false?{retrySafe:false}:{}), ...(err.outcome==='unknown'?{outcome:'unknown'}:{}), response: null }],
      participants: [{ model: modelId, seat: seatId, agentId: agent?.agentId || null, agentSlug: agent?.agentSlug || null }],
    };
  }
}

async function executeSequential(phase, lineup, input, originalPrompt, topology, dispatchOpts = {}) {
  const seatIds = phase.seats || [phase.seat];
  const participants = [];
  const responses = [];
  let currentOutput = input;

  for (const seatId of seatIds) {
    const models = lineup[seatId] || [];
    const seatDef = topology.seats.find((s) => s.id === seatId);
    for (const [modelIndex, modelId] of models.entries()) {
      const agent = agentForSeat(dispatchOpts, seatId, modelIndex);
      participants.push({ model: modelId, seat: seatId, agentId: agent?.agentId || null, agentSlug: agent?.agentSlug || null });
      // The operator's task now rides in the [Mandate]; the [Task] body carries the
      // sequential-review instruction + the prior output to improve.
      const task = `This is a sequential review. Improve the previous output:\n\n${currentOutput}`;
      const dispositionBlock = await resolveDispositionBlock({
        modelId, seatId, agentId: agent?.agentId || null, seatDef, dispatchOpts,
        sessionId: dispatchOpts.sessionId, topologyId: dispatchOpts.topologyId, phaseId: phase.id,
      });
      const injections = drainInjections(modelId).map((inj) => inj.content);
      const framed = await buildCognitiveSeatFrame({
        modelId, seatId, agent, seatDef, dispatchOpts,
        dispositionBlock, task, injections,
        phase,
      });
      const msg = framed.msg;

      try {
        const result = await querySeat(modelId, msg, {
          ...dispatchOpts,
          ...framed.dispatchOptions,
          seat: seatId,
          roleHint: seatDef?.roleHint,
          agentId: agent?.agentId || null,
          agentSlug: agent?.agentSlug || null,
          skillGrants: seatGrantFor(dispatchOpts, seatId, agent),
          capabilityResolution: capabilityResolutionFor(dispatchOpts, seatId),
          workPermit: workPermitFor(dispatchOpts, agent),
          workPermitRequired: dispatchOpts.workPermitRequired === true,
        });
        responses.push({ ...result, seat: seatId, agentId: agent?.agentId || null, agentSlug: agent?.agentSlug || null });
        currentOutput = result.response || currentOutput;
      } catch (err) {
        responses.push({ model: modelId, seat: seatId, agentId: agent?.agentId || null, agentSlug: agent?.agentSlug || null, error: err.message, response: null });
      }
    }
  }

  return { responses, participants };
}

async function executeRotating(phase, lineup, input, topology, dispatchOpts = {}) {
  const seatIds = phase.seats || [phase.seat];
  const allModels = [];
  for (const seatId of seatIds) {
    for (const [modelIndex, modelId] of (lineup[seatId] || []).entries()) {
      const agent = agentForSeat(dispatchOpts, seatId, modelIndex);
      allModels.push({ model: modelId, seat: seatId, agentId: agent?.agentId || null, agentSlug: agent?.agentSlug || null, agentIndex: modelIndex });
    }
  }

  const maxRounds = Array.isArray(phase.rounds) ? phase.rounds[1] : (phase.rounds || 3);
  const responses = [];
  let sharedArtifact = input;

  for (let round = 0; round < maxRounds; round++) {
    const facIdx = round % allModels.length;
    const facilitator = allModels[facIdx];
    const contributors = allModels.filter((_, i) => i !== facIdx);

    // Facilitator poses question — framed with the mandate + facilitator seat lens.
    const facSeatDef = topology.seats.find(s => s.id === facilitator.seat);
    const facAgent = agentForSeat(dispatchOpts, facilitator.seat, facilitator.agentIndex);
    const facDisposition = await resolveDispositionBlock({
      modelId: facilitator.model, seatId: facilitator.seat, agentId: facAgent?.agentId || null, seatDef: facSeatDef, dispatchOpts,
      sessionId: dispatchOpts.sessionId, topologyId: dispatchOpts.topologyId, phaseId: phase.id,
    });
    const facFramed = await buildCognitiveSeatFrame({
      modelId: facilitator.model,
      seatId: facilitator.seat,
      agent: facAgent,
      seatDef: facSeatDef,
      dispatchOpts,
      assignment: `facilitator, round ${round + 1}`,
      dispositionBlock: facDisposition,
      task: `You are the facilitator for round ${round + 1}. Shared artifact:\n\n${sharedArtifact}\n\nPose the next question or direction.`,
      injections: drainInjections(facilitator.model).map((inj) => inj.content),
      phase,
    });
    const facPrompt = facFramed.msg;

    let facResult;
    try {
      facResult = await querySeat(facilitator.model, facPrompt, {
        ...dispatchOpts,
        ...facFramed.dispatchOptions,
        seat: facilitator.seat,
        agentId: facAgent?.agentId || null,
        agentSlug: facAgent?.agentSlug || null,
        skillGrants: seatGrantFor(dispatchOpts, facilitator.seat, facAgent),
        workPermit: workPermitFor(dispatchOpts, facAgent),
        workPermitRequired: dispatchOpts.workPermitRequired === true,
      });
    } catch (err) {
      facResult = { model: facilitator.model, response: null, error: err.message };
    }

    // Contributors respond with explicit pipeline modifiers when provided.
    const contribResults = await Promise.allSettled(
      contributors.map(async (c) => {
        const cSeatDef = topology.seats.find(s => s.id === c.seat);
        const cAgent = agentForSeat(dispatchOpts, c.seat, c.agentIndex);
        const cDisposition = await resolveDispositionBlock({
          modelId: c.model, seatId: c.seat, agentId: cAgent?.agentId || null, seatDef: cSeatDef, dispatchOpts,
          sessionId: dispatchOpts.sessionId, topologyId: dispatchOpts.topologyId, phaseId: phase.id,
        });
        const cFramed = await buildCognitiveSeatFrame({
          modelId: c.model,
          seatId: c.seat,
          agent: cAgent,
          seatDef: cSeatDef,
          dispatchOpts,
          dispositionBlock: cDisposition,
          task: `Facilitator asks:\n${facResult.response || "[no question]"}\n\nArtifact:\n${sharedArtifact}\n\nContribute.`,
          injections: drainInjections(c.model).map((inj) => inj.content),
          phase,
        });
        return querySeat(c.model, cFramed.msg, {
          ...dispatchOpts,
          ...cFramed.dispatchOptions,
          seat: c.seat,
          agentId: cAgent?.agentId || null,
          agentSlug: cAgent?.agentSlug || null,
          skillGrants: seatGrantFor(dispatchOpts, c.seat, cAgent),
          workPermit: workPermitFor(dispatchOpts, cAgent),
          workPermitRequired: dispatchOpts.workPermitRequired === true,
        });
      })
    );

    // Facilitator merges
    const contribText = contribResults.map((r, i) => {
      const val = r.status === "fulfilled" ? r.value : { response: null, error: r.reason?.message };
      return `[${contributors[i].model}]: ${val.response || val.error || "[no response]"}`;
    }).join("\n\n");

    try {
      const mergeFramed = await buildCognitiveSeatFrame({
        modelId: facilitator.model,
        seatId: facilitator.seat,
        agent: facAgent,
        seatDef: facSeatDef,
        dispatchOpts,
        assignment: `facilitator merging round ${round + 1}`,
        dispositionBlock: facDisposition,
        task: `Merge contributions into the shared artifact:\n\n${contribText}\n\nCurrent artifact:\n${sharedArtifact}`,
        phase,
      });
      const merge = await querySeat(facilitator.model, mergeFramed.msg, {
        ...dispatchOpts,
        ...mergeFramed.dispatchOptions,
        seat: facilitator.seat,
        agentId: facAgent?.agentId || null,
        agentSlug: facAgent?.agentSlug || null,
        skillGrants: seatGrantFor(dispatchOpts, facilitator.seat, facAgent),
        workPermit: workPermitFor(dispatchOpts, facAgent),
        workPermitRequired: dispatchOpts.workPermitRequired === true,
      });
      sharedArtifact = merge.response || sharedArtifact;
    } catch {}

    responses.push({
      round: round + 1,
      facilitator: facilitator.model,
      question: facResult.response,
      mergedArtifact: sharedArtifact,
    });
  }

  return { responses, participants: allModels, sharedArtifact };
}

// ═══════════════════════════════════════════════════════════════════════════
// W1: PHASE ARTIFACT CONSTRUCTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build a default text artifact from phase responses.
 * Every phase gets an artifact — respond-mode phases get { type: "text" }.
 */
function buildTextArtifact(phaseResult) {
  const content = (phaseResult.responses || [])
    .filter(r => r.response)
    .map(r => r.response)
    .join("\n\n---\n\n");
  return { type: "text", content };
}

// ═══════════════════════════════════════════════════════════════════════════
// W3: MODE VALIDATION
// ═══════════════════════════════════════════════════════════════════════════

function resolvePhaseMode(phase, options = {}) {
  const mode = phase.mode || "respond";
  if (!VALID_MODES.includes(mode)) {
    console.warn(`[runner] Unknown phase mode "${mode}" on phase "${phase.id}", falling back to "respond"`);
    return "respond";
  }
  return phaseModeForRunControl(mode, options.runControl);
}

// ═══════════════════════════════════════════════════════════════════════════
// W4: WRITE MODE EXECUTOR
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Execute a phase in write mode. The model produces file operations as a
 * structured JSON manifest. The runner parses the manifest and executes
 * each operation through the tool bridge.
 *
 * @param {object} phase - Phase definition
 * @param {object} phaseResult - Result from concurrency executor (already has responses)
 * @param {object} context - { sessionId, topologyId }
 * @returns {object} artifact - { type: "files", files: [...], content }
 */
async function executeWriteMode(phase, phaseResult, context) {
  const allFiles = [];
  // The telemetry recordEvent calls below reference `topologyId` + `dispatchOpts`, which
  // are NOT parameters of this function. Derive them from context so an arg-eval cannot
  // throw a ReferenceError and get caught by the op's try/catch — which mislabels a
  // SUCCESSFUL write as failed (the proof-v3 false-negative: the edit landed, the
  // post-write telemetry threw "topologyId is not defined").
  const topologyId = context.topologyId;
  const dispatchOpts = { projectId: context.projectId };

  for (const response of phaseResult.responses) {
    if (!response.response) continue;

    const operations = extractFileOperations(response.response);
    if (operations.length === 0) {
      // Model produced prose instead of structured ops — flag as malformed
      phaseResult.malformed = true;
      phaseResult.malformedReason = "expected file operations, got text";
      continue;
    }

    for (const op of operations) {
      const toolContext = {
        sessionId: context.sessionId,
        phaseId: phase.id,
        agentId: response.agentId || response.model,
        agentSlug: response.agentSlug || null,
        agentName: response.seat,
        topologyId: context.topologyId,
        workPermit: workPermitFor({ workPermits: context.workPermits }, { agentId: response.agentId, agentSlug: response.agentSlug }),
        workPermitRequired: context.workPermitRequired === true,
        gateLevel: "FULL",
      };

      if (context.sandboxes && context.sandboxes[response.seat]) {
        toolContext.workspaceRoot = context.sandboxes[response.seat].workdir;
      }

      // ─── FABRICATION GUARD ───
      // Refuse a full-content overwrite of an EXISTING file. A model must modify an
      // existing file via a TARGETED edit {type:"edit", path, oldString, newString} —
      // which cannot match unless it read the real content — never a wholesale replace.
      // NEW files (full content, not yet on disk) pass through untouched.
      const _fullContentOp = (op.type === "create" || op.type === "write" || op.type === "edit")
        && op.content != null && op.oldString == null;
      if (_fullContentOp) {
        let _exists = false;
        try { _exists = existsSync(pathResolve(toolContext.workspaceRoot || process.cwd(), op.path)); } catch {}
        if (_exists) {
          const reason = `Refused full-content overwrite of existing file ${op.path}. Emit a targeted edit: {type:"edit", path, oldString, newString}.`;
          allFiles.push({ path: op.path, operation: op.type, hash: null, content: null, success: false, error: reason });
          phaseResult.malformed = true;
          phaseResult.malformedReason = reason;
          continue;
        }
      }

      try {
        let result;
        switch (op.type) {
          case "create":
          case "write":
            result = await executeTool("file_write", { path: op.path, content: op.content }, toolContext);
            telemetryStore.recordEvent({
              run_id: topologyId,
              session_id: context.sessionId,
              project_id: dispatchOpts.projectId,
              event_type: "tool_execution",
              phase_id: phase.id,
              seat_id: response.seat,
              model_id: response.model,
              payload: {
                tool_name: "file_write",
                operation: op.type,
                path: op.path,
                success: result.success,
                error: result.success ? null : (result.error || result.reason),
              },
            });
            break;
          case "edit":
            result = await executeTool("file_edit",
              op.oldString != null
                ? { path: op.path, oldString: op.oldString, newString: op.newString ?? "" }
                : { path: op.path, content: op.content },
              toolContext);
            telemetryStore.recordEvent({
              run_id: topologyId,
              session_id: context.sessionId,
              project_id: dispatchOpts.projectId,
              event_type: "tool_execution",
              phase_id: phase.id,
              seat_id: response.seat,
              model_id: response.model,
              payload: {
                tool_name: "file_edit",
                operation: op.type,
                path: op.path,
                success: result.success,
                error: result.success ? null : (result.error || result.reason),
              },
            });
            break;
          case "delete":
            result = await executeTool("file_delete", { path: op.path }, toolContext);
            telemetryStore.recordEvent({
              run_id: topologyId,
              session_id: context.sessionId,
              project_id: dispatchOpts.projectId,
              event_type: "tool_execution",
              phase_id: phase.id,
              seat_id: response.seat,
              model_id: response.model,
              payload: {
                tool_name: "file_delete",
                operation: op.type,
                path: op.path,
                success: result.success,
                error: result.success ? null : (result.error || result.reason),
              },
            });
            break;
          default:
            result = { success: false, error: `Unknown operation type: ${op.type}` };
        }

        allFiles.push({
          path: op.path,
          operation: op.type,
          hash: simpleHash(op.content || ""),
          content: op.content || null,
          success: result.success,
          error: result.success ? null : (result.error || result.reason),
        });
      } catch (err) {
        allFiles.push({
          path: op.path,
          operation: op.type,
          hash: null,
          content: null,
          success: false,
          error: err.message,
        });
      }
    }
  }

  return {
    type: "files",
    files: allFiles,
    content: allFiles.map(f => `${f.operation} ${f.path} — ${f.success ? "ok" : f.error}`).join("\n"),
  };
}

/**
 * Extract file operations from model response.
 * Tries JSON first, then falls back to code block extraction.
 */
function extractFileOperations(text) {
  // Try JSON manifest extraction
  const jsonMatch = text.match(/```json\s*\n([\s\S]*?)```/) || text.match(/\{[\s\S]*"operations"[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const raw = jsonMatch[1] || jsonMatch[0];
      const parsed = JSON.parse(raw);
      const ops = parsed.operations || parsed;
      if (Array.isArray(ops) && ops.length > 0 && ops[0].path) {
        return ops.map(op => ({
          type: op.type || op.action || "create",
          path: op.path,
          content: op.content || "",
          oldString: op.oldString ?? op.old ?? op.search ?? undefined,
          newString: op.newString ?? op.new ?? op.replace ?? undefined,
        }));
      }
    } catch { /* fall through to code block extraction */ }
  }

  // Fallback: extract code blocks with file path annotations
  const blocks = [];
  const codeBlockRegex = /```[\w]*\s*\n\/\/\s*(?:file|path):\s*(.+)\n([\s\S]*?)```/gi;
  let match;
  while ((match = codeBlockRegex.exec(text)) !== null) {
    blocks.push({ type: "create", path: match[1].trim(), content: match[2] });
  }

  return blocks;
}

// ═══════════════════════════════════════════════════════════════════════════
// W5: READ MODE EXECUTOR
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Execute a phase in read mode. Reads files from the previous phase's
 * artifact and injects actual file contents into the model's prompt.
 * The model's response becomes an assessment artifact.
 *
 * @param {object} phase - Phase definition
 * @param {string} input - Resolved input (may reference file artifact)
 * @param {Array<{phaseId: string, artifact: object}>} referencedArtifacts - All artifacts from referenced phases
 * @param {object} lineup - Seat-to-model mapping
 * @param {object} topology - Full topology definition
 * @param {object} dispatchOpts - Dispatch options
 * @param {object} context - { sessionId, topologyId }
 * @returns {{ phaseResult, artifact }}
 */
async function executeReadMode(phase, input, referencedArtifacts, lineup, topology, dispatchOpts, context) {
  let enrichedInput = input;
  const filesRead = [];
  const seatIds = phase.seats || (phase.seat ? [phase.seat] : []);
  const participants = [];

  for (const seatId of seatIds) {
    for (const [modelIndex, modelId] of (lineup[seatId] || []).entries()) {
      const agent = agentForSeat(dispatchOpts, seatId, modelIndex);
      participants.push({ model: modelId, seat: seatId, agentId: agent?.agentId || null, agentSlug: agent?.agentSlug || null, agentIndex: modelIndex });
    }
  }

  // Collect file artifacts from ALL referenced phases (not just the last one)
  const fileArtifacts = referencedArtifacts.filter(a => a.artifact?.type === "files" && a.artifact.files);

  if (fileArtifacts.length > 0) {
    const fileContents = [];

    for (const { phaseId, artifact } of fileArtifacts) {
      for (const file of artifact.files) {
        if (!file.success || file.operation === "delete") continue;
        try {
          const reader = participants[0] || null;
          const readResult = await executeTool("file_read", { path: file.path }, {
            sessionId: context.sessionId,
            phaseId: phase.id,
            topologyId: context.topologyId,
            agentId: reader?.agentId || null,
            agentSlug: reader?.agentSlug || null,
            agentName: reader?.seat || null,
            workPermit: workPermitFor({ workPermits: context.workPermits }, { agentId: reader?.agentId, agentSlug: reader?.agentSlug }),
            workPermitRequired: context.workPermitRequired === true,
          });
          telemetryStore.recordEvent({
            run_id: context.topologyId,
            session_id: context.sessionId,
            project_id: dispatchOpts?.projectId,
            event_type: "tool_execution",
            phase_id: phase.id,
            seat_id: phase.seat || (phase.seats && phase.seats[0]),
            model_id: null,
            payload: {
              tool_name: "file_read",
              path: file.path,
              success: readResult.success,
              error: readResult.success ? null : (readResult.error || readResult.reason),
            },
          });
          if (readResult.success && readResult.result) {
            fileContents.push(`--- ${file.path} (from phase: ${phaseId}) ---\n${readResult.result.content}`);
            filesRead.push(file.path);
          }
        } catch (err) {
          fileContents.push(`--- ${file.path} (from phase: ${phaseId}) --- [read error]`);
          telemetryStore.recordEvent({
            run_id: context.topologyId,
            session_id: context.sessionId,
            project_id: dispatchOpts.projectId,
            event_type: "tool_execution",
            phase_id: phase.id,
            seat_id: participants[0]?.seat || null,
            model_id: participants[0]?.model || null,
            payload: {
              tool_name: "file_read",
              path: file.path,
              success: false,
              error: err.message,
            },
          });
        }      }
    }

    if (fileContents.length > 0) {
      enrichedInput = `Review the following files:\n\n${fileContents.join("\n\n")}\n\n---\n\nOriginal context:\n${input}`;
    }
  }

  // Run the standard concurrency executor with the enriched input
  const results = await Promise.allSettled(
    participants.map(async (p) => {
      const seatDef = topology.seats.find(s => s.id === p.seat);
      const seatLabel = seatDef?.label || p.seat;
      const msg = `You are the "${seatLabel}". Produce a thorough assessment.\n\n${enrichedInput}`;
      const agent = agentForSeat(dispatchOpts, p.seat, p.agentIndex);
      const result = await dispatchSeat(p.model, msg, p.seat, seatDef, dispatchOpts, agent);
      return { ...result, seat: p.seat, agentId: p.agentId, agentSlug: p.agentSlug };
    })
  );

  const responses = results.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    return { model: participants[i].model, seat: participants[i].seat, agentId: participants[i].agentId, agentSlug: participants[i].agentSlug, error: r.reason?.message, response: null };
  });

  const assessmentContent = responses.filter(r => r.response).map(r => r.response).join("\n\n---\n\n");

  return {
    phaseResult: { responses, participants },
    artifact: { type: "assessment", content: assessmentContent, filesRead },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// W6: EXECUTE MODE EXECUTOR
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Execute a phase in execute mode. Two-call pattern:
 *   1. Ask the model what commands to run
 *   2. Run the commands through the tool bridge
 *   3. Feed results back to the model for interpretation
 *
 * @param {object} phase - Phase definition
 * @param {string} input - Resolved input
 * @param {object} lineup - Seat-to-model mapping
 * @param {object} topology - Full topology definition
 * @param {object} dispatchOpts - Dispatch options
 * @param {object} context - { sessionId, topologyId }
 * @returns {{ phaseResult, artifact }}
 */
async function executeExecuteMode(phase, input, lineup, topology, dispatchOpts, context) {
  const seatId = phase.seat || (phase.seats ? phase.seats[0] : null);
  const models = lineup[seatId] || [];
  const modelId = models[0];
  const agent = agentForSeat(dispatchOpts, seatId, 0);

  if (!modelId) {
    return {
      phaseResult: { responses: [{ model: "none", seat: seatId, error: "No model in seat", response: null }], participants: [] },
      artifact: { type: "commands", commands: [], summary: "No model available" },
    };
  }

  const seatDef = topology.seats.find(s => s.id === seatId);
  const seatLabel = seatDef?.label || seatId;

  // Call 1: Ask the model what commands to run
  // If phase has predefined commands in modeConfig, skip this call
  let commands;
  let call1Result;

  if (phase.modeConfig?.commands) {
    commands = phase.modeConfig.commands.map(c => ({ cmd: c }));
  } else {
    const commandPrompt = buildExecuteCommandPrompt({
      seatLabel,
      input,
      workspaceRoot: dispatchOpts.workspaceRoot || context.workspaceRoot || process.cwd(),
      projectId: dispatchOpts.projectId || null,
    });
    call1Result = await querySeat(modelId, commandPrompt, {
      ...dispatchOpts,
      seat: seatId,
      roleHint: seatDef?.roleHint,
      agentId: agent?.agentId || null,
      agentSlug: agent?.agentSlug || null,
      skillGrants: seatGrantFor(dispatchOpts, seatId, agent),
      workPermit: workPermitFor(dispatchOpts, agent),
      workPermitRequired: dispatchOpts.workPermitRequired === true,
    });
    commands = extractCommands(call1Result.response || "");
  }

  // Execute commands through tool bridge with strictest gate level
  const commandResults = [];
  for (const cmd of commands) {
    try {
      const commandParams = { command: cmd.cmd, timeout: 60000 };
      if (cmd.workingDirectory || cmd.cwd) commandParams.workingDirectory = cmd.workingDirectory || cmd.cwd;
      const result = await executeTool("shell_exec", commandParams, {
        sessionId: context.sessionId,
        phaseId: phase.id,
        agentId: agent?.agentId || modelId,
        agentSlug: agent?.agentSlug || null,
        agentName: seatId,
        topologyId: context.topologyId,
        workspaceRoot: dispatchOpts.workspaceRoot || context.workspaceRoot || process.cwd(),
        workPermit: workPermitFor(dispatchOpts, agent),
        workPermitRequired: dispatchOpts.workPermitRequired === true,
        gateLevel: "ESCALATED",
      });
      commandResults.push({
        cmd: cmd.cmd,
        ...(commandParams.workingDirectory ? { workingDirectory: commandParams.workingDirectory } : {}),
        exitCode: result.result?.exitCode ?? -1,
        stdout: result.result?.stdout || "",
        stderr: result.result?.stderr || "",
        success: result.success,
      });
      telemetryStore.recordEvent({
        run_id: topology.id,
        session_id: context.sessionId,
        project_id: dispatchOpts.projectId,
        event_type: "tool_execution",
        phase_id: phase.id,
        seat_id: seatId,
        model_id: modelId,
        payload: {
          tool_name: "shell_exec",
          command: cmd.cmd,
          exitCode: result.result?.exitCode ?? -1,
          success: result.success,
          error: result.success ? null : (result.error || result.reason),
        },
      });
    } catch (err) {
      commandResults.push({
        cmd: cmd.cmd,
        exitCode: -1,
        stdout: "",
        stderr: err.message,
        success: false,
      });
      telemetryStore.recordEvent({
        run_id: topology.id,
        session_id: context.sessionId,
        project_id: dispatchOpts.projectId,
        event_type: "tool_execution",
        phase_id: phase.id,
        seat_id: seatId,
        model_id: modelId,
        payload: {
          tool_name: "shell_exec",
          command: cmd.cmd,
          exitCode: -1,
          success: false,
          error: err.message,
        },
      });
    }
  }

  // Call 2: Feed results back for interpretation
  const resultLog = commandResults.map(c =>
    `$ ${c.cmd}\nexit: ${c.exitCode}\n${c.stdout}${c.stderr ? `\nSTDERR: ${c.stderr}` : ""}`
  ).join("\n\n");

  const interpretPrompt = `You are the "${seatLabel}". Here are the execution results. Summarize the status — what passed, what failed, what needs attention.\n\n${resultLog}`;
  const call2Result = await querySeat(modelId, interpretPrompt, {
    ...dispatchOpts,
    seat: seatId,
    roleHint: seatDef?.roleHint,
    agentId: agent?.agentId || null,
    agentSlug: agent?.agentSlug || null,
    skillGrants: seatGrantFor(dispatchOpts, seatId, agent),
    workPermit: workPermitFor(dispatchOpts, agent),
    workPermitRequired: dispatchOpts.workPermitRequired === true,
  });

  const responses = [call1Result, call2Result].filter(Boolean).map(r => ({
    ...r,
    seat: seatId,
    agentId: agent?.agentId || null,
    agentSlug: agent?.agentSlug || null,
  }));

  return {
    phaseResult: { responses, participants: [{ model: modelId, seat: seatId, agentId: agent?.agentId || null, agentSlug: agent?.agentSlug || null }] },
    artifact: {
      type: "commands",
      commands: commandResults,
      summary: call2Result?.response || "No interpretation available",
    },
  };
}

/** Extract command list from model response */
function extractCommands(text) {
  // Try JSON object wrapper: {"commands": [...]}
  const objMatch = text.match(/\{\s*"commands"\s*:\s*(\[[\s\S]*?\])\s*\}/);
  if (objMatch) {
    try {
      const parsed = JSON.parse(objMatch[0]);
      if (Array.isArray(parsed.commands) && parsed.commands.length > 0) {
        return parsed.commands.map(c => typeof c === "string" ? { cmd: c } : c).filter(c => c.cmd);
      }
    } catch { /* fall through */ }
  }

  // Try JSON array
  const jsonMatch = text.match(/\[[\s\S]*?\]/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map(c => typeof c === "string" ? { cmd: c } : c).filter(c => c.cmd);
      }
    } catch { /* fall through */ }
  }

  // Fallback: lines starting with $ or >
  const lines = text.split("\n").filter(l => /^\s*[\$>]\s+/.test(l));
  return lines.map(l => ({ cmd: l.replace(/^\s*[\$>]\s+/, "").trim() })).filter(c => c.cmd);
}

// ═══════════════════════════════════════════════════════════════════════════
// W7: DELEGATE MODE EXECUTOR
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Execute a phase in delegate mode. Hands off to Codex's queryWithWrite()
 * for autonomous execution with native tool use.
 *
 * Gate: phase.mode must be explicitly "delegate" AND the topology must have
 * stabilityThreshold <= 0.3 (high-trust only).
 *
 * @param {object} phase - Phase definition
 * @param {string} input - Resolved input
 * @param {object} lineup - Seat-to-model mapping
 * @param {object} topology - Full topology definition
 * @param {object} dispatchOpts - Dispatch options
 * @returns {{ phaseResult, artifact }}
 */
async function executeDelegateMode(phase, input, lineup, topology, dispatchOpts) {
  const seatId = phase.seat || (phase.seats ? phase.seats[0] : null);
  const models = lineup[seatId] || [];
  const modelId = models[0];
  const agent = agentForSeat(dispatchOpts, seatId, 0);

  // Capability check: only Codex supports delegate mode currently
  const isCodex = modelId && modelId.includes("codex");

  // Trust check: topology must have low stability threshold (high trust)
  const trustOk = topology.stabilityThreshold !== null && topology.stabilityThreshold <= 0.3;

  if (!isCodex || !trustOk) {
    // Fall back to write mode
    console.warn(`[runner] delegate mode not available for ${modelId} in ${topology.id} (codex=${isCodex}, trust=${trustOk}). Falling back to write.`);

    // Run as normal query, then process as write mode
    const seatDef = topology.seats.find(s => s.id === seatId);
    const seatLabel = seatDef?.label || seatId;
    const msg = `You are the "${seatLabel}". Produce file operations as a JSON manifest.\n\n${input}`;
    const result = await querySeat(modelId, msg, {
      ...dispatchOpts,
      seat: seatId,
      roleHint: seatDef?.roleHint,
      agentId: agent?.agentId || null,
      agentSlug: agent?.agentSlug || null,
      skillGrants: seatGrantFor(dispatchOpts, seatId, agent),
      workPermit: workPermitFor(dispatchOpts, agent),
      workPermitRequired: dispatchOpts.workPermitRequired === true,
    });

    const phaseResult = {
      responses: [{ ...result, seat: seatId, agentId: agent?.agentId || null, agentSlug: agent?.agentSlug || null }],
      participants: [{ model: modelId, seat: seatId, agentId: agent?.agentId || null, agentSlug: agent?.agentSlug || null }],
    };
    const artifact = await executeWriteMode(phase, phaseResult, {
      topologyId: topology.id,
      workPermits: dispatchOpts.workPermits,
      workPermitRequired: dispatchOpts.workPermitRequired === true,
    });
    return { phaseResult, artifact };
  }

  // Codex delegate execution
  try {
    const result = await queryWithWrite(input, {
      workingDirectory: process.cwd(),
      reasoning: "high",
    });

    const phaseResult = {
      responses: [{
        model: "codex-local",
        seat: seatId,
        agentId: agent?.agentId || null,
        agentSlug: agent?.agentSlug || null,
        response: result.response,
        usage: result.usage,
        latency: result.latency,
      }],
      participants: [{
        model: "codex-local",
        seat: seatId,
        agentId: agent?.agentId || null,
        agentSlug: agent?.agentSlug || null,
      }],
    };

    const artifact = {
      type: "delegate",
      content: result.response,
      fileChanges: result.fileChanges || [],
    };

    return { phaseResult, artifact };
  } catch (err) {
    const uncertain = err?.code === "ILLUCI_CODEX_WRITE_OUTCOME_UNCONFIRMED";
    const evidence = uncertain ? {
      code: err.code, outcome: err.outcome, retrySafe: err.retrySafe,
      providerCompletionObserved: err.providerCompletionObserved,
      ...(err.threadRef ? { threadRef: err.threadRef } : {}),
    } : {};
    return {
      phaseResult: {
        responses: [{ model: "codex-local", seat: seatId, agentId: agent?.agentId || null, agentSlug: agent?.agentSlug || null, error: err.message, response: null, ...evidence }],
        participants: [{ model: "codex-local", seat: seatId, agentId: agent?.agentId || null, agentSlug: agent?.agentSlug || null }],
      },
      artifact: { type: "delegate", content: "", fileChanges: uncertain && Array.isArray(err.fileChanges) ? err.fileChanges.map(change => ({ ...change })) : [], ...evidence },
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// UTILITY
// ═══════════════════════════════════════════════════════════════════════════

/** Simple string hash for content integrity tracking */
function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + ch;
    hash |= 0;
  }
  return hash.toString(16);
}

export default { runTopology, runMixed };
