/**
 * [A18] MCP supervisor — verifies a source-change triggers a transparent respawn:
 * the host's initialize is replayed to the fresh child, the host keeps getting answers,
 * the replayed init response is swallowed, and a list_changed nudge is sent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { runSupervisor } from "./supervisor.js";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, ms = 1500) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (cond()) return; await delay(10); }
  throw new Error("waitFor timed out");
}

// A minimal fake MCP child: answers any request (id + method) with its label.
function makeFakeChild(label) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.killed = false;
  child.kill = () => { if (!child.killed) { child.killed = true; child.emit("exit", 0); } };
  let buf = "";
  child.stdin.setEncoding("utf8");
  child.stdin.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      const t = line.trim(); if (!t) continue;
      let msg; try { msg = JSON.parse(t); } catch { continue; }
      if (msg.id != null && msg.method) {
        child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { server: label, method: msg.method } }) + "\n");
      }
    }
  });
  return child;
}

function collect(stream) {
  const msgs = [];
  let buf = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      const t = line.trim(); if (!t) continue;
      try { msgs.push(JSON.parse(t)); } catch { /* skip */ }
    }
  });
  return msgs;
}

test("supervisor replays initialize and keeps serving across a source-change respawn", async () => {
  const toHost = new PassThrough();
  const fromHost = new PassThrough();
  let fp = "fp-1";
  const children = [];
  const out = collect(toHost);
  const sup = runSupervisor({
    input: fromHost,
    output: toHost,
    snapshot: () => fp,
    pollMs: 25,
    drainMs: 80,
    spawnChild: () => { const c = makeFakeChild(`child-${children.length + 1}`); children.push(c); return c; },
    log: () => {},
  });

  // host initializes against the first child
  fromHost.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
  await waitFor(() => out.some((m) => m.id === 1));
  assert.equal(children.length, 1);

  // a source change → transparent respawn onto a fresh child
  fp = "fp-2";
  await waitFor(() => children.length === 2);
  assert.equal(children[0].killed, true, "stale child is replaced");

  // host calls a tool AFTER the respawn → answered by the fresh child
  fromHost.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
  await waitFor(() => out.some((m) => m.id === 2));
  assert.equal(out.find((m) => m.id === 2).result.server, "child-2", "served by the fresh child");

  // the replayed initialize's response (id 1 from child-2) was swallowed → host saw it once
  assert.equal(out.filter((m) => m.id === 1).length, 1, "no duplicate initialize response");
  // host was nudged to refresh its surface views
  assert.ok(out.some((m) => m.method === "notifications/tools/list_changed"), "list_changed nudge sent");

  sup.stop();
});
