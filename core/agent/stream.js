/**
 * illuci Agent SDK — Event Stream (push → pull bridge)
 *
 * run() is a single AsyncIterable, but events arrive from three places that are
 * not the generator's own yield points:
 *   - the single-agent loop (token deltas, tool calls/results)
 *   - the permission handler, fired deep inside executeTool (a callback)
 *   - the council emitter (push pub/sub)
 * They all push() here; run() async-iterates here. One queue unifies the two
 * internal streaming models (pull async-generator + push pub/sub) into the one
 * public surface.
 *
 * Backpressure is intentionally unbounded: agent runs are low-frequency
 * (model-paced), and a bounded buffer would risk dropping governance-relevant
 * events (permission, tool_result). Memory is bounded by run length, not rate.
 */
export class EventStream {
  #queue = [];
  #resolvers = [];
  #closed = false;
  #error = null;

  /** Push an event. No-op after close (a late council event cannot reopen a run). */
  push(event) {
    if (this.#closed) return;
    const waiter = this.#resolvers.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.#queue.push(event);
  }

  /** Close the stream. Drains pending waiters with done:true. Idempotent. */
  close() {
    if (this.#closed) return;
    this.#closed = true;
    while (this.#resolvers.length) {
      this.#resolvers.shift()({ value: undefined, done: true });
    }
  }

  /**
   * Fail the stream. The next/queued iteration rejects with `err`. Used only for
   * truly unexpected internal faults; ordinary run failures travel as an `error`
   * AgentEvent followed by a clean close, so consumers see them in-band.
   */
  fail(err) {
    if (this.#closed) return;
    this.#error = err;
    const waiter = this.#resolvers.shift();
    if (waiter) waiter(Promise.reject(err));
    this.close();
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.#error) {
          const e = this.#error;
          this.#error = null;
          return Promise.reject(e);
        }
        if (this.#queue.length) {
          return Promise.resolve({ value: this.#queue.shift(), done: false });
        }
        if (this.#closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => this.#resolvers.push(resolve));
      },
    };
  }
}

export default { EventStream };
