/**
 * illuci - Unified Dispatch
 *
 * Routes queries to models via bridges. Every query passes through:
 *   1. Governance injection (preamble prepended unless raw)
 *   2. Throttle (rate limiting per provider)
 *   3. Bridge (model-specific I/O)
 *
 * Supports:
 *   - Single model query
 *   - Concurrent multi-model query (fires all, returns all)
 *   - Role-based resolution via capability matrix
 *
 * Dual-mode: internal (no metering) vs SaaS (metered per token).
 */

import { getBridge, MODEL_DEFAULTS, resolveModelId } from "../bridges/index.js";
import { createHash, randomUUID } from 'node:crypto';
import { loadBridgeModule } from "../bridges/bridge-loaders.js";
import { acquireSlot, releaseSlot, resolveThrottleKey } from "../throttle/throttle.js";
import { withRetry } from "./retry.js";
import { createTraceExposure, bindTraceSources } from '../bridges/trace-exposure.js';
import { injectGovernance } from "../governance/injector.js";
import { enforceDispatch, enforceDispatchBill, carryMandate, verifyDispatchSoft, softVerifyEnabled, makeJudge } from "../governance/enforcement/enforce.js";
import { checkRepoAuthority } from "../governance/gitops/repo-authority-gate.js";
import { getConcurrentModels } from "../matrix/capability-matrix.js";
import { describeBridgeFailure, describeRoutePreflightFailure, describeUnavailableModel } from "../fleet/model-doctor.js";
import { applyEstimatedUsage } from "../context/tokens.js";
import { isModelPaused, drainInjections } from "../events/sse-server.js";
import { buildAdaptiveExecutionPlan, resolveAdaptiveControls, resolveRaceTimeout, resolveReasoningTimeout, resolveSeatTimeoutHeadroom } from "./adaptive-fallback.js";
import { raceQuery } from "./race.js";
import { REASONING_STARVED_ERROR } from "../bridges/reasoning-split.js";
// DRL (Dynamic-Resilience Layer). All four imports are leaf-safe: resilience
// depends only on bridges/model-registry.js + dispatch/retry.js (both already in
// this graph), so no cycle. Every use is guarded by isDrlEnabled() (read at call
// time) so with ILLUCI_DRL_ENABLED off the dispatch path is byte-identical to
// before: no fast-fail, no p95 extension, no breaker recording.
import { isDrlEnabled } from "../resilience/config.js";
import { toCanonicalKey } from "../resilience/canonical.js";
import { assertBreakerAllowsDispatch } from "../resilience/breaker.js";
import { getP95, makeStallWatcher } from "../resilience/latency-store.js";
import { recordDispatchOutcome } from "../resilience/outcome.js";
import { recordReliability } from "../fleet/reliability.js";
// [A39]/CAP-3 vision seam — leaf-safe: model-registry is already in this graph;
// grants/{affordances,resolve} import only skills/grants + data/paths (no cycle).
import { getEntry } from "../bridges/model-registry.js";
import { assessVisionNeed } from "../governance/grants/affordances.js";
import { resolveCapabilityGrants, evaluateCapabilityGrant } from "../governance/grants/resolve.js";
import { gatherCreationFacts } from "../governance/compiler/runtime/dispatch-bridge.js";

// The Codex SDK bridge can run native tools. Once entered, an absent result or
// cancellation is not proof that the provider or its effects did not execute.
function agenticCodexRoute(modelId, channel) {
  return (channel?.bridge || getEntry(modelId)?.bridge) === 'codex.js';
}
function agenticGrokRoute(modelId, channel) {
  return (channel?.bridge || getEntry(modelId)?.bridge) === 'grok-cli.js';
}
function unconfirmedAgenticOutcome(cause, route = 'Codex') {
  const error = new Error(`${route} outcome unconfirmed; reconcile the original attempt`, { cause });
  error.code = 'ILLUCI_AGENTIC_OUTCOME_UNCONFIRMED'; error.retrySafe = false; error.outcome = 'unknown';
  return error;
}

/**
 * [A17.3] Empty-success honesty. A bridge result with NO content AND zero COMPLETION tokens is a
 * route/auth/preflight failure (unauthorized key, dead route, zero-output), NOT a model answer —
 * return it reclassified as `failed` so topology gates, doctors, and the operator see a loud, honest
 * failure instead of a silent empty success. Uses COMPLETION tokens, not total: applyEstimatedUsage
 * back-fills PROMPT tokens for a zero-usage result, so `total_tokens` goes nonzero even on a failure;
 * a genuine answer always has completion tokens. Already-failed / skipped / blocked results are
 * returned untouched — they legitimately carry `response:null`. Pure: unit-tested, side-effect free.
 * (Mirrors the runner's classifyGateResult honest-classification pattern.)
 */
export function reclassifyEmptySuccess(result) {
  if (!result || result.failed || result.skipped || result.blocked) return result;
  const completion = result.usage?.completion_tokens ?? result.usage?.output_tokens ?? 0;
  if (result.response || completion > 0) return result;
  return {
    ...result,
    failed: true,
    error: result.error || "bridge returned empty content with zero completion tokens (route/auth/preflight failure)",
  };
}

export function isReasoningStarvedResult(result) {
  if (!result || !result.failed) return false;
  const error = typeof result.error === "string" ? result.error : "";
  return error === REASONING_STARVED_ERROR || error.startsWith("reasoning-starved:");
}

export function shouldRetryReasoningStarved(result, options = {}) {
  if (!isReasoningStarvedResult(result)) return false;
  if (options._reasoningStarvedRetry === true) return false;
  if (options.thinking === false) return false;
  if (options.params?.think === false) return false;
  return true;
}

export function buildReasoningStarvedRetryOptions(options = {}) {
  return {
    ...options,
    _reasoningStarvedRetry: true,
    thinking: false,
    params: {
      ...(options.params || {}),
      think: false,
    },
  };
}

function composeAbortSignals(...signals) {
  const live = signals.filter(Boolean);
  if (live.length === 0) return null;
  if (live.length === 1) return live[0];

  const controller = new AbortController();
  const abortFrom = (signal) => {
    if (!controller.signal.aborted) {
      controller.abort(signal?.reason || new Error("ABORTED"));
    }
  };
  for (const signal of live) {
    if (signal.aborted) {
      abortFrom(signal);
      break;
    }
    signal.addEventListener("abort", () => abortFrom(signal), { once: true });
  }
  return controller.signal;
}

const MODE = process.env.ILLUCI_MODE || "internal"; // "internal" | "saas"

// --- Repo-authority per-checkout probe memo (A28.5/A28.6) ----------------------
// gatherRepoContextFacts spawns ~8 sync git child processes; probing on EVERY
// dispatch would be a git storm. The DIVERGENCE verdict (root/branch/worktree/
// shadow) is STABLE within a single checkout, so we memoize the whole gate result
// keyed on the RESOLVED cwd + the RESOLVED dispatched lineage. This is a
// per-checkout memo, NOT a session cache: a long-lived MCP process that switches
// branches MID-SESSION would keep seeing the pre-switch DIVERGENCE verdict for a
// given cwd+lineage key (stale). That is an accepted limitation — divergence is
// stable within a checkout, and clearRepoAuthorityCache() is exported for a host
// that wants to invalidate the memo explicitly (nothing calls it automatically).
const REPO_AUTHORITY_CACHE = new Map();

