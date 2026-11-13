/**
 * illuci - Codex Bridge (Subscription CLI)
 *
 * Routes through @openai/codex-sdk with Plus subscription auth.
 * Strips OPENAI_API_KEY and isolates mutable runtime directories.
 * Bridge preparation does not discover or copy authentication.
 */

// Lazy-loaded @openai/codex-sdk per [A60.1] / DR-070 — the static import
// `import { Codex } from "@openai/codex-sdk"` previously crashed module
// load when the SDK wasn't installed, which cascaded through
// `bridges/index.js`'s static re-export and broke unrelated bridges
// (Claude, etc.). Lazy-load inside getCodex() so this module can be
// imported safely even when the Codex SDK isn't present; only fails when
// a Codex query is actually attempted.
import { mkdirSync, realpathSync, statSync } from "fs";
import { join } from "path";
import {
  buildCanonicalToolEnv,
  getCodexRuntimeHome,
} from "./tool-paths.js";
import { resolveCliLaneWorkspace } from "./cli-sandbox.js";
import { toCodexEffort } from "../reasoning/dial.js";
import { createTraceExposure } from './trace-exposure.js';
import { usageFromSDK } from '../connections/codex-usage.js';

// Process-owned clients, never reconstructed from model/program JSON. The host
// must resolve approved account bindings and authenticate mode/identity first.
const accountClients = new WeakMap();
export async function createAccountClient(binding, { CodexClass, baseEnv = process.env } = {}) {
  if (!binding || binding.authMode !== 'chatgpt' || !['accountId','workerId','connectionRef','runtimeHome'].every(k => typeof binding[k] === 'string' && binding[k])) throw TypeError('Authenticated subscription account binding required');
  const runtimeHome = realpathSync(binding.runtimeHome);
  if (!statSync(runtimeHome).isDirectory()) throw TypeError('Existing approved account home required');
  if (!CodexClass) ({ Codex: CodexClass } = await import('@openai/codex-sdk'));
  // In particular, do not inherit API keys, external tokens or a remote server.
  const allowed = new Set(['PATH','SYSTEMROOT','WINDIR','COMSPEC','PATHEXT','SYSTEMDRIVE','LANG','LC_ALL']);
  const env = {};
  for (const k of Object.keys(baseEnv)) if (allowed.has(k.toUpperCase()) && typeof baseEnv[k] === 'string') env[k] = baseEnv[k];
  configureCodexRuntimeEnv(env, runtimeHome);
  if (binding.serviceTier !== undefined && !['fast', 'standard'].includes(binding.serviceTier)) throw TypeError('Supported service tier required');
  const config = { forced_login_method: 'chatgpt', model_provider: 'openai', ...(binding.serviceTier === undefined ? {} : { service_tier: binding.serviceTier === 'fast' ? 'fast' : 'default', features: { fast_mode: binding.serviceTier === 'fast' } }) };
  const codex = new CodexClass({ env, config });
  const client = Object.freeze({ accountId: binding.accountId, workerId: binding.workerId, connectionRef: binding.connectionRef });
  accountClients.set(client, codex); return client;
}

let _codex = null;
let _CodexClass = null;

function createCodex(CodexClass) {
  const cleanEnv = buildCanonicalToolEnv({}, "codex");
  delete cleanEnv.OPENAI_API_KEY;

  const tmpHome = getCodexRuntimeHome();
  mkdirSync(tmpHome, { recursive: true });

  configureCodexRuntimeEnv(cleanEnv, tmpHome);
  return new CodexClass({ env: cleanEnv });
}

async function getCodex(CodexClassOverride = null, accountClient = null) {
  if (accountClient !== null) {
    if (!accountClients.has(accountClient)) throw TypeError('Owning process account client required');
    return accountClients.get(accountClient);
  }
  if (CodexClassOverride) return createCodex(CodexClassOverride);

  if (!_codex) {
    if (!_CodexClass) {
      try {
        const m = await import("@openai/codex-sdk");
        _CodexClass = m.Codex;
      } catch (err) {
        throw new Error(
          `Codex bridge unavailable: @openai/codex-sdk not installed. ` +
          `Install with: npm install @openai/codex-sdk. (root cause: ${err.message})`
        );
      }
    }
    _codex = createCodex(_CodexClass);
  }
  return _codex;
}

