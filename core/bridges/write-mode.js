// CLI-agent lane auto-approve discipline (DR-204; [A117]) — the fail-closed half
// of the per-lane tool-flag layer ([A115] jailed grok's filesystem; this closes
// the APPROVAL posture on the lanes that inverted it).
//
// The convention (set by grok-cli.js at [A46], made law here): a bridge may pass
// its CLI's auto-approve flag (--yolo / --approval-mode=yolo / --always-approve)
// ONLY when the caller explicitly set `writeMode: true`. Every other value —
// absent, undefined, null, false, or garbage — is GATED. Fail closed.
//
// Why (F-144): gemini.js and kimi.js shipped the INVERTED test
// (`options.writeMode !== false`), so any caller that never thought about
// writeMode — `illuci chat`, bare API dispatch — spawned a full agentic host with
// ALL tool executions auto-approved. The topology runner and MCP dispatch always
// set writeMode explicitly (write/execute/delegate phases true; respond/read
// phases false; MCP postures via postureWriteMode), so the inversion's blast
// radius was exactly the callers that never opted into anything.
//
// One helper, every CLI-agent bridge: the A99 lesson — one shared resolver means
// the surfaces cannot drift apart again. claude.js needs no flag discipline (it
// is allowlist-shaped: `--allowedTools Read,Glob,Grep` unless the caller widens)
// and codex.js threads its own sandboxMode; both are covered by the guard test's
// no-inversion sweep.

/**
 * True iff the caller EXPLICITLY opted this dispatch into auto-approved tool
 * execution. Anything short of literal `true` is gated.
 * @param {object} [options] — dispatch options (reads `writeMode`)
 * @returns {boolean}
 */
export function autoApproveEnabled(options = {}) {
  return options.writeMode === true;
}

export default { autoApproveEnabled };
