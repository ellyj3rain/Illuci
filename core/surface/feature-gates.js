/**
 * Illuci feature-gate registry — surface-context / capability-card support.
 *
 * The disclosed run-posture controls live in `core/governance/defaults-registry.js`
 * (DR-129/DR-130). This registry discloses the opt-in `ILLUCI_*_ENABLED` *feature*
 * gates so the capability card can tell a host agent or human what is off and the
 * one-line control to turn it on.
 *
 * Disclosure only: nothing here flips a gate. Each gate reports its live state from
 * the environment. Gate names are the real env controls read across `core/`; the
 * "off (default)" reading follows the opt-in `_ENABLED` convention. A follow-on can
 * bind each gate to its own config resolver (as defaults-registry does for DRL /
 * preflight) so the default reading is resolver-exact rather than convention-based.
 */

export const FEATURE_GATES_SCHEMA = "illuci.surface.feature-gates/1";

function truthy(v) {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "on" || s === "yes";
}

/** Opt-in feature gates: id, the env control, and what it unlocks. */
export const FEATURE_GATES = Object.freeze([
  { id: "datastore", env: "ILLUCI_DATASTORE_ENABLED", unlocks: "Polyglot datastore (event-sourced SQLite trunk + vec/graph/DuckDB projections over run/company output)." },
  { id: "classifier", env: "ILLUCI_CLASSIFIER_ENABLED", unlocks: "Runtime classifier layer for governance/routing decisions." },
  { id: "multimodal", env: "ILLUCI_MULTIMODAL_ENABLED", unlocks: "Multimodal dispatch beyond text." },
  { id: "role-governance", env: "ILLUCI_ROLE_GOVERNANCE_ENABLED", unlocks: "Role-governance enforcement over seated agents." },
  { id: "preset-run", env: "ILLUCI_PRESET_RUN_ENABLED", unlocks: "Executing runtime-authored graph presets (`illuci presets run`)." },
  { id: "company", env: "ILLUCI_COMPANY_ENABLED", unlocks: "Company mode — concurrent topologies on one shared bus." },
  { id: "company-rounds", env: "ILLUCI_COMPANY_ROUNDS_ENABLED", unlocks: "Multi-round company execution." },
  { id: "cognitive-controls", env: "ILLUCI_COGNITIVE_CONTROLS_ENABLED", unlocks: "Cognitive tool-affordance controls (reasoning/thinking surface)." },
  { id: "fleet-normalized", env: "ILLUCI_FLEET_NORMALIZED_ENABLED", unlocks: "Normalized fleet model resolution." },
  { id: "fleet-channels", env: "ILLUCI_FLEET_CHANNELS_ENABLED", unlocks: "Fleet channel routing." },
  { id: "fleet-serving", env: "ILLUCI_FLEET_SERVING_MODULE_ENABLED", unlocks: "Fleet serving module." },
  { id: "fleet-liveness", env: "ILLUCI_FLEET_LIVENESS_ENABLED", unlocks: "Live fleet-route liveness probing." },
  { id: "fleet-curation", env: "ILLUCI_FLEET_CURATION_ENABLED", unlocks: "Operator fleet-curation controls." },
  { id: "capability-permit-mandatory", env: "ILLUCI_CAPABILITY_PERMIT_MANDATORY", unlocks: "Per-run mandatory capability permits (deny-all until a grant lifts each capability)." },
]);

/** Live state of one gate — factual read of the environment; flips nothing. */
export function featureGateState(gate, env = process.env) {
  const raw = env[gate.env];
  const isSet = raw !== undefined && raw !== "";
  let current;
  if (isSet) current = truthy(raw) ? "on" : "off";
  else current = "off (default)"; // opt-in _ENABLED gate: inactive until turned on
  return {
    id: gate.id,
    env: gate.env,
    unlocks: gate.unlocks,
    current,
    turnOn: `${gate.env}=1`,
    turnOff: `${gate.env}=0`,
  };
}

/** Disclosure snapshot of every feature gate for the capability card. */
export function featureGatesSnapshot(env = process.env) {
  const gates = FEATURE_GATES.map((g) => featureGateState(g, env));
  return Object.freeze({
    schema: FEATURE_GATES_SCHEMA,
    disclosure:
      "Opt-in feature gates. Each is inactive until its env control turns it on. Disclosure only — nothing is flipped here.",
    gates,
    on: gates.filter((g) => g.current === "on").map((g) => g.id),
    off: gates.filter((g) => g.current !== "on").map((g) => g.id),
  });
}

export default { FEATURE_GATES_SCHEMA, FEATURE_GATES, featureGateState, featureGatesSnapshot };
