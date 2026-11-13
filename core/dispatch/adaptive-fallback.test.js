import { describe, expect, it } from "vitest";

import {
  buildAdaptiveExecutionPlan,
  resolveAdaptiveControls,
} from "./adaptive-fallback.js";

const codexDefaults = {
  adaptive: {
    reasoning: {
      supported: true,
      tiers: ["xhigh", "high", "medium"],
      timeoutMs: {
        xhigh: 300000,
        high: 180000,
        medium: 120000,
      },
    },
  },
};

describe("adaptive fallback planning", () => {
  it("uses Max's selected timeout and respects a disabled fallback", () => {
    const defaults = { adaptive: { reasoning: { supported: true, tiers: ["max", "xhigh", "high"], timeoutMs: { max: 360000, xhigh: 300000, high: 180000 } } } };
    const plan = buildAdaptiveExecutionPlan("codex-terra", { reasoning: "max" }, defaults, { adaptiveFallback: false, reasoningFloor: "medium" });
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ reasoningTier: "max", timeoutMs: 360000, options: { reasoning: "max" }, fallback: false });
    const defaultPlan = buildAdaptiveExecutionPlan("codex", { reasoning: "max" }, defaults, { adaptiveFallback: true, reasoningFloor: "high" });
    expect(defaultPlan.map(attempt => attempt.reasoningTier)).toEqual(["max"]);
    const adaptive = buildAdaptiveExecutionPlan("codex", { reasoning: "max", adaptiveFallback: true }, defaults, { adaptiveFallback: true, reasoningFloor: "high" });
    expect(adaptive.map(attempt => attempt.reasoningTier)).toEqual(["max", "xhigh", "high"]);
  });
  it("builds a codex reasoning fallback chain down to medium by default", () => {
    const controls = resolveAdaptiveControls({}, {});
    const plan = buildAdaptiveExecutionPlan(
      "codex-local",
      { reasoning: "xhigh" },
      codexDefaults,
      controls,
    );

    expect(plan.map((attempt) => attempt.reasoningTier)).toEqual(["xhigh", "high", "medium"]);
    expect(plan.map((attempt) => attempt.timeoutMs)).toEqual([300000, 180000, 120000]);
  });

  it("stops at the configured floor tier", () => {
    const plan = buildAdaptiveExecutionPlan(
      "codex-local",
      { reasoning: "xhigh" },
      codexDefaults,
      { adaptiveFallback: true, reasoningFloor: "high" },
    );

    expect(plan.map((attempt) => attempt.reasoningTier)).toEqual(["xhigh", "high"]);
  });

  it("disables fallback when adaptive controls are off", () => {
    const plan = buildAdaptiveExecutionPlan(
      "codex-local",
      { reasoning: "xhigh" },
      codexDefaults,
      { adaptiveFallback: false, reasoningFloor: "medium" },
    );

    expect(plan).toHaveLength(1);
    expect(plan[0].reasoningTier).toBe("xhigh");
    expect(plan[0].fallback).toBe(false);
  });

  it("reads adaptive controls from dynamic toggles", () => {
    const controls = resolveAdaptiveControls({}, {
      ILLUCI_ADAPTIVE_FALLBACK: "off",
      ILLUCI_REASONING_FLOOR: "high",
    });

    expect(controls).toEqual({
      adaptiveFallback: false,
      reasoningFloor: "high",
    });
  });
});
