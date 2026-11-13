# code-review

A capability-half skill in the `engineering` domain. Systematic evaluation of code changes for correctness, style, performance, and security. Reads diffs structurally, not line-by-line.

## What the skill is

Code Review reads a diff as a whole before commenting on any individual line. The point is to understand the change as a structural movement, then evaluate it. The skill is review, not implementation, and its tool posture reflects that.

## Heuristics

Read the full diff before commenting on any individual line. Distinguish between blocking issues and suggestions, and never blur the two. Check for regression risk: does this change break existing behavior. Evaluate naming, abstraction boundaries, and test coverage. Flag security implications explicitly when present, do not let them hide inside a style comment.

## Tool-weighting posture

`grep_search: 0.9` and `read_file: 0.9` carry the work. Code Review leans on search and read because it is inspecting, not editing. `bash: 0.5` is present for running tests, which is how the reviewer validates a claim about behavior rather than trusting the diff description. `edit_file: 0.1` is intentionally minimal: this is review, not implementation, and the low weight keeps the skill from drifting into rewriting the code it is supposed to judge.

## Invariants

All flagged issues include a severity, either blocking or suggestion. Reviews reference specific lines or ranges, not vague descriptions. These two are non-negotiable. A review with no severities, or a review that says "around here" without a line, fails the skill contract.

## Autonomy envelope

`requiresIntrospector: false`, `maxDepth: 0`, `maxBudgetTokens: 30000`, `sandboxRequired: false`. Code Review does not need the introspector and does not recurse. It works at depth 0 against a bounded budget and needs no sandbox because it is not executing untrusted code, only running tests the operator already has.

## dispositionPull

`conscientiousness: +0.15`, `agreeableness: -0.10`. The conscientiousness lift biases the agent toward systematic, line-referenced, severity-tagged review. The negative agreeableness is deliberate: reviewers should push back. A reviewer optimized for agreeableness will soften a blocking issue into a suggestion, which is exactly the failure mode the invariants exist to prevent.

## Bridges

None. `bridges: []`. Code Review is on-floor only and does not attach external MCP/CLI tooling.