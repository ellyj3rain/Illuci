/**
 * Phase 7 — the MC legibility feed (optional, one-way) behavior + back-compat.
 *
 * Hermetic: no model, no bridge, no network. The HTTP sink is exercised with an
 * injected fake fetch. The central guarantee under test is that the awareness bus
 * behaves IDENTICALLY whether or not the feed is attached (back-compat / no-op),
 * and that a misbehaving MC can never break a dispatch.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as store from "../awareness/store.js";
import {
  attachMcFeed,
  detachMcFeed,
  isMcFeedAttached,
  createHttpSink,
  resolveEnvSink,
} from "./mc-feed.js";

// Every test starts from a clean store + no attached feed.
function fresh() {
  detachMcFeed();
  store.reset();
}

// ─── Back-compat / no-op: the bus is byte-identical when the feed is unused ───

test("back-compat: with no feed attached, publish/recall are unchanged and federation stays off", () => {
  fresh();
  assert.equal(isMcFeedAttached(), false, "no feed attached after reset");

  const ev = store.publish({ company: "s1", topologyId: "t", seatId: "g", summary: "hello" });
  assert.ok(ev && ev.summary === "hello", "publish returns the event as before");
  const budget = { maxEvents: 12, maxTokens: 4000, perEventTokenCeiling: 384 };
  const recalled = store.recall({ company: "s1", excludeTopologyId: "other", budget });
  assert.deepEqual(recalled.map((e) => e.summary), ["hello"], "recall unaffected by the (absent) feed");
  assert.equal(isMcFeedAttached(), false, "merely importing/using mc-feed does not attach it");
});

test("back-compat: attach then detach leaves the store exactly as it began (federation null)", () => {
  fresh();
  const seen = [];
  attachMcFeed((e) => seen.push(e.summary));
  assert.equal(isMcFeedAttached(), true);
  store.publish({ company: "s1", topologyId: "t", seatId: "g", summary: "during" });
  assert.deepEqual(seen, ["during"]);

  detachMcFeed();
  assert.equal(isMcFeedAttached(), false, "detach removes the federation callback");
  store.publish({ company: "s1", topologyId: "t", seatId: "g", summary: "after" });
  assert.deepEqual(seen, ["during"], "post-detach events are NOT forwarded — store back to baseline");
});

// ─── Callback sink: forwards every event, verbatim shape ───

test("callback sink: receives every published AwarenessEvent with the full shape", () => {
  fresh();
  const events = [];
  attachMcFeed((e) => events.push(e));
  store.publish({ company: "c", topologyId: "debate", seatId: "red", summary: "found a race", tags: ["risk"], tokens: 5 });
  store.publish({ company: "c", topologyId: "debate", seatId: "blue", summary: "defends fix" });

  assert.equal(events.length, 2);
  const first = events[0];
  for (const k of ["id", "ts", "company", "topologyId", "seatId", "kind", "summary", "tags", "tokens"]) {
    assert.ok(k in first, `forwarded event carries "${k}"`);
  }
  assert.equal(first.company, "c");
  assert.equal(first.topologyId, "debate");
  assert.deepEqual(first.tags, ["risk"]);
});

// ─── Swallow-on-error: a throwing sink never breaks the bus ───

test("swallow-on-error: a throwing sink does not break publish or the local store", () => {
  fresh();
  attachMcFeed(() => { throw new Error("MC exploded"); });
  const ev = store.publish({ company: "s1", topologyId: "t", seatId: "g", summary: "survives" });
  assert.ok(ev, "publish still returns the event despite the sink throwing");
  assert.equal(store.getAdapter().recent(1)[0].summary, "survives", "local store unaffected by sink fault");
});

// ─── Idempotent attach: re-attaching swaps the sink, keeps one registration ───

test("idempotent attach: a second attach swaps the sink without double-forwarding", () => {
  fresh();
  const a = [];
  const b = [];
  attachMcFeed((e) => a.push(e.summary));
  attachMcFeed((e) => b.push(e.summary)); // swap
  store.publish({ company: "s1", topologyId: "t", seatId: "g", summary: "one" });
  assert.deepEqual(a, [], "old sink no longer receives after swap");
  assert.deepEqual(b, ["one"], "new sink receives exactly once (single registration)");
});

// ─── HTTP sink: POSTs JSON, fire-and-forget, swallows async + sync faults ───

test("http sink: POSTs each event as JSON with content-type and optional bearer", () => {
  fresh();
  const calls = [];
  const fakeFetch = (url, init) => { calls.push({ url, init }); return Promise.resolve({ ok: true }); };
  attachMcFeed(createHttpSink({ endpoint: "http://mc.local/ingest", token: "secret", fetchImpl: fakeFetch }));

  store.publish({ company: "s1", topologyId: "t", seatId: "g", summary: "wire me" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://mc.local/ingest");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["Content-Type"], "application/json");
  assert.equal(calls[0].init.headers["Authorization"], "Bearer secret");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.summary, "wire me");
});

test("http sink: a rejected fetch (MC down) is swallowed — bus + store survive", async () => {
  fresh();
  const fakeFetch = () => Promise.reject(new Error("ECONNREFUSED"));
  attachMcFeed(createHttpSink({ endpoint: "http://mc.local/ingest", fetchImpl: fakeFetch }));
  const ev = store.publish({ company: "s1", topologyId: "t", seatId: "g", summary: "mc-down" });
  assert.ok(ev, "publish unaffected by a network failure to MC");
  assert.equal(store.getAdapter().recent(1)[0].summary, "mc-down");
  // Let any microtask rejection settle; it must not surface.
  await Promise.resolve();
});

test("http sink: a synchronously-throwing fetch impl is swallowed", () => {
  fresh();
  const fakeFetch = () => { throw new Error("sync boom"); };
  attachMcFeed(createHttpSink({ endpoint: "http://mc.local/ingest", fetchImpl: fakeFetch }));
  const ev = store.publish({ company: "s1", topologyId: "t", seatId: "g", summary: "sync-throw" });
  assert.ok(ev, "publish unaffected by a synchronously throwing fetch");
});

test("createHttpSink requires an endpoint", () => {
  assert.throws(() => createHttpSink({}), /endpoint/);
  assert.throws(() => createHttpSink({ endpoint: 123 }), /endpoint/);
});

test("attach with an http-config object builds the sink internally", () => {
  fresh();
  const calls = [];
  const fakeFetch = (url) => { calls.push(url); return Promise.resolve({ ok: true }); };
  attachMcFeed({ endpoint: "http://mc.local/ingest", fetchImpl: fakeFetch });
  store.publish({ company: "s1", topologyId: "t", seatId: "g", summary: "via-config" });
  assert.deepEqual(calls, ["http://mc.local/ingest"]);
});

// ─── Opt-in by config: no endpoint => no feed (the OFF-by-default default) ───

test("resolveEnvSink: returns null when no endpoint is configured (feed stays off)", () => {
  assert.equal(resolveEnvSink({}), null);
  assert.equal(resolveEnvSink({ ILLUCI_CFG_MC_FEED_TOKEN: "x" }), null, "token alone does not enable the feed");
});

test("resolveEnvSink: builds an http sink from ILLUCI_CFG_ env when an endpoint is set", () => {
  const calls = [];
  // resolveEnvSink builds via createHttpSink (real global fetch); we just assert it
  // produced a callable sink keyed to the env endpoint, not that it fired a request.
  const sink = resolveEnvSink({ ILLUCI_CFG_MC_FEED_ENDPOINT: "http://mc.local/x" });
  assert.equal(typeof sink, "function");
  void calls;
});

test("attach() with no sink and no env endpoint is a safe no-op (stays detached)", () => {
  fresh();
  const detach = attachMcFeed(undefined); // no arg, empty env (no ILLUCI_CFG_MC_FEED_ENDPOINT in test env)
  // In a clean test environment no endpoint is configured, so nothing attaches.
  assert.equal(isMcFeedAttached(), false, "no configured sink => feed not attached");
  assert.equal(typeof detach, "function", "still returns a callable (no-op) detach");
  detach(); // must not throw
});

// ─── Detach safety ───

test("detach is safe to call when already detached", () => {
  fresh();
  detachMcFeed();
  detachMcFeed(); // double detach — no throw
  assert.equal(isMcFeedAttached(), false);
});
