/** MCP prompt/resource/tool handlers and stdio JSON-RPC transport over the engine.
 * Operations retain the host's permission context and actual runtime/source checks.
 * Ground Zero supplies independently adopted methods; this project owns enforcement.
 */

// ─────────────────────────────────────────────────────────────────────────
// IMPORTS — local module-internal only at v0.1
// ─────────────────────────────────────────────────────────────────────────

import { SCHEMA_REGISTRY, registerSchema, getSchema } from './schema-registry.js';
import { auditWrap, auditBoundary, AuditWriteError } from './audit-wrapper.js';
import { GOVERNANCE_PREAMBLE_PROMPT } from './governance-prompt.js';
import { DECISION_LOG_RESOURCE } from './decision-log-resource.js';
import { DATASTORE_RESOURCE } from './datastore-resource.js';
import { RUNTIME_RESOURCES } from './runtime-resource.js';
import { ALLOCATION_RESOURCES } from './allocation-resource.js';
import { MOUSECAT_BRIDGE_RESOURCE } from './mousecat-bridge-resource.js';
import { COMPOSITION_TOOLS } from './composition-tools.js';
import { FORMATION_TOOLS } from './formation-tools.js';
import { ANALYSIS_TOOLS } from './analysis-tools.js';
import { DISPATCH_TOOLS } from './dispatch-tools.js';
import { WRITE_TOOLS } from './write-tools.js';
import { INTENT_TOOLS } from './intent-tools.js';
import { CRUCIBLE_TOOLS } from './crucible-tools.js';
import { GRANTS_TOOLS } from './grants-tools.js';
import { GENOME_TOOLS } from './genome-tools.js';
import { PRESET_TOOLS } from './preset-tools.js';
import { DATASTORE_TOOLS } from './datastore-tools.js';
import { CAPABILITY_MATRIX_RESOURCE } from './matrix-resource.js';
import { CAPABILITY_CARD_RESOURCE } from './surface-resource.js';
import { resolveRoleContext, filterToolsByRoleContext, assertMcpToolExposed } from './permission-context.js';
import { assertWorkPermit, isWorkPermitRequired } from '../governance/work-permit.js';
import {
  createMcpRuntimeGuard,
  describeRuntimeDelta,
  isMcpRuntimeStaleError,
} from './runtime-guard.js';
import { assertServeGrounding } from '../runtime/grounding.js';
import { pathToFileURL } from 'node:url';
import {
  surfaceServerName,
  surfaceLogTag,
  surfaceTenantId,
  scrub,
  isEonSurface,
} from '../identity/surface.js';


// ─────────────────────────────────────────────────────────────────────────
// SERVER METADATA
// ─────────────────────────────────────────────────────────────────────────

const SERVER_INFO = {
  name: surfaceServerName(),
  version: '0.3.0', // server impl version; distinct from per-schema versions
  description: scrub(
    'GZDS illuci-side MCP-boundary server. Tier-1 surface: governance preamble ' +
    '(prompt); decision log (resource); composition ' +
    'resolvers (tools).',
  ),
  // Internal source / discipline / sibling paths surface in internal mode only.
  ...(isEonSurface()
    ? {}
    : {
        source: 'illuci/core/mcp/server.js',
        discipline: 'constitutional/BILL_OF_STANDARDS.md (Standard 16) v1.0.0',
        sibling: 'claude/system/mcp/',
      }),
};

function guardHandler(handler, runtimeGuard) {
  return async (request, context = {}) => {
    runtimeGuard.assertFresh();
    return handler(request, context);
  };
}

function staleErrorData(error) {
  return describeRuntimeDelta(error?.boot, error?.current);
}


// ─────────────────────────────────────────────────────────────────────────
// TIER-1 SURFACE REGISTRATION
// ─────────────────────────────────────────────────────────────────────────

