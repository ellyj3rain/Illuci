// core/mcp/genome-tools.js
//
// [A88] The persona-genome read verbs on the MCP surface — the shipped
// learning loop's first host-facing window (DR-181). Thin read-only wrappers
// over the persona-memory readers: status is the raw validated HEAD
// projection ([A80] genomeStatus — cheap, uncompensated counters), profile is
// the canonical live read ([A87] readLiveProfile — the fold, crashed-seal
// window compensated; readers compensate, never write). The read law: a read
// verb NEVER births a genome — the preset stays out of the contract, so the
// lazy-genesis path is unreachable from here by construction. Both verbs are
// read-shaped (requiredActions: [], the grants idiom) and take an EXPLICIT
// projectDir (the dispatchOpts.genome.projectDir coordinate — never cwd- or
// env-derived; the deployed runtime must not ground reads in its own
// checkout). Also reachable as REST verbs (/runtime/genome/*) through the
// [A22.8] canonical-API map — MCP == API, one contract.

import { genomeStatus, readLiveProfile } from "../agents/persona-memory.js";

function requireString(value, verb, field) {
  if (!value || typeof value !== "string") {
    throw new Error(`${verb}: ${field} (string) is required`);
  }
}

export const GENOME_TOOLS = [
  {
    name: "genome_status_v1",
    schema_version: "1.0.0",
    description:
      "Read-only persona-genome status: the validated HEAD projection (baseRef, raw " +
      "activeLedgerLen, last-seal marks) for the genome at " +
      "<projectDir>/.illuci/data/memory/personas/<slug>. Returns { exists: false } when no " +
      "genome has been born — a read verb never triggers genesis.",
    requiredActions: [],
    inputSchema: {
      type: "object",
      properties: {
        projectDir: {
          type: "string",
          description: "The genome's project directory (the dispatchOpts.genome.projectDir coordinate; explicit, never cwd-derived).",
        },
        slug: { type: "string", description: "The persona agentSlug (sanitized: lowercase [a-z0-9-], max 64 chars)." },
      },
      required: ["projectDir", "slug"],
    },
    async handler(args = {}) {
      requireString(args.projectDir, "genome_status_v1", "projectDir");
      requireString(args.slug, "genome_status_v1", "slug");
      return { projectDir: args.projectDir, slug: args.slug, ...genomeStatus(args.projectDir, args.slug) };
    },
  },
  {
    name: "genome_profile_v1",
    schema_version: "1.0.0",
    description:
      "Read-only persona-genome live profile: the canonical fold (current base + unsealed " +
      "ledger) via readLiveProfile — crashed-seal-window compensated (DR-180: readers " +
      "compensate, never write). Carries the unsealed ledger with its run provenance. " +
      "Returns { exists: false } when no genome has been born — a read verb never triggers " +
      "genesis (the preset is not part of this contract).",
    requiredActions: [],
    inputSchema: {
      type: "object",
      properties: {
        projectDir: {
          type: "string",
          description: "The genome's project directory (the dispatchOpts.genome.projectDir coordinate; explicit, never cwd-derived).",
        },
        slug: { type: "string", description: "The persona agentSlug (sanitized: lowercase [a-z0-9-], max 64 chars)." },
      },
      required: ["projectDir", "slug"],
    },
    async handler(args = {}) {
      requireString(args.projectDir, "genome_profile_v1", "projectDir");
      requireString(args.slug, "genome_profile_v1", "slug");
      const status = genomeStatus(args.projectDir, args.slug);
      if (!status.exists) {
        return { projectDir: args.projectDir, slug: args.slug, exists: false };
      }
      // The genome exists, so loadIdentity inside readLiveProfile takes the
      // READ branch and the (absent) preset is never consulted — a pure read.
      const live = readLiveProfile(args.projectDir, args.slug);
      return {
        projectDir: args.projectDir,
        slug: args.slug,
        exists: true,
        profile: live.profile,
        ledger: live.ledger,
        baseRef: live.baseRef,
        activeLedgerLen: live.activeLedgerLen,
        compensated: live.compensated,
      };
    },
  },
];

export default { GENOME_TOOLS };
