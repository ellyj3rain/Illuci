import test from "node:test";
import assert from "node:assert/strict";

import { defineResolutionRecord } from "./resolution-record.js";

test("resolution records preserve dynamic outcomes with governance metadata", () => {
  const record = defineResolutionRecord({
    layer: "role",
    query: "react hooks",
    resolved: { id: "specialist/react/hooks-architect" },
    candidates: [{ id: "specialist/react/hooks-architect", confidence: 0.91 }],
    resolver: "test-resolver-v1",
  });

  assert.equal(record.layer, "role");
  assert.equal(record.telemetry.status, "resolved");
  assert.equal(record.telemetry.resolver, "test-resolver-v1");
  assert.equal(record.governance.dynamic, true);
  assert.equal(record.governance.auditable, true);
});

test("weak matches remain visible without becoming resolved", () => {
  const record = defineResolutionRecord({
    layer: "model",
    query: "cheap visual long context",
    resolved: null,
    candidates: [{ id: "candidate", confidence: 0.22 }],
    resolver: "test-resolver-v1",
  });

  assert.equal(record.resolved, null);
  assert.equal(record.confidence, 0.22);
  assert.equal(record.telemetry.status, "candidates-below-threshold");
});
