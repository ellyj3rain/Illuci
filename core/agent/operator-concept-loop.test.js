import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStream } from "./stream.js";
import { runSingleAgent } from "./loop.js";
import { reviewChiefWork, skillIdsForWorkItem } from "../roles/operator-concept-steward.js";

test("single-agent synthesis invokes steward and makes one concrete correction turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "illuci-concept-loop-"));
  try {
    for (const id of skillIdsForWorkItem()) {
      const dir = join(root, id);
      mkdirSync(dir);
      writeFileSync(join(dir, "SKILL.md"), `# ${id}\n`);
    }
    const stream = new EventStream();
    const observations = [];
    const turns = [];
    let response = 0;
    const outcome = await runSingleAgent({
      stream, runId: "run-1", direction: { intent: "Explain the first-week integration" },
      context: { cwd: process.cwd(), projectId: "example-project" },
      config: { agent: "chief-test", tools: [], maxSteps: 3,
        operatorConceptReview: {
          workItem: { id: "d2-week-one", objective: "Join ExampleProject's ontology" },
          operatorWords: [{ text: "every integration, it has to be rooted and chained to adhere to our ontology", sourceRef: "operator:direction" }],
          model: "steward-test", skillRoot: root,
        },
      },
    }, {
      queryModelStream: async function* (_model, message) {
        turns.push(message);
        const text = turns.length === 1
          ? "ImportedPlugin remains the native subject identity."
          : "I corrected the integration: ExampleProject local identity service owns identity; source roles are credited behavior inputs to appraisal and planning.";
        yield { type: "final", response: text };
      },
      reviewChiefWork: (input) => reviewChiefWork(input, {
        queryModel: async () => ({ response: JSON.stringify({ findings: [{
          kind: response++ === 0 ? "drift" : "fit",
          operatorQuote: "rooted and chained to adhere to our ontology",
          outputQuote: input.actualOutput.includes("ImportedPlugin") ? "ImportedPlugin remains" : "ExampleProject local identity service owns identity",
          reason: "The output's identity owner was checked against the operator rule.",
          nextAction: input.actualOutput.includes("ImportedPlugin") ? "Use ExampleProject local identity service." : null,
        }] }) }),
        record: (receipt) => { observations.push(receipt); return { id: `obs-${observations.length}` }; },
      }),
    });
    stream.close();
    const events = [];
    for await (const event of stream) events.push(event);
    assert.equal(outcome.ok, true);
    assert.equal(outcome.steps, 2);
    assert.equal(turns.length, 2);
    assert.match(turns[1], /operator-concept review/);
    assert.equal(observations.length, 2);
    assert.equal(observations[0].priorReviewCount, 0);
    assert.equal(observations[1].priorReviewCount, 1);
    assert.deepEqual(outcome.operatorConceptReviews.map((item) => item.verdict), ["drift", "fit"]);
    assert.equal(outcome.operatorConceptStatus, "fit");
    assert.equal(events.filter((event) => event.type === "synthesis").length, 1);
    assert.match(events.find((event) => event.type === "synthesis").text, /ExampleProject local identity service/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a second drift remains explicit after the bounded correction turn", async () => {
  const stream = new EventStream();
  let turns = 0;
  const outcome = await runSingleAgent({
    stream, runId: "run-drift", direction: { intent: "Check output" },
    context: { cwd: process.cwd() },
    config: { agent: "chief-test", tools: [], maxSteps: 3,
      operatorConceptReview: { workItem: { id: "work", objective: "Check" },
        operatorWords: [{ text: "native person", sourceRef: "operator:1" }] } },
  }, {
    queryModelStream: async function* () {
      turns += 1;
      yield { type: "final", response: turns === 1 ? "imported identity" : "still imported identity" };
    },
    reviewChiefWork: async () => ({ status: "reviewed", verdict: "drift",
      findings: [{ kind: "drift", operatorQuote: "native person",
        outputQuote: "imported identity", reason: "identity mismatch",
        nextAction: "Use the native person identity." }] }),
  });
  stream.close();
  const events = [];
  for await (const event of stream) events.push(event);
  assert.equal(turns, 2);
  assert.equal(outcome.operatorConceptStatus, "drift");
  assert.equal(events.find((event) => event.type === "synthesis").operatorConceptStatus, "drift");
});
