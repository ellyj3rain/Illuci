#!/usr/bin/env node
// Commit-message gate for batch-prefix discipline.
//
// Usage:
//   node commit-message-cli.mjs <commit-message-file>
//   node commit-message-cli.mjs --message "[A2] summary"
//   node commit-message-cli.mjs --allow-github-merge-body --message "Merge pull request..."
//
// Exit 0 = batch prefix present. Exit 1 = missing/malformed batch prefix.
// Attribution is warn-tier here, matching floor-check.js's DEFAULT_FLOOR_POLICY.

import { readFileSync } from "node:fs";
import { checkBatchPrefix } from "./batch-prefix.js";
import { checkAttribution } from "./cast-trailer.js";

const args = process.argv.slice(2);
const messageIdx = args.indexOf("--message");
const allowGithubMergeBody = args.includes("--allow-github-merge-body");
const inlineMessage =
  messageIdx !== -1 && args[messageIdx + 1] && !args[messageIdx + 1].startsWith("--")
    ? args[messageIdx + 1]
    : null;
const file = args.find((a, i) => {
  if (a.startsWith("--")) return false;
  if (messageIdx !== -1 && i === messageIdx + 1) return false;
  return true;
});

function meaningfulLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function githubMergeSubject(subject) {
  return /^Merge pull request #\d+ from \S+/.test(String(subject || "").trim());
}

// [A15.5.10] The dual-forge posture (design/forge-posture.md) fast-forwards GitHub `main` to
// GitLab-merged commits, whose default subject is `Merge branch 'batch/aXX…' into 'main'` — no
// [A#] in the subject, and NOT the GitHub `Merge pull request #N` shape. The batch id lives in
// the source-branch NAME. Recognize that shape and reconstruct the batch token from the branch.
function gitlabMergeSubject(subject) {
  return /^Merge branch '[^']+' into '[^']+'/.test(String(subject || "").trim());
}
function batchFromGitlabMerge(subject) {
  const m = /^Merge branch '([^']+)' into '[^']+'/.exec(String(subject || "").trim());
  if (!m) return null;
  const b = /(?:^|\/)((?:A|B)\d+(?:\.\d+){0,3})(?=[-/]|$)/i.exec(m[1]);
  return b ? `[${b[1].toUpperCase()}]` : null;
}

let message = inlineMessage;
if (message == null && file) {
  message = readFileSync(file, "utf8");
}

const lines = meaningfulLines(message);
const subject = lines[0] || "";
let checkedSubject = subject;
let batch = checkBatchPrefix(subject);

if (!batch.ok && allowGithubMergeBody && githubMergeSubject(subject)) {
  checkedSubject = lines[1] || "";
  batch = checkBatchPrefix(checkedSubject);
  if (!batch.ok) {
    process.stderr.write(
      "GZDS commit-message gate: BLOCKED - GitHub merge commit subject requires a batch-prefixed PR title in the message body\n",
    );
    process.exit(1);
  }
}

// [A15.5.10] GitLab merge commit (dual-forge FF onto GitHub main): the batch id is carried by
// the source-branch name in the subject, not by a body line.
if (!batch.ok && allowGithubMergeBody && gitlabMergeSubject(subject)) {
  const reconstructed = batchFromGitlabMerge(subject);
  if (reconstructed) {
    checkedSubject = `${reconstructed} (GitLab merge of ${subject.replace(/^Merge branch '([^']+)'.*/, "$1")})`;
    batch = checkBatchPrefix(checkedSubject);
  }
  if (!batch.ok) {
    process.stderr.write(
      "GZDS commit-message gate: BLOCKED - GitLab merge commit must name a batch/[AB]#… source branch\n",
    );
    process.exit(1);
  }
}

if (!batch.ok) {
  process.stderr.write("GZDS commit-message gate: BLOCKED - " + batch.reason + "\n");
  process.exit(1);
}

const attribution = checkAttribution(message);
if (!attribution.ok) {
  process.stderr.write("GZDS commit-message gate: WARN - " + attribution.reason + "\n");
}

const suffix = checkedSubject !== subject ? " via merge body \"" + checkedSubject.slice(0, 80) + "\"" : "";
process.stdout.write("GZDS commit-message gate: OK (" + batch.reason + suffix + ")\n");
process.exit(0);
