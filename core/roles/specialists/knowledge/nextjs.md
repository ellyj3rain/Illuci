| Document | illuci/core/roles/specialists/knowledge/nextjs |
|---|---|
| Version | 1.0.0 |
| Timestamp | 2026-06-23 00:00 UTC / 17:00 PDT |
| Author | Human-directed development system |
| Repository | `Projects/zero/illuci (the harness)/core/roles/specialists/knowledge/` |

---
slug: nextjs
domain: Next.js
canonical-refs:
  - The Next.js documentation at nextjs.org/docs (chapter-by-chapter; the framework's own docs are themselves the spec)
  - The React documentation at react.dev (Server Components and Suspense chapters specifically)
  - Next.js Conf talks (annual; especially the App Router introduction and the partial prerendering talks)
  - The vercel/next.js GitHub repository RFCs (design changes get socialized as RFCs; the specialist tracks them)
  - The React Server Components specification work in facebook/react RFCs
  - The Vercel deployment documentation for the production runtime split
named-patterns:
  - route-group-based-auth-gate
  - server-action-only-from-form
  - route-handler-for-redirects
  - cache-tag-invalidation
  - notFound-and-redirect-server-flow-control
  - child-segments-inherit-parent-layout
  - not-found-page-boundary
  - error-tsx-boundary
  - loading-tsx-streaming-fallback
  - useFormState-for-action-error-surfacing
  - parallel-routes-for-modal-overlays
  - intercepting-routes-for-soft-navigation
  - typed-route-handlers-with-NextRequest
  - metadata-api-for-document-head
taxonomies:
  - the four caching layers (request memoization, data cache, full route cache, route segment cache)
  - the runtime split (edge / nodejs)
  - the rendering modes (static / dynamic / ISR / streaming / partial-prerendering)
  - the directive boundaries ('use client' / 'use server')
  - the route segment configs (dynamic, revalidate, runtime, preferredRegion, fetchCache)
  - layout vs template vs page vs route handler conventions
  - server action vs route handler discriminator
vocabulary:
  - server component (the default; runs on the server; cannot use hooks or browser APIs)
  - client component (opts in via `'use client'`; runs on the client and the server during SSR)
  - server action (opts in via `'use server'`; an RPC endpoint Next.js generates from a function)
  - route handler (an HTTP endpoint defined in route.ts; the explicit-API alternative to server actions)
  - request memoization (the in-request fetch dedupe layer)
  - data cache (the persistent cross-request fetch cache)
  - full route cache (the rendered HTML/RSC payload cache)
  - route segment cache (the client-side prefetched segment cache)
  - revalidatePath, revalidateTag (the imperative cache invalidation primitives)
  - dynamic API (cookies(), headers(), searchParams; using one opts a route into dynamic rendering)
  - partial prerendering (the static shell + dynamic holes streaming model)
status: knowledge-seed
legacy-origin: illuci/core/agents/anthropology/curricula/nextjs
---

# Next.js

The discipline of the React meta-framework: a layered system in which file-system routing, the server/client component split, the four caching layers, and the runtime split (edge vs Node) compose into a single rendering and deployment posture. The Combine specialist who tends the Next.js polyhedron tends a framework whose specification is its own documentation (nextjs.org/docs is the framework's normative reference) but whose implementation evolves quickly enough that drift between authored intent and actual rendering posture is a constant concern. The framework is the most prominent consumer of React Server Components; the specialist tracks both the React side (where the primitives are designed) and the Next.js side (where they are operationalized).

## Foundations

The App Router is the modern routing model. Files in `app/` define routes by directory structure; the conventions are `page.tsx` for the leaf, `layout.tsx` for shared structure that wraps child segments, `template.tsx` for layouts that re-mount on navigation, `loading.tsx` for the streaming fallback, `error.tsx` for the error boundary, `not-found.tsx` for the 404 boundary, and `route.ts` for HTTP route handlers. Route groups (parenthesized segment names like `(auth)` or `(marketing)`) introduce layout boundaries that do not appear in the URL; the Combine specialist applies route groups for the named pattern of the route-group-based auth gate, where a layout enforces authentication for an entire subtree without inflating the URL with a path prefix.

Dynamic segments use bracket notation: `[id]` for a single parameter, `[...slug]` for catch-alls, `[[...slug]]` for optional catch-alls. Parallel routes use `@slot` directories rendered into named slots in a layout; intercepting routes use `(.)`, `(..)`, `(...)` prefixes to render a route inline at one URL while preserving the full route at another (the canonical use is modal overlays that have a deep-link fallback).

## Server components vs client components

The default is server. A component runs on the server, returns serialized React output, and never ships its source to the browser. The `'use client'` directive at the top of a file marks the file (and its imports of components) as client-side: the components ship to the browser and run there, with hooks and browser APIs available. The directive is transitive in the import graph: importing a server-only module from a client component is an error; importing a client component from a server component is the canonical composition.

The boundary has serialization rules. Props passed from a server component to a client component must be JSON-serializable: no functions (server actions are the exception, see below), no Date, no Map, no Set, no class instances. The Combine specialist holds the serialization rule as load-bearing; props that violate it produce silent runtime errors at the boundary, and the specialist watches for boundary-crossing props that would fail to serialize.

## Server actions

Server actions are async functions marked with the `'use server'` directive (either at the top of a file, exporting actions, or inline at the top of a function). Next.js generates an RPC endpoint per action; the framework wires the client-to-server call. The canonical consumption is form-action: a `<form action={serverAction}>` invokes the action on submit. The `useTransition` and `useFormState` hooks are the canonical client-side surfaces for tracking pending state and surfacing errors.

Server actions revalidate via the imperative primitives: `revalidatePath(path)` invalidates the route segment cache for a path, `revalidateTag(tag)` invalidates all data-cache entries with that tag, `cookies().set(...)` writes a cookie that is visible on the next request. The Combine specialist holds the rule: server actions only from forms (or from `useTransition`-wrapped client invocations); for HTTP endpoints called from external systems, redirects to third parties, or invocations from non-React contexts, the route handler in `route.ts` is the discriminator. The discriminator is the canonical convention named in the Next.js handbook's Server Actions and Route Handlers chapters; specialists apply it consistently across consumer projects.

## Data fetching and the four caching layers

Next.js extends the standard `fetch` with three options: `next.revalidate` (seconds until the cache entry is considered stale), `cache: 'force-cache' | 'no-store'` (the binary cache opt-in/opt-out), and `next.tags` (cache tags for `revalidateTag`). React's `cache` function is also available for memoizing pure server-side functions across a request.

The four caching layers compose: (1) the **request memoization** layer dedupes identical fetches within a single render pass; (2) the **data cache** persists fetch results across requests, keyed by URL and options; (3) the **full route cache** stores the rendered HTML and RSC payload for static routes; (4) the **route segment cache** is the client-side prefetched segment cache that powers soft navigation. The mental model is layered: a misconfiguration in one layer (e.g., a route that is dynamic because it reads cookies but expects to be statically cached) silently masks the others.

## The runtime split

Each route segment can declare `export const runtime = 'edge'` or `'nodejs'`. The edge runtime runs on a V8 isolate (no Node APIs, no native modules, restricted streaming surface, smaller bundle ceiling); the Node runtime runs on standard Node. The Combine specialist names the active runtime in their reports because the same code reads as deployable under one runtime and undeployable under another. Common pitfalls: a Node-only library imported into an edge route, a streaming response configuration that the deployment target does not support.

## Streaming and Suspense

Next.js streams the document. The `loading.tsx` convention provides a streaming fallback for a route segment; React Suspense boundaries inside a route stream their children as data resolves. Partial prerendering (the modern composition) emits a static shell with dynamic holes that stream in; the specialist tracks the partial-prerendering RFC because the rendering mode is becoming the canonical default for routes mixing static and dynamic content.

## Failure modes the specialist watches for

A client component that fetches data the server component above it could have fetched is the most common compounding failure. The specialist holds the server-first default: data should be fetched server-side and passed across the boundary as serialized props.

A server action used where a route handler is the discriminator (or vice versa) is the canonical anti-pattern. The specialist applies the canonical discriminator (forms invoke server actions; external HTTP, redirects to third parties, and non-form invocations use route handlers) and pushes back when a consumer project's convention drifts from it.

A route declared as static but reading a dynamic API (cookies, headers, dynamic searchParams) silently becomes dynamic; the route segment config and the actual rendering posture diverge. The specialist verifies the declared posture matches the actual posture, especially in deployment to Vercel where the build output is the audit surface.

A monorepo deployment that omits `outputFileTracingRoot` ships an incomplete standalone build. The specialist names the workaround as a canonical pattern for any monorepo Next.js consumer.

## Ecosystem awareness

The specialist tracks the active Next.js major's release notes (Next.js ships major versions roughly annually with significant routing or caching changes), the active React canary's Server Components surface, the project's `next.config.js` (or `.mjs` / `.ts`) configuration, the deployment target (Vercel-native vs self-hosted Node vs `output: 'standalone'`), and any uses of escape hatches (`unstable_*` APIs, `dangerouslyAllowSVG`, `experimental.*` flags) which are claims the specialist treats as deliberate departures requiring justification.

The Next.js polyhedron is well-tended in the framework's home (Vercel maintains both framework and the most prominent deployment target). The Combine specialist's attention is therefore mostly on the consumer side: are the rendering modes in this codebase a faithful description of the deployment posture? Are the caching layers configured intentionally or by accident? Are the server/client boundaries drawn with stated reasons or accumulated by drift?
