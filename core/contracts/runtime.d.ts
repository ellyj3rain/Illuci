// core/contracts/runtime.d.ts
//
// [A22.1] Illuci Runtime service — typed contract (DR-105 spine).
//
// The canonical, TS-consumable (and later other-language) shape of the runtime
// identity / capability / doctor surfaces that a remote client resolves. Kept in
// core/contracts so it grows with the typed-contracts spine rather than drifting.

export type RuntimeSourceFrom =
  | "build-stamp-env"
  | "build-stamp-file"
  | "git-worktree"
  | "unknown";

export interface RuntimeSourceRevision {
  rev: string | null;
  from: RuntimeSourceFrom;
  branch?: string | null;
  dirty?: boolean;
}

export interface RuntimeIdentity {
  schema: string;
  runtimeId: string;
  version: string | null;
  schemaVersion: string;
  source: RuntimeSourceRevision;
}

export interface RuntimeProvider {
  id: string | null;
  label: string | null;
  organization: string | null;
  class: string | null;
  /** The auth MODE (e.g. "api-key", "oauth-ultra", "subscription") — never a secret value. */
  authMode: string | null;
}

export interface RuntimeModel {
  id: string | null;
  registryId?: string | null;
  label: string | null;
  tier: string | null;
  provider?: string | null;
  providerLabel?: string | null;
  providerModel?: string | null;
  transport?: string | null;
  authMode?: string | null;
  lane?: string | null;
  status?: string | null;
  modality?: string | null;
  fleetUse?: "seat" | "delegate" | string | null;
  capabilityLanes?: string[];
}

export interface RuntimeMcpSurface {
  tools: string[];
  resources: string[];
  prompts: string[];
}

export interface RuntimeCapabilityCounts {
  providers: number;
  models: number;
  topologies: number;
  roles: number;
  skillFrameworks: number;
}

export interface RuntimeCapability {
  schema: string;
  providers: RuntimeProvider[];
  models: RuntimeModel[];
  topologies: string[];
  roles: string[];
  skillFrameworks: string[];
  /** Distinct auth modes across providers — the "what auth is possible" facet, no values. */
  authModes: string[];
  mcp: RuntimeMcpSurface | { present: false; note: string };
  counts: RuntimeCapabilityCounts;
}

export interface RuntimeDoctorCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface RuntimeDoctorReport {
  schema: string;
  status: "ok" | "ok-dirty" | "degraded";
  identity: RuntimeIdentity;
  capability: { counts: RuntimeCapabilityCounts; authModes: string[] };
  checks: RuntimeDoctorCheck[];
  current: { sourceFrom: RuntimeSourceFrom | string; dirty: boolean; rev: string | null };
}
