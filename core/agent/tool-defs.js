/**
 * illuci Agent SDK — Native Tool Definitions
 *
 * JSON-schema definitions for illuci's built-in tool surface, rendered in the
 * provider-native function-calling shape the bridges forward via
 * options.tools:
 *
 *   { type: "function", function: { name, description, parameters } }
 *
 * This is the schema half the core-loop audit found missing: tool-protocol's
 * priority-1 NATIVE path and the ollama bridge's options.tools plumbing both
 * existed, but nothing ever BUILT definitions to send, so every model was
 * forced through the JSON-in-prose protocol. buildToolDefinitions() closes
 * that gap for the curated core tools.
 *
 * Names without a curated schema (OS-control, Burp, UE5, MCP-namespaced) are
 * OMITTED rather than auto-generated: the hybrid prose protocol still covers
 * them every turn, and an inaccurate machine-guessed schema would mislead the
 * model worse than no schema. Curate before you emit.
 *
 * Schemas mirror the handler signatures in bridges/tools.js — keep the two in
 * sync when a tool's parameters change.
 */

const str = (description) => ({ type: "string", description });
const int = (description) => ({ type: "integer", description });
const bool = (description) => ({ type: "boolean", description });

/** name → { description, parameters } (parameters = JSON Schema object). */
export const TOOL_SCHEMAS = {
  file_read: {
    description: "Read a UTF-8 text file from the workspace.",
    parameters: {
      type: "object",
      properties: {
        path: str("File path (workspace-relative or absolute within the workspace)."),
        offset: int("1-based line number to start reading from (optional)."),
        limit: int("Maximum number of lines to read (optional)."),
      },
      required: ["path"],
    },
  },
  file_write: {
    description: "Write content to a file, creating parent directories as needed. Overwrites existing content.",
    parameters: {
      type: "object",
      properties: {
        path: str("Destination file path."),
        content: str("Full file content to write."),
      },
      required: ["path", "content"],
    },
  },
  file_edit: {
    description: "Edit an existing file: replace oldString with newString, or overwrite the whole file with content.",
    parameters: {
      type: "object",
      properties: {
        path: str("File path to edit."),
        oldString: str("Exact text to find (used with newString)."),
        newString: str("Replacement text (used with oldString)."),
        content: str("Full replacement content (alternative to oldString/newString)."),
      },
      required: ["path"],
    },
  },
  file_delete: {
    description: "Delete a file from the workspace.",
    parameters: {
      type: "object",
      properties: { path: str("File path to delete.") },
      required: ["path"],
    },
  },
  file_move: {
    description: "Move or rename a file within the workspace.",
    parameters: {
      type: "object",
      properties: {
        source: str("Current file path."),
        destination: str("New file path."),
      },
      required: ["source", "destination"],
    },
  },
  search: {
    description: "Search file contents for a pattern (ripgrep).",
    parameters: {
      type: "object",
      properties: {
        pattern: str("Search pattern (regular expression)."),
        path: str("Directory or file to search (default: workspace root)."),
        type: str("Search type hint (default: \"content\")."),
      },
      required: ["pattern"],
    },
  },
  glob: {
    description: "Find files by name pattern.",
    parameters: {
      type: "object",
      properties: {
        pattern: str("Filename pattern, e.g. \"*.js\"."),
        path: str("Directory to search under (default: workspace root)."),
      },
      required: ["pattern"],
    },
  },
  shell_exec: {
    description: "Execute a shell command in the workspace (gated).",
    parameters: {
      type: "object",
      properties: {
        command: str("Command line to execute."),
        workingDirectory: str("Working directory (default: workspace root)."),
        timeout: int("Timeout in milliseconds (default 60000)."),
      },
      required: ["command"],
    },
  },
  git_status: {
    description: "Show the git working-tree status (porcelain).",
    parameters: { type: "object", properties: {} },
  },
  git_log: {
    description: "Show recent git commits.",
    parameters: {
      type: "object",
      properties: {
        limit: int("Number of commits to show, 1-1000 (default 10)."),
        format: str("Log format (default \"oneline\")."),
      },
    },
  },
  git_diff: {
    description: "Show git diff for the working tree or a specific path.",
    parameters: {
      type: "object",
      properties: {
        path: str("Limit the diff to this path (optional)."),
        staged: bool("Diff staged changes instead of the working tree."),
      },
    },
  },
  git_add: {
    description: "Stage files for commit.",
    parameters: {
      type: "object",
      properties: {
        paths: { type: "array", items: { type: "string" }, description: "File paths to stage." },
      },
      required: ["paths"],
    },
  },
  git_commit: {
    description: "Create a git commit with the staged changes (gated).",
    parameters: {
      type: "object",
      properties: { message: str("Commit message.") },
      required: ["message"],
    },
  },
  git_push: {
    description: "Push commits to the remote (gated).",
    parameters: {
      type: "object",
      properties: { force: bool("Force-push (default false).") },
    },
  },
  http_fetch: {
    description: "Fetch a URL over HTTP(S).",
    parameters: {
      type: "object",
      properties: {
        url: str("URL to fetch."),
        method: str("HTTP method (default GET)."),
        headers: { type: "object", description: "Request headers (optional)." },
        body: str("Request body (optional)."),
        timeout: int("Timeout in milliseconds (default 30000)."),
      },
      required: ["url"],
    },
  },
  browse_page: {
    description: "Load a web page in a headless browser and extract its content.",
    parameters: {
      type: "object",
      properties: {
        url: str("Page URL."),
        instructions: str("What to look for or extract (optional)."),
        timeout: int("Timeout in milliseconds (default 30000)."),
      },
      required: ["url"],
    },
  },
};

/**
 * Build provider-native tool definitions for a run's allowed tool names.
 * Unknown names are skipped (covered by the hybrid prose protocol instead).
 *
 * @param {string[]} toolNames — the run's allowed tool names
 * @returns {Array<{type: "function", function: {name, description, parameters}}>}
 */
export function buildToolDefinitions(toolNames = []) {
  const defs = [];
  for (const name of toolNames) {
    const schema = TOOL_SCHEMAS[name];
    if (!schema) continue;
    defs.push({
      type: "function",
      function: { name, description: schema.description, parameters: schema.parameters },
    });
  }
  return defs;
}

export default { TOOL_SCHEMAS, buildToolDefinitions };
