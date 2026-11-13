/**
 * illuci - Dispatch race helpers
 *
 * raceQuery: race a single bridge query against BOTH a wall-clock timeout and an
 * optional abort signal. Rejects Error("TIMEOUT") when timeoutMs elapses first
 * (which drives the reasoning-tier fallback in dispatch.js) and Error("ABORTED")
 * the instant the signal fires (a top-level cancel / run budget - fails fast,
 * never falls back). The timer + abort listener are cleared on settle so a
 * finished query can never pin the Node event loop. With no signal it is a plain
 * query-vs-timeout race, byte-identical to the prior inline behavior.
 *
 * Kept dependency-free (no bridge/throttle/governance imports) so it is unit-
 * testable in isolation under node:test without standing up the dispatch stack.
 * (Sibling raceAbort still lives in dispatch.js on the streaming path; the two
 * could be consolidated here in a later pass.)
 */
export async function raceQuery(queryPromise, { timeoutMs, signal = null, onTimeout = null } = {}) {
  let raceTimer = null;
  let onAbort = null;
  const racers = [queryPromise];
  const finiteTimeoutMs = Number(timeoutMs);
  if (Number.isFinite(finiteTimeoutMs) && finiteTimeoutMs > 0) {
    racers.push(new Promise((_, reject) => {
      raceTimer = setTimeout(() => {
        try {
          if (typeof onTimeout === "function") onTimeout();
        } catch {}
        reject(new Error("TIMEOUT"));
      }, finiteTimeoutMs);
    }));
  }
  if (signal) {
    racers.push(new Promise((_, reject) => {
      onAbort = () => reject(new Error("ABORTED"));
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }));
  }
  try {
    return await Promise.race(racers);
  } finally {
    if (raceTimer) clearTimeout(raceTimer);
    if (onAbort && signal) signal.removeEventListener("abort", onAbort);
  }
}

export default { raceQuery };