function registerTier1Surface() {
  const reg = (entry) => {
    if (!getSchema(entry.name)) registerSchema(entry);
  };

  // Governance preamble prompt — sourced from illuci/core/governance/injector.js
  // via governance-prompt.js ([A63] / DR-073)
  reg({
    name: GOVERNANCE_PREAMBLE_PROMPT.name,
    schema_version: GOVERNANCE_PREAMBLE_PROMPT.schema_version,
    kind: 'prompt',
    definition: GOVERNANCE_PREAMBLE_PROMPT,
  });

  // Decision log resource — sourced from illuci/core/decisions/logger.js
  // via decision-log-resource.js ([A63] / DR-073). Read-only.
  reg({
    name: DECISION_LOG_RESOURCE.name,
    schema_version: DECISION_LOG_RESOURCE.schema_version,
    kind: 'resource',
    definition: DECISION_LOG_RESOURCE,
  });

  // Capability matrix as a Tier-1 resource ([A79] / DR-090) — static-data
  // snapshot (constitutional/10 lists the matrix as a resource, not a tool).
  reg({
    name: CAPABILITY_MATRIX_RESOURCE.name,
    schema_version: CAPABILITY_MATRIX_RESOURCE.schema_version,
    kind: 'resource',
    definition: CAPABILITY_MATRIX_RESOURCE,
  });

  // Capability card / surface-context probe — illuci self-describes to a host agent
  // (Claude/Codex/Grok/Cursor) or human over MCP. Read-only disclosure snapshot,
  // the MCP mirror of `illuci describe`.
  reg({
    name: CAPABILITY_CARD_RESOURCE.name,
    schema_version: CAPABILITY_CARD_RESOURCE.schema_version,
    kind: 'resource',
    definition: CAPABILITY_CARD_RESOURCE,
  });

  // Mousecat bridge contract ([A4.16.12] / DR-054) — public MCP contract
  // metadata for an OSS bridge consumer, not an export of private illuci logic.
  reg({
    name: MOUSECAT_BRIDGE_RESOURCE.name,
    schema_version: MOUSECAT_BRIDGE_RESOURCE.schema_version,
    kind: 'resource',
    definition: MOUSECAT_BRIDGE_RESOURCE,
  });

  // Datastore resource ([A19]) — illuci's unified event-sourced datastore, read-only.
  // Sync read verbs (records / by-run / graph-reach / health); the async + SQL surface
  // is the companion datastore_query_v1 tool.
  reg({
    name: DATASTORE_RESOURCE.name,
    schema_version: DATASTORE_RESOURCE.schema_version,
    kind: 'resource',
    definition: DATASTORE_RESOURCE,
  });

  // Runtime API resources ([A22.4]) - MCP mirrors the canonical runtime
  // identity/capability/doctor shapes instead of owning an isolated runtime view.
  for (const resource of RUNTIME_RESOURCES) {
    reg({
      name: resource.name,
      schema_version: resource.schema_version,
      kind: 'resource',
      definition: resource,
    });
  }

  // Engine allocation read-tier resources ([A54] / DR-134). These expose
  // warehouse nodes, orchestrator slots, activation/container policy catalogs,
  // allocation preview, and the disposition catalog without scheduling or
  // dispatch authority.
  for (const resource of ALLOCATION_RESOURCES) {
    reg({
      name: resource.name,
      schema_version: resource.schema_version,
      kind: 'resource',
      definition: resource,
    });
  }

  // Pure-function resolvers as Tier-1 tools — composition (role/skill/disposition) +
  // formation Phase A (complexity/team) + analysis (cost/calibration). Read-shaped
  // request→response; see constitutional/10 § Tier-1. Completed at [A80] / DR-091.
  // Plus the Promotion P-1 dispatch tools (dispatch_v1 / run_topology_v1, [A87] /
  // DR-095) — these are NOT read-shaped: they dispatch to the fleet, gated by a
  // permission posture above illuci's hard-deny floor (see dispatch-tools.js).
  // CRUCIBLE_TOOLS: the illuci-side binding of the cross-harness crucible decision-elicitation
  // discipline (crucible_classify_v1 read-shaped; crucible_elicit_v1 surfaces a decision through
  // illuci's operator-decision surface via ctx.elicit — the structural twin of AskUserQuestion). One
  // discipline (illuci/core/skills/crucible/crucible.discipline.js + the user-global SKILL.md), two
  // harness surfaces. Reachable from Claude through illuci_intent_v1 + the illuci-orchestration umbrella.
  // GENOME_TOOLS: [A88] read-only persona-genome status/profile — the learning
  // loop's host-facing window (readers compensate, never write; no genesis).
  for (const tool of [...COMPOSITION_TOOLS, ...FORMATION_TOOLS, ...ANALYSIS_TOOLS, ...DISPATCH_TOOLS, ...WRITE_TOOLS, ...INTENT_TOOLS, ...CRUCIBLE_TOOLS, ...PRESET_TOOLS, ...DATASTORE_TOOLS, ...GRANTS_TOOLS, ...GENOME_TOOLS]) {
    reg({
      name: tool.name,
      schema_version: tool.schema_version,
      kind: 'tool',
      definition: tool,
    });
  }
}