function repoAuthorityCacheKey(cwd, lineage) {
  return `${cwd}::${JSON.stringify(lineage ?? null)}`;
}

/**
 * Clear the per-checkout repo-authority memo. Exported for a host that changes
 * checkout state mid-process (e.g. a long-lived MCP that switches branches) and
 * wants the next dispatch to re-probe. Nothing in dispatch calls this
 * automatically; the memo is intentionally stable within a checkout.
 */
export function clearRepoAuthorityCache() {
  REPO_AUTHORITY_CACHE.clear();
}

// Resolve the dispatched lineage from the carried mandate (object form only;
// a string mandate from spawn.js has no .repo and falls through) or an explicit
// options.repoLineage. Null when neither is present. This is the SINGLE source of
// dispatched lineage for BOTH the pre-dispatch gate and the Bill context, so the
// gate and the compiled Bill can never diverge on which lineage they verify.
function resolveDispatchLineage(options = {}) {
  return options.mandate?.repo?.lineage ?? options.repoLineage ?? null;
}

// Run (and cache) the repo-authority gate for this dispatch. Pure pass-through to
// checkRepoAuthority; the cache is the only added behavior. Throws propagate to
// the caller, which owns the fail-open-on-throw contract.
function checkRepoAuthorityCached({ cwd, dispatchedLineage, trigger, stamp }) {
  const key = repoAuthorityCacheKey(cwd, dispatchedLineage);
  if (REPO_AUTHORITY_CACHE.has(key)) return REPO_AUTHORITY_CACHE.get(key);
  const authority = checkRepoAuthority({ cwd, dispatchedLineage, trigger, stamp });
  REPO_AUTHORITY_CACHE.set(key, authority);
  return authority;
}

// Build the compiled-Bill dispatch context. Always carries scope_record. The
// repo-authority predicate fragment (which un-starves the compiled std-12
// single-canonical-root gate atom — inert until canonical_roots is in ctx) is
// merged ONLY from a precomputed predicateCtx handed in by an ALREADY-RUN gate
// check. buildDispatchBillContext itself NEVER probes git:
//   - Non-raw dispatches already ran the cached pre-dispatch gate and pass its
//     predicateCtx in, so the fragment rides for free (no second probe).
//   - Raw dispatches (soft-verify judge, sibling/raw governance calls) SKIP the
//     gate by contract, so predicateCtx is null and this returns the scope-only
//     ctx. The selected creation decision supplies fit facts on both paths without a git probe.
//     This is the fix for the ~8-git-process storm that used to fire on
//     EVERY raw dispatch when the fallback re-probed here.
export function buildDispatchBillContext(options = {}, predicateCtx = null) {
  const scopeRecord = options.mandate ?? options.scopeRecord ?? options.scope_record ?? options.scope ?? null;
  const ctx = {};
  if (!(scopeRecord === null || scopeRecord === undefined || scopeRecord === "")) {
    ctx.scope_record = scopeRecord;
  }
  if (predicateCtx && typeof predicateCtx === "object") {
    Object.assign(ctx, predicateCtx);
  }
  Object.assign(ctx, gatherCreationFacts(options, scopeRecord));
  return ctx;
}

// [A39]/CAP-3 vision-seam plumbing: a warn fires once per seat+model pair per
// process (no log storms on retry loops); resolution arrives via
// options.capabilityResolution (runner-threaded) or resolves seat-side from
// the record store; the check never throws into the dispatch path.
const visionWarned = new Set();
// Returns null (proceed) or {reason, code} — an ENFORCE-mode denial refuses
// the dispatch (the [A40] flipped floor); warn mode logs once and proceeds.
function checkVisionCapability(modelId, message, options) {
  let entry = null;
  try {
    entry = getEntry(modelId);
  } catch {
    entry = null;
  }
  const need = assessVisionNeed(entry, message, options);
  if (!need.needed) return;
  const key = `${options.seat || "?"}:${modelId}`;
  if (visionWarned.has(key)) return;
  let resolution = options.capabilityResolution ?? null;
  if (resolution === null && options.seat) {
    try {
      resolution = resolveCapabilityGrants({ seatId: options.seat });
    } catch {
      resolution = null;
    }
  }
  const verdict = evaluateCapabilityGrant("vision", resolution);
  if (!verdict.allow) {
    return { reason: `vision capability required (${need.trigger}) and not granted for seat=${options.seat || "unknown"} — ${verdict.reason}`, code: verdict.code };
  }
  if (verdict.warned) {
    visionWarned.add(key);
    console.warn(
      `[capability] vision needed (${need.trigger}) by seat=${options.seat || "unknown"} model=${modelId} — ${verdict.reason}`,
    );
  }
  return null;
}

/**
 * Query a single model by ID.
 * Governance preamble injected. Throttle enforced.
 *
 * @param {string} modelId
 * @param {string} message
 * @param {object} options
 * @param {boolean} options.raw - skip governance injection
 * @param {string} options.seat - seat label for governance context
 * @param {string} options.topology - topology name for governance context
 */
// Refusal identities are private to this pre-provider boundary.
const responseOnlyRefusals = new WeakSet();
// Per-call technical constraint. This neither grants permission nor changes config.
async function resolveResponseOnlyBridge(modelId, options) {
  const refuse = message => { const error = new Error(message);
    error.code = 'ILLUCI_RESPONSE_ONLY_UNSUPPORTED'; error.blocked = true; error.retrySafe = false;
    responseOnlyRefusals.add(error); throw error; };
  if (options.requireProviderAdmission !== undefined && options.requireProviderAdmission !== false &&
      (options.requireProviderAdmission !== true || options.responseOnly !== true || typeof options.beforeProviderRequest !== 'function')) refuse('Final provider admission requires a response-only callback');
  if (options.responseOnly === undefined || options.responseOnly === false) return null;
  if (options.responseOnly !== true) refuse('Invalid response-only constraint');
  if (softVerifyEnabled()) refuse('Response-only execution held: configured secondary soft judge is unqualified');
  let bridge;
  try { bridge = options.channel?.bridge ? await loadBridgeModule(options.channel.bridge) : await getBridge(modelId); }
  catch { refuse('Response-only selected adapter could not be loaded before provider execution'); }
  const assertion = bridge?.assertResponseOnly || bridge?.default?.assertResponseOnly;
  if (typeof assertion !== 'function') refuse('Response-only execution unsupported by selected bridge');
  let supported;
  try { supported = assertion.call(bridge.default || bridge); }
  catch (error) { refuse(error?.code === 'ILLUCI_RESPONSE_ONLY_UNSUPPORTED' ? error.message : 'Selected bridge could not establish response-only support'); }
  if (supported !== true) {
    // Observe an unsupported promise rejection without treating it as support.
    if (supported instanceof Promise) supported.catch(() => {});
    refuse('Response-only adapter must synchronously attest literal true');
  }
  if (options.requireProviderAdmission === true) {
    const declaration = bridge?.assertProviderAdmission || bridge?.default?.assertProviderAdmission;
    let supportedAdmission;
    try { supportedAdmission = typeof declaration === 'function' && declaration.call(bridge.default || bridge); }
    catch { refuse('Selected bridge could not establish final provider admission support'); }
    if (supportedAdmission !== true) {
      if (supportedAdmission instanceof Promise) supportedAdmission.catch(() => {});
      refuse('Selected bridge must synchronously attest final provider admission support');
    }
  }
  return bridge;
}

