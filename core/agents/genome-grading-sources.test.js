// node:test — the genome grading-sources control (DR-194): terminal-by-default,
// optionality, fail-closed, salient disclosed.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  KNOWN_GRADING_SOURCES,
  RESERVED_GRADING_SOURCES,
  DEFAULT_GRADING_SOURCES,
  SALIENT_LIMITATION,
  normalizeGradingSources,
  isDefaultGradingSources,
  GradingSourcesConfigError,
} from "./genome-grading-sources.js";

test("default is tension-only (terminal-by-default, byte-identical)", () => {
  assert.deepEqual([...DEFAULT_GRADING_SOURCES], ["tension"]);
  assert.deepEqual([...normalizeGradingSources(null)], ["tension"]);
  assert.deepEqual([...normalizeGradingSources(undefined)], ["tension"]);
  assert.deepEqual([...normalizeGradingSources([])], ["tension"], "empty → default, not a mute run");
  assert.equal(isDefaultGradingSources(null), true);
  assert.equal(isDefaultGradingSources(["salient"]), false);
});

test("salient is a real selectable source; a comma string parses (optionality)", () => {
  assert.deepEqual([...normalizeGradingSources("salient")], ["salient"]);
  assert.deepEqual([...normalizeGradingSources("tension,salient")], ["tension", "salient"]);
  assert.deepEqual([...normalizeGradingSources(["salient", "tension"])], ["tension", "salient"], "order-stable (KNOWN order)");
  assert.deepEqual([...normalizeGradingSources(["salient", "salient"])], ["salient"], "deduped");
});

test("fail-closed: unknown sources throw loudly (DR-129, never a silent downgrade)", () => {
  assert.throws(() => normalizeGradingSources(["bogus"]), GradingSourcesConfigError);
  assert.throws(() => normalizeGradingSources("tension,bogus"), /unknown source "bogus"/);
  assert.throws(() => normalizeGradingSources(42), /must be an array/);
  assert.throws(() => normalizeGradingSources([7]), /must be strings/);
});

test("A102/DR-195: behavioral is now a KNOWN selectable source (the commissioned attribution director)", () => {
  assert.ok(KNOWN_GRADING_SOURCES.includes("behavioral"));
  assert.deepEqual([...RESERVED_GRADING_SOURCES], [], "nothing reserved any longer");
  assert.deepEqual([...normalizeGradingSources("tension,behavioral")], ["tension", "behavioral"]);
  assert.deepEqual([...normalizeGradingSources(["behavioral", "salient", "tension"])], ["tension", "salient", "behavioral"], "order-stable (KNOWN order)");
});

test("the salient limitation is disclosed as data (informed-consent surface)", () => {
  assert.match(SALIENT_LIMITATION, /NOT attribution-grounded/);
  assert.match(SALIENT_LIMITATION, /autocatalysis/);
  // [A102]/DR-195: the disclosure now names the grounded alternative that shipped.
  assert.match(SALIENT_LIMITATION, /behavioral/);
  assert.ok(KNOWN_GRADING_SOURCES.includes("salient") && KNOWN_GRADING_SOURCES.includes("tension"));
});
