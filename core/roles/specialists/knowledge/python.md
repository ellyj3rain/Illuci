| Document | illuci/core/roles/specialists/knowledge/python |
|---|---|
| Version | 1.0.0 |
| Timestamp | 2026-06-23 00:00 UTC / 17:00 PDT |
| Author | Human-directed development system |
| Repository | `Projects/zero/illuci (the harness)/core/roles/specialists/knowledge/` |

---
slug: python
domain: Python
canonical-refs:
  - The Python Language Reference and Library Reference at docs.python.org (the spec, chapter-by-chapter)
  - Fluent Python (Luciano Ramalho, O'Reilly 2022 2nd ed)
  - Effective Python - 90 Specific Ways (Brett Slatkin, Addison-Wesley 2019 2nd ed)
  - The PEP index at peps.python.org (especially the language-evolution PEPs - 8, 20, 257, 484, 517, 518, 526, 544, 604, 612, 621, 646, 654, 695, 703)
  - The python-dev mailing list and discuss.python.org (ongoing primary source for direction)
  - The CPython source tree at github.com/python/cpython (when a question reduces to "what does the implementation actually do")
named-patterns:
  - EAFP (easier to ask forgiveness than permission) vs LBYL (look before you leap)
  - with-statement-for-resources
  - dataclass-frozen-default for immutable values
  - Protocol-instead-of-ABC for structural typing
  - functools-wraps on decorators
  - contextmanager-decorator for simple context managers
  - asynccontextmanager for async resource management
  - TaskGroup-instead-of-gather (3.11+)
  - match-statement structural-pattern-matching for tag-discrimination
  - assert_never for exhaustiveness
taxonomies:
  - data-model dunder method classes (construction, representation, comparison, hashing, attribute access, container, callable, context-manager, iteration, descriptor, numeric, async)
  - concurrency models (threading / multiprocessing / asyncio / 3.13 free-threaded mode)
  - typing constructs (annotation, alias, generic, protocol, typeddict, paramspec, variadic, final, annotated)
  - exception hierarchy (BaseException above Exception above the specific types; the new ExceptionGroup branch)
  - standard library layers (built-ins / "batteries included" stdlib / third-party)
  - import system layers (built-in modules / frozen modules / file-based packages / namespace packages / importlib hooks)
vocabulary:
  - dunder method
  - duck typing
  - structural typing (via Protocol)
  - the GIL (Global Interpreter Lock)
  - I/O-bound vs CPU-bound
  - generator vs iterator vs iterable
  - coroutine vs task vs future
  - descriptor (data descriptor vs non-data descriptor)
  - metaclass (the type of types)
  - method resolution order (MRO, the C3 linearization)
status: knowledge-seed
legacy-origin: illuci/core/agents/anthropology/curricula/python
---

# Python

The discipline of dynamic typing with gradual static typing layered on top, of a small language core whose every operation reduces to method calls on objects, of a "batteries included" standard library that is itself a load-bearing piece of the language. The Combine specialist who tends the Python polyhedron tends a language whose specification and reference implementation are unusually well-aligned (CPython is, in practice, the spec) but whose ecosystem is broad enough that drift between authored types and runtime behavior, and between declared dependencies and actual installed versions, is a constant concern. The era this Knowledge Seed is written for is the 3.11/3.12/3.13 line: exception groups, structural pattern matching, fast-startup, free-threading.

## The data model as foundation

Every operation in Python reduces to a method call on an object. `a + b` is `a.__add__(b)` (with reflected fallback to `b.__radd__(a)`); `a[k]` is `a.__getitem__(k)`; `with x:` is `x.__enter__()` followed by `x.__exit__(...)`; `for x in xs:` is `iter(xs)` followed by repeated `__next__`. The Combine specialist holds this as the foundational reading: understanding Python is understanding the data model, and understanding the data model is understanding the named protocols (iteration, context management, descriptors, numeric, comparison, container, callable). The protocols are the polyhedron's primary face; the surface syntax is sugar over them.

Duck typing is the consequence: any object that implements the relevant dunder methods is acceptable wherever those methods are called. Structural typing - PEP 544's Protocol - is the static-typing layer's recognition of this. The specialist reaches for Protocol classes when the type system needs to express "any object with these methods" without forcing inheritance, and reaches for ABCs when shared implementation is also needed.

## The classic footguns

Mutable default arguments are the canonical Python footgun. `def f(x=[])` shares a single list across all calls that omit the argument; the default is evaluated once at function definition. The Combine specialist treats every mutable default as a finding until the author has stated they meant it, and pushes back on the common refactor of `x=None` followed by `x = x if x is not None else []` only when a clearer pattern is available.

Late binding in closures is the second classic footgun: a `lambda` or function defined in a loop captures the loop variable by reference, not by value, so all closures over `i` see the loop's final value. The fix is the explicit-default-argument idiom (`lambda x, i=i: ...`) or `functools.partial`.

Bare `except:` and overly broad `except Exception:` that swallow without re-raise are the third class. The specialist holds that an exception caught is an exception that must be handled or re-raised; one that is silently swallowed is a future bug. PEP 654's `ExceptionGroup` and `except*` are the modern mechanism for handling concurrent failures structurally.

## Iteration: generators, iterators, iterables, the protocol

An iterable is anything with `__iter__`; an iterator is anything with `__iter__` and `__next__` (and whose `__iter__` returns `self`); a generator is the most common form of iterator, produced by `yield` or by a generator expression. The specialist holds the distinction load-bearing: a function returning an iterable can be re-iterated; one returning an iterator can only be consumed once. `yield from` delegates iteration to a sub-iterable, including for coroutine sub-tasks in pre-async-await code.

Async generators (`async def` with `yield`) extend the protocol to coroutine context. The async iteration protocol is `__aiter__` / `__anext__`, surfaced through `async for`.

## Async: the event loop, coroutines, tasks

Python's async story is built on coroutines (functions defined with `async def`), the event loop (`asyncio.get_running_loop()`), and tasks (futures wrapped around coroutines). `await` suspends the current coroutine until the awaited awaitable resolves; the event loop schedules other ready tasks while the current one is suspended. The specialist holds the I/O-bound vs CPU-bound split as the first question: asyncio shines for I/O-bound concurrency where the workload is "wait for many network calls"; threading or multiprocessing is required for CPU-bound work because the GIL serializes Python bytecode execution within a process.

The TaskGroup (`asyncio.TaskGroup`, 3.11+) is the modern preferred pattern over the historical `asyncio.gather`. TaskGroup provides structured concurrency: tasks created within the group are awaited together at exit; if any task raises, the others are cancelled and exceptions are bundled into an ExceptionGroup. The specialist reaches for TaskGroup whenever multiple concurrent tasks must succeed-together-or-cancel-together. PEP 703 (free-threading, accepted; available experimentally in 3.13) describes the path to a GIL-less CPython; the specialist tracks the experiment but treats production code as GIL-bound until the no-GIL build is the default.

## Type hints in the modern era

Type hints are not enforced at runtime; the runtime ignores them. The static checkers (mypy, pyright, pyrefly) read them and produce diagnostics. PEP 604's union syntax (`X | Y`, 3.10+) replaces `Union[X, Y]`. PEP 695's type alias statement (`type Alias = ...`, 3.12+) replaces the older `Alias: TypeAlias = ...`. PEP 612's ParamSpec captures and forwards full callable signatures through decorators. PEP 544 Protocol classes provide structural typing. TypedDict provides typed mappings. `Final`, `Annotated`, `NewType`, and `assert_never` round out the modern toolkit. The specialist reaches for `assert_never` in match-statement default arms and `if/elif` chains over discriminated unions to enforce exhaustiveness at type-check time.

## Dataclasses, pydantic, attrs

`dataclasses.dataclass` is the standard-library mechanism for typed value classes. The specialist's defaults: `frozen=True` for immutable values, `slots=True` for memory efficiency on instances created at scale, `field(default_factory=list)` for the mutable-default-argument fix, `__post_init__` for validation that needs computed state. Pydantic is the canonical choice when boundary validation is needed (network input, config files, API surfaces); pydantic v2 produces typed, validated models from untrusted data. attrs is the historical alternative that predates dataclasses and remains in use; the specialist recognizes it but defaults new code to dataclasses + pydantic.

## Context managers, exceptions, decorators, metaclasses

The `with` statement runs `__enter__` / `__exit__` around a block, with `__exit__` receiving exception info and able to suppress (by returning truthy) or re-raise (by returning falsy or `None`). `contextlib.contextmanager` decorates a generator with one `yield` into a context manager, the canonical pattern for simple cases. `ExitStack` composes multiple context managers dynamically. `asynccontextmanager` provides the async analogue.

Exceptions inherit from `BaseException`; user code typically catches `Exception` or its subclasses. `raise X from Y` chains causes; `__cause__` and `__context__` carry the chain through `traceback`. PEP 654's `ExceptionGroup` and `except*` syntax (3.11+) handle structurally concurrent failures.

Decorators are functions that wrap functions or classes; the specialist's discipline is `@functools.wraps(fn)` on every wrapper to preserve `__name__`, `__doc__`, `__wrapped__`. The descriptor protocol (`__get__`, `__set__`, `__delete__`) is the underlying mechanism beneath methods, properties, and classmethods. Metaclasses (the `type` of types) are sometimes the right tool for class registries and class-level invariants, but the specialist's default is to reach for `__init_subclass__` or a class decorator first; metaclasses are correct rarely and confusing often.

## Packaging in the modern era

`pyproject.toml` is the single source of truth: PEP 517 (build backend interface), PEP 518 (build-system requires), PEP 621 (project metadata). Build backends include setuptools, hatch, poetry-core, and flit-core; the specialist reads the `[build-system]` table to know which backend's conventions apply. Entry points (`[project.scripts]`, `[project.gui-scripts]`, `[project.entry-points]`) declare console commands and plugin hooks. The specialist verifies the declared `requires-python` against the actual feature use in the codebase, and verifies `dependencies` against the actual imports.

## Failure modes the specialist watches for

Type hints that drift from runtime behavior - especially at boundaries (network, storage, user input) where unvalidated `dict[str, Any]` is treated as a typed structure in the body - are a Substrate Collapse in miniature. The specialist narrows at the boundary, with pydantic or explicit validation, not in the body.

A `# type: ignore` without a stated reason accumulates the same way an `as` cast does in the structural-typing world: each one is a claim the type system has been told to trust, and unaudited claims are future bugs.

A bare `except:` that swallows a `KeyboardInterrupt` or `SystemExit` is the catastrophic case; even `except Exception:` without re-raise hides operational failures. The specialist treats every broad-catch without re-raise as a finding.

A library version pinned in `pyproject.toml` whose installed wheel has drifted from the pin (e.g., a transitive constraint loosens it; a virtualenv was created against an older lockfile) is the dependency-side version of the Substrate problem. The specialist recommends `pip-compile`, `uv pip compile`, or poetry's lockfile to keep declared and installed versions joint.

## Ecosystem awareness

The specialist tracks the active Python release line (3.11, 3.12, 3.13 at this Knowledge Seed's writing; the cadence is roughly annual), the active type-checker (mypy / pyright / the newer pyrefly) and its strictness configuration, the project's `pyproject.toml` build backend, and the lockfile mechanism in use. The specialist reads release notes for each minor version to know which features can be assumed and which require fallback (`ExceptionGroup` requires 3.11+, `type` statement requires 3.12+, free-threaded build requires 3.13+ and is opt-in).

The Python polyhedron is well-tended at its center (CPython + the docs are co-evolved by the same community). The Combine specialist's attention is therefore mostly on the consumer side: are the type hints in this codebase a faithful description of the runtime behavior? Is the strictness profile honest about what has been audited? Are escape hatches (`Any`, `# type: ignore`, broad `except:`) documented or accumulated? Is the concurrency model matched to the workload (asyncio for I/O-bound, threading for I/O-bound with sync libraries, multiprocessing for CPU-bound until free-threading is default)?
