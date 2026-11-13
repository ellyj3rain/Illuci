// core/composition/role-resolver.js
// MODEL-PROPOSED: investigator-v1
// Manages role definitions and resolution, abstracting from the capability matrix.
//
// Diagnostic posture ([A112]/WO-S9, Rosa's ruling): ILLUCI_DEBUG-gated stderr.
// stdout on a machine surface is the payload and nothing else, so the
// diagnostic can never live there; and a per-resolution log line is firehose
// noise for an operator debugging a dead run (resolution facts already ride
// the run telemetry), so it is silent by default and opts in via ILLUCI_DEBUG —
// the config-service precedent. Even the opted-in channel is stderr, so the
// debug mode itself can never poison --json output.

import { MODEL_CAPABILITIES, isAvailable } from '../matrix/capability-matrix.js';

export async function resolveRole(roleId) {
    if (process.env.ILLUCI_DEBUG) {
        console.error(`[role-resolver] Resolving role: ${roleId}`);
    }

    const resolvedCandidates = [];
    for (const [model, capabilities] of Object.entries(MODEL_CAPABILITIES)) {
        const cap = capabilities[roleId];
        if (!cap) continue; // Model does not have this role
        if (!isAvailable(model)) continue; // Model is not currently available

        resolvedCandidates.push({
            modelId: model,
            priority: cap.priority,
            description: `Role: ${roleId} for model: ${model}`, // Placeholder, can be more detailed
            requiredSkills: [], // Not yet derived from capability matrix
            dispositionBias: {},
            concurrent: cap.concurrent,
        });
    }

    // Sort by priority (lower number = higher priority)
    resolvedCandidates.sort((a, b) => a.priority - b.priority);

    // For now, return the best candidate as the resolved "role" object
    // This will evolve when the dynamic team formation engine is implemented
    if (resolvedCandidates.length > 0) {
        const bestCandidate = resolvedCandidates[0];
        return {
            roleId: roleId,
            description: bestCandidate.description,
            requiredSkills: bestCandidate.requiredSkills,
            dispositionBias: bestCandidate.dispositionBias,
            candidates: resolvedCandidates
        };
    }

    return null; // Role not found or no available models
}

export function getRoleDispositionBias(role) {
    return role?.dispositionBias || {};
}

export function getRoleRequiredSkills(role) {
    return role?.requiredSkills || [];
}
