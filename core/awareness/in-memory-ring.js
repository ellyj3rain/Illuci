// Phase 3 — InMemoryRingAdapter, the default awareness store.
//
// A fixed-size ring buffer: O(1) append, self-evicting, newest-first read. It is
// the ONLY adapter in the default runtime path (the standalone baseline that keeps
// illuci non-dependent on MC). SQLite and MC-federated adapters implement the SAME
// StoreAdapter shape and layer on top via store.setAdapter() — they are opt-in, not
// in the default path. The store does all filtering and budget packing; the adapter
// is dumb storage.
//
// StoreAdapter shape (the seam MC's Musings can also implement):
//   name()                -> string
//   append(event)         -> void   (sync, never throws)
//   recent(limit)         -> AwarenessEvent[]   (newest-first, up to limit)
//   snapshot()            -> AwarenessEvent[]    (all live events, newest-first)
//   restore(events)       -> void   (re-seed, e.g. from a federated peer)
//   clear()               -> void
//
// Phase F (harden) — concurrency safety. Under runCompany, parallel seats publish
// concurrently. The append() body `ring[head]=e; head=(head+1)%cap` is a read-modify-
// write of the shared head: if two appends interleave between the write and the
// increment, both target the same slot — one event is silently overwritten and lost,
// and count over-counts. A single JS event loop cannot preempt mid-statement, but a
// re-entrant call (e.g. a synchronous federation/observer hook that publishes during
// an append) CAN interleave, and Phase-2 worker-thread isolation will make the race
// real across threads. The fix keeps append SYNCHRONOUS (store.publish must never block)
// and wraps the slot mutation in an explicit, indivisible critical section guarded
// against re-entrancy: a re-entrant append is deferred to a queue and drained once the
// in-progress append's critical section completes, so no two writers ever hold `head`
// at once and zero events are lost. This guard is the seam batch 2 shims for a real
// cross-thread mutex.

export function createInMemoryRingAdapter({ capacity = 1024 } = {}) {
  const cap = Math.max(1, capacity | 0);
  const ring = new Array(cap);
  let head = 0; // next write slot
  let count = 0;

  // Re-entrancy guard for the append critical section. A nested append (triggered
  // synchronously from inside another append) is queued and drained in order rather
  // than interleaving the shared head/count mutation.
  let inCritical = false;
  const pending = [];

  // The indivisible slot mutation. Only ever runs while inCritical is held.
  function writeSlot(event) {
    ring[head] = event;
    head = (head + 1) % cap;
    if (count < cap) count += 1;
  }

  function recent(limit = Infinity) {
    const n = Math.min(count, limit === Infinity ? count : Math.max(0, limit | 0));
    const out = [];
    for (let i = 0; i < n; i++) {
      const idx = (head - 1 - i + cap * 2) % cap;
      const e = ring[idx];
      if (e !== undefined) out.push(e);
    }
    return out; // newest-first
  }

  return {
    name: () => "memory",
    append(event) {
      if (!event) return;
      // If an append is already inside its critical section (re-entrant call), queue
      // this event and let the in-progress append drain it — never interleave the
      // shared head/count mutation. Preserves call order; zero events lost.
      if (inCritical) { pending.push(event); return; }
      inCritical = true;
      try {
        writeSlot(event);
        // Drain anything that re-entered while we held the section, in arrival order.
        while (pending.length) writeSlot(pending.shift());
      } finally {
        inCritical = false;
      }
    },
    recent,
    snapshot: () => recent(Infinity),
    restore(events) {
      // events are newest-first; append oldest-first so recency is preserved.
      for (const e of (events || []).slice().reverse()) this.append(e);
    },
    clear() {
      ring.fill(undefined);
      head = 0;
      count = 0;
      pending.length = 0;
      inCritical = false;
    },
    get size() { return count; },
  };
}

export default { createInMemoryRingAdapter };
