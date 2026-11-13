/**
 * illuci - raceQuery (node:test)
 *
 * AMD-7 safety valve. The buffered dispatch race now honors options.signal, so a
 * top-level abort/budget interrupts an in-flight attempt and fails fast - headroom
 * can never mask a stuck seat. Proves: query wins -> resolves; timeout first ->
 * Error("TIMEOUT") (drives the reasoning-tier fallback); signal -> Error("ABORTED")
 * immediately (never a fallback); no signal -> plain query-vs-timeout race.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { raceQuery } from "./race.js";

const after = (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms));
const never = () => new Promise(() => {});

test("raceQuery: resolves with the query value when the query wins", async () => {
  const result = await raceQuery(after(5, { response: "ok" }), { timeoutMs: 1000 });
  assert.deepEqual(result, { response: "ok" });
});

test("raceQuery: rejects TIMEOUT when the timeout elapses before the query", async () => {
  await assert.rejects(raceQuery(never(), { timeoutMs: 20 }), /TIMEOUT/);
});

test("raceQuery: calls onTimeout when the timeout wins", async () => {
  let called = 0;
  await assert.rejects(raceQuery(never(), { timeoutMs: 20, onTimeout: () => { called++; } }), /TIMEOUT/);
  assert.equal(called, 1);
});

test("raceQuery: no timeout means the query owns completion", async () => {
  assert.equal(await raceQuery(after(5, "no-timeout"), {}), "no-timeout");
});

test("raceQuery: a pre-aborted signal rejects ABORTED immediately (fail fast)", async () => {
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(raceQuery(never(), { timeoutMs: 1000, signal: ac.signal }), /ABORTED/);
});

test("raceQuery: a signal firing mid-race rejects ABORTED before the timeout", async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 10);
  await assert.rejects(raceQuery(never(), { timeoutMs: 5000, signal: ac.signal }), /ABORTED/);
});

test("raceQuery: with no signal it is a plain query-vs-timeout race (resolves)", async () => {
  assert.equal(await raceQuery(after(5, 42), { timeoutMs: 1000 }), 42);
});
