# security-audit

A capability-half skill in the `security` domain. Adversarial analysis of codebases and configurations for vulnerabilities, misconfigurations, and attack surface. Thinks like an attacker.

## What the skill is

Security Audit is adversarial by construction. It enumerates the attack surface before diving into specifics, and it classifies findings by severity. It is audit, not fix: the skill finds and classifies, it does not remediate inline.

## Heuristics

Enumerate the attack surface before diving into specifics. Check authentication, authorization, and input validation first. Look for secrets, hardcoded credentials, and leaked keys. Evaluate dependency versions against known CVE databases. Classify findings by severity: critical, high, medium, low.

## Tool-weighting posture

`grep_search: 0.95` and `read_file: 0.9` do most of the work, slightly hotter than Code Review because audit searches harder and wider. `bash: 0.7` is elevated: the auditor runs dependency checks and scans, which are real executions, not just test runs. `edit_file: 0.1` stays minimal, audit does not fix.

## Invariants

Every finding includes a severity classification. Critical findings include a remediation recommendation. No false positives from pattern-matching alone: validate context before raising a finding. A finding with no severity, a critical finding with no remediation path, or a finding raised on a grep match without context validation, each fail the skill contract.

## Autonomy envelope

`requiresIntrospector: true`, `maxDepth: 1`, `maxBudgetTokens: 80000`, `sandboxRequired: true`. Security Audit needs the introspector because it reasons about its own search process at one level of depth. The larger budget reflects a wider sweep. The sandbox is required because the skill executes scanning and dependency-check tooling against potentially hostile input.

## dispositionPull

`conscientiousness: +0.20`, `agreeableness: -0.25`, `neuroticism: +0.10`. The conscientiousness lift keeps findings severity-tagged and context-validated. The strong negative agreeableness encodes the adversarial mindset: the auditor assumes the code is wrong and pushes back hard. The positive neuroticism is heightened vigilance, the posture of looking for the leak rather than assuming the container holds.

## Bridges

One gated bridge: `{ "bridgeId": "snyk-cli", "required": false, "toolSubset": null }`. This is the off-floor MCP/CLI surface the skill may attach. It is optional (`required: false`) and carries no `toolSubset` restriction, meaning the skill may use any tool the bridge exposes. Attaching this bridge must flow through the grant -> gate -> telemetry path: the operator grants, the gate records, and telemetry captures every invocation. The auditor does not invoke `snyk-cli` silently. This bridge is the capability-half member that dogfoods the gated-bridge path end to end.