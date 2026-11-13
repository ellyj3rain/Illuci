// illuci -- warehouse-native draft intake coordinate discipline (node:test)

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  assessWarehouseIntakeCoordinates,
  prepareSubBatchPlan,
  prepareWarehouseIntakePacket,
  INTAKE_COORDINATE_CLAIM,
  INTAKE_SUBBATCH_LABEL_CLAIM,
} from "./warehouse-intake.js";

test("warehouse intake maps unlabeled draft slices to local ids without durable coordinates", () => {
  const packet = prepareWarehouseIntakePacket({
    slices: [
      { title: "License and attribution asset schema" },
      { title: "Asset decomposition specialty" },
    ],
  });

  assert.equal(packet.ok, true);
  assert.equal(packet.stationId, "S0-intake");
  assert.equal(packet.stationLedgerId, "W0");
  assert.deepEqual(packet.slices.map((s) => s.localId), ["intake-slice-1", "intake-slice-2"]);
  assert.equal(packet.slices[0].durableCoordinate, null);
});

test("warehouse intake refuses slice labels that look like durable coordinates", () => {
  const packet = prepareWarehouseIntakePacket({
    slices: [{ label: "W1", title: "License and attribution asset schema" }],
  });

  assert.equal(packet.ok, false);
  assert.equal(packet.findings.length, 1);
  assert.equal(packet.findings[0].code, INTAKE_COORDINATE_CLAIM);
  assert.equal(packet.findings[0].token, "W1");
});

test("planning artifact scan flags noun-derived coordinate labels", () => {
  const result = assessWarehouseIntakeCoordinates({
    path: "design/scope-packet.md",
    oldContent: "# Packet\n",
    newContent: "# Packet\n\n| S1 | Security lane hardening |\n",
  });

  assert.equal(result.ok, false);
  assert.equal(result.findings[0].token, "S1");
  assert.equal(result.findings[0].line, 3);
});

test("planning artifact scan allows warehouse station ledgers in warehouse context", () => {
  const result = assessWarehouseIntakeCoordinates({
    path: "design/factory-note.md",
    oldContent: "# Factory\n",
    newContent: "# Factory\n\n| W1 | Ideation station ledger in the warehouse belt |\n",
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.findings, []);
});

test("planning artifact scan ignores non-markdown source strings", () => {
  const result = assessWarehouseIntakeCoordinates({
    path: "core/example.test.js",
    oldContent: "",
    newContent: "const label = 'W1';\n",
  });

  assert.equal(result.ok, true);
});

test("sub-batch plan normalizes unlabeled slices to numeric children of the parent batch", () => {
  const packet = prepareSubBatchPlan({
    parentBatch: "A14",
    slices: [
      { title: "Visual parity audit" },
      { title: "CSS parity repair" },
    ],
  });

  assert.equal(packet.ok, true);
  assert.equal(packet.parentBatch, "A14");
  assert.deepEqual(packet.slices.map((s) => s.batchLabel), ["A14.1", "A14.2"]);
  assert.deepEqual(packet.slices.map((s) => s.localId), ["sub-batch-slice-1", "sub-batch-slice-2"]);
});

test("sub-batch plan accepts explicit immediate numeric child labels", () => {
  const packet = prepareSubBatchPlan({
    parentBatch: "A14",
    slices: [
      { label: "A14.1", title: "Visual parity audit" },
      { label: "A14.2", title: "CSS parity repair" },
    ],
  });

  assert.equal(packet.ok, true);
  assert.deepEqual(packet.slices.map((s) => s.batchLabel), ["A14.1", "A14.2"]);
});

test("sub-batch plan rejects noun-derived labels before they harden", () => {
  const packet = prepareSubBatchPlan({
    parentBatch: "A14",
    slices: [{ label: "S", title: "Security lane hardening" }],
  });

  assert.equal(packet.ok, false);
  assert.equal(packet.findings.length, 1);
  assert.equal(packet.findings[0].code, INTAKE_SUBBATCH_LABEL_CLAIM);
  assert.equal(packet.findings[0].route, "operator");
  assert.equal(packet.findings[0].token, "S");
  assert.match(packet.findings[0].reason, /A14\.1/);
});

test("planning artifact scan allows numeric sub-batch labels", () => {
  const result = assessWarehouseIntakeCoordinates({
    path: "design/example-batch-plan.md",
    oldContent: "# Plan\n",
    newContent: "# Plan\n\n| A14.1 | Visual parity audit |\n| A14.2 | CSS parity repair |\n",
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.findings, []);
});

test("planning artifact scan flags bare noun-derived sub-batch labels", () => {
  const result = assessWarehouseIntakeCoordinates({
    path: "design/example-batch-plan.md",
    oldContent: "# Plan\n",
    newContent: "# Plan\n\n| S | Security lane hardening |\n",
  });

  assert.equal(result.ok, false);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].code, INTAKE_SUBBATCH_LABEL_CLAIM);
  assert.equal(result.findings[0].token, "S");
  assert.equal(result.findings[0].line, 3);
});

test("planning artifact scan ignores governance ledger ids that contain single-letter prefixes", () => {
  const result = assessWarehouseIntakeCoordinates({
    path: "FINDINGS.md",
    oldContent: "# Findings\n",
    newContent: "# Findings\n\n## F-096 | Bare planning initials could still bypass durable-coordinate intake\n\n*Finding:* example\n",
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.findings, []);
});