/**
 * Point all mutable Codex SDK state at the runtime home.
 *
 * @param {object} env - environment passed to the Codex SDK
 * @param {string} runtimeHome - writable isolated runtime home
 */
function configureCodexRuntimeEnv(env, runtimeHome) {
  const config = join(runtimeHome, "config");
  const cache = join(runtimeHome, "cache");
  const state = join(runtimeHome, "state");
  const tmp = join(runtimeHome, "tmp");
  const appData = join(runtimeHome, "AppData", "Roaming");
  const localAppData = join(runtimeHome, "AppData", "Local");

  for (const dir of [runtimeHome, config, cache, state, tmp, appData, localAppData]) {
    mkdirSync(dir, { recursive: true });
  }

  env.CODEX_HOME = runtimeHome;
  env.HOME = runtimeHome;
  env.XDG_CONFIG_HOME = config;
  env.XDG_CACHE_HOME = cache;
  env.XDG_STATE_HOME = state;
  env.TEMP = tmp;
  env.TMP = tmp;

  if (process.platform === "win32") {
    const driveMatch = runtimeHome.match(/^([a-zA-Z]:)(.*)$/);
    env.USERPROFILE = runtimeHome;
    if (driveMatch) {
      env.HOMEDRIVE = driveMatch[1];
      env.HOMEPATH = driveMatch[2] || "\\";
    }
    env.APPDATA = appData;
    env.LOCALAPPDATA = localAppData;
  }
}

/**
 * Resolve a scoped working directory for Codex.
 * Instead of scanning the entire repo, scope to the
 * relevant subdirectory based on the task context.
 *
 * @param {object} options - dispatch options
 * @returns {string} scoped working directory
 */
function resolveWorkingDirectory(options) {
  // An explicit workingDirectory stays the strongest control (queryWithWrite
  // REQUIRES one — a write against a caller-named workspace is deliberate).
  if (options.workingDirectory) return options.workingDirectory;
  // DR-200/F-139 — Codex is an agentic host; ground it in the per-dispatch
  // sandbox by default. Codex's OWN sandboxMode jail then encloses the scratch
  // dir (sandbox-in-sandbox — the strongest posture of any CLI-agent lane).
  return resolveCliLaneWorkspace(options).cwd;
}

function buildSessionState(priorMessages, userMessage, response) {
  return [
    ...priorMessages,
    { role: "user", content: userMessage },
    { role: "assistant", content: response },
  ];
}

// Agentic seats that need filesystem access - use Codex SDK
const AGENTIC_SEATS = new Set(["implementer", "fixer", "tester", "builder", "architect"]);

// The Codex SDK validates that run options.signal is an AbortSignal instance. The runner threads
// `signal: options.signal || null` (runner.js), so a literal null reaches the bridge and the SDK
// throws "options.signal must be an instance of AbortSignal. Received null". Sibling bridges
// (gemini-api, grok-api) guard the same way: forward the signal only when it is a real
// AbortSignal, otherwise omit the field entirely.
function codexRunOptions(options = {}) {
  const signal = options.signal;
  return signal instanceof AbortSignal ? { signal } : {};
}

// The owning host opts in with a process-local callback; no wire field or
// account authentication is inferred from the SDK thread reference.
async function runWithCorrelation(thread, message, options) {
  if (typeof options.onCodexThreadStarted !== 'function') return thread.run(message, codexRunOptions(options));
  if (typeof thread.runStreamed !== 'function') throw Error('SDK early thread correlation unavailable');
  const {events}=await thread.runStreamed(message, codexRunOptions(options));
  const items=[];let finalResponse='',usage=null,started=false,completed=false;
  for await (const event of events) {
    if(event.type==='thread.started') {if(started||typeof event.thread_id!=='string'||!event.thread_id)throw Error('Invalid SDK thread-start event');started=true;await options.onCodexThreadStarted(event.thread_id);}
    else if(event.type==='item.completed') {items.push(event.item);if(event.item?.type==='agent_message')finalResponse=event.item.text;}
    else if(event.type==='turn.completed'){completed=true;usage=event.usage;}
    else if(event.type==='turn.failed')throw Error(event.error?.message || 'SDK turn failed');
  }
  if(!started||!completed)throw Error('SDK turn ended without correlated completion');
  return {items,finalResponse,usage};
}