export async function queryModel(modelId, message, options = {}) {
  const dispatchStart = Date.now();
  // [A39]/CAP-3: the vision seam at the ONE dispatch choke point — a
  // vision-lane model (modality vlm) or image-bearing input requires the
  // `vision` capability. Warn-first (the ratified transition): an unlicensed
  // need proceeds with a coded warning, deduped per seat+model. Never throws
  // into the dispatch path.
  let visionRefusal = null;
  try {
    visionRefusal = checkVisionCapability(modelId, message, options);
  } catch {}
  if (visionRefusal) {
    return {
      model: modelId,
      response: null,
      error: visionRefusal.reason,
      failed: true,
      blocked: true,
      code: visionRefusal.code,
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      latency: Date.now() - dispatchStart,
      seat: options.seat || null,
    };
  }
  try {
    const responseOnlyBridge = await resolveResponseOnlyBridge(modelId, options);
    const result = await _queryModelInner(modelId, message, options, responseOnlyBridge);
    // DRL: EXACTLY ONE terminal outcome record per dispatch, on the success path.
    // recordDispatchOutcome classifies the shape (success / terminal_failure /
    // ignored) and feeds the breaker + latency store. Inert when the flag is off.
    if (isDrlEnabled()) {
      try {
        const rec = recordDispatchOutcome(modelId, result, Date.now() - dispatchStart);
        // [A48]/DR-128: learned reliability rides the SAME taxonomy the breaker
        // uses — success/terminal_failure accrue; ignored (transient/paused/
        // aborted/blocked) never touches standing, exactly as it never trips the
        // breaker.
        if (rec.outcome !== "ignored") recordReliability(modelId, rec.outcome === "success");
      } catch {}
    }
    return result;
  } catch (err) {
    console.warn(`[dispatch] ${modelId} failed: ${err.message}`);
    const failure = {
      model: modelId,
      response: null,
      error: err.message,
      failed: true,
      ...(err?.retrySafe === false || err?.outcome === 'unknown' ? { ...(err.code ? {code:err.code} : {}), retrySafe:false, ...(err.outcome === 'unknown' ? {outcome:'unknown'} : {}) } : {}),
      ...(responseOnlyRefusals.has(err) ? { blocked: true, code: err.code, providerInvoked: false } : {}),
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      latency: Date.now() - dispatchStart,
      seat: options.seat || null,
      ...(options.modelRuntime ? { modelRuntime: options.modelRuntime } : {}),
      bridgeFailure: describeBridgeFailure(modelId, err, options),
    };
    // DRL: the matching ONE terminal record for the catch path. The error string
    // is classified via retry.js (transient/aborted -> ignored; permanent/unknown
    // -> terminal_failure), so a network blip never trips the breaker.
    if (isDrlEnabled()) {
      try {
        const rec = recordDispatchOutcome(modelId, failure, failure.latency);
        if (rec.outcome !== "ignored") recordReliability(modelId, rec.outcome === "success");
      } catch {}
    }
    return failure;
  }
}

