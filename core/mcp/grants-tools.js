// core/mcp/grants-tools.js
//
// [A43] The capability-grant verbs on the MCP surface — the wire that turns
// the configured capability ledger into a live surface. Thin wrappers over the [A36]
// manager: every mutating act stays SSH-signed against the committed
// allowed_signers registry, list/verify are read-shaped, and issue/revoke
// declare file_write so the permission seam gates them like every other
// write tool. Also reachable as REST verbs (/runtime/grants/*) through the
// [A22.8] canonical-API map — MCP == API, one contract.

import { issueGrant, revokeGrant, listGrants, verifyGrant } from "../governance/grants/manager.js";
import { findGrant } from "../governance/grants/store.js";
import { CAPABILITY_VOCABULARY, GRANT_LAYERS, summarizeGrant } from "../governance/grants/registry.js";

export const GRANTS_TOOLS = [
  {
    name: "grants_list_v1",
    schema_version: "1.0.0",
    description:
      "List capability-grant records (first-class, SSH-signed; DR-125). Optional layer/subject/" +
      "capability filters. Each record is annotated with live activity (revocation beats expiry).",
    requiredActions: [],
    inputSchema: {
      type: "object",
      properties: {
        layer: { type: "string", enum: [...GRANT_LAYERS], description: "Optional layer filter (seat|run|tenant)." },
        subjectId: { type: "string", description: "Optional subject filter (seat/run/tenant id)." },
        capability: { type: "string", enum: [...CAPABILITY_VOCABULARY], description: "Optional capability filter (the closed vocabulary)." },
      },
    },
    async handler(args = {}) {
      const grants = listGrants({
        layer: args.layer || undefined,
        subjectId: args.subjectId || undefined,
        capability: args.capability || undefined,
      });
      return { count: grants.length, grants, summary: grants.map((g) => summarizeGrant(g)) };
    },
  },
  {
    name: "grants_issue_v1",
    schema_version: "1.0.0",
    description:
      "Issue a capability-grant record (or a deny-polarity withhold). The granting act is " +
      "SSH-signed against the committed allowed_signers registry; unsigned records refuse to " +
      "persist. Gated as a write (the operator's permission seam applies).",
    requiredActions: ["file_write"],
    inputSchema: {
      type: "object",
      properties: {
        layer: { type: "string", enum: [...GRANT_LAYERS], description: "The grant layer (seat|run|tenant)." },
        subjectId: { type: "string", description: "The subject (seat/run/tenant id)." },
        capability: { type: "string", enum: [...CAPABILITY_VOCABULARY], description: "The capability (closed vocabulary, DR-125)." },
        polarity: { type: "string", enum: ["grant", "deny"], description: "Optional; deny = the within-layer/outer-layer withhold primitive. Default grant." },
        expiresAt: { type: ["string", "null"], description: "Optional ISO-8601 expiry (must postdate the grant)." },
        grantorName: { type: "string", description: "Optional grantor display name (default operator)." },
        grantorPrincipal: { type: "string", description: "Explicit principal in your configured SSH signer registry." },
      },
      required: ["layer", "subjectId", "capability", "grantorPrincipal"],
    },
    async handler(args = {}) {
      const record = issueGrant({
        layer: args.layer,
        subjectId: args.subjectId,
        capability: args.capability,
        polarity: args.polarity || "grant",
        expiresAt: args.expiresAt ?? null,
        grantorName: args.grantorName || "operator",
        grantorPrincipal: args.grantorPrincipal,
      });
      return { issued: true, record, summary: summarizeGrant(record) };
    },
  },
  {
    name: "grants_revoke_v1",
    schema_version: "1.0.0",
    description:
      "Revoke a capability-grant record. The revoking act is signed and attributed exactly like " +
      "the granting act (revokedBy + reason are required — a recorded act, never a silent edit). " +
      "Revocation takes effect at the NEXT resolution (session-pinned runs finish under their pin).",
    requiredActions: ["file_write"],
    inputSchema: {
      type: "object",
      properties: {
        grantId: { type: "string", description: "The grant record id." },
        reason: { type: "string", description: "Why (recorded on the revocation)." },
        revokedBy: { type: "string", description: "Optional attribution (default operator)." },
      },
      required: ["grantId", "reason"],
    },
    async handler(args = {}) {
      const record = revokeGrant(args.grantId, { revokedBy: args.revokedBy || "operator", reason: args.reason });
      return { revoked: true, record, summary: summarizeGrant(record) };
    },
  },
  {
    name: "grants_verify_v1",
    schema_version: "1.0.0",
    description:
      "Verify a grant record's signatures (grant act + revocation act when present) against the " +
      "committed allowed_signers registry. A bad signature is a coded FINDING, never a throw.",
    requiredActions: [],
    inputSchema: {
      type: "object",
      properties: { grantId: { type: "string", description: "The grant record id." } },
      required: ["grantId"],
    },
    async handler(args = {}) {
      const record = findGrant(args.grantId);
      if (!record) return { found: false, grantId: args.grantId };
      return { found: true, grantId: args.grantId, ...verifyGrant(record) };
    },
  },
];

export default { GRANTS_TOOLS };