/** Pure capability refusal: installed SDK does not establish native-tool denial. */
export function assertResponseOnly() {
  const error = new Error('Codex response-only execution unsupported: native-tool suppression is not established by read-only/never settings');
  error.code = 'ILLUCI_RESPONSE_ONLY_UNSUPPORTED'; error.blocked = true; error.retrySafe = false;
  throw error;
}

export async function query(userMessage, options = {}) {
  if (options.responseOnly !== undefined && options.responseOnly !== false) assertResponseOnly();
  const trace = createTraceExposure(options,'illuci.bridge.codex-sdk');
  const seat = options.seat || "";
  if (!AGENTIC_SEATS.has(seat)) {
    return queryRespondOnly(userMessage, options);
  }

  const codex = await getCodex(options._CodexClass, options.accountClient ?? null);
  // [A109] fallback tracks the operator's own Codex default (the GPT-5.6
  // family head); the codex-sol/-terra/-luna lanes pin options.model upstream.
  const model = options.model || process.env.CODEX_SDK_MODEL || "gpt-5.6-sol";
  const start = Date.now();
  const originalUserMessage = userMessage;

  if (options.sessionState && Array.isArray(options.sessionState) && options.sessionState.length > 0) {
    const history = options.sessionState.map((m) => `[${m.role}]: ${m.content}`).join("\n\n");
    userMessage = `Prior conversation:\n${history}\n\n---\n\nCurrent message:\n${userMessage}`;
  }

  const fullMessage = options.systemPrompt
    ? `${options.systemPrompt}\n\n---\n\n${userMessage}`
    : userMessage;

  const thread = codex.startThread({
    model,
    modelReasoningEffort: toCodexEffort(options.reasoning) || process.env.CODEX_REASONING || "xhigh",
    sandboxMode: options.sandboxMode || "workspace-write",
    workingDirectory: resolveWorkingDirectory(options),
    approvalPolicy: options.approvalPolicy || "on-request",
    skipGitRepoCheck: true,
  });

  const result = await runWithCorrelation(thread, fullMessage, options);
  await trace.record(result,'sdk-exposed-value','sdk-turn-result'); await trace.finish();
  const usage = result.usage || {};
  const response = result.finalResponse || "";
  const priorMessages = options.sessionState || [];

  return {
    accountUsage: options.accountClient ? usageFromSDK(result.usage) : undefined,
    threadRef: options.accountClient ? thread.id ?? null : undefined,
    model: "codex-local",
    role: options.role || "agent",
    response,
    usage: {
      prompt_tokens: usage?.input_tokens || 0,
      completion_tokens: usage?.output_tokens || 0,
      total_tokens: (usage?.input_tokens || 0) + (usage?.output_tokens || 0),
    },
    latency: Date.now() - start,
    sessionState: buildSessionState(priorMessages, originalUserMessage, response),
  };
}