async function _queryModelInner(modelId, message, options = {}, responseOnlyBridge = null) {
  const dispatchStart = Date.now();
  if (isModelPaused(modelId)) {
    return { model: modelId, response: null, skipped: true, reason: "paused", usage: {}, latency: 0 };
  }

  const unavailable = describeUnavailableModel(modelId);
  if (unavailable) {
    return {
      model: modelId,
      response: null,
      error: unavailable.message,
      failed: true,
      unavailable: true,
      bridgeFailure: unavailable,
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      latency: Date.now() - dispatchStart,
      seat: options.seat || null,
      ...(options.modelRuntime ? { modelRuntime: options.modelRuntime } : {}),
    };
  }
  const routePreflightFailure = await describeRoutePreflightFailure(modelId, options);
  if (routePreflightFailure) {
    return {
      model: modelId,
      response: null,
      error: routePreflightFailure.message,
      failed: true,
      unavailable: true,
      bridgeFailure: routePreflightFailure,
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      latency: Date.now() - dispatchStart,
      seat: options.seat || null,
      ...(options.modelRuntime ? { modelRuntime: options.modelRuntime } : {}),
    };
  }

  // DRL bridge-entry fast-fail: an OPEN breaker (or a half-open with its single
  // probe already in flight) short-circuits BEFORE the bridge is touched, so a
  // dead backend stops burning its full timeout window. Returns the same failure
  // shape a thrown bridge returns (failed:true) plus a `breaker` tag, so callers
  // need no new branch and the outcome recorder treats it as 'ignored' (the
  // breaker already decided - no double-count). assertBreakerAllowsDispatch
  // reserves the one half-open probe slot when it allows a half-open dispatch.
  if (isDrlEnabled()) {
    const verdict = assertBreakerAllowsDispatch(toCanonicalKey(modelId));
    if (!verdict.allowed) {
      return {
        model: modelId,
        response: null,
        error: `circuit breaker ${verdict.reason}`,
        failed: true,
        breaker: verdict.reason,
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        latency: Date.now() - dispatchStart,
        seat: options.seat || null,
        ...(options.modelRuntime ? { modelRuntime: options.modelRuntime } : {}),
      };
    }
  }

  const selectedChannel = options.channel || null;
  const bridge = responseOnlyBridge || (selectedChannel?.bridge ? await loadBridgeModule(selectedChannel.bridge) : await getBridge(modelId));
  // Aliases canonicalize before the defaults lookup (MODEL_DEFAULTS is keyed
  // by canonical id only - the registry owns every other spelling).
  const defaults = MODEL_DEFAULTS[resolveModelId(modelId) ?? modelId] || {};
  const merged = bindTraceSources({ ...defaults, ...options },bridge);
  const responseOnly = responseOnlyBridge !== null;
  const agenticCodex = agenticCodexRoute(modelId, selectedChannel);
  const agenticGrok = agenticGrokRoute(modelId, selectedChannel);
  const oneShotAgentic = agenticCodex || agenticGrok;

  // Selected-channel dispatch is explicit runtime configuration. The channel owns
  // both the bridge module and provider model string, so alternate channels cannot
  // be reduced to cosmetic labels while the primary bridge fires.
  if (selectedChannel?.model) {
    merged.model = selectedChannel.model;
    if (selectedChannel.transport === "antigravity") merged.agyModel = selectedChannel.model;
  }
  if (typeof merged.thinking === "boolean") {
    merged.params = { ...(merged.params || {}) };
    if (merged.params.think === undefined) merged.params.think = merged.thinking;
  }
  // HARD tier: fail-closed POLICY check on the dispatch path (NOT a per-query
  //    operator prompt). Inert unless a dispatch policy is armed; on a policy deny
  //    (and no GateConfig override) we return the same failure shape a thrown bridge
  //    error returns, so every caller handles it with zero new branches. A throw in
  //    the policy layer (e.g. a malformed gate-config) ALSO fails closed: the catch
  //    turns it into a DENY, never a leaked exception that reaches the bridge. --
  let verdict;
  try {
    verdict = enforceDispatch({ modelId, options });
  } catch (err) {
    console.warn(`[dispatch] enforcement threw, failing closed: ${err.message}`);
    verdict = { allowed: false, reason: `enforcement error: ${err.message}` };
  }
  if (!verdict.allowed) {
    return {
      model: modelId,
      response: null,
      error: verdict.reason,
      failed: true,
      blocked: true,
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      latency: Date.now() - dispatchStart,
      seat: options.seat || null,
      ...(options.modelRuntime ? { modelRuntime: options.modelRuntime } : {}),
    };
  }

  // ARMED repo-authority PRE-DISPATCH (A28.6, divergence-only contract 2026-06-30):
  // fail-closed ONLY on a genuine SPLIT-BRAIN — a DIVERGENCE verdict (repo-root /
  // branch / worktree mismatch, or a shadow/nested repo) where the actual context
  // contradicts a PRESENT dispatched lineage. EVERYTHING else is advisory and passes:
  // no-dispatched-lineage, non-git cwd, dirty/detached/behind, stash, remote-mismatch
  // — you cannot split-brain against a lineage that is absent or a repo that is not
  // there. (Grounded in the classifier: only the four divergence codes carry
  // S.BLOCK; advisories are S.WATCH/S.CAUTION/S.INFO, so makeGovernedVerdict never
  // hard-stops them.) raw/judge dispatches are EXEMPT (options.raw) so the
  // soft-verify judge and raw governance calls traverse ungated. FAIL-OPEN ONLY ON A
  // THROW: a probe fault becomes { allowed: true }; a RETURNED !allowed (a real
  // divergence) is the whole point and fails closed. Lineage is sourced via the SAME
  // resolveDispatchLineage the Bill context uses, so the gate and the compiled Bill
  // verify one lineage. The verdict's predicateCtx feeds the Bill below (no re-probe).
  let repoAuthority = null;
  if (!options.raw) {
    try {
      repoAuthority = checkRepoAuthorityCached({
        cwd: options.cwd || process.cwd(),
        dispatchedLineage: resolveDispatchLineage(options),
        trigger: "pre-dispatch",
        stamp: options.stamp || null,
      });
    } catch (err) {
      console.warn(`[dispatch] repo-authority probe threw, failing open: ${err.message}`);
      repoAuthority = { allowed: true };
    }
    if (!repoAuthority.allowed) {
      return {
        model: modelId, response: null, error: repoAuthority.reason,
        failed: true, blocked: true,
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        latency: Date.now() - dispatchStart, seat: options.seat || null,
        ...(options.modelRuntime ? { modelRuntime: options.modelRuntime } : {}),
      };
    }
  }

  // Dispatch-side gate tier of the compiled Bill: run the obligations whose facts a dispatch can
  // supply (scope-delegation + the un-starved single-canonical-root). Other gate obligations stay
  // inert until their facts are plumbed. The repo-authority fragment rides ONLY via
  // repoAuthority.predicateCtx (present on the non-raw path from the gate above; null on the raw
  // path, which keeps the Bill ctx scope-only and probes no git). Fail-open on a broken/absent Bill
  // (enforceDispatchBill swallows load faults).
  {
    const bill = await enforceDispatchBill(buildDispatchBillContext(options, repoAuthority?.predicateCtx || null));
    if (!bill.ok) {
      return {
        model: modelId, response: null, error: bill.blocking.map((b) => b.reason).join("; "),
        failed: true, blocked: true,
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        latency: Date.now() - dispatchStart, seat: options.seat || null,
        ...(options.modelRuntime ? { modelRuntime: options.modelRuntime } : {}),
      };
    }
  }

  let composedPrefix = "";
  if (options.seat && !options.raw) {
    try {
      const { compose } = await import("../composition/composer.js");
      const composition = await compose(modelId, {
        roleId: options.roleHint || null,
        skills: options.skills || [],
      }, {
        message,
        projectId: options.projectId,
        peerIds: options.peerIds,
        taskTokens: options.taskTokens,
        skipContext: options.skipContext === true,
      });
      if (composition.systemPrompt) {
        composedPrefix = composition.systemPrompt + "\n\n";
      }
    } catch {
      // Composition is non-fatal - degrade to governance-only
    }
  }

  const injections = drainInjections(modelId);
  const injectionText = injections.length > 0
    ? "\n\n[Operator injection]: " + injections.map((i) => i.content).join("\n") + "\n\n"
    : "";

  // CARRIED tier: the operator mandate rides EVERY dispatch - UNCONDITIONAL (no seat
  // guard). carryMandate prepends the [Mandate] anchor (idempotent; frame.js already
  // places it first on seated councils). Raw keeps its preamble-skip by separation of
  // concerns: the lean anchor rides here; the verbose preamble stays injectGovernance's
  // job, still raw-gated. No dispatch (seated, unseated, sibling, raw) escapes the law.
  const anchored = carryMandate(injectionText + message, options);

  const governedMessage = injectGovernance(composedPrefix + anchored, {
    raw: options.raw,
    skipIdentitySummary: options.skipIdentitySummary === true,
    seat: options.seat,
    topology: options.topology,
    modelId,
    peerIds: options.peerIds,
    projectId: options.projectId,
  });

  // Throttle at the provider level (from MODEL_DEFAULTS), not the raw alias -
  // alias-level overrides in the throttle config still win when present.
  const throttleProvider = selectedChannel?.provider || defaults.provider || null;
  const throttleKey = resolveThrottleKey(modelId, throttleProvider);
  const trace = createTraceExposure(options,'illuci.dispatch','governed-dispatch');
  await trace.source(bridge);
  await trace.record({modelId,message:governedMessage,history:options.sessionState||[],
    channel:selectedChannel?.transport||null,bridge:selectedChannel?.bridge||null,providerModel:selectedChannel?.model||null},
    'normalized-runtime-event','governed-query-input',['composition','governance-injection']);
  await acquireSlot(throttleKey);
  let result;
  let agenticEntered = false;
  let directLease = null, directDescriptor = null, directThreadRef = null;
  try {
    if (options.directAttemptJournalRoot) {
      throw Object.assign(new Error('This build does not provide the requested external attempt-journal adapter'), {
        code: 'ILLUCI_UNSUPPORTED_ADAPTER', retrySafe: false,
      });
    }
    // withRetry wraps the whole adaptive sequence: connection/5xx/429 faults
    // retry with backoff (the run no longer dies on one transient blip), while
    // timeouts stay the job of the reasoning-tier fallback INSIDE this block.
    result = await withRetry(async () => {
      const adaptiveControls = resolveAdaptiveControls(merged);
      const plan = buildAdaptiveExecutionPlan(modelId, merged, defaults, adaptiveControls);
      const attempts = responseOnly || oneShotAgentic ? plan.slice(0, 1) : plan;
      const seated = Boolean(options.seat);
      const seatHeadroom = resolveSeatTimeoutHeadroom();
      let attemptResult;

      for (let index = 0; index < attempts.length; index++) {
        const attempt = attempts[index];
        try {
          // Caller timeout (options.timeoutMs, e.g. `illuci run --timeout`) wins as-is;
          // otherwise the reasoning-tier default applies, with a headroom multiplier
          // for SEATED runs so a council/composition member - which carries
          // composition-prefix + agentic-loop overhead - is not guillotined at the
          // bare-query ceiling (AMD-7: the unmodified 300s xhigh killed a build seat
          // twice). raceQuery also honors options.signal: a top-level abort/budget
          // interrupts the in-flight attempt and fails fast, so headroom never masks
          // a genuinely stuck seat (the buffered path previously ignored the signal
          // mid-attempt; the streaming path's raceAbort already did this).
          // DRL observed-latency extension: when armed, pass the model's observed
          // p95 so resolveRaceTimeout adds it to the tier ceiling before the seat
          // headroom multiply. Flag-off passes p95Ms=0 (the default), so the
          // timeout is byte-identical to before; getP95 also returns 0 under 2
          // samples, so even armed it is inert until enough signal exists.
          const observedP95 = isDrlEnabled() ? getP95(toCanonicalKey(modelId)) : 0;
          const raceTimeoutMs = resolveRaceTimeout({
            callerTimeoutMs: merged.timeoutMs,
            tierTimeoutMs: attempt.timeoutMs,
            seated,
            headroom: seatHeadroom,
            p95Ms: observedP95,
          });
          const attemptAbort = new AbortController();
          const attemptSignal = composeAbortSignals(merged.signal || null, attemptAbort.signal);
          const attemptOptions = { ...attempt.options, ...(attemptSignal ? {signal:attemptSignal} : {}),
            ...(directLease ? {onCodexThreadStarted:threadRef=>{directLease.correlate(threadRef);directThreadRef=threadRef;}} : {}) };
          if (directLease) directLease.enter();
          if (oneShotAgentic) agenticEntered = true;
          attemptResult = await raceQuery(bridge.query(governedMessage, attemptOptions), {
            timeoutMs: raceTimeoutMs,
            signal: merged.signal || null,
            onTimeout: () => attemptAbort.abort(new Error("TIMEOUT")),
          });

          if (attempt.fallback) {
            attemptResult._reasoningFallback = true;
            attemptResult._adaptiveFallback = {
              dimension: "reasoning",
              initial: attempts[0]?.reasoningTier || null,
              settled: attempt.reasoningTier || null,
              floor: adaptiveControls.reasoningFloor,
              attempted: attempts.map((candidate) => candidate.reasoningTier).filter(Boolean),
            };
          }
          break;
        } catch (err) {
          const timedOut = err.message === "TIMEOUT";
          const hasNextAttempt = index < attempts.length - 1;

          if (timedOut && hasNextAttempt) {
            const nextAttempt = attempts[index + 1];
            console.warn(`[dispatch] ${modelId} timed out at ${attempt.label}, retrying at ${nextAttempt.label}`);
            continue;
          }

          if (timedOut && attempts.length > 1) {
            throw new Error("TIMEOUT_FALLBACK");
          }

          throw err;
        }
      }

      return attemptResult;
    }, {
      signal: merged.signal || null,
      maxAttempts: responseOnly || oneShotAgentic ? 1 : 3,
      onRetry: (i) => console.warn(`[dispatch] ${modelId} transient ${i.class} (${i.error}); retry ${i.nextAttempt} in ${i.delayMs}ms`),
    });

    if (!responseOnly && !oneShotAgentic && shouldRetryReasoningStarved(result, merged)) {
      const initialError = result.error || null;
      const retryOptions = buildReasoningStarvedRetryOptions(merged);
      const observedP95 = isDrlEnabled() ? getP95(toCanonicalKey(modelId)) : 0;
      const retryTimeoutMs = resolveRaceTimeout({
        callerTimeoutMs: retryOptions.timeoutMs,
        tierTimeoutMs: resolveReasoningTimeout(retryOptions.reasoning, defaults.adaptive?.reasoning),
        seated: Boolean(options.seat),
        headroom: resolveSeatTimeoutHeadroom(),
        p95Ms: observedP95,
      });
      console.warn(`[dispatch] ${modelId} reasoning-starved; retrying once with thinking disabled`);
      const retryResult = await withRetry(() => {
        const retryAbort = new AbortController();
        const retrySignal = composeAbortSignals(retryOptions.signal || null, retryAbort.signal);
        const bridgedRetryOptions = retrySignal ? { ...retryOptions, signal: retrySignal } : retryOptions;
        return raceQuery(bridge.query(governedMessage, bridgedRetryOptions), {
          timeoutMs: retryTimeoutMs,
          signal: retryOptions.signal || null,
          onTimeout: () => retryAbort.abort(new Error("TIMEOUT")),
        });
      }, {
        signal: retryOptions.signal || null,
        onRetry: (i) => console.warn(`[dispatch] ${modelId} no-think retry transient ${i.class} (${i.error}); retry ${i.nextAttempt} in ${i.delayMs}ms`),
      });
      result = {
        ...retryResult,
        _reasoningStarvedRetry: {
          attempted: true,
          initialError,
          thinking: false,
        },
      };
    }

    if(directLease)directLease.finish('completed',{kind:'sdk-completed-return',threadRef:directThreadRef});
    result = applyEstimatedUsage(result, governedMessage, modelId);
    await trace.record(result,'normalized-runtime-event','bridge-result',['bridge-normalization']);
    await trace.finish();
  } catch (error) {
    if(directLease){try{directLease.finish(agenticEntered?'unknown':'not-started',{reason:agenticEntered?'sdk-outcome-unconfirmed':'before-bridge-entry',...(directThreadRef?{threadRef:directThreadRef}:{})});}catch{}}
    if (oneShotAgentic && agenticEntered) throw unconfirmedAgenticOutcome(error, agenticGrok ? 'Grok Build' : 'Codex');
    throw error;
  } finally {
    const tokenCount = result?.usage?.total_tokens || 0;
    releaseSlot(throttleKey, tokenCount);
  }

  if (MODE === "saas") {
    // TODO: meter tokens, log to billing, enforce customer budget
  }

  // [A17.3] Defense-in-depth over EVERY bridge: never let an empty+zero-completion result through
  // as a success. This funnel is reached only by the real-bridge-call path (skipped/paused/blocked
  // results return earlier), so it is the single point that makes an unauthorized/dead route a
  // loud failure instead of a silent empty answer.
  result = reclassifyEmptySuccess(result);

  const dispatchResult = {
    model: result?.model || modelId,
    response: result?.response ?? null,
    usage: {
      prompt_tokens: result?.usage?.prompt_tokens || result?.usage?.input_tokens || 0,
      completion_tokens: result?.usage?.completion_tokens || result?.usage?.output_tokens || 0,
      total_tokens: result?.usage?.total_tokens || 0,
    },
    latency: result?.latency || 0,
    seat: options.seat || null,
    ...(options.modelRuntime ? { modelRuntime: options.modelRuntime } : {}),
    ...result,
    model: result?.model || modelId,
    response: result?.response ?? null,
  };

  // -- P4 multi-channel C2 (DR-134): selected-channel path ONLY. Stamp the served
  //    result with the resolved IDENTITY (modelId) and the channel transport, so
  //    provenance records "claude-opus" on the "antigravity" channel rather than the
  //    bridge's literal model (agy returns model:"agy"). This ALIGNS with the
  //    serving-module.js C2 stamp (model:id + channel:transport); when the
  //    ServingModule facade already stamped this result's channel, we do NOT
  //    double-stamp. No-op when no channel is selected -> byte-identical. --
  if (selectedChannel && dispatchResult.channel !== selectedChannel.transport) {
    dispatchResult.model = modelId;
    dispatchResult.channel = selectedChannel.transport;
  }

  if (dispatchResult.modelRuntime) {
    dispatchResult.modelRuntime = {
      ...dispatchResult.modelRuntime,
      actual: {
        model: dispatchResult.model,
        channel: dispatchResult.channel || selectedChannel?.transport || null,
        bridge: selectedChannel?.bridge || null,
        providerModel: selectedChannel?.model || null,
      },
    };
  }

  // SOFT tier: off-critical-path, non-blocking. Fire-and-forget AFTER the result is
  // assembled and BEFORE the return - the response returns immediately; the verify
  // pass races in the background and can never delay or fail the dispatch. Gated off
  // by default (ILLUCI_VERIFY_SOFT); raw:true judge so it does not recurse into governance.
  const closeSoftVerification = softVerifyEnabled();
  if (responseOnly && closeSoftVerification) {
    // Configuration changed after admission. Retain the actual primary output,
    // hold its qualification, and never start an unconstrained secondary judge.
    Object.assign(dispatchResult, { failed: true, blocked: true,
      error: 'Response-only result held: secondary soft judge became enabled after admission',
      secondaryVerification: { status: 'held', providerInvoked: false } });
  } else if (closeSoftVerification && !options.raw) {
    verifyDispatchSoft({ output: dispatchResult.response, modelId, seat: options.seat, judge: makeJudge(queryModel) }).catch(() => {});
  }

  return dispatchResult;
}

