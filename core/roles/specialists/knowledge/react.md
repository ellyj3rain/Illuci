| Document | illuci/core/roles/specialists/knowledge/react |
|---|---|
| Version | 1.0.0 |
| Timestamp | 2026-06-23 00:00 UTC / 17:00 PDT |
| Author | Human-directed development system |
| Repository | `Projects/zero/illuci (the harness)/core/roles/specialists/knowledge/` |

---
slug: react
domain: React (the library, React 19 era)
canonical-refs:
  - The React documentation at react.dev (the canonical spec, chapter-by-chapter)
  - Dan Abramov, "A Complete Guide to useEffect" (overreacted.io, 2019)
  - Dan Abramov, "Before You memo()" (overreacted.io, 2021)
  - The React 19 release notes (react.dev/blog)
  - The React RFCs repository (reactjs/rfcs on GitHub)
  - "Pure React" (Dave Ceddia, 2018) for the foundation model
  - The React Conf talks, especially the React Server Components introduction (Joseph Savona / Dan Abramov / Lauren Tan) and the React Compiler announcement
named-patterns:
  - lift-state-up
  - colocation-of-state-with-use
  - controlled-vs-uncontrolled-component-split
  - render-props (historical, mostly superseded but still in use)
  - children-as-function
  - compound-component
  - controlled-input-value-onChange-contract
  - key-prop-as-identity
  - useSyncExternalStore-for-external-stores
  - error-boundary-as-class-component
  - ref-as-escape-hatch (focus, non-React DOM, third-party imperative APIs)
  - forwardRef (and React 19's ref-as-prop)
  - useImperativeHandle (paired with forwardRef or ref-as-prop)
  - Suspense-as-coordinated-loading-state
  - useTransition-vs-startTransition
taxonomies:
  - hook categories (state / ref / effect / context / performance / concurrent / form)
  - component categories (server / client / shared)
  - rendering phases (render / commit)
  - effect timing (insertion / layout / passive)
  - render causes (state change / parent re-render / context change / forced update)
  - urgency (urgent updates vs transitions)
vocabulary:
  - reconciliation
  - Fiber
  - work loop
  - render phase, commit phase
  - hook identity by call order
  - the Rules of Hooks
  - StrictMode double-fire
  - Suspense boundary
  - streaming
  - concurrent rendering
  - transitions (urgent vs non-urgent)
  - 'use client' transitivity
  - prop serialization across the Server/Client boundary
  - ref forwarding
  - escape hatch
  - auto-memoization (the React Compiler)
status: knowledge-seed
legacy-origin: illuci/core/agents/anthropology/curricula/react
---

# React (the library, React 19 era)

The discipline of declarative UI as a function of state, layered atop the DOM (and other targets) via a reconciler that diffs a virtual representation against the previous render to compute the minimum mutation. The Combine specialist who tends the React polyhedron tends a library whose specification (the documentation at react.dev) and implementation (the reference renderer in `react-dom`, plus React Native, plus other targets) are co-evolved by Meta's React team, but whose ecosystem is broad enough that drift between the canonical contract and consumer-side patterns is constant. React 19 introduced Server Components into the library's surface (not merely Next.js's), the Compiler as the directional answer to manual memoization, and a substantial new hook surface (`use`, `useOptimistic`, `useActionState`, `useFormStatus`) that the specialist is expected to know.

## Foundations

React's render model is a pure function from props and state to a description of UI. The reconciler (Fiber, since React 16) walks that description, diffs it against the previous tree, and produces a list of mutations to apply during the commit phase. The work loop is interruptible: the reconciler can pause, yield to higher-priority work, and resume. The Combine specialist holds the render-vs-commit distinction as load-bearing: the render phase must be pure (no side effects, no observable mutation, idempotent), and the commit phase is where DOM mutation, refs are populated, and effects fire. A render function with side effects is a polyhedron face that has cracked.

The Rules of Hooks exist because hook identity is established by call order. React does not name hooks; it numbers them by the order of their invocation within a render. A hook called conditionally or inside a loop loses its identity across renders, breaks state association, and corrupts the component. The specialist holds the Rules of Hooks as inviolable: hooks at the top level of a component or custom hook, never inside conditions, loops, or after early returns.

## The hook surface

The hook categories are state (`useState`, `useReducer`), ref (`useRef`, `useImperativeHandle`), effect (`useEffect`, `useLayoutEffect`, `useInsertionEffect`), context (`useContext`), performance (`useMemo`, `useCallback`), concurrent (`useTransition`, `useDeferredValue`, `useId`, `useSyncExternalStore`), and form/React-19 (`use`, `useOptimistic`, `useActionState` (formerly `useFormState`), `useFormStatus`). The specialist holds this taxonomy as the working vocabulary; a hook applied without naming its category is a hook applied without intention.

`useEffect` synchronizes a component with an external system. The specialist holds this framing strictly: an effect is for synchronization, not for derivation, not for sequencing, not for "I needed somewhere to put this code." Dan Abramov's "A Complete Guide to useEffect" is the canonical reference for the model. The most common anti-pattern the specialist watches for is state set inside `useEffect` when the value could be derived from existing state during render. The second most common is `useEffect` used to synchronize with an external store where `useSyncExternalStore` is canonical (the latter handles tearing under concurrent rendering, which a hand-rolled `useEffect` does not).

`useLayoutEffect` fires synchronously after DOM mutation and before paint; `useEffect` fires after paint. The specialist applies `useLayoutEffect` only when measurement-then-mutation must happen before the user sees the intermediate state; otherwise `useEffect` is correct, and `useLayoutEffect` is a performance cost.

The React 19 form hooks (`useActionState`, `useFormStatus`, `useOptimistic`) integrate with the form-action surface and the optimistic-update pattern. The specialist applies them where the codebase has adopted React 19 idioms; in pre-19 code, the older patterns (controlled inputs, manual loading-state management) remain idiomatic.

## Server Components and the boundary

React 19 makes Server Components part of React's surface. The boundary is the `'use client'` directive: a file with `'use client'` is a client-rendered module, and any module imported into it is also client-rendered (the directive is transitive across the import graph from that module downward, but the module itself is the boundary). Server Components run on the server, can be async, can read from the database directly, and cannot use hooks or browser APIs. Props passed from a Server Component to a Client Component must be serializable; functions, class instances, and Maps/Sets cross the boundary only via specific React serialization affordances. The specialist watches for the boundary: a Server Component that imports a Client Component is the canonical mixed tree; a Client Component that imports a Server Component requires the `children`-prop pattern (the Server Component is rendered on the server and passed in as `children`).

## Suspense, concurrent rendering, transitions

Suspense is a coordinated loading-state primitive. A Suspense boundary catches the suspension of any descendant (by a thrown promise or by a `use(promise)` call) and renders the fallback until the descendants resolve. The specialist places Suspense boundaries deliberately: too wide and the fallback shows for unrelated work; too narrow and the loading state cannot coordinate.

Concurrent rendering means the reconciler may interrupt low-priority work to handle high-priority work (e.g., an input keystroke). `useTransition` and `startTransition` mark state updates as non-urgent (transitions); React then keeps the previous UI visible while the new render is in progress, surfaces an `isPending` flag, and prefers urgent updates. The specialist applies transitions to expensive renders triggered by user input where the user should keep typing without UI lag. `useDeferredValue` is the read-side equivalent: it lets a child component render with a stale value while the new value is in transition.

## StrictMode, error boundaries, refs

StrictMode in development double-invokes render functions and effect bodies (mount, unmount, mount) to surface bugs in non-idempotent renders and missing cleanup. The "fire effect / cleanup / fire again" sequence tests that effect bodies are resilient to remount; an effect that breaks under double-fire is an effect with a hidden assumption that production will eventually break. The specialist treats a StrictMode-uncovered bug as a real bug, not a development artifact.

Error boundaries are still class-component-only as the public API. The function-component equivalent (a hook for error catching) has been considered and not yet shipped. The specialist applies error boundaries at meaningful tree boundaries (route segments, feature boundaries) and pairs them with Suspense; an unrecovered error inside a Suspense boundary will propagate to the nearest error boundary.

Refs are escape hatches. Their correct uses are focus management, integration with non-React DOM (canvas, WebGL, third-party JS libraries that mutate DOM imperatively), and storing values whose changes should not trigger re-renders. Their misuse is as a re-render avoidance mechanism for state that should be state. `forwardRef` (or React 19's ref-as-prop) and `useImperativeHandle` together expose a stable imperative handle from a child to its parent; the specialist applies them when the imperative API is unavoidable and the structural alternative (lifting state, using context) is worse.

## Performance and the React Compiler

Manual memoization (`useMemo`, `useCallback`, `React.memo`) helps when the upstream identity of dependencies is stable; otherwise it costs without benefiting. Dan Abramov's "Before You memo()" is the canonical reference for the diagnostic question: would moving state down or composing children differently eliminate the re-render at issue, before reaching for memoization? The React Compiler (announced at React Conf and shipped in React 19) is the directional answer to most manual memoization patterns: it auto-memoizes at the compiler level, releasing the consumer from the manual `useMemo` / `useCallback` discipline for most cases. The specialist tracks Compiler adoption in the codebase under review and adjusts recommendations accordingly.

## Failure modes the specialist watches for

State set in `useEffect` when derivation would compute the same value during render. `useEffect` synchronizing with an external store where `useSyncExternalStore` would handle tearing correctly. Lists keyed by array index when the underlying identity is stable, causing identity loss across reorderings. StrictMode-uncovered double-fire bugs (effects without cleanup, fire-once assumptions). `useLayoutEffect` used where `useEffect` would suffice (a paint-blocking cost). Memoization added without the upstream stability that makes it cost-effective. Server/Client boundary violations: non-serializable props crossing the boundary, browser APIs called in Server Components, async/await in Client Components without Suspense to catch the suspension.

## Ecosystem awareness

The specialist tracks the active React version (the documentation at react.dev is versioned), the React Compiler's adoption status in the codebase, the framework integration (Vite, Next.js, Remix, etc.) for the Server/Client surface, and the strict-mode configuration of the rendering root. The React polyhedron is well-tended in the library's home; the specialist's attention is therefore mostly on the consumer side: are the components in this codebase a faithful description of the render contract? Are effects scoped to synchronization, or have they accumulated derivation? Are Suspense boundaries placed where coordination is meaningful? Is the Server/Client boundary respected, or has prop-serialization drift entered the tree?
