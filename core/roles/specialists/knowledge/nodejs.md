| Document | illuci/core/roles/specialists/knowledge/nodejs |
|---|---|
| Version | 1.0.0 |
| Timestamp | 2026-06-23 00:00 UTC / 17:00 PDT |
| Author | Human-directed development system |
| Repository | `Projects/zero/illuci (the harness)/core/roles/specialists/knowledge/` |

---
slug: nodejs
domain: Node.js
canonical-refs:
  - The Node.js API documentation at nodejs.org/api (the spec)
  - Node.js Design Patterns - Mario Casciaro and Luciano Mammino (Packt, 3rd ed)
  - The libuv documentation at docs.libuv.org (the layer below Node)
  - The Node.js streams documentation (chapter-length, treated as its own reference)
  - The V8 blog at v8.dev (especially the GC and TurboFan posts)
  - The Node.js GitHub repository's diagnostic-tools wiki
  - Recent NodeConf and Node Collab Summit talks
named-patterns:
  - abortcontroller-plumbing
  - pipeline-with-promisify
  - destroy-on-error-cleanup
  - finish-vs-end-vs-close-event-discipline
  - eventemitter-once-with-cleanup
  - worker-threads-pool
  - conditional-exports-for-dual-mode-packages
  - async-iteration-over-readable
  - queuemicrotask-over-process-nexttick
  - heap-snapshot-on-fatalerror
taxonomies:
  - event-loop phases (timers, pending callbacks, idle/prepare, poll, check, close callbacks)
  - microtask queue (process.nextTick vs Promise resolutions; nextTick drains first)
  - stream class types (Readable, Writable, Duplex, Transform)
  - module resolution conditions (default, node, import, require, browser, production, development)
  - diagnostic surfaces (sync inspector, async hooks, perf hooks, diagnostics_channel, reports, heap snapshots)
  - threadpool delegators (fs, dns.lookup, crypto.pbkdf2/scrypt/randomBytes, zlib)
  - the four primary cancellation surfaces (AbortController, signal events, server.close, child_process.kill)
vocabulary:
  - backpressure
  - high-water mark
  - flowing mode vs paused mode
  - event-loop lag
  - threadpool saturation
  - top-level await
  - dual-mode package
  - transferable vs structured-clone
  - the V8 isolate
status: knowledge-seed
legacy-origin: illuci/core/agents/anthropology/curricula/nodejs
---

# Node.js

The discipline of running JavaScript outside the browser, embedding the V8 engine in a host whose I/O is asynchronous, single-threaded at the JavaScript layer, and event-loop driven via libuv. The Combine specialist who tends the Node.js polyhedron tends a runtime whose specification is the documentation at nodejs.org/api, whose implementation is a single canonical project (the OpenJS-stewarded `nodejs/node` repository), but whose ecosystem layers (npm, the `@types/node` set, the long tail of native addons) drift independently and must be tended jointly.

## Foundations

Node.js is a host for V8 plus libuv. V8 evaluates JavaScript on a single thread, the JavaScript thread; libuv runs the event loop, which schedules callbacks for I/O completion, timers, and immediates. The event loop has phases - timers, pending callbacks, idle/prepare, poll, check, close callbacks - and drains a microtask queue between phases. The microtask queue itself has two sub-queues: `process.nextTick` callbacks (which drain first) and Promise resolutions (which drain next). The specialist holds the phase order as load-bearing knowledge; the canonical confusion of `setImmediate` (check phase, runs after I/O callbacks in the same tick) versus `setTimeout(fn, 0)` (timers phase, runs in the next tick if `now < expiration`) is a phase-order question, not a performance question.

Threadpool delegation is the second load-bearing fact. Most filesystem operations (`fs.*` async forms), DNS lookups via `dns.lookup`, several crypto operations (`pbkdf2`, `scrypt`, `randomBytes`), and zlib operations are dispatched to libuv's threadpool. The default size is 4; `UV_THREADPOOL_SIZE` adjusts it. The specialist watches for threadpool saturation: a server doing concurrent crypto-heavy work on the default pool will queue work even when CPUs are idle, and the symptom is event-loop lag with low CPU.

## Streams and backpressure

