// core/composition/composer.js
// MODEL-PROPOSED: investigator-v1
// Unified entry point for composing agent configurations.

import { loadSkill, applySkillInstructions, getSkillTools } from './skill-resolver.js';
import { resolveRole, getRoleRequiredSkills } from './role-resolver.js';
import { getSpecialistRolePreamble } from '../roles/specialists/preamble.js';
import * as contextManager from '../context/manager.js';
import { getContextWindow } from '../context/manager.js';

export async function compose(modelId, seatDef = {}, taskContext = {}) {
    let systemPrompt = '';
    let tools = [];

    // 0. Specialist role preamble. Specialist profiles are role substrate:
    // concise role metadata plus linked knowledge references.
    const specialistSlug = seatDef.specialistSlug || null;
    if (specialistSlug) {
        const specialist = await getSpecialistRolePreamble(specialistSlug, {
            includeLegacyProfileBody: false,
        });
        if (specialist) {
            systemPrompt += `${specialist}\n\n`;
        }
    }

    // 1. Resolve Role
    if (seatDef.roleId) {
        const role = await resolveRole(seatDef.roleId);
        if (!role) {
            // Role not found or no available models — continue without role-specific config
            return compose(modelId, { ...seatDef, roleId: null }, taskContext);
        }
        const requiredSkills = getRoleRequiredSkills(role);
        // Automatically add required skills
        for (const skillId of requiredSkills) {
            const skill = await loadSkill(skillId);
            systemPrompt = applySkillInstructions(skill, systemPrompt);
            tools.push(...getSkillTools(skill));
        }
    }

    // 2. Load and Apply Explicit Skills
    if (seatDef.skills && Array.isArray(seatDef.skills)) {
        for (const skillId of seatDef.skills) {
            const skill = await loadSkill(skillId);
            systemPrompt = applySkillInstructions(skill, systemPrompt);
            tools.push(...getSkillTools(skill));
        }
    }

    // 3. Context View (reuse existing contextManager)
    const contextView = contextManager.buildView(
        taskContext.projectId,
        modelId,
        {
            task: taskContext.message,
            taskTokens: taskContext.taskTokens,
            relevantArtifacts: taskContext.relevantArtifacts,
            includeIdentity: true,
            includePeers: true, // Assuming peer awareness is always desired in composition
            peerIds: taskContext.peerIds,
            historyDepth: taskContext.historyDepth,
            skipContext: taskContext.skipContext, // Pass skipContext option
        }
    );

    // 4. Constraints
    const constraints = {
        tokenBudget: getContextWindow(modelId) - contextView.tokensUsed - (taskContext.taskTokens || 0),
        // Add other constraints like gate levels, etc. from seatDef or global config
    };

    return {
        systemPrompt: systemPrompt,
        tools: [...new Set(tools)], // Deduplicate tools
        contextView: contextView,
        constraints: constraints,
    };
}