// ─────────────────────────────────────────────────────────────────────────
// MCP HANDLERS (stubs — full SDK wiring deferred)
// ─────────────────────────────────────────────────────────────────────────

/**
 * MCP `prompts/list` handler. Returns the catalog of registered prompts
 * with their schema versions for host capability negotiation.
 *
 * Wrapped with auditBoundary per the audit-integrity invariant.
 */
const handleListPrompts = auditBoundary('prompts/list', async (request) => {
  const prompts = Object.values(SCHEMA_REGISTRY)
    .filter((s) => s.kind === 'prompt')
    .map((s) => ({
      name: s.name,
      description: s.definition.description,
      schema_version: s.schema_version,
      arguments: s.definition.arguments || [],
    }));
  return { prompts };
});

/**
 * MCP `prompts/get` handler. Returns a specific prompt rendered with
 * supplied arguments. Carries schema_version in the response for client-
 * side version-pinning verification.
 *
 * Wrapped with auditBoundary per the audit-integrity invariant.
 */
const handleGetPrompt = auditBoundary('prompts/get', async (request) => {
  const { name, arguments: args = {} } = request.params || {};
  const schema = getSchema(name);
  if (!schema) {
    throw new Error(`MCP prompt not found: ${name}`);
  }
  if (schema.kind !== 'prompt') {
    throw new Error(`MCP schema ${name} is not a prompt (kind=${schema.kind})`);
  }
  const rendered = schema.definition.render(args);
  return {
    schema_version: schema.schema_version,
    description: schema.definition.description,
    messages: rendered.messages,
  };
});

/**
 * MCP `resources/list` handler. Returns the catalog of registered resources
 * (e.g., the decision log) with their URIs + schema versions for host
 * capability negotiation.
 *
 * Wrapped with auditBoundary per the audit-integrity invariant.
 */
const handleListResources = auditBoundary('resources/list', async (request) => {
  const resources = Object.values(SCHEMA_REGISTRY)
    .filter((s) => s.kind === 'resource')
    .map((s) => ({
      name: s.name,
      uri: s.definition.uri,
      mimeType: s.definition.mimeType || 'application/json',
      description: s.definition.description,
      schema_version: s.schema_version,
      arguments: s.definition.arguments || [],
    }));
  return { resources };
});

/**
 * MCP `resources/read` handler. Reads a specific resource with supplied
 * arguments (filters). Read-only — resources expose observe-only surfaces
 * (e.g., the decision log NEVER writes through this path).
 *
 * Wrapped with auditBoundary per the audit-integrity invariant.
 */
const handleReadResource = auditBoundary('resources/read', async (request, context = {}) => {
  const { name, uri, arguments: args = {} } = request.params || {};
  // Resolve by name, or fall back to a URI match for URI-addressed reads.
  let schema = name ? getSchema(name) : null;
  if (!schema && uri) {
    schema = Object.values(SCHEMA_REGISTRY).find(
      (s) => s.kind === 'resource' && s.definition.uri === uri,
    ) || null;
  }
  if (!schema) {
    throw new Error(`MCP resource not found: ${name || uri}`);
  }
  if (schema.kind !== 'resource') {
    throw new Error(`MCP schema ${schema.name} is not a resource (kind=${schema.kind})`);
  }
  const read = await schema.definition.read(args, { ...context, mcpRegistry: SCHEMA_REGISTRY });
  return {
    schema_version: schema.schema_version,
    contents: read.contents,
  };
});

/**
 * MCP `tools/list` handler. Returns the catalog of registered tools with their
 * input schemas + schema versions for host capability negotiation.
 *
 * Phase 2 (dynamic MCP-boundary exposure): the catalog is filtered by the
 * request's resolved role-context, so a seat sees only the tools its effective
 * permission entitles it to. With role governance off (the default, read at call
 * time), filterToolsByRoleContext returns the FULL set unchanged (behavior-
 * identical-off). This is the first of the two independent enforcement layers;
 * the second is the assertMcpToolExposed check in handleCallTool.
 *
 * Wrapped with auditBoundary per the audit-integrity invariant.
 */
