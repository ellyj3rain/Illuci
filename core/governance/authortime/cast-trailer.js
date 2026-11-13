// illuci/core/governance/authortime/cast-trailer.js
//
// Atom (warn-tier by default): Standard 15 commit-scope attribution discipline.
// Git and GitHub record the human operator as contributor of record. Model, harness,
// persona, role, topology, and cast provenance belong in ledgers, runtime data,
// governed records, or prose where that context is actually explanatory. A Git commit
// therefore must not append a model-named Co-Authored-By trailer. A Cast: trailer is
// allowed as ordinary prose/provenance, but it is not required repository hygiene.
//
// PURE + clock-free: it reads only the message text and matches the model coauthor
// trailer grammar. It never tries to infer authorship from prose.

// A model-as-coauthor trailer Standard 15 forbids. Anchored to a line start (multiline)
// so a prose mention of a model name in the body is never a false positive - only a
// real `Co-Authored-By:` trailer naming a fleet model trips it.
const MODEL_COAUTHOR = /^Co-Authored-By:\s*(Claude|GPT|Gemini|DeepSeek|Kimi|GLM|Grok|Minimax|Qwen|Llama)\b/im;

/**
 * Check a commit message against Standard 15 commit-scope attribution discipline.
 *
 * @param {string|null} message  the full commit message text
 * @returns {{ok:boolean, code:string, reason:string}}
 *   ok:true  -> no-message | operator-git-author
 *   ok:false -> model-coauthor-present  (advisory under the warn policy)
 */
export function checkAttribution(message) {
  const msg = message == null ? "" : String(message);
  if (msg.trim() === "") {
    return { ok: true, code: "no-message", reason: "no message" };
  }

  if (MODEL_COAUTHOR.test(msg)) {
    return {
      ok: false,
      code: "model-coauthor-present",
      reason:
        "commit carries a model Co-Authored-By trailer; per Standard 15, Git authorship stays with the human operator while model and harness participation belong in provenance records",
    };
  }

  return {
    ok: true,
    code: "operator-git-author",
    reason: "commit carries no model-named Git coauthor trailer",
  };
}

export default { checkAttribution };
