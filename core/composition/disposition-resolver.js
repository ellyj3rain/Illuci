/**
 * Illuci - Disposition Resolver
 *
 * Resolves the [Behavioral Disposition] block for a model seated in a topology.
 * Active input is `seatDispositions`: preset/profile plus optional role and skills.
 *
 * @module core/composition/disposition-resolver
 */

import { injectDimensional, summarizeActivations } from "./dimensional-engine.js";
import { DISPOSITION_PRESETS } from "../agents/disposition-presets.js";
import { isValidProfile } from "../agents/disposition-dimensions.js";
import { composeDispositionForRoleIntent } from "./role-composition.js";
import { deriveIdentity } from "../agents/disposition-identity.js";
import { readLiveProfile } from "../agents/persona-memory.js";
import { normalizeChildIdentity, deriveChildSlug } from "../orchestrate/child-identity.js";

const RETIRED_DISPOSITION_KEYS = Object.freeze([
  "personalityTypeId",
  "pathologicalProfiles",
  "qualitativeTraits",
  "roleBias",
  "operatorSet",
  "bigFive",
  "darkTriad",
  "enneagram",
]);

/**
 * Compose the [Behavioral Disposition] block for a seat.
 *
 * @param {Object} args
 * @param {string} args.modelId - model filling this seat
 * @param {string} args.seatId - topology seat id
 * @param {string} [args.agentId] - stable agent id for repeated seats
 * @param {Object} args.seatDef - topology seat definition
 * @param {Object} args.dispatchOpts - run options carrying seatDispositions
 * @returns {Promise<{block: string, engine: string, audit: Array, meta: Object}>}
 */
export async function composeBehavioralDisposition({ modelId, seatId, agentId = null, seatDef = {}, dispatchOpts = {} }) {
  const seatConfig = dispatchOpts?.seatDispositions?.[seatId];
  const agentConfig = agentId ? dispatchOpts?.agentDispositions?.[agentId] : null;
  const nodeConfig = seatConfig || agentConfig;
  if (process.env.ILLUCI_DEBUG_DISPOSITION) {
    console.error(`[disposition-debug] seat=${seatId} has-presetId=${!!nodeConfig?.presetId} keys=${nodeConfig ? Object.keys(nodeConfig).join(",") : "<none>"}`);
  }

  assertNoRetiredDispositionKeys(nodeConfig, `seat "${seatId}"`);
  assertNoRetiredDispositionKeys(seatDef, `seat definition "${seatId}"`);

  // A80/DR-173 (DR-170 Phase A3): the persona-genome joins composition ONLY on
  // the explicit control — dispatchOpts.genome = { projectDir, precedence? } —
  // AND a durable agent identity. Absent either, composition is byte-identical
  // to pre-A80. Fail-closed: asking for the genome without a projectDir is a
  // loud error, not a silent skip.
  let genomeCtx = null;
  if (dispatchOpts?.genome && agentId) {
    const { projectDir, precedence = "seed" } = dispatchOpts.genome;
    if (!projectDir || typeof projectDir !== "string") {
      throw new Error(
        `disposition-resolver: dispatchOpts.genome requires a projectDir (seat "${seatId}", agent "${agentId}")`,
      );
    }
    // [A92]/DR-185 (DR-182 Phase 3): the `derive` state — a CHILD run
    // (parentRunId present) mints a DERIVED persona per seated agent:
    // `<parentAgentId>-<childSeatId>`, its genome born from the parent
    // persona's live compensated profile (below). A ROOT run armed `derive`
    // seats the agent underived — derivation is a property of children.
    if (normalizeChildIdentity(dispatchOpts.genome) === "derive" && dispatchOpts?.parentRunId) {
      genomeCtx = {
        projectDir,
        precedence,
        slug: deriveChildSlug(agentId, seatId),
        deriveFrom: agentId,
        spawnCoordinate: {
          runId: dispatchOpts?.runId ?? null,
          parentRunId: dispatchOpts?.parentRunId ?? null,
          seatId,
          topologyId: dispatchOpts?.topologyId ?? null,
        },
      };
    } else {
      genomeCtx = { projectDir, precedence, slug: agentId };
    }
  }

  if (nodeConfig?.presetId || nodeConfig?.profile) {
    return composeDimensional({ seatId, nodeConfig, genomeCtx });
  }

  if (seatDef?.presetId || seatDef?.profile) {
    return composeDimensional({
      seatId,
      nodeConfig: {
        presetId: seatDef.presetId,
        profile: seatDef.profile,
      },
      genomeCtx,
    });
  }

  return emptyResult("none");
}

