/**
 * illuci — Gate Registry
 *
 * Classification rules for which actions require gating.
 * Determines the gate level for each tool action.
 */

import { GATE_LEVELS } from './gate-types.js';

/**
 * Pattern-based gate classification rules
 * Ordered by priority - first match wins
 */
const GATE_RULES = [
  // Read-only operations - no gate
  { pattern: /^file_read$/, level: GATE_LEVELS.NONE },
  { pattern: /^search$/, level: GATE_LEVELS.NONE },
  { pattern: /^glob$/, level: GATE_LEVELS.NONE },
  { pattern: /^git_log$/, level: GATE_LEVELS.NONE },
  { pattern: /^git_diff$/, level: GATE_LEVELS.NONE },
  { pattern: /^git_status$/, level: GATE_LEVELS.NONE },
  { pattern: /^git_branch$/, level: GATE_LEVELS.NONE },

  // File mutations - full gate
  { pattern: /^file_(write|edit|delete|move|rename)$/, level: GATE_LEVELS.FULL },

  // Shell commands - classified by safety
  { pattern: /^shell_exec$/, classify: classifyShellCommand },

  // Git dangerous operations - escalated
  { pattern: /^git_(push|force_push|reset)$/, level: GATE_LEVELS.ESCALATED },

  // Git safe operations - full gate
  { pattern: /^git_(add|commit)$/, level: GATE_LEVELS.FULL },

  // OS control — ALL spatial/hardware/system tools require ESCALATED
  { pattern: /^mouse_(move|click|position)$/, level: GATE_LEVELS.ESCALATED },
  { pattern: /^key_(type|press|combo)$/, level: GATE_LEVELS.ESCALATED },
  { pattern: /^screenshot$/, level: GATE_LEVELS.ESCALATED },
  { pattern: /^screen_info$/, level: GATE_LEVELS.NONE }, // read-only, no gate
  { pattern: /^volume_(set|get|mute)$/, level: GATE_LEVELS.ESCALATED },
  { pattern: /^window_(list)$/, level: GATE_LEVELS.NONE }, // read-only
  { pattern: /^window_focus$/, level: GATE_LEVELS.ESCALATED },
  { pattern: /^process_launch$/, level: GATE_LEVELS.ESCALATED },
  { pattern: /^process_kill$/, level: GATE_LEVELS.ESCALATED },
  { pattern: /^process_list$/, level: GATE_LEVELS.NONE }, // read-only
  { pattern: /^system_info$/, level: GATE_LEVELS.NONE }, // read-only
  { pattern: /^clipboard_(get|set)$/, level: GATE_LEVELS.ESCALATED },

  // Web — http_fetch and browse_page
  { pattern: /^http_fetch$/, level: GATE_LEVELS.FULL },
  { pattern: /^browse_page$/, level: GATE_LEVELS.FULL },

  // UE5 MCP — read-only operations no gate
  { pattern: /^ue5_(check|get_actors|find_actors|get_properties|find_nodes|focus_viewport|screenshot)$/, level: GATE_LEVELS.NONE },
  // UE5 MCP — mutation operations require full gate
  { pattern: /^ue5_(spawn_actor|set_transform|set_property|create_blueprint|add_component|compile_blueprint|set_blueprint_property|spawn_blueprint_actor|add_event_node|add_function_node|connect_nodes|add_variable|create_widget|add_widget_to_viewport|create_input_mapping)$/, level: GATE_LEVELS.FULL },
  // UE5 MCP — destructive operations require escalated gate
  { pattern: /^ue5_delete_actor$/, level: GATE_LEVELS.ESCALATED },
];

/**
 * Safe command patterns (read-only / informational)
 * @readonly
 */
const SAFE_COMMANDS = [
  /^ls\s/,
  /^cat\s/,
  /^head\s/,
  /^tail\s/,
  /^grep\s/,
  /^rg\s/,
  /^find\s/,
  /^git\s+(log|diff|status|branch|show)/,
  /^echo\s/,
  /^pwd$/,
  /^which\s/,
  /^where\s/,
  /^dir$/,
  /^type\s/,
];

/**
 * Dangerous command patterns (destructive / irreversible)
 * @readonly
 */
