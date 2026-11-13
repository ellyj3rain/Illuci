/**
 * illuci - work permits.
 *
 * A work permit is a runtime permission carrier. It binds an agent identity to
 * exact actions, tool family/channel, capability, target scope, risk ceiling,
 * expiry, and a deterministic integrity signature.
 */

import { createHash } from "node:crypto";
import { basename } from "node:path";
import { DENIAL_CODES } from "../roles/denial-codes.js";

const RISK = Object.freeze({ low: 0, medium: 1, high: 2, critical: 3 });

const TOOL_SCOPE = Object.freeze({
  file_read: { action: "file_read", toolFamily: "filesystem", toolChannel: "native", capability: "file.read", risk: "low" },
  file_write: { action: "file_write", toolFamily: "filesystem", toolChannel: "native", capability: "file.write", risk: "medium" },
  file_edit: { action: "file_edit", toolFamily: "filesystem", toolChannel: "native", capability: "file.write", risk: "medium" },
  file_delete: { action: "file_delete", toolFamily: "filesystem", toolChannel: "native", capability: "file.delete", risk: "high" },
  file_move: { action: "file_move", toolFamily: "filesystem", toolChannel: "native", capability: "file.write", risk: "medium" },
  search: { action: "search", toolFamily: "filesystem", toolChannel: "native", capability: "file.read", risk: "low" },
  glob: { action: "glob", toolFamily: "filesystem", toolChannel: "native", capability: "file.read", risk: "low" },
  shell_exec: { action: "shell_exec", toolFamily: "process", toolChannel: "native", capability: "process.exec", risk: "high" },
  http_fetch: { action: "http_fetch", toolFamily: "network", toolChannel: "native", capability: "network.fetch", risk: "medium" },
  browse_page: { action: "browse_page", toolFamily: "network", toolChannel: "native", capability: "network.fetch", risk: "medium" },
  git_status: { action: "git_status", toolFamily: "git", toolChannel: "native", capability: "git.read", risk: "low" },
  git_log: { action: "git_log", toolFamily: "git", toolChannel: "native", capability: "git.read", risk: "low" },
  git_diff: { action: "git_diff", toolFamily: "git", toolChannel: "native", capability: "git.read", risk: "low" },
  git_add: { action: "git_add", toolFamily: "git", toolChannel: "native", capability: "git.write", risk: "medium" },
  git_commit: { action: "git_commit", toolFamily: "git", toolChannel: "native", capability: "git.write", risk: "medium" },
  git_push: { action: "git_push", toolFamily: "git", toolChannel: "native", capability: "git.publish", risk: "high" },
});

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => key !== "signature")
        .sort()
        .map((key) => [key, stable(value[key])]),
    );
  }
  return value;
}

export function canonicalPermitPayload(permit = {}) {
  return JSON.stringify(stable(permit));
}

export function signWorkPermit(permit = {}) {
  const payload = canonicalPermitPayload(permit);
  return { ...permit, signature: "sha256:" + createHash("sha256").update(payload).digest("hex") };
}

function verifySignature(permit = {}) {
  if (!permit.signature) return { ok: false, reason: "work permit has no signature" };
  const expected = signWorkPermit({ ...permit, signature: undefined }).signature;
  if (permit.signature !== expected) return { ok: false, reason: "work permit signature mismatch" };
  return { ok: true };
}

function toolScope(toolName, context = {}) {
  const base = TOOL_SCOPE[toolName] || {
    action: toolName,
    toolFamily: context.toolFamily || "mcp",
    toolChannel: context.toolChannel || "mcp",
    capability: toolName,
    risk: "medium",
  };
  return {
    ...base,
    ...(context.toolFamily ? { toolFamily: context.toolFamily } : {}),
    ...(context.toolChannel ? { toolChannel: context.toolChannel } : {}),
    ...(context.capability ? { capability: context.capability } : {}),
    ...(context.risk ? { risk: context.risk } : {}),
  };
}

function callTarget(toolName, params = {}) {
  if (params.path) return String(params.path);
  if (params.source || params.destination) return [params.source, params.destination].filter(Boolean).map(String).join(" -> ");
  if (params.workingDirectory) return String(params.workingDirectory);
  if (params.url) return String(params.url);
  if (params.command) return basename(String(params.command).trim().split(/\s+/)[0] || "");
  if (toolName) return String(toolName);
  return null;
}

function contains(permit, names, value) {
  const allowed = names.flatMap((name) => asArray(permit[name]));
  if (!allowed.length) return false;
  return allowed.includes(value);
}

function targetAllowed(permit, target) {
  const targets = [
    ...asArray(permit.targets),
    ...asArray(permit.targetScope),
    ...asArray(permit.contexts),
  ].filter(Boolean).map(String);
  if (!targets.length) return false;
  if (targets.some((item) => item === "*" || item === "**/*")) {
    return permit.allowWildcardTargets === true;
  }
  if (!target) return false;
  const normalizedTarget = normalizeTarget(target);
  return targets.some((item) => targetMatches(normalizeTarget(item), normalizedTarget));
}

