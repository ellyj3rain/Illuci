/** Public Agent SDK. One streaming run surface supports direct and council execution.
 * See README.md and docs/architecture.md for the delivered interfaces and ownership.
 */

export { run } from "./run.js";
export { AGENT_EVENT_TYPES, agentEvent } from "./events.js";

// Internal surfaces — exported for consumers that compose at a lower level
// (and for the test harness). Not the primary API.
export { runSingleAgent } from "./loop.js";
export { runCouncil } from "./council.js";
export { EventStream } from "./stream.js";
export { parseToolCalls, buildToolInstructions } from "./tool-protocol.js";
export { withPermissionChannel } from "./permission.js";

import { run } from "./run.js";
export default { run };