function composeDimensional({ seatId, nodeConfig, genomeCtx = null }) {
  if (nodeConfig.presetId) {
    const requestedRoleId = nodeConfig.role || null;
    const skillIds = nodeConfig.skills || [];

    // A80: resolve the genome for this persona (lazy genesis on first touch),
    // fold its live profile, and hand composition the pure algebra inputs.
    // Loud on failure — the operator explicitly asked for the genome.
    let genomeOptions = {};
    let genomeMeta = null;
    if (genomeCtx) {
      const preset = DISPOSITION_PRESETS[nodeConfig.presetId];
      if (!preset) throw new Error(`disposition-resolver: unknown preset "${nodeConfig.presetId}" for genome genesis`);
      // A87/DR-180: ONE canonical read — lazy genesis + fold, with reader-side
      // compensation for the crashed-seal window (no double-apply, no write).
      // [A92]/DR-185: under `derive`, the child persona's genesis seeds from
      // the PARENT persona's live compensated profile (D5.5) — read the parent
      // first (its genome exists from the parent run's own composition; the
      // preset covers the cold path), then birth the derived slug from a
      // synthetic preset carrying that profile, with genealogy staged INTO the
      // atomic genesis (lineage is born with the genome, never written after).
      let live;
      if (genomeCtx.deriveFrom) {
        const parentLive = readLiveProfile(genomeCtx.projectDir, genomeCtx.deriveFrom, { preset });
        live = readLiveProfile(genomeCtx.projectDir, genomeCtx.slug, {
          preset: { profile: parentLive.profile },
          genealogy: {
            parentSlug: genomeCtx.deriveFrom,
            parentBaseRef: parentLive.baseRef,
            parentActiveLedgerLen: parentLive.activeLedgerLen,
            spawn: genomeCtx.spawnCoordinate,
          },
        });
      } else {
        live = readLiveProfile(genomeCtx.projectDir, genomeCtx.slug, { preset });
      }
      genomeOptions = { genome: { liveProfile: live.profile, ledger: live.ledger, precedence: genomeCtx.precedence } };
      genomeMeta = {
        slug: genomeCtx.slug,
        precedence: genomeCtx.precedence,
        baseRef: live.baseRef,
        activeLedgerLen: live.activeLedgerLen,
        ...(genomeCtx.deriveFrom ? { derivedFrom: genomeCtx.deriveFrom } : {}),
      };
    }

    const { composed, role } = composeDispositionForRoleIntent(
      nodeConfig.presetId, requestedRoleId, skillIds, genomeOptions,
    );
    const block = `[Behavioral Disposition]\n${composed.directive}`;
    const activations = summarizeActivations(composed.profile);

    return {
      block,
      engine: "dimensional",
      audit: [{ source: "composition", directive: "Composed Disposition Directive" }],
      meta: {
        presetId: nodeConfig.presetId,
        ...(genomeMeta ? { genome: genomeMeta } : {}),
        // A76/DR-169: composed identity ({base preset, composed post-pull} slug + fingerprint)
        // for run provenance — which disposition actually drove this seat.
        identity: composed.identity
          ? {
              base: composed.identity.base,
              composed: { slug: composed.identity.composed.slug, fingerprint: composed.identity.composed.fingerprint },
            }
          : null,
        role: role.requestedRoleId,
        matrixRole: role.matrixRoleId,
        compositionRole: role.compositionRoleId,
        compositionRoleSource: role.source,
        skills: skillIds,
        activeFacets: activations.facets.length,
        activeDarkTriad: activations.darkTriad.length,
        activePid5: activations.pid5.length,
        activeValues: activations.values.length,
        enneagramCore: activations.enneagram,
        directiveCount: 1,
      },
    };
  }

  if (nodeConfig.profile) {
    if (!isValidProfile(nodeConfig.profile)) {
      throw new Error(`Invalid inline profile for seat "${seatId}" - failed schema validation`);
    }
    const profile = nodeConfig.profile;
    const { prompt, audit } = injectDimensional("", profile, { audit: true });
    const block = prompt.replace(/^\n+/, "");
    const activations = summarizeActivations(profile);
    const inlineIdentity = deriveIdentity(profile); // A76/DR-169: fingerprint for run provenance (no base preset)

    return {
      block,
      engine: "dimensional",
      audit,
      // A80: hand the inline profile to the runner's grader seam (A78 skipped
      // preset-less seats — they have an identity but no preset to resolve the
      // tension lens from). NOT part of meta: telemetry meta stays compact.
      graderProfile: profile,
      meta: {
        presetId: null,
        identity: { base: null, composed: { slug: inlineIdentity.slug, fingerprint: inlineIdentity.fingerprint } },
        activeFacets: activations.facets.length,
        activeDarkTriad: activations.darkTriad.length,
        activePid5: activations.pid5.length,
        activeValues: activations.values.length,
        enneagramCore: activations.enneagram,
        directiveCount: audit.length,
      },
    };
  }

  return emptyResult("none");
}

function assertNoRetiredDispositionKeys(config, label) {
  if (!config || typeof config !== "object") return;
  const retired = RETIRED_DISPOSITION_KEYS.filter((key) => config[key] !== undefined);
  if (retired.length) {
    throw new Error(`${label} uses retired disposition key(s): ${retired.join(", ")}`);
  }
}

function emptyResult(engine) {
  return { block: "", engine, audit: [], meta: {} };
}

/**
 * Assemble seat assignment metadata for visualizers from active disposition configs.
 *
 * @param {Object.<string, Object>} seatDispositions
 * @returns {Object.<string, Object>} seat id to summary
 */
export function buildSeatAssignments(seatDispositions) {
  if (!seatDispositions) return null;
  const out = {};
  for (const [seatId, config] of Object.entries(seatDispositions)) {
    assertNoRetiredDispositionKeys(config, `seat "${seatId}"`);
    if (config.presetId) {
      const preset = DISPOSITION_PRESETS[config.presetId];
      out[seatId] = {
        engine: "dimensional",
        presetId: config.presetId,
        enneagramCore: preset?.profile?.enneagram?.core || null,
        activations: preset ? summarizeActivations(preset.profile) : null,
      };
    } else if (config.profile) {
      out[seatId] = {
        engine: "dimensional",
        inline: true,
        enneagramCore: config.profile.enneagram?.core || null,
        activations: summarizeActivations(config.profile),
      };
    } else {
      out[seatId] = {
        engine: "dimensional",
        presetId: null,
        role: config.role || null,
        skills: Array.isArray(config.skills) ? [...config.skills] : [],
      };
    }
  }
  return out;
}
