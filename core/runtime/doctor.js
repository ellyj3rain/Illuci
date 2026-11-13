// core/runtime/doctor.js
//
// [A22.1] Illuci Runtime service — doctor.
//
// The deterministic answer to "what runtime is active and is it current?" — for a remote
// client, not a manual worktree inspection. Composes the identity + capability surfaces
// into a single self-describing report with pass/fail checks. No secrets ever cross this
// surface (the capability layer only exposes auth MODES, never values).

import process from "node:process";
import { getRuntimeIdentity } from "./identity.js";
import { getRuntimeCapability } from "./capability.js";
import { compareSessionGrounding } from "./grounding.js";

/**
 * [A33] The doctor carries the GROUNDING block (path-bearing) — it is the
 * token-gated operator diagnostic, and "which root is this runtime actually
 * serving from" is precisely what it exists to answer. The broad identity
 * surface stays path-free. `activeRoot` (optional) is the ACTIVE session or
 * agent worktree: when given, the doctor runs the split-brain comparison a
 * self-polling server can never run for itself — active worktree vs the
 * MCP-launcher's actual root.
 *
 * @param {{ mcpRegistry?: object|null, activeRoot?: string|null }} [opts]
 * @returns {import("../contracts/runtime.d.ts").RuntimeDoctorReport}
 */
export function runtimeDoctor({ mcpRegistry = null, activeRoot = null } = {}) {
  const identity = getRuntimeIdentity({ grounding: true });
  const capability = getRuntimeCapability({ mcpRegistry });

  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });
  add("version-present", Boolean(identity.version), identity.version || "MISSING");
  add("source-revision", Boolean(identity.source?.rev), identity.source?.from || "unknown");
  add(
    "grounding-legitimate",
    identity.grounding?.grounding?.failClosed !== true,
    `${identity.grounding?.grounding?.status || "unknown"}: ${identity.grounding?.grounding?.reason || "no grounding facts"}`,
  );
  if (activeRoot) {
    const session = compareSessionGrounding({ activeRoot, servedRoot: identity.grounding?.sourceRoot });
    add("session-grounding-aligned", session.match, `${session.status}: ${session.reason}`);
  }
  add("providers-nonempty", capability.counts.providers > 0, `${capability.counts.providers} providers`);
  add("models-nonempty", capability.counts.models > 0, `${capability.counts.models} models`);
  add("topologies-nonempty", capability.counts.topologies > 0, `${capability.counts.topologies} topologies`);
  add("auth-modes-declared", capability.authModes.length > 0, capability.authModes.join(","));
  add("node-runtime", true, process.version);

  const dirty = identity.source?.dirty === true;
  const allOk = checks.every((c) => c.ok);
  const status = allOk ? (dirty ? "ok-dirty" : "ok") : "degraded";

  return {
    schema: identity.schema,
    status,
    identity,
    capability: { counts: capability.counts, authModes: capability.authModes },
    checks,
    current: { sourceFrom: identity.source?.from ?? "unknown", dirty, rev: identity.source?.rev ?? null },
  };
}

export default { runtimeDoctor };
