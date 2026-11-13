export function buildExecuteCommandPrompt({ seatLabel = "Executor", input = "", workspaceRoot = null, projectId = null } = {}) {
  const targetEvidence = [
    workspaceRoot ? `Workspace root: ${workspaceRoot}` : null,
    projectId ? `Project id: ${projectId}` : null,
  ].filter(Boolean).join("\n");

  const targetBlock = targetEvidence ? `\nTarget evidence:\n${targetEvidence}\n` : "";

  return `You are the "${seatLabel}". Build a JSON array of commands to execute for verification/testing.

Only include commands justified by the provided target repository evidence and task context.
If the context does not identify the target repository, scripts, files, or command surface clearly enough for a meaningful check, return [] instead of guessing.

Format: [{"cmd": "<repo-evidence-backed command>"}]${targetBlock}
Context:
${input}`;
}