/**
 * Streaming sibling of queryModel. Runs the same governed path - composition
 * (when a seat is given) + governance-preamble injection + throttle - but
 * routes to the bridge's queryStream() and yields token deltas as they arrive.
 * Falls back to wrapping a non-streaming bridge.query() as a single delta when
 * the bridge exposes no queryStream, so every backend works through this path.
 *
 * Async generator contract:
 *   - yields { type: "delta", text, reasoning } per token chunk
 *   - yields { type: "error", model, error, latency, seat } on failure (terminal)
 *   - otherwise yields exactly one terminal { type: "final", model, response,
 *       usage, latency, seat, toolCalls } - toolCalls is the bridge's native
 *       function-calling result ([{ id, name, args }] or null), preserved so
 *       the agent loop's native tool path (tool-protocol.js priority 1) fires
 *
 * Note: unlike queryModel, the streaming path does NOT run the adaptive
 * reasoning-tier fallback (timeout-race + retry) - streaming is for
 * interactive chat where a single governed attempt is the right shape; the
 * adaptive plan stays on the buffered queryModel path.
 *
 * @param {string} modelId
 * @param {string} message
 * @param {object} options - same as queryModel (raw, seat, topology, roleHint, ...)
 */
export async function* queryModelStream(modelId, message, options = {}) {
  let responseOnlyBridge;
  try { responseOnlyBridge = await resolveResponseOnlyBridge(modelId, options); }
  catch (error) {
    yield { type: 'error', model: modelId, error: error.message, code: error.code, blocked: true, providerInvoked: false };
    return;
  }
  const dispatchStart = Date.now();

  // Cancellation: options.signal (an AbortSignal threaded from the agent loop).
  // An aborted run never starts a turn; an abort mid-stream stops consuming the
  // bridge and surfaces a terminal { type: "error", aborted: true } event.
  const signal = options.signal || null;
  if (signal && signal.aborted) {
    yield { type: "error", model: modelId, error: "aborted", aborted: true, latency: 0, seat: options.seat || null };
    return;
  }

  if (isModelPaused(modelId)) {
    yield { type: "final", model: modelId, response: null, skipped: true, reason: "paused", usage: {}, latency: 0, seat: options.seat || null };
    return;
  }

  const unavailable = describeUnavailableModel(modelId);
  if (unavailable) {
    yield { type: "error", model: modelId, error: unavailable.message, unavailable: true, bridgeFailure: unavailable, latency: Date.now() - dispatchStart, seat: options.seat || null };
    return;
  }
  const routePreflightFailure = await describeRoutePreflightFailure(modelId, options);
  if (routePreflightFailure) {
    yield { type: "error", model: modelId, error: routePreflightFailure.message, unavailable: true, bridgeFailure: routePreflightFailure, latency: Date.now() - dispatchStart, seat: options.seat || null };
    return;
  }

  // DRL bridge-entry fast-fail (streaming parity with the buffered path): an open
  // breaker short-circuits before the bridge is touched. Yields a terminal error
  // event tagged `breaker` so the consumer's streaming code handles it like any
  // other terminal error; the recorder treats it as 'ignored' (no double-count).
  if (isDrlEnabled()) {
    const verdict = assertBreakerAllowsDispatch(toCanonicalKey(modelId));
    if (!verdict.allowed) {
      yield { type: "error", model: modelId, error: `circuit breaker ${verdict.reason}`, breaker: verdict.reason, latency: Date.now() - dispatchStart, seat: options.seat || null };
      return;
    }
  }

  const selectedChannel = options.channel || null;
  const bridge = responseOnlyBridge || (selectedChannel?.bridge ? await loadBridgeModule(selectedChannel.bridge) : await getBridge(modelId));
  // Aliases canonicalize before the defaults lookup (MODEL_DEFAULTS is keyed
  // by canonical id only - the registry owns every other spelling).
  const defaults = MODEL_DEFAULTS[resolveModelId(modelId) ?? modelId] || {};
  const merged = bindTraceSources({ ...defaults, ...options },bridge);
  const responseOnly = responseOnlyBridge !== null;
  const agenticCodex = agenticCodexRoute(modelId, selectedChannel);
  const agenticGrok = agenticGrokRoute(modelId, selectedChannel);
  const oneShotAgentic = agenticCodex || agenticGrok;
  if (selectedChannel?.model) {
    merged.model = selectedChannel.model;
    if (selectedChannel.transport === "antigravity") merged.agyModel = selectedChannel.model;
  }
  if (typeof merged.thinking === "boolean") {
    merged.params = { ...(merged.params || {}) };
    if (merged.params.think === undefined) merged.params.think = merged.thinking;
  }

  // -- HARD tier: same fail-closed POLICY check as the buffered path. On deny (or a
  //    policy-layer throw - the try/catch converts it to a deny), yield a terminal
  //    error event; the throw never escapes this generator uncaught. --
  let verdict;
  try {
    verdict = enforceDispatch({ modelId, options });
  } catch (err) {
    console.warn(`[dispatch] enforcement threw, failing closed: ${err.message}`);
    verdict = { allowed: false, reason: `enforcement error: ${err.message}` };
  }
  if (!verdict.allowed) {
    yield { type: "error", model: modelId, error: verdict.reason, blocked: true, latency: Date.now() - dispatchStart, seat: options.seat || null };
    return;
  }

  // ARMED repo-authority PRE-DISPATCH (A28.6, divergence-only) - streaming parity with
  // the buffered path. Same semantics: fail-closed ONLY on a genuine split-brain
  // (DIVERGENCE verdict against a PRESENT lineage / shadow repo); no-lineage, non-git,
  // and dirty/detached/behind all PASS as advisory. raw/judge dispatches are EXEMPT
  // (options.raw); a returned !allowed (a real divergence) fails closed with a terminal
  // error event; the ONLY fail-open is a thrown probe fault (-> allowed). Lineage is
  // sourced via the SAME resolveDispatchLineage the Bill context uses.
  let repoAuthority = null;
  if (!options.raw) {
    try {
      repoAuthority = checkRepoAuthorityCached({
        cwd: options.cwd || process.cwd(),
        dispatchedLineage: resolveDispatchLineage(options),
        trigger: "pre-dispatch",
        stamp: options.stamp || null,
      });
    } catch (err) {
      console.warn(`[dispatch] repo-authority probe threw, failing open: ${err.message}`);
      repoAuthority = { allowed: true };
    }
    if (!repoAuthority.allowed) {
      yield { type: "error", model: modelId, error: repoAuthority.reason, blocked: true, latency: Date.now() - dispatchStart, seat: options.seat || null };
      return;
    }
  }

  // Dispatch-side gate tier of the compiled Bill (scope-delegation + the un-starved
  // single-canonical-root; other gate obligations inert until their facts are plumbed). The
  // repo-authority fragment rides ONLY via repoAuthority.predicateCtx (non-raw path); the raw
  // path passes null, keeping the Bill ctx scope-only with no git probe. Fail-open on a
  // broken/absent Bill.
  {
    const bill = await enforceDispatchBill(buildDispatchBillContext(options, repoAuthority?.predicateCtx || null));
    if (!bill.ok) {
      yield { type: "error", model: modelId, error: bill.blocking.map((b) => b.reason).join("; "), blocked: true, latency: Date.now() - dispatchStart, seat: options.seat || null };
      return;
    }
  }

  // -- Governed message: composition prefix (seated only) + operator injections
  //    + governance preamble - identical assembly to _queryModelInner. --
  let composedPrefix = "";
  if (options.seat && !options.raw) {
    try {
      const { compose } = await import("../composition/composer.js");
      const composition = await compose(modelId, {
        roleId: options.roleHint || null,
        skills: options.skills || [],
      }, {
        message,
        projectId: options.projectId,
        peerIds: options.peerIds,
        taskTokens: options.taskTokens,
        skipContext: options.skipContext === true,
      });
      if (composition.systemPrompt) {
        composedPrefix = composition.systemPrompt + "\n\n";
      }
    } catch {
      // Composition is non-fatal - degrade to governance-only.
    }
  }

  const injections = drainInjections(modelId);
  const injectionText = injections.length > 0
    ? "\n\n[Operator injection]: " + injections.map((i) => i.content).join("\n") + "\n\n"
    : "";

  // CARRIED tier: unconditional [Mandate] anchor (same as the buffered path).
  const anchored = carryMandate(injectionText + message, options);

  const governedMessage = injectGovernance(composedPrefix + anchored, {
    raw: options.raw,
    skipIdentitySummary: options.skipIdentitySummary === true,
    seat: options.seat,
    topology: options.topology,
    modelId,
    peerIds: options.peerIds,
    projectId: options.projectId,
  });

  // Same provider-level throttle key as the buffered path.
  const throttleProvider = selectedChannel?.provider || defaults.provider || null;
  const throttleKey = resolveThrottleKey(modelId, throttleProvider);
  const trace = createTraceExposure(options,'illuci.dispatch','governed-dispatch');
  await trace.source(bridge);
  await trace.record({modelId,message:governedMessage,history:options.sessionState||[],
    channel:selectedChannel?.transport||null,bridge:selectedChannel?.bridge||null,providerModel:selectedChannel?.model||null},
    'normalized-runtime-event','governed-query-input',['composition','governance-injection']);
  await acquireSlot(throttleKey);
  let finalResult = null;
  let errored = null;
  let sawAbort = false;
  let bridgeExhausted = false;
  let agenticEntered = false;
  // DRL stall watcher: EWMA over inter-delta gaps. Started (seeded) before the
  // for-await; ticked on each delta. It only OBSERVES (a long smoothed gap reads
  // as stalled) - it never aborts the stream or touches the breaker here; acting
  // on a stall is a later integration. Inert when the flag is off (null watcher).
  const stallWatcher = isDrlEnabled() ? makeStallWatcher(toCanonicalKey(modelId)) : null;
  if (stallWatcher) stallWatcher.tick(); // seat the baseline timestamp
  try {
    if (typeof bridge.queryStream === "function") {
      if (oneShotAgentic) agenticEntered = true;
      for await (const event of bridge.queryStream(governedMessage, merged)) {
        // Capture before abort/final projections can discard original exposure.
        await trace.record(event,'normalized-runtime-event','bridge-stream-event',['bridge-normalization']);
        if (oneShotAgentic && event.type === 'error') throw new Error(event.error || 'Agentic stream error');
        // Abort between chunks: stop consuming the bridge (break runs its
        // generator finally) and discard the turn - the run is being torn down.
        if (signal && signal.aborted) { sawAbort = true; break; }
        if (stallWatcher && event.type !== "final") stallWatcher.tick(); // observe delta cadence
        if (event.type === "final") finalResult = event;
        else yield event; // delta (and any non-final event) passes straight through
      }
      if (oneShotAgentic && !sawAbort && !finalResult) throw new Error('Agentic stream ended without a final result');
    } else {
      // Non-streaming bridge - emit the whole response as a single delta so the
      // consumer's streaming code path still works uniformly. raceAbort unblocks
      // this await the moment the signal fires (merged.signal also reaches the
      // bridge so bridges can kill their spawned CLI child when they adopt it).
      // withRetry wraps the single-shot call: a transient (connection/5xx/429)
      // fault can retry with backoff for eligible routes. Codex execution can
      // have effects even if query() produced no visible output.
      const result = await withRetry(() => { if (oneShotAgentic) agenticEntered = true; return raceAbort(bridge.query(governedMessage, merged), signal); }, {
        signal,
        maxAttempts: responseOnly || oneShotAgentic ? 1 : 3,
        onRetry: (i) => console.warn(`[dispatch] ${modelId} transient ${i.class} (${i.error}); retry ${i.nextAttempt} in ${i.delayMs}ms`),
      });
      await trace.record(result,'normalized-runtime-event','bridge-result',['bridge-normalization']);
      if (result?.response) yield { type: "delta", text: result.response, reasoning: false };
      finalResult = { ...result, type: "final" };
    }
    if (!sawAbort) bridgeExhausted = true;
  } catch (err) {
    if (err && err.message === "ABORTED") sawAbort = true;
    else errored = err;
  } finally {
    // Generators run finally on early consumer return/throw too, so the slot is
    // always released - including when the caller stops iterating mid-stream.
    const tokenCount = finalResult?.usage?.total_tokens || 0;
    releaseSlot(throttleKey, tokenCount);
    await trace.finish(bridgeExhausted && !sawAbort && !signal?.aborted);
  }

  if (sawAbort || (signal && signal.aborted)) {
    const abortEvent = { type: "error", model: modelId, error: "aborted", aborted: true, ...(oneShotAgentic && agenticEntered && !bridgeExhausted ? {code:'ILLUCI_AGENTIC_OUTCOME_UNCONFIRMED',retrySafe:false,outcome:'unknown'} : {}), latency: Date.now() - dispatchStart, seat: options.seat || null };
    // DRL: terminal record for the abort path - classifies as 'ignored' (a cancel
    // is not a backend fault), so the breaker is untouched.
    if (isDrlEnabled()) { try { recordDispatchOutcome(modelId, abortEvent, abortEvent.latency); } catch {} }
    yield abortEvent;
    return;
  }

  if (errored) {
    if (oneShotAgentic && agenticEntered) errored = unconfirmedAgenticOutcome(errored, agenticGrok ? 'Grok Build' : 'Codex');
    console.warn(`[dispatch] ${modelId} stream failed: ${errored.message}`);
    const errEvent = { type: "error", model: modelId, error: errored.message, ...(errored?.retrySafe === false || errored?.outcome === 'unknown' ? { ...(errored.code ? {code:errored.code} : {}), retrySafe:false, ...(errored.outcome === 'unknown' ? {outcome:'unknown'} : {}) } : {}), bridgeFailure: describeBridgeFailure(modelId, errored, options), latency: Date.now() - dispatchStart, seat: options.seat || null };
    // DRL: terminal record for the error path - classifies the error string
    // (transient -> ignored; permanent/unknown -> terminal_failure).
    if (isDrlEnabled()) { try { recordDispatchOutcome(modelId, errEvent, errEvent.latency); } catch {} }
    yield errEvent;
    return;
  }

  finalResult = applyEstimatedUsage(finalResult || {}, governedMessage, modelId);

  // DRL: terminal record for the final (success) path - exactly one per dispatch
  // (the abort and error exits above already returned). A real response feeds the
  // breaker (reset/close) + latency ring; a paused final classifies as 'ignored'.
  if (isDrlEnabled()) {
    try { recordDispatchOutcome(modelId, finalResult, finalResult.latency || (Date.now() - dispatchStart)); } catch {}
  }

  // SOFT tier: fire-and-forget AFTER the terminal final - the consumer already has
  // its data, so the verify pass can never delay or fail the stream. Off by default.
  const closeSoftVerification = softVerifyEnabled();
  if (responseOnly && closeSoftVerification) {
    // Configuration changed after admission. Retain the actual primary output,
    // hold its qualification, and never start an unconstrained secondary judge.
    Object.assign(finalResult, { failed: true, blocked: true,
      error: 'Response-only result held: secondary soft judge became enabled after admission',
      secondaryVerification: { status: 'held', providerInvoked: false } });
  } else if (closeSoftVerification && !options.raw) {
    verifyDispatchSoft({ output: finalResult.response ?? null, modelId, seat: options.seat, judge: makeJudge(queryModel) }).catch(() => {});
  }

  const finalModel = selectedChannel ? modelId : (finalResult.model || modelId);
  const finalChannel = selectedChannel ? selectedChannel.transport : finalResult.channel;
  const modelRuntime = options.modelRuntime ? {
    ...options.modelRuntime,
    actual: {
      model: finalModel,
      channel: finalChannel || null,
      bridge: selectedChannel?.bridge || null,
      providerModel: selectedChannel?.model || null,
    },
  } : null;

  yield {
    type: "final",
    model: finalModel,
    response: finalResult.response ?? null,
    usage: {
      prompt_tokens: finalResult.usage?.prompt_tokens || finalResult.usage?.input_tokens || 0,
      completion_tokens: finalResult.usage?.completion_tokens || finalResult.usage?.output_tokens || 0,
      total_tokens: finalResult.usage?.total_tokens || 0,
    },
    latency: finalResult.latency || (Date.now() - dispatchStart),
    seat: options.seat || null,
    sessionState: finalResult.sessionState,
    channel: finalChannel || null,
    ...(modelRuntime ? { modelRuntime } : {}),
    // Native function-calling result from the bridge. The explicit field list
    // above used to DROP this, severing the loop's native tool path.
    toolCalls: finalResult.toolCalls ?? null,
    // Exposed trace text and failure/skip semantics survive this projection.
    ...(Object.hasOwn(finalResult,'reasoning') ? {reasoning:finalResult.reasoning} : {}),
    ...(Object.hasOwn(finalResult,'failed') ? {failed:finalResult.failed} : {}),
    ...(Object.hasOwn(finalResult,'blocked') ? {blocked:finalResult.blocked} : {}),
    ...(Object.hasOwn(finalResult,'secondaryVerification') ? {secondaryVerification:finalResult.secondaryVerification} : {}),
    ...(Object.hasOwn(finalResult,'error') ? {error:finalResult.error} : {}),
    ...(Object.hasOwn(finalResult,'code') ? {code:finalResult.code} : {}),
    ...(Object.hasOwn(finalResult,'retrySafe') ? {retrySafe:finalResult.retrySafe} : {}),
    ...(Object.hasOwn(finalResult,'outcome') ? {outcome:finalResult.outcome} : {}),
    ...(Object.hasOwn(finalResult,'stopReason') ? {stopReason:finalResult.stopReason} : {}),
    ...(Object.hasOwn(finalResult,'refused') ? {refused:finalResult.refused} : {}),
    ...(Object.hasOwn(finalResult,'continuationRequired') ? {continuationRequired:finalResult.continuationRequired} : {}),
    ...(Object.hasOwn(finalResult,'nativeHistoryCandidate') ? {nativeHistoryCandidate:finalResult.nativeHistoryCandidate, nativeHistoryStatus:finalResult.nativeHistoryStatus} : {}),
    ...(Object.hasOwn(finalResult,'skipped') ? {skipped:finalResult.skipped,reason:finalResult.reason} : {}),
  };
}