const handleListTools = auditBoundary('tools/list', async (request, context = {}) => {
  const tools = Object.values(SCHEMA_REGISTRY)
    .filter((s) => s.kind === 'tool' && !s.deprecated)
    .map((s) => ({
      name: s.name,
      description: s.definition.description,
      schema_version: s.schema_version,
      inputSchema: s.definition.inputSchema || { type: 'object' },
    }));
  const roleCtx = resolveRoleContext(context);
  return { tools: filterToolsByRoleContext(tools, roleCtx) };
});

/**
 * MCP `tools/call` handler. Invokes a registered tool's handler with the supplied
 * arguments, returning the result as MCP content. Most tools are illuci's pure-function
 * resolvers (read-shaped, no gate). The Promotion P-1 dispatch tools (dispatch_v1 /
 * run_topology_v1) DO dispatch to the fleet; they self-gate inside their handlers via
 * the permission posture above illuci's hard-deny floor (constitutional/10 § Promotion P-1).
 *
 * Wrapped with auditBoundary per the audit-integrity invariant.
 */
const handleCallTool = auditBoundary('tools/call', async (request, context = {}) => {
  const { name, arguments: args = {} } = request.params || {};
  const schema = getSchema(name);
  if (!schema) {
    throw new Error(`MCP tool not found: ${name}`);
  }
  if (schema.kind !== 'tool') {
    throw new Error(`MCP schema ${name} is not a tool (kind=${schema.kind})`);
  }
  // Phase 2 (dynamic MCP-boundary exposure): enforce the request's role-context
  // BEFORE the handler runs, throwing CAPABILITY_DENIED for a tool the seat's
  // effective permission does not entitle. Independent of the tools/list filter
  // (defense in depth — a host that calls a name it never listed is still denied).
  // With role governance off, resolveRoleContext reports governanceEnabled:false
  // and this is a no-op (behavior-identical-off).
  assertMcpToolExposed(name, resolveRoleContext(context));
  if (context.workPermit || context.permit || isWorkPermitRequired(context)) {
    assertWorkPermit(name, args, { ...context, toolChannel: "mcp", toolFamily: "mcp" });
  }
  // The session context (tenant + the progress notifier, when the client supplied a
  // progressToken) is threaded to the handler so the Promotion P-1 dispatch tools can
  // stream. Read-shaped tools ignore it and run synchronously, as before.
  const result = await schema.definition.handler(args, context);
  return {
    schema_version: schema.schema_version,
    content: [
      { type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) },
    ],
  };
});


// ─────────────────────────────────────────────────────────────────────────
// SERVER LIFECYCLE
// ─────────────────────────────────────────────────────────────────────────

/**
 * Server startup: register Tier-1 surface, then wire up stdio/HTTP
 * transport (TBD per the deferred SDK wiring).
 *
 * Per the per-tenant instance topology at constitutional/10 § "Per-tenant
 * instance topology", a tenant_id is accepted at startup; v0.1 stores it
 * but does not yet enforce multi-tenant isolation (single-tenant default).
 */
