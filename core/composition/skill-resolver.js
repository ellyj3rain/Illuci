// core/composition/skill-resolver.js
// Loads skill definitions from the source/runtime skill registry.

/**
 * Load a skill definition by ID.
 *
 * @param {string} skillId
 * @returns {Promise<object>} { skillId, instructions, tools, traits }
 */
export async function loadSkill(skillId) {
  try {
    const { getSkill } = await import("../skills/registry.js");
    const registered = getSkill(skillId);
    if (registered) {
      return {
        skillId: registered.name,
        instructions: registered.prompt || registered.description || "",
        tools: registered.tools || [],
        traits: registered.traits || {},
      };
    }
  } catch {}

  return { skillId, instructions: "", tools: [], traits: {} };
}

export function applySkillInstructions(skill, systemPrompt) {
  if (!skill?.instructions) return systemPrompt;
  return `${systemPrompt}\n\n[Skill: ${skill.skillId}]\n${skill.instructions}`;
}

export function getSkillTools(skill) {
  return skill?.tools || [];
}

export function getSkillDispositionBias(skill) {
  return skill?.traits || {};
}
