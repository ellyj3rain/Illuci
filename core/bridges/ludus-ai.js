/**
 * illuci — Ludus AI Bridge (DEPRECATED)
 *
 * Ludus AI credits stripped after auto-renewal cancellation.
 * Cloud endpoint (mcp.ludusengine.com) is dead.
 *
 * UE5 editor tools are now provided by core/tools/unreal-mcp.js
 * as a contingent tool layer (chongdashu/unreal-mcp, TCP on 55557).
 * Any seated model can invoke UE5 tools — Ludus is no longer a model.
 *
 * This file exists only as a tombstone. If anything still references
 * "ludus-ai" as a model bridge, this will throw a clear error.
 */

export async function query() {
  throw new Error(
    "ludus-ai bridge is dead — credits stripped. " +
    "UE5 tools are now in core/tools/unreal-mcp.js (contingent tool layer). " +
    "Remove ludus-ai from your lineup and use any model with UE5 tools."
  );
}

export default { query };
