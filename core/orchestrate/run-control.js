// core/orchestrate/run-control.js
//
// Canonical run-control envelope. This module owns the operator/host-facing
// shape for a topology run: agenda planning, phase mutation authority, governed
// tool autonomy, and (A96/DR-189) the optional token budget cascade are
// orthogonal controls.

import { normalizeBudgetControl } from "../throttle/seat-budget.js";

export const RUN_CONTROL_SCHEMA = "illuci.run-control/1";

export const AGENDA_STRATEGIES = Object.freeze(["conducted", "derived", "ritual"]);
export const MUTATION_AUTHORITIES = Object.freeze(["gated", "blocked"]);
export const TOOL_AUTONOMY_LEVELS = Object.freeze(["directed", "checkpointed", "governed", "autonomous"]);

export const DEFAULT_RUN_CONTROL = Object.freeze({
  schema: RUN_CONTROL_SCHEMA,
  agenda: Object.freeze({ strategy: "conducted" }),
  execution: Object.freeze({ mutationAuthority: "gated" }),
  tools: Object.freeze({ autonomy: "directed" }),
  budget: null, // [A96]/DR-189: the token budget cascade is off by default
});

export class RunControlConfigError extends Error {
  constructor(message) {
    super(`run-control: ${message}`);
    this.name = "RunControlConfigError";
    this.code = "RUN_CONTROL_CONFIG_INVALID";
  }
}

export class ToolAutonomyConfigError extends Error {
  constructor(message) {
    super(`tool-autonomy: ${message}`);
    this.name = "ToolAutonomyConfigError";
    this.code = "TOOL_AUTONOMY_CONFIG_INVALID";
  }
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function validateEnum(kind, value, allowed) {
  if (!allowed.includes(value)) {
    throw new RunControlConfigError(`${kind} must be one of ${allowed.join("|")} (got "${value}")`);
  }
}

export function normalizeRunControl(options = {}) {
  const raw = options.runControl === undefined || options.runControl === null ? {} : options.runControl;
  if (!plainObject(raw)) {
    throw new RunControlConfigError("runControl must be an object");
  }

  const agenda = raw.agenda ?? {};
  const execution = raw.execution ?? {};
  const tools = raw.tools ?? {};
  if (!plainObject(agenda) || !plainObject(execution) || !plainObject(tools)) {
    throw new RunControlConfigError("agenda, execution, and tools must be objects when present");
  }

  const agendaStrategy = agenda.strategy ?? DEFAULT_RUN_CONTROL.agenda.strategy;
  const mutationAuthority = execution.mutationAuthority ?? DEFAULT_RUN_CONTROL.execution.mutationAuthority;
  const toolAutonomy = tools.autonomy ?? DEFAULT_RUN_CONTROL.tools.autonomy;

  validateEnum("agenda.strategy", agendaStrategy, AGENDA_STRATEGIES);
  validateEnum("execution.mutationAuthority", mutationAuthority, MUTATION_AUTHORITIES);
  validateEnum("tools.autonomy", toolAutonomy, TOOL_AUTONOMY_LEVELS);

  // [A96]/DR-189 (WO-2 ruling): the optional budget cascade. Absent → null (off,
  // byte-identical). Validated fail-closed by the seat-budget policy module (a
  // malformed stanza throws, never a silent downgrade — DR-129).
  const budget = normalizeBudgetControl(raw.budget ?? null);

  return {
    schema: RUN_CONTROL_SCHEMA,
    agenda: { strategy: agendaStrategy },
    execution: { mutationAuthority },
    tools: { autonomy: toolAutonomy },
    budget,
  };
}

export function runControlAgendaMode(runControl = DEFAULT_RUN_CONTROL) {
  return runControl?.agenda?.strategy || DEFAULT_RUN_CONTROL.agenda.strategy;
}

export function runControlAutonomy(runControl = DEFAULT_RUN_CONTROL) {
  return runControl?.tools?.autonomy || DEFAULT_RUN_CONTROL.tools.autonomy;
}

export function resolveToolAutonomy(level, { checkpointPort = null } = {}) {
  if (!TOOL_AUTONOMY_LEVELS.includes(level)) {
    throw new ToolAutonomyConfigError(`unknown level "${level}" - one of: ${TOOL_AUTONOMY_LEVELS.join(", ")}`);
  }
  if (level === "checkpointed" && typeof checkpointPort !== "function") {
    throw new ToolAutonomyConfigError(
      'level "checkpointed" requires a fire-control checkpoint port; pacing without a pacer must refuse before dispatch',
    );
  }
  return {
    level,
    seatLoop: level !== "directed",
    checkpointRequired: level === "checkpointed",
    capabilityPermitMandatory: level === "governed",
  };
}

export function deriveRunToolAutonomy(runControl = DEFAULT_RUN_CONTROL, options = {}) {
  const resolved = resolveToolAutonomy(runControlAutonomy(runControl), { checkpointPort: options.checkpoint || null });
  return {
    ...resolved,
    seatLoop: options.seatLoop !== undefined && options.seatLoop !== null ? options.seatLoop : resolved.seatLoop,
  };
}

export function runControlBlocksPhaseMutation(runControl = DEFAULT_RUN_CONTROL) {
  return runControl?.execution?.mutationAuthority === "blocked";
}

export function phaseModeForRunControl(phaseMode, runControl = DEFAULT_RUN_CONTROL) {
  if (!runControlBlocksPhaseMutation(runControl)) return phaseMode;
  return phaseMode === "write" || phaseMode === "execute" || phaseMode === "delegate"
    ? "respond"
    : phaseMode;
}

export default {
  RUN_CONTROL_SCHEMA,
  AGENDA_STRATEGIES,
  MUTATION_AUTHORITIES,
  TOOL_AUTONOMY_LEVELS,
  DEFAULT_RUN_CONTROL,
  RunControlConfigError,
  ToolAutonomyConfigError,
  normalizeRunControl,
  runControlAgendaMode,
  runControlAutonomy,
  resolveToolAutonomy,
  deriveRunToolAutonomy,
  runControlBlocksPhaseMutation,
  phaseModeForRunControl,
};