const DANGEROUS_COMMANDS = [
  /^rm\s+/,
  /^rmdir\s+/,
  /^mv\s+/,
  /^cp\s+/,
  /^chmod\s+/,
  /^chown\s+/,
  /^git\s+push/,
  /^git\s+force-push/,
  /^git\s+reset/,
  /^git\s+checkout\s+--/,
  /^git\s+clean/,
  /^git\s+revert/,
  /^npm\s+(publish|unpublish|deprecate)/,
  /^curl\s+.*-X\s*(POST|PUT|DELETE)/,
  /^(sudo|doas)\s/,
  />\s*\/dev\/null/,
  /2>&1\s*>/,
];

/**
 * Classify a shell command by its danger level
 * @param {string} command - The shell command to classify
 * @returns {string} GATE_LEVELS value
 */
function classifyShellCommand(command) {
  if (!command || typeof command !== 'string') {
    return GATE_LEVELS.FULL; // Unknown = gate it
  }

  const trimmed = command.trim();

  // Check for obviously safe commands
  if (SAFE_COMMANDS.some(rx => rx.test(trimmed))) {
    return GATE_LEVELS.NONE;
  }

  // Check for dangerous commands
  if (DANGEROUS_COMMANDS.some(rx => rx.test(trimmed))) {
    return GATE_LEVELS.ESCALATED;
  }

  // Default: unknown commands get full gating
  return GATE_LEVELS.FULL;
}

/**
 * Determine if an action requires gating and at what level
 * @param {string} action - The action type (e.g., 'file_write', 'shell_exec')
 * @param {Object} params - Additional parameters (e.g., { command: 'rm -rf /' })
 * @returns {string} GATE_LEVELS value
 */
export function requiresGate(action, params = {}) {
  for (const rule of GATE_RULES) {
    if (!rule.pattern.test(action)) {
      continue;
    }

    if (rule.classify) {
      return rule.classify(params.command);
    }

    return rule.level;
  }

  // Unknown actions default to full gating
  return GATE_LEVELS.FULL;
}

/**
 * Check if an action requires gating (convenience method)
 * @param {string} action - The action type
 * @param {Object} params - Additional parameters
 * @returns {boolean}
 */
export function isGated(action, params = {}) {
  const level = requiresGate(action, params);
  return level !== GATE_LEVELS.NONE;
}

/**
 * Get the list of all gated action patterns
 * @returns {Array<{pattern: string, level: string}>}
 */
export function getGatedActions() {
  return GATE_RULES
    .filter(r => !r.classify && r.level !== GATE_LEVELS.NONE)
    .map(r => ({ pattern: r.pattern.source, level: r.level }));
}

/**
 * Operator override configuration
 * Allows experienced operators to configure trust levels per-project
 */
export class GateConfig {
  constructor(config = {}) {
    this.defaultLevel = config.defaultLevel || GATE_LEVELS.FULL;
    this.overrides = config.overrides || {};
    this.trustedAgents = config.trustedAgents || [];
    this.trustedPaths = config.trustedPaths || [];
    this.sessionEscalation = config.sessionEscalation || false;
  }

  /**
   * Check if an agent is trusted
   * @param {string} agentId
   * @returns {boolean}
   */
  isAgentTrusted(agentId) {
    return this.trustedAgents.includes(agentId);
  }

  /**
   * Check if a path matches trusted patterns
   * @param {string} filePath
   * @returns {boolean}
   */
  isPathTrusted(filePath) {
    // Simple glob matching - could be enhanced with minimatch
    return this.trustedPaths.some(pattern => {
      if (pattern.includes('*')) {
        const regex = new RegExp('^' + pattern.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*') + '$');
        return regex.test(filePath);
      }
      return filePath.includes(pattern);
    });
  }

  /**
   * Get the effective gate level for an action
   * @param {string} action
   * @param {Object} params
   * @param {string} agentId
   * @returns {string}
   */
  getEffectiveLevel(action, params = {}, agentId = null) {
    // Trusted agents bypass gates
    if (agentId && this.isAgentTrusted(agentId)) {
      return GATE_LEVELS.NONE;
    }

    // Check for action-level override
    if (this.overrides[action]) {
      return this.overrides[action];
    }

    // Check for path-based trust
    if (params.filePath && this.isPathTrusted(params.filePath)) {
      return GATE_LEVELS.NONE;
    }

    // Fall back to registry classification
    return requiresGate(action, params);
  }
}

export default {
  requiresGate,
  isGated,
  getGatedActions,
  GateConfig,
  GATE_LEVELS,
};
