export const REASONING_TIERS = ["minimal", "low", "medium", "high", "xhigh", "max"];

const DEFAULT_REASONING_TIMEOUTS = {
  max: 360000,
  xhigh: 300000,
  high: 180000,
  medium: 120000,
  low: 90000,
  minimal: 60000,
};

export function parseBooleanLike(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;

  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on", "enabled"].includes(normalized)) return true;
  if (["0", "false", "no", "off", "disabled"].includes(normalized)) return false;
  return fallback;
}

export function normalizeReasoningTier(value) {
  if (!value) return null;
  const normalized = String(value).trim().toLowerCase();
  return REASONING_TIERS.includes(normalized) ? normalized : null;
}

export function resolveAdaptiveControls(options = {}, env = process.env) {
  return {
    adaptiveFallback: parseBooleanLike(
      options.adaptiveFallback,
      parseBooleanLike(env.ILLUCI_ADAPTIVE_FALLBACK, true),
    ),
    reasoningFloor: normalizeReasoningTier(options.reasoningFloor || env.ILLUCI_REASONING_FLOOR) || "medium",
  };
}

export function resolveReasoningTimeout(tier, reasoningMeta = {}) {
  if (!tier) return 180000;
  return reasoningMeta.timeoutMs?.[tier] || DEFAULT_REASONING_TIMEOUTS[tier] || 180000;
}

export function resolveSeatTimeoutHeadroom(env = process.env) {
  // Seated council/composition members carry composition-prefix + agentic-loop
  // overhead the bare-query reasoning-tier timeouts were never tuned for, so the
  // unmodified ceiling (e.g. 300s xhigh) guillotines a long build seat (AMD-7).
  // Headroom is a CONTINUOUS, env-tunable multiplier (default 1.3), not a flag;
  // a value < 1 would shorten the ceiling and is meaningless, so it clamps to 1.
  const raw = Number(env.ILLUCI_SEAT_TIMEOUT_HEADROOM);
  if (!Number.isFinite(raw) || raw < 1) return 1.3;
  return raw;
}

export function resolveRaceTimeout({ callerTimeoutMs, tierTimeoutMs, seated = false, headroom, p95Ms = 0 } = {}) {
  // An explicit caller timeout (options.timeoutMs, e.g. `illuci run --timeout`) wins
  // as-is: the operator asked for exactly that wall-clock, headroom included.
  if (Number.isFinite(callerTimeoutMs) && callerTimeoutMs > 0) return callerTimeoutMs;
  const tierBase = Number.isFinite(tierTimeoutMs) && tierTimeoutMs > 0 ? tierTimeoutMs : 180000;
  // DRL observed-latency extension (additive; default p95Ms=0 => no-op, so an
  // unextended call is byte-identical to before). When the dispatch path is DRL-
  // armed it passes the model's observed p95; we add it to the tier ceiling BEFORE
  // the seat headroom multiply, so a genuinely-slow model this session is not
  // guillotined by a ceiling tuned for a faster one. getP95 returns 0 under 2
  // samples, so the extension stays inert until enough signal exists.
  const observed = Number.isFinite(p95Ms) && p95Ms > 0 ? p95Ms : 0;
  const base = tierBase + observed;
  const factor = seated ? (Number.isFinite(headroom) && headroom >= 1 ? headroom : 1.3) : 1;
  return Math.round(base * factor);
}

function resolveFloorTier(requestedTier, configuredFloor, supportedTiers) {
  const requestedIndex = supportedTiers.indexOf(requestedTier);
  if (requestedIndex === -1) return requestedTier;

  const explicitFloorIndex = supportedTiers.indexOf(configuredFloor);
  if (explicitFloorIndex !== -1) {
    return explicitFloorIndex < requestedIndex ? requestedTier : configuredFloor;
  }

  const configuredOrder = REASONING_TIERS.indexOf(configuredFloor);
  if (configuredOrder === -1) return supportedTiers[supportedTiers.length - 1] || requestedTier;

  for (let i = supportedTiers.length - 1; i >= requestedIndex; i--) {
    const candidate = supportedTiers[i];
    if (REASONING_TIERS.indexOf(candidate) >= configuredOrder) {
      return candidate;
    }
  }

  return supportedTiers[supportedTiers.length - 1] || requestedTier;
}

export function buildAdaptiveExecutionPlan(modelId, merged = {}, modelDefaults = {}, controls = resolveAdaptiveControls(merged)) {
  const reasoningMeta = modelDefaults.adaptive?.reasoning;
  const requestedTier = normalizeReasoningTier(merged.reasoning);
  const primaryAttempt = {
    label: "primary",
    options: { ...merged },
    reasoningTier: requestedTier,
    timeoutMs: resolveReasoningTimeout(requestedTier, reasoningMeta),
    fallback: false,
  };

  // Max previously had no adaptive tier and therefore ran once. Preserve that
  // selection unless this invocation explicitly requests adaptive fallback.
  if (requestedTier === "max" && !parseBooleanLike(merged.adaptiveFallback, false)) return [primaryAttempt];
  if (!reasoningMeta?.supported || !requestedTier) {
    return [primaryAttempt];
  }

  const supportedTiers = (reasoningMeta.tiers || []).map(normalizeReasoningTier).filter(Boolean);
  if (!controls.adaptiveFallback || !supportedTiers.includes(requestedTier)) {
    return [primaryAttempt];
  }

  const requestedIndex = supportedTiers.indexOf(requestedTier);
  const floorTier = resolveFloorTier(requestedTier, controls.reasoningFloor, supportedTiers);
  const floorIndex = supportedTiers.indexOf(floorTier);
  const endIndex = floorIndex >= requestedIndex ? floorIndex : requestedIndex;

  return supportedTiers.slice(requestedIndex, endIndex + 1).map((tier, index) => ({
    label: `reasoning:${tier}`,
    options: { ...merged, reasoning: tier },
    reasoningTier: tier,
    timeoutMs: resolveReasoningTimeout(tier, reasoningMeta),
    fallback: index > 0,
  }));
}

export default {
  REASONING_TIERS,
  buildAdaptiveExecutionPlan,
  normalizeReasoningTier,
  parseBooleanLike,
  resolveAdaptiveControls,
  resolveReasoningTimeout,
  resolveSeatTimeoutHeadroom,
  resolveRaceTimeout,
};
