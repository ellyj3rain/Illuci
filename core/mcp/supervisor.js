/**
 * illuci MCP supervisor — keeps a long-lived stdio MCP server fresh across illuci updates
 * WITHOUT disrupting the host (e.g. JetBrains Air).
 *
 * The host invokes THIS instead of server.js directly:
 *
 *   { "command": "node", "args": [".../illuci/core/mcp/supervisor.js"], "cwd": ".../illuci" }
 *
 * It proxies newline-delimited JSON-RPC between the host (stdin/stdout) and a child
 * `core/mcp/server.js`, polls the source fingerprint (the same one runtime-guard.js
 * uses), and on ANY change to the checkout respawns a fresh child — replaying the
 * cached initialize handshake, re-issuing any in-flight requests, and signaling the
 * list_changed notifications, so the host's connection survives and always reaches
 * current code. The child runs with the fail-closed stale guard disabled
 * (ILLUCI_MCP_STALE_GUARD=0): the supervisor owns freshness via respawn, replacing the
 * guard's "fail closed, restart by hand" disruption with a transparent reload.
 */
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildMcpRuntimeStamp, ILLUCI_ROOT } from "./runtime-guard.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = resolve(HERE, "server.js");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export function runSupervisor({
  input = process.stdin,
  output = process.stdout,
  root = ILLUCI_ROOT,
  pollMs = 1500,
  drainMs = 1500,
  snapshot = () => buildMcpRuntimeStamp({ root }).fingerprint,
  spawnChild = () =>
    spawn(process.execPath, [SERVER_PATH], {
      cwd: root,
      env: { ...process.env, ILLUCI_MCP_STALE_GUARD: "0" },
      stdio: ["pipe", "pipe", "inherit"],
    }),
  log = (m) => { try { process.stderr.write("[mcp-serve] " + m + "\n"); } catch (_e) { /* ignore */ } },
} = {}) {
  let child = null;
  let respawning = false;
  let initializeLine = null;   // cached `initialize` request (raw line)
  let initializedLine = null;  // cached `notifications/initialized`
  let replayInitId = null;     // id of the replayed initialize whose response we swallow
  let fingerprint = snapshot();
  const inFlight = new Map();   // request id → raw line (host requests awaiting a response)
  const buffered = [];          // host lines that arrive mid-respawn

  function writeLine(stream, line) {
    try { stream.write(line + "\n"); } catch (e) { log(`write failed: ${e.message}`); }
  }

  function wireChild(c) {
    let buf = "";
    c.stdout.setEncoding("utf8");
    c.stdout.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        onChildLine(line);
      }
    });
    c.on("exit", (code) => {
      if (!respawning) { log(`child exited (code ${code}); respawning`); void respawn("child-exit"); }
    });
    return c;
  }

  // child → host
  function onChildLine(line) {
    const t = line.trim();
    if (!t) return;
    let msg = null;
    try { msg = JSON.parse(t); } catch { /* opaque: pass through */ }
    if (msg && msg.id != null) {
      if (replayInitId != null && msg.id === replayInitId) { replayInitId = null; return; } // swallow replayed init response
      inFlight.delete(msg.id);
    }
    writeLine(output, line);
  }

  // host → child
  function onClientLine(line) {
    const t = line.trim();
    if (!t) return;
    if (respawning) { buffered.push(line); return; }
    let msg = null;
    try { msg = JSON.parse(t); } catch { /* opaque */ }
    if (msg) {
      if (msg.method === "initialize") initializeLine = line;
      else if (msg.method === "notifications/initialized") initializedLine = line;
      if (msg.id != null && msg.method) inFlight.set(msg.id, line); // a request (id + method)
    }
    writeLine(child.stdin, line);
  }

  async function respawn(reason) {
    if (respawning) return;
    respawning = true;
    log(`respawn: ${reason}`);
    const deadline = Date.now() + drainMs;
    while (inFlight.size && Date.now() < deadline) await delay(20); // let in-flight settle (best effort)
    try { child && child.kill(); } catch { /* ignore */ }

    child = wireChild(spawnChild());
    if (initializeLine) {
      try { replayInitId = JSON.parse(initializeLine).id ?? null; } catch { replayInitId = null; }
      writeLine(child.stdin, initializeLine);
      if (initializedLine) writeLine(child.stdin, initializedLine);
    }
    // re-issue requests still in flight so the host still gets its responses (idempotent
    // reads are safe; a tool call caught exactly mid-respawn may re-run — a narrow window).
    for (const reqLine of inFlight.values()) writeLine(child.stdin, reqLine);

    fingerprint = snapshot();
    respawning = false;
    while (buffered.length) onClientLine(buffered.shift());
    // the new code may expose a different surface — prompt the host to refresh its views
    for (const kind of ["tools", "resources", "prompts"]) {
      writeLine(output, JSON.stringify({ jsonrpc: "2.0", method: `notifications/${kind}/list_changed` }));
    }
  }

  const timer = setInterval(() => {
    if (respawning) return;
    let fp;
    try { fp = snapshot(); } catch { return; }
    if (fp !== fingerprint) void respawn("source-change");
  }, pollMs);
  if (timer.unref) timer.unref();

  let cbuf = "";
  input.setEncoding("utf8");
  input.on("data", (chunk) => {
    cbuf += chunk;
    let nl;
    while ((nl = cbuf.indexOf("\n")) !== -1) {
      const line = cbuf.slice(0, nl);
      cbuf = cbuf.slice(nl + 1);
      onClientLine(line);
    }
  });
  input.on("end", () => stop());

  function stop() { clearInterval(timer); try { child && child.kill(); } catch { /* ignore */ } }

  child = wireChild(spawnChild());
  return { respawn, stop, get fingerprint() { return fingerprint; }, _inFlight: inFlight };
}

// Entry point: run as the supervisor when invoked directly (not when imported).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSupervisor();
}

export default { runSupervisor };