function normalizeTarget(value) {
  return String(value).replace(/\\/g, "/");
}

function targetMatches(scope, target) {
  if (target === scope) return true;
  if (scope.endsWith("/**")) {
    const prefix = scope.slice(0, -3);
    return target === prefix || target.startsWith(prefix + "/");
  }
  if (scope.endsWith("/*")) {
    const prefix = scope.slice(0, -2);
    const rest = target.startsWith(prefix + "/") ? target.slice(prefix.length + 1) : null;
    return !!rest && !rest.includes("/");
  }
  if (scope.endsWith("*")) {
    return target.startsWith(scope.slice(0, -1));
  }
  if (scope.endsWith("/")) return target.startsWith(scope);
  return target.startsWith(scope + "/");
}

export function evaluateWorkPermit({ permit = null, required = false, toolName, params = {}, context = {}, now = new Date() } = {}) {
  if (!permit) {
    return required
      ? { allow: false, code: DENIAL_CODES.WORK_PERMIT_DENIED, reason: "work permit required" }
      : { allow: true, reason: "no work permit required" };
  }

  const scope = toolScope(toolName, context);
  const agentIds = [context.agentId, context.agentSlug].filter(Boolean);
  const target = callTarget(toolName, params);

  if (permit.agentId && agentIds.length && !agentIds.includes(permit.agentId)) {
    return { allow: false, code: DENIAL_CODES.WORK_PERMIT_DENIED, reason: `work permit belongs to agent "${permit.agentId}", not "${agentIds[0]}"` };
  }
  if (!permit.agentId && required) {
    return { allow: false, code: DENIAL_CODES.WORK_PERMIT_DENIED, reason: "work permit has no agentId" };
  }
  if (permit.expiresAt && Date.parse(permit.expiresAt) <= now.getTime()) {
    return { allow: false, code: DENIAL_CODES.WORK_PERMIT_DENIED, reason: "work permit expired" };
  }
  const sig = verifySignature(permit);
  if (!sig.ok) return { allow: false, code: DENIAL_CODES.WORK_PERMIT_DENIED, reason: sig.reason };

  if (!contains(permit, ["actions", "tools"], scope.action) && !contains(permit, ["actions", "tools"], toolName)) {
    return { allow: false, code: DENIAL_CODES.WORK_PERMIT_DENIED, reason: `action "${scope.action}" is outside work permit scope` };
  }
  if (!contains(permit, ["toolFamilies", "families"], scope.toolFamily)) {
    return { allow: false, code: DENIAL_CODES.WORK_PERMIT_DENIED, reason: `tool family "${scope.toolFamily}" is outside work permit scope` };
  }
  if (!contains(permit, ["toolChannels", "channels"], scope.toolChannel)) {
    return { allow: false, code: DENIAL_CODES.WORK_PERMIT_DENIED, reason: `tool channel "${scope.toolChannel}" is outside work permit scope` };
  }
  if (!contains(permit, ["capabilities"], scope.capability)) {
    return { allow: false, code: DENIAL_CODES.WORK_PERMIT_DENIED, reason: `capability "${scope.capability}" is outside work permit scope` };
  }

  const ceiling = permit.riskCeiling || permit.risk || "low";
  if ((RISK[scope.risk] ?? 99) > (RISK[ceiling] ?? -1)) {
    return { allow: false, code: DENIAL_CODES.WORK_PERMIT_DENIED, reason: `risk "${scope.risk}" exceeds ceiling "${ceiling}"` };
  }
  if (!targetAllowed(permit, target)) {
    return { allow: false, code: DENIAL_CODES.WORK_PERMIT_DENIED, reason: `target "${target || "none"}" is outside work permit scope` };
  }

  return { allow: true, reason: "work permit scope matched", scope: { ...scope, target } };
}

export function isWorkPermitRequired(context = {}) {
  return context.workPermitRequired === true || process.env.ILLUCI_WORK_PERMIT_REQUIRED === "1";
}

export function assertWorkPermit(toolName, params = {}, context = {}) {
  const verdict = evaluateWorkPermit({
    permit: context.workPermit || context.permit || null,
    required: isWorkPermitRequired(context),
    toolName,
    params,
    context,
  });
  if (verdict.allow) return verdict;
  const err = new Error(`${DENIAL_CODES.WORK_PERMIT_DENIED}: ${verdict.reason}`);
  err.code = DENIAL_CODES.WORK_PERMIT_DENIED;
  err.tool = toolName;
  err.reason = verdict.reason;
  throw err;
}

export default {
  signWorkPermit,
  evaluateWorkPermit,
  assertWorkPermit,
  isWorkPermitRequired,
};