export async function startServer({ tenantId = 'default', transport = 'stdio' } = {}) {
  registerTier1Surface();
  // [A33] Grounding gate — fail closed BEFORE serving a single tool when this
  // process is grounded in the wrong root (launcher/root mismatch) or in an
  // ephemeral linked worktree. Unlike the stale guard below, the supervisor
  // never disables this: a respawn cannot fix a wrong root.
  const grounding = assertServeGrounding();
  const runtimeGuard = createMcpRuntimeGuard();
  const info = {
    ...SERVER_INFO,
    runtime: {
      guard: 'source-stale-fail-closed',
      grounding: {
        sourceRoot: grounding.sourceRoot,
        branch: grounding.branch,
        head: grounding.head,
        version: grounding.version,
        launcherPath: grounding.launcherPath,
        pid: grounding.pid,
        worktreeKind: grounding.worktreeKind,
        expectedRoot: grounding.expectedRoot,
        status: grounding.grounding.status,
      },
      boot: {
        gitHead: runtimeGuard.boot.gitHead,
        gitBranch: runtimeGuard.boot.gitBranch,
        version: runtimeGuard.boot.version,
        packageVersion: runtimeGuard.boot.packageVersion,
        fingerprint: runtimeGuard.boot.fingerprint,
      },
    },
  };

  const promptCount = Object.values(SCHEMA_REGISTRY).filter((s) => s.kind === 'prompt').length;
  const resourceCount = Object.values(SCHEMA_REGISTRY).filter((s) => s.kind === 'resource').length;
  const toolCount = Object.values(SCHEMA_REGISTRY).filter((s) => s.kind === 'tool').length;
  console.error(
    `[${surfaceLogTag()}] Server initializing. tenant=${tenantId} transport=${transport}`,
  );
  console.error(`[${surfaceLogTag()}] Registered prompts: ${promptCount}; resources: ${resourceCount}; tools: ${toolCount}`);

  // The real stdio transport over these handlers is serveStdio() below
  // (hand-rolled JSON-RPC 2.0, no @modelcontextprotocol/sdk dependency).

  return {
    info,
    tenant_id: tenantId,
    transport,
    handlers: {
      'prompts/list': guardHandler(handleListPrompts, runtimeGuard),
      'prompts/get': guardHandler(handleGetPrompt, runtimeGuard),
      'resources/list': guardHandler(handleListResources, runtimeGuard),
      'resources/read': guardHandler(handleReadResource, runtimeGuard),
      'tools/list': guardHandler(handleListTools, runtimeGuard),
      'tools/call': guardHandler(handleCallTool, runtimeGuard),
    },
    registry: SCHEMA_REGISTRY,
    runtimeGuard,
  };
}


// ─────────────────────────────────────────────────────────────────────────
// STDIO TRANSPORT — hand-rolled JSON-RPC 2.0 over stdin/stdout (no SDK dep)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Serve the registered handlers over the MCP stdio transport: newline-delimited
 * JSON-RPC 2.0 on stdin/stdout. Mirrors the outbound client at
 * core/tools/mcp-client.js, so illuci's own client can drive illuci's own server. This
 * is what makes core/mcp/ a live server rather than only an in-process handler map.
 *
 * Requests are serialized by a conformant client (one request, await response,
 * next), so per-message dispatch in arrival order is sufficient at this cut.
 */
/**
 * Build a progress-notifier for one tool call ([A88] / DR-095 transport extension).
 * When the client supplied a progressToken (MCP `params._meta.progressToken`), returns
 * a function that writes a `notifications/progress` over the transport per call, with a
 * monotonic progress counter. When absent, returns null and the tool runs synchronously
 * (the in-process handler map and non-progress clients keep the prior behavior).
 */
export function makeProgressNotifier(progressToken, write) {
  if (progressToken == null) return null;
  let n = 0;
  return (payload = {}) => {
    write({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken, progress: ++n, ...payload } });
  };
}

/**
 * Build an elicitor for one tool call ([A89] / DR-095 transport extension, part 2).
 * When the client advertised the `elicitation` capability at initialize, returns a function
 * that sends a server-initiated `elicitation/create` request and resolves with the client's
 * response (`{ action: 'accept' | 'decline' | 'cancel', content? }`). When the client lacks
 * the capability, returns null and the caller falls back to posture-only gating. `register`
 * (supplied by the transport) records the pending resolver under a fresh server-request id so
 * the line reader can correlate the response back.
 */
export function makeElicitor(clientSupportsElicitation, write, register) {
  if (!clientSupportsElicitation) return null;
  return (params = {}) =>
    new Promise((resolve) => {
      const id = register(resolve);
      write({ jsonrpc: '2.0', id, method: 'elicitation/create', params });
    });
}

