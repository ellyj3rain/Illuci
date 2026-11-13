// core/runtime/verb-contract.test.js
//
// [A22.8] MCP==API contract coverage for ACTION VERBS — the [A22.4] doctrine (MCP is a
// normalized adapter over the canonical runtime API) extended from resources to verbs.
// The REST verb body must deep-equal the payload inside the MCP tools/call envelope for
// the same arguments, because both are wire shapes over ONE governed pipeline.
//
// Hermetic: datastore_query_v1 (read-only SQL over the local trunk) proves payload
// equality without any model dispatch; run_topology_v1 / dispatch_v1 are proven at their
// fail-fast validation edge (no fleet call is ever made).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ILLUCI_DATA_HOME = mkdtempSync(join(tmpdir(), "illuci-verb-contract-"));

const { startHttpTransport, RUNTIME_ACTION_VERBS, unwrapToolEnvelope } = await import("./http-transport.js");
const { illuciRemoteClient } = await import("./remote-client.js");

test("verb contract: [A22.8] REST verbs mirror MCP tools/call over one governed pipeline", async (t) => {
  const svc = await startHttpTransport({ port: 0, tenantId: "verb-contract-test" });
  const client = illuciRemoteClient({ baseUrl: svc.url });
  try {
    const rest = (path, payload) =>
      fetch(`${svc.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const mcpToolCall = async (name, args) => {
      const r = await fetch(`${svc.url}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      });
      return (await r.json()).result;
    };

    await t.test("MCP==API: the datastore-query verb's REST body deep-equals the MCP payload", async () => {
      const args = { verb: "sql", sql: "SELECT 1 AS one" };
      const restRes = await rest("/runtime/datastore/query", args);
      assert.equal(restRes.status, 200);
      const restBody = await restRes.json();
      const mcpEnvelope = await mcpToolCall("datastore_query_v1", args);
      const mcpPayload = unwrapToolEnvelope(mcpEnvelope);
      assert.deepEqual(restBody, mcpPayload, "one pipeline, two wire shapes — payloads identical");
    });

    await t.test("MCP==API: the genome read verbs' REST bodies deep-equal the MCP payloads ([A88])", async () => {
      const projectDir = mkdtempSync(join(tmpdir(), "illuci-verb-genome-"));
      const args = { projectDir, slug: "unborn-verb" };
      for (const [path, name] of [
        ["/runtime/genome/status", "genome_status_v1"],
        ["/runtime/genome/profile", "genome_profile_v1"],
      ]) {
        const restRes = await rest(path, args);
        assert.equal(restRes.status, 200);
        const restBody = await restRes.json();
        assert.deepEqual(restBody, { projectDir, slug: "unborn-verb", exists: false }, `${name}: a read verb never births a genome`);
        const mcpPayload = unwrapToolEnvelope(await mcpToolCall(name, args));
        assert.deepEqual(restBody, mcpPayload, "one pipeline, two wire shapes — payloads identical");
      }
      const invalid = await rest("/runtime/genome/status", {});
      assert.equal(invalid.status, 400);
      assert.match((await invalid.json()).error, /projectDir \(string\) is required/);
    });

    await t.test("remote client verb == raw REST body", async () => {
      const args = { verb: "sql", sql: "SELECT 1 AS one" };
      const viaClient = await client.datastoreQuery(args);
      const viaRest = await (await rest("/runtime/datastore/query", args)).json();
      assert.deepEqual(viaClient, viaRest);
    });

    await t.test("run-topology verb: governed validation errors surface as 400, fail-fast (no dispatch)", async () => {
      const missing = await rest("/runtime/run-topology", {});
      assert.equal(missing.status, 400);
      assert.match((await missing.json()).error, /topology \(string\) is required/);

      const unknown = await rest("/runtime/run-topology", { topology: "no-such-topology", task: "x" });
      assert.equal(unknown.status, 400);
      assert.match((await unknown.json()).error, /unknown topology/);
    });

    await t.test("run-topology verb: runControl.tools.autonomy checkpointed reaches the transport's channel ([A58])", async () => {
      // The port gate precedes topology lookup, so a portless boundary refuses on the
      // port BEFORE naming the topology. Getting the topology error back proves the
      // REST path now carries ctx.checkpointPort exactly like /mcp — hermetically,
      // at the validation edge, with no dispatch.
      const r = await rest("/runtime/run-topology", {
        topology: "no-such-topology",
        task: "x",
        runControl: { tools: { autonomy: "checkpointed" } },
      });
      assert.equal(r.status, 400);
      const err = (await r.json()).error;
      assert.doesNotMatch(err, /checkpoint port/, "the REST boundary is not portless — this transport owns the channel");
      assert.match(err, /unknown topology/, "validation proceeded past the port gate to topology lookup");
    });

    await t.test("dispatch verb: a failed dispatch is LOUD over the wire ([A44]/F-084) — never a silent empty success", async () => {
      const r = await rest("/runtime/dispatch", { model: "no-such-model-a44", prompt: "x" });
      assert.equal(r.status, 400);
      assert.ok((await r.json()).error, "failure carried as an error, not response:''");
    });

    await t.test("dispatch verb: governed validation errors surface as 400, fail-fast (no dispatch)", async () => {
      const missing = await rest("/runtime/dispatch", {});
      assert.equal(missing.status, 400);
      assert.ok((await missing.json()).error, "validation error carried");
    });

    await t.test("the verb table is curated — no generic tool pass-through over REST", async () => {
      // [A43] the grants verbs join the curated table (the runtime capability boundary).
      // [A88] the genome read verbs join it (the learning loop's host window).
      assert.deepEqual(Object.values(RUNTIME_ACTION_VERBS).sort(), ["datastore_query_v1", "dispatch_v1", "genome_profile_v1", "genome_status_v1", "grants_issue_v1", "grants_list_v1", "grants_revoke_v1", "grants_verify_v1", "run_topology_v1"]);
      const r = await rest("/runtime/crucible_classify_v1", { question: "?" });
      assert.equal(r.status, 404, "an unlisted tool is not REST-reachable");
    });

    await t.test("a non-object body rejects 400 before the pipeline", async () => {
      const r = await rest("/runtime/datastore/query", [1, 2, 3]);
      assert.equal(r.status, 400);
    });
  } finally {
    await svc.close();
  }
});
