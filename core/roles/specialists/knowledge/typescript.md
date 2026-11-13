| Document | illuci/core/roles/specialists/knowledge/typescript |
|---|---|
| Version | 1.0.0 |
| Timestamp | 2026-06-23 00:00 UTC / 17:00 PDT |
| Author | Human-directed development system |
| Repository | `Projects/zero/illuci (the harness)/core/roles/specialists/knowledge/` |

---
slug: typescript
domain: TypeScript
canonical-refs:
  - The TypeScript Handbook (Microsoft, the official spec-equivalent)
  - Programming TypeScript (Boris Cherny, O'Reilly 2019)
  - Effective TypeScript - 83 Specific Ways (Dan Vanderkam, O'Reilly 2024 2nd ed)
  - The TypeScript Compiler API documentation
  - Type-Level Programming in TypeScript (the community pattern catalog at type-level-typescript.com)
  - The Soundness Issues page in the TypeScript handbook FAQ
named-patterns:
  - branded-types
  - discriminated-unions-with-tag-narrowing
  - exhaustiveness-checking-via-never
  - const-assertions-for-literal-types
  - mapped-types-with-key-remapping
  - conditional-types-with-infer
  - template-literal-types
  - satisfies-operator-for-type-checked-literals
  - module-augmentation
  - declaration-merging
  - type-predicate-functions
  - assertion-functions
taxonomies:
  - any vs unknown vs never (the three top-level escape hatches)
  - structural vs nominal typing (TypeScript is structural; nominal is achieved via brands)
  - covariance vs contravariance vs invariance vs bivariance (with method-parameter bivariance as the historical exception)
  - declaration-files vs ambient-modules vs module-augmentation
  - strict-mode flag composition (strictNullChecks, noImplicitAny, strictFunctionTypes, strictBindCallApply, strictPropertyInitialization, alwaysStrict, useUnknownInCatchVariables, noImplicitOverride)
  - the four soundness escape hatches (any, type assertion, non-null assertion, function-parameter bivariance)
vocabulary:
  - structural compatibility
  - type narrowing
  - excess property checking
  - widening and narrowing of literal types
  - distributive conditional types
  - homomorphic mapped types
  - higher-kinded type emulation
  - phantom types via brands
status: knowledge-seed
legacy-origin: illuci/core/agents/anthropology/curricula/typescript
---

# TypeScript

The discipline of static typing layered atop a dynamic-typed runtime, designed to capture the structural shapes JavaScript programs already have without changing what those programs do at runtime. The Combine specialist who tends the TypeScript polyhedron tends a language whose specification and implementation are unusually well-aligned (Microsoft owns both compiler and language spec) but whose ecosystem is broad enough that drift between authored types and shipped JavaScript is a constant concern.

## Foundations

TypeScript is structurally typed. Two types are compatible when their shapes are compatible, regardless of whether the types share a name. Nominal typing, when needed, is achieved through brands (a unique symbol property added to a type to make it distinct in the structural lattice). The structural model is load-bearing: it is what allows TypeScript to type JavaScript libraries that were never written with TypeScript in mind. The Combine specialist holds the structural model as foundational and reaches for nominal patterns only when the structural model would let two unrelated types collide (e.g., a `UserId` and a `ProductId` both being `string`).

The type system is distinct from the runtime. Types are erased at compile time; the JavaScript that ships does not carry type information. The specialist holds this as a load-bearing property: the type system can be rich, can use higher-order constructs, can do compile-time computation, without affecting runtime cost. The corollary is that the type system cannot be relied upon for runtime safety; runtime checks are the responsibility of validation libraries, type predicate functions, or assertion functions.

## The escape hatches and the soundness story

TypeScript is intentionally unsound. The handbook's Soundness Issues page enumerates the four primary escape hatches: `any` (opts out of type checking entirely), type assertions (`as` casts that the type system trusts without verifying), non-null assertions (`!` that asserts a value is non-null without runtime check), and function-parameter bivariance (a historical compatibility hack disabled by `strictFunctionTypes`). The Combine specialist treats unsoundness as a deliberate trade for ergonomics, names every use of an escape hatch as such, and pushes back on uses that have not been justified.

The taxonomy `any` vs `unknown` vs `never` is the working axis. `any` opts out; the type system stops checking. `unknown` requires narrowing before use, preserving soundness at the cost of explicit checks. `never` is the bottom type, used in exhaustiveness checking and in the return type of functions that do not return. A specialist who reaches for `any` is making a deliberate choice to leave the discipline at one point in the program; one who reaches for `unknown` is staying within the discipline and accepting the cost of narrowing.

## Named patterns the specialist applies

Discriminated unions with tag narrowing are the canonical pattern for sum types. Each variant carries a literal-typed discriminator (e.g., `kind: 'circle' | 'square'`); a `switch` over the discriminator narrows the type within each branch. Exhaustiveness is enforced via a `never`-typed default branch. The pattern is universal in well-typed TypeScript and is the first construct the specialist reaches for when modeling state.

Branded types are the canonical pattern for nominal distinctions on top of structurally identical primitives. A function that should accept only `UserId` (and not raw `string`) annotates the parameter as `UserId`, where `UserId` is `string & { readonly __brand: unique symbol }`. The specialist applies brands when the structural model is too permissive for the domain.

The `satisfies` operator is the canonical pattern for type-checked literals that should retain their inferred narrow type. Where `as Foo` would assert without checking and `: Foo` would widen to the annotation, `satisfies Foo` checks compatibility while preserving the literal's narrow shape. The specialist reaches for `satisfies` whenever a configuration object should be both type-checked and exposed at its narrow type.

Conditional types with `infer` are the canonical pattern for type-level computation. They are the building block for utility types like `ReturnType`, `Parameters`, `Awaited`, and the user's own domain-specific extractors. The specialist applies them sparingly; type-level programming has a cognitive cost, and the working code is more often a clear discriminated union than a clever conditional.

## Strictness as composition

The `strict` flag is a meta-flag composing seven sub-flags (per the taxonomy in the frontmatter). The Combine specialist holds that all seven are load-bearing for new code; legacy code may opt-out per sub-flag during migration. The specialist names the active strictness configuration when reading a codebase, because the same code reads as safe under one configuration and unsafe under another.

`useUnknownInCatchVariables` is worth singling out: the historical default of `any` for `catch` parameters meant that error-handling code silently accepted any narrowing the author chose; the modern default of `unknown` forces explicit narrowing. The specialist holds the modern default as correct and pushes back on legacy `any`-typed catches that have not been audited.

## Failure modes the specialist watches for

A type assertion (`as`) without an accompanying runtime check is the most common compounding failure. The specialist treats every `as` as a claim the type system has been told to trust without verifying; if the underlying value can come from outside the program (network, storage, user input), the claim is suspect until a runtime check is added.

A function whose parameters are typed broadly (`object`, `Record<string, unknown>`, `any`) but whose body assumes narrow shapes is a future bug. The specialist narrows at the boundary, not in the body.

A library typed via `@types/<name>` packages whose definitions have drifted from the runtime library is a Substrate Collapse in miniature. The specialist verifies the definitions match the version of the runtime library actually being shipped, especially in projects where the `@types` packages are pinned independently from the runtime.

## Ecosystem awareness

The specialist tracks the active TypeScript version's release notes (compiler releases land roughly quarterly), the active `@types` set's drift relative to runtime libraries, the project's `tsconfig.json` strictness profile, and any uses of `// @ts-ignore` / `// @ts-expect-error` (the former is a permanent escape; the latter requires the asserted error to actually exist, failing if it does not - the specialist prefers `expect-error` over `ignore` whenever the assertion is meant to be temporary).

The TypeScript polyhedron is well-tended in the language's home (the compiler + handbook are co-evolved by the same team). The Combine specialist's attention is therefore mostly on the consumer side: are the types in this codebase a faithful description of the runtime behavior? Is the strict-mode profile honest about what has been audited? Are escape hatches documented or accumulated?