export async function serveStdio({ tenantId = surfaceTenantId() } = {}) {
  // stdout is the JSON-RPC channel — reroute any stray console.log (e.g. a
  // resolver's debug line) to stderr so it cannot corrupt the protocol stream.
  console.log = (...args) => console.error(...args);

  const server = await startServer({ tenantId, transport: 'stdio' });
  const { handlers, runtimeGuard, info } = server;

  const write = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
  const ok = (id, result) => write({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message, data = undefined) => write({
    jsonrpc: '2.0',
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  });
  const failAndExitIfStale = (id, err) => {
    if (!isMcpRuntimeStaleError(err)) {
      // Return bounded reconciliation fields, preserving execution uncertainty.
      // Payloads, causes, stacks and sink details remain outside the wire record.
      const audit = err instanceof AuditWriteError ? {
        code: err.code, stage: err.stage, operationId: err.operationId,
        attemptId: err.attemptId, handlerOutcome: err.handlerOutcome,
        executionObserved: err.executionObserved, auditOutcome: err.auditOutcome,
        retrySafe: err.retrySafe,
      } : undefined;
      fail(id, err?.jsonRpcCode || -32000, String(err.message || err), audit);
      return;
    }
    fail(id, err.jsonRpcCode, err.message, staleErrorData(err));
    console.error(`[${surfaceLogTag()}] ${err.message}`);
    const timer = setTimeout(() => process.exit(75), 10);
    if (typeof timer.unref === 'function') timer.unref();
  };

  // Server-initiated requests (elicitation, [A89]): pending resolvers keyed by a server-side
  // id, plus the client's advertised elicitation capability (read at initialize).
  const pendingElicit = new Map();
  let srvSeq = 0;
  const register = (resolve) => {
    const id = `srv-${++srvSeq}`;
    pendingElicit.set(id, resolve);
    return id;
  };
  let clientSupportsElicitation = false;

  // Dispatch one client request asynchronously. Fire-and-forget: the handler writes its own
  // response, so a handler that awaits an elicitation round-trip does NOT block the
  // (synchronous) line reader from routing the elicitation response back in.
  const dispatchRequest = async (msg) => {
    try {
      runtimeGuard.assertFresh();
      if (msg.method === 'initialize') {
        clientSupportsElicitation = !!msg.params?.capabilities?.elicitation;
        ok(msg.id, {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {}, prompts: {}, resources: {} },
          serverInfo: info,
        });
      } else if (handlers[msg.method]) {
        // Thread the session context: a progress notifier (when the client requested
        // progress via params._meta.progressToken) and an elicitor (when the client
        // advertised elicitation). Read-shaped tools ignore both and run synchronously.
        const meta = msg.params?._meta || {};
        const progressToken = meta.progressToken;
        const ctx = {
          tenant_id: tenantId,
          progressToken,
          notify: makeProgressNotifier(progressToken, write),
          clientSupportsElicitation,
          elicit: makeElicitor(clientSupportsElicitation, write, register),
          // Phase-2 boundary feed: carry the seat identity so resolveRoleContext
          // resolves a seat from the request (behavior-identical when _meta carries none).
          roleId: meta.roleId ?? null,
          sessionId: meta.sessionId ?? null,
          topologyId: meta.topologyId ?? null,
          seatId: meta.seatId ?? null,
        };
        ok(msg.id, await handlers[msg.method](msg, ctx));
      } else {
        fail(msg.id, -32601, `Method not found: ${msg.method}`);
      }
    } catch (err) {
      failAndExitIfStale(msg.id, err);
    }
  };

  // Synchronous line reader: parse + route only, never await. This lets it route an incoming
  // elicitation RESPONSE while a tool handler is mid-await on its elicitation request (the
  // reentrancy a single awaiting loop could not handle without a buffer race).
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // non-JSON line — skip
      }
      // A response to a server-initiated elicitation: no method, id matches a pending request.
      if (msg.method === undefined && msg.id != null && pendingElicit.has(msg.id)) {
        const resolve = pendingElicit.get(msg.id);
        pendingElicit.delete(msg.id);
        resolve(msg.error ? { action: 'cancel' } : (msg.result || { action: 'cancel' }));
        continue;
      }
      if (msg.id == null) continue; // a notification (e.g. notifications/initialized)
      void dispatchRequest(msg); // async, fire-and-forget (handler writes its own response)
    }
  });
  process.stdin.on('end', () => process.exit(0));
}


// ─────────────────────────────────────────────────────────────────────────
// CLI ENTRY
// ─────────────────────────────────────────────────────────────────────────

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  serveStdio().catch((err) => {
    console.error(`[${surfaceLogTag()}] Startup failed:`, err);
    process.exit(1);
  });
}


export {
  SERVER_INFO,
  handleListPrompts,
  handleGetPrompt,
  handleListResources,
  handleReadResource,
  handleListTools,
  handleCallTool,
};