The streams API is the native composition primitive for I/O in Node.js. Four classes: `Readable` produces, `Writable` consumes, `Duplex` does both, `Transform` is a `Duplex` that maps input to output. The backpressure model is built on `write()` returning `false` when the internal buffer crosses the high-water mark; the producer is expected to pause until a `'drain'` event fires. The specialist holds the canonical truth that `pipe` honors backpressure automatically and `pipeline` (and its `promisify`-wrapped form, or `stream/promises`'s native promise version) does the same with proper cleanup on error.

The mode distinction is foundational: a `Readable` is in paused mode by default and switches to flowing mode when a `'data'` listener is attached, when `pipe()` is called, or when `resume()` is invoked. Mixing `readable.read()` with a `'data'` listener or with async iteration is a category error: the specialist treats it as such. Async iteration over a readable (`for await (const chunk of readable)`) is the modern idiom and the specialist reaches for it for one-shot consumers.

The named patterns the specialist applies: `pipeline` over `pipe` whenever cleanup-on-error matters; `destroy(err)` as the canonical disposal idiom (which emits `'error'` and `'close'`); the discipline of distinguishing `'finish'` (writable side flushed), `'end'` (readable side exhausted), and `'close'` (underlying resource released). An `'error'` listener is mandatory on every stream the specialist reads or writes; an unhandled error event terminates the process in modern Node.

## Cancellation as discipline

`AbortController` is the canonical cancellation primitive across the modern Node API surface: `fetch`, `fs/promises`, `server.close`, `setTimeout` (the promisified form), `child_process.spawn`, and the streams' async iteration all honor an `AbortSignal`. The named pattern: create a controller in the calling scope, pass `controller.signal` through to every cancellable operation, listen for `'abort'` to clean up local resources, call `controller.abort()` on the cancellation event. Node 20+ adds `AbortSignal.any` for chaining; the specialist reaches for it when a derived cancellation should fire on the union of multiple sources.

## Modules

Node supports both CommonJS and ECMAScript Modules. The `package.json` `type` field declares the default ("module" makes `.js` ESM, default makes it CJS); `.mjs` and `.cjs` are unambiguous. The `exports` field is the load-bearing surface for a published package: it declares the public entry points, gates internal modules from import, and supports conditional resolution (`default`, `node`, `import`, `require`, `browser`, `production`, `development`). The specialist reads `exports` as the contract a package presents to its consumers and holds dual-mode (CJS+ESM) packaging as a conditional-exports problem first, a build problem second.

ESM-CJS interop is the active drift surface. CJS reading from ESM works only via dynamic `import()` (top-level `require` of an ESM module throws). ESM reading from CJS gets a default-export view; named exports come from the CJS module's `module.exports` object only when statically analyzable. The specialist watches for `__dirname` / `__filename` references in ESM (those are CJS globals; ESM uses `import.meta.url`), for top-level await across module boundaries (synchronously imported ESM cannot top-level-await), and for `engines` fields whose Node range does not match the syntax used.

## Concurrency

`worker_threads` provides JavaScript-level parallelism: each worker is a separate V8 isolate with its own event loop. The specialist holds workers as the right tool for CPU-bound work (compression, hashing, parsing of large structures) and the wrong tool for I/O (the threadpool already handles that). Communication crosses isolates via `postMessage`, which structured-clones by default; `Transferable` objects (`ArrayBuffer`, `MessagePort`) move ownership without copying. `SharedArrayBuffer` is the shared-memory primitive when needed. The named pattern is the worker-pool: a fixed pool of workers consuming a queue, sized to CPU count.

`cluster` provides process-level parallelism: a master spawns workers and the OS round-robin-distributes incoming connections across them. The specialist holds cluster as the right tool for scaling stateful single-process servers across cores; it is not a replacement for a process manager (PM2, systemd, the orchestrator's restart policy).

## The diagnostic surface

The specialist tracks the diagnostic taxonomy: the synchronous inspector (`--inspect`, Chrome DevTools attach); `perf_hooks` (`performance.mark`, `performance.measure`, `monitorEventLoopDelay`); `async_hooks` (semi-stable, expensive when active); `diagnostics_channel` (the modern subscriber pattern for instrumenting libraries); `--report-on-fatalerror` (writes a JSON report on uncaught exception or fatal); heap snapshots via `--heap-prof` and `v8.writeHeapSnapshot()`. Each surface answers a different question: snapshots for retainers, perf hooks for latency, async hooks for context propagation, diagnostic channels for cross-cutting instrumentation. The specialist matches the surface to the question.

## Failure modes the specialist watches for

Synchronous APIs (`fs.readFileSync`, `JSON.parse` on multi-megabyte strings, `crypto.pbkdf2Sync`) in request handlers block the event loop for every concurrent request. The specialist treats every `*Sync` call in a hot path as a finding pending justification.

Streams without an `'error'` listener will crash the process in modern Node. The specialist verifies every `pipe`-composed chain has been replaced with `pipeline`, or that every stream in a hand-rolled chain has an explicit error handler.

Unhandled promise rejections crash the process by default in current Node. The specialist watches for `async` functions whose errors are silently dropped and for top-level `await` calls without `try`/`catch` in startup paths.

`process.nextTick` used where `queueMicrotask` would suffice creates a phase-order surprise: nextTick callbacks drain before Promise resolutions, which can starve the Promise queue if used in a loop. The specialist reaches for `queueMicrotask` by default and reserves `nextTick` for the historical cases where microtask-before-Promise ordering is required.

Reliance on internal APIs (anything not in the public docs at nodejs.org/api) is a Substrate Collapse in miniature. The specialist verifies that imports resolve to documented exports, especially when reading dependency code that crosses major Node versions.

## Ecosystem awareness

The specialist tracks the active Node.js LTS line (even-numbered majors get LTS; odd-numbered are short-lived current releases), the experimental permission model introduced in Node 20 (`--permission`, `--allow-fs-read`, `--allow-fs-write`, `--allow-child-process`, `--allow-net`; not yet production-default but a direction-of-travel), the built-in `fetch` (Node 18+, backed by undici, with browser-fetch differences in `AbortSignal` honoring and the absence of cookie-jar semantics), and the `engines` field of the project (the version range the project claims to support, which the specialist verifies matches the syntax actually used).

The Node.js polyhedron is well-tended at its core (the runtime team is responsive; the documentation is canonical). The Combine specialist's attention is therefore mostly on the consumer side: are the streams in this codebase composed with `pipeline`? Is cancellation plumbed through `AbortController`? Is the `exports` map honest about what the package presents? Are the diagnostic surfaces enabled in the environment where the specialist will be asked to read the symptoms?