export async function queryWithWrite(userMessage, options = {}) {
  if (options.responseOnly !== undefined && options.responseOnly !== false) assertResponseOnly();
  const trace = createTraceExposure(options,'illuci.bridge.codex-sdk');
  const codex = await getCodex(options._CodexClass, options.accountClient ?? null);
  const model = options.model || process.env.CODEX_WRITE_MODEL || process.env.CODEX_SDK_MODEL || "gpt-5.6-sol";
  if (!options.workingDirectory) throw new Error("queryWithWrite requires workingDirectory");

  const start = Date.now();
  const fullMessage = options.systemPrompt
    ? `${options.systemPrompt}\n\n---\n\n${userMessage}`
    : userMessage;

  const thread = codex.startThread({
    model,
    modelReasoningEffort: toCodexEffort(options.reasoning) || "high",
    sandboxMode: "workspace-write",
    workingDirectory: options.workingDirectory,
    approvalPolicy: "never",
    skipGitRepoCheck: true,
  });

  const fileChanges = [];
  let finalResponse = "";
  let usage = null;
  let completed = false;
  const unconfirmed = (message, cause) => Object.assign(new Error(message, cause ? { cause } : undefined), {
    code: 'ILLUCI_CODEX_WRITE_OUTCOME_UNCONFIRMED', outcome: 'unknown', retrySafe: false,
    providerCompletionObserved: completed, fileChanges: fileChanges.map(change => ({ ...change })),
    ...(thread.id ? { threadRef: thread.id } : {}),
  });

  try {
    const streamed = await thread.runStreamed(fullMessage, codexRunOptions(options));
    for await (const rawEvent of streamed.events) {
      // The trace observer is a separate consumer and must not mutate the event
      // used to decide whether an effect completed or which changes were seen.
      const event = structuredClone(rawEvent);
      let eventFailure = null;
      if (event.type === "error") eventFailure = event.message || 'Codex write stream reported an error';
      if (event.type === "item.completed") {
        if (event.item?.type === "agent_message") finalResponse = event.item.text;
        if (event.item?.type === "file_change") {
          for (const c of event.item.changes || []) {
            fileChanges.push({ path: c.path, kind: c.kind });
          }
        }
      }
      if (event.type === "turn.failed") eventFailure = event.error?.message || 'Codex write turn failed';
      if (event.type === "turn.completed") {
        if (completed) throw unconfirmed('Codex write turn reported completion more than once');
        completed = true;
        usage = event.usage || {};
      }
      await trace.record(structuredClone(event),'sdk-exposed-value','sdk-stream-event');
      if (eventFailure) throw unconfirmed(eventFailure);
    }
    if (!completed) throw unconfirmed('Codex write stream ended without completion');
    await trace.finish();
  } catch (error) {
    await trace.finish(false);
    if (error?.code === 'ILLUCI_CODEX_WRITE_OUTCOME_UNCONFIRMED') throw error;
    throw unconfirmed('Codex write outcome is unconfirmed', error);
  }
  return {
    accountUsage: options.accountClient ? usageFromSDK(usage) : undefined,
    threadRef: options.accountClient ? thread.id ?? null : undefined,
    model: "codex-local",
    response: finalResponse,
    fileChanges,
    usage: {
      prompt_tokens: usage?.input_tokens || 0,
      completion_tokens: usage?.output_tokens || 0,
      total_tokens: (usage?.input_tokens || 0) + (usage?.output_tokens || 0),
    },
    latency: Date.now() - start,
  };
}

/**
 * Respond-only mode - uses Codex SDK with read-only workspace access and no approvals.
 * For seats like reviewer, judge, motho, censor, etc.
 * Uses the same subscription auth as the agentic path - no separate API key needed.
 */
async function queryRespondOnly(userMessage, options = {}) {
  const trace = createTraceExposure(options,'illuci.bridge.codex-sdk');
  const codex = await getCodex(options._CodexClass, options.accountClient ?? null);
  const model = options.model || process.env.CODEX_RESPOND_MODEL || process.env.CODEX_SDK_MODEL || "gpt-5.6-sol";
  const start = Date.now();
  const originalUserMessage = userMessage;

  if (options.sessionState?.length) {
    const history = options.sessionState.map((m) => `[${m.role}]: ${m.content}`).join("\n\n");
    userMessage = `Prior conversation:\n${history}\n\n---\n\nCurrent message:\n${userMessage}`;
  }

  const fullMessage = options.systemPrompt
    ? `${options.systemPrompt}\n\n---\n\n${userMessage}`
    : userMessage;

  const thread = codex.startThread({
    model,
    modelReasoningEffort: toCodexEffort(options.reasoning) || "high",
    sandboxMode: "read-only",
    workingDirectory: resolveWorkingDirectory(options),
    approvalPolicy: "never",
    skipGitRepoCheck: true,
  });

  const result = await runWithCorrelation(thread, fullMessage, options);
  await trace.record(result,'sdk-exposed-value','sdk-turn-result'); await trace.finish();
  const usage = result.usage || {};
  const response = result.finalResponse || "";
  const priorMessages = options.sessionState || [];

  return {
    accountUsage: options.accountClient ? usageFromSDK(result.usage) : undefined,
    threadRef: options.accountClient ? thread.id ?? null : undefined,
    model: "codex-local",
    role: options.role || "agent",
    response,
    usage: {
      prompt_tokens: usage?.input_tokens || 0,
      completion_tokens: usage?.output_tokens || 0,
      total_tokens: (usage?.input_tokens || 0) + (usage?.output_tokens || 0),
    },
    latency: Date.now() - start,
    sessionState: buildSessionState(priorMessages, originalUserMessage, response),
  };
}

export default { query, queryWithWrite, assertResponseOnly };
