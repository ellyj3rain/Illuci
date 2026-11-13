// core/formation/cost-model.js

import { getTopology } from '../topologies/index.js';
import { inferComplexity } from './engine.js';

/**
 * Calculates a heuristic cost for a given topology and task.
 * This is a simplified model for initial formation optimization.
 *
 * @param {string} topologyId - The ID of the topology.
 * @param {string} task - The natural language task description.
 * @returns {number} The estimated cost.
 */
export function calculateTopologyCost(topologyId, task) {


  const topology = getTopology(topologyId);

  // Base cost from topology structure
  let seatCapacity = 0;
  for (const seat of topology.seats) {
    seatCapacity += seat.max; // Use max to represent potential concurrent model usage
  }

  // Each phase represents a step, adding to cost
  const phaseCount = topology.phases.length;

  let baseCost = seatCapacity * phaseCount;

  // Adjust cost based on task complexity
  const complexity = inferComplexity(task); // Re-using existing complexity inference
  let complexityFactor = 1.0;
  if (complexity === 'low') {
    complexityFactor = 0.8;
  } else if (complexity === 'high') {
    complexityFactor = 1.5;
  }

  return baseCost * complexityFactor;
}

/**
 * Compares two topologies by their calculated cost for a given task.
 * Useful for sorting or selecting the cheaper option.
 *
 * @param {string} topologyIdA - ID of the first topology.
 * @param {string} topologyIdB - ID of the second topology.
 * @param {string} task - The natural language task description.
 * @returns {number} A negative value if A is cheaper, positive if B is cheaper, 0 if equal.
 */
export function compareTopologiesByCost(topologyIdA, topologyIdB, task) {
  const costA = calculateTopologyCost(topologyIdA, task);
  const costB = calculateTopologyCost(topologyIdB, task);
  return costA - costB;
}

export default { calculateTopologyCost, compareTopologiesByCost };