/**
 * Race a bridge promise against an AbortSignal. Resolves with the promise's
 * value, or rejects with Error("ABORTED") the moment the signal fires - so a
 * blocked non-streaming bridge call cannot pin an aborted run. Killing the
 * bridge's spawned CLI child is the bridge's job once it adopts options.signal;
 * this guarantees only that the dispatch path itself unblocks. The orphaned
 * promise stays subscribed to Promise.race, so a late rejection is handled.
 */
async function raceAbort(promise, signal) {
  if (!signal) return promise;
  let onAbort = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        onAbort = () => reject(new Error("ABORTED"));
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Query multiple models concurrently. Returns all results.
 * Failed models return { model, error } instead of throwing.
 */
export async function queryConcurrent(modelIds, message, options = {}) {
  const results = await Promise.allSettled(
    modelIds.map(async (id) => {
      try {
        return await queryModel(id, message, options);
      } catch (err) {
        return { model: id, error: err.message, response: null, usage: {}, latency: 0 };
      }
    }),
  );

  return results.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    return { model: modelIds[i], error: r.reason?.message, response: null, usage: {}, latency: 0 };
  });
}

/**
 * Query all available models concurrently.
 */
export async function queryAll(message, options = {}) {
  const all = Object.keys(MODEL_DEFAULTS);
  return queryConcurrent(all, message, options);
}

/**
 * Query by role - resolves the best model(s) for a role via capability
 * matrix, then dispatches. Returns results from all concurrent models.
 *
 * @param {string} role - capability matrix role (e.g., "recon", "reviewer")
 * @param {string} message
 * @param {object} options
 */
export async function queryByRole(role, message, options = {}) {
  const models = getConcurrentModels(role);
  if (models.length === 0) {
    throw new Error(`No models available for role: ${role}`);
  }

  const modelIds = models.map((m) => m.model);

  const results = await Promise.allSettled(
    models.map(async (m) => {
      try {
        const roleMessage = m.prompt
          ? `${m.prompt}\n\n---\n\n${message}`
          : message;
        return await queryModel(m.model, roleMessage, { ...options, seat: role });
      } catch (err) {
        return { model: m.model, error: err.message, response: null, usage: {}, latency: 0 };
      }
    }),
  );

  return results.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    return { model: modelIds[i], error: r.reason?.message, response: null, usage: {}, latency: 0 };
  });
}

export default { queryModel, queryModelStream, queryConcurrent, queryAll, queryByRole };
