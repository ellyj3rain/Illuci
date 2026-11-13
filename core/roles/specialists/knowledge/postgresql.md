| Document | illuci/core/roles/specialists/knowledge/postgresql |
|---|---|
| Version | 1.0.0 |
| Timestamp | 2026-06-23 00:00 UTC / 17:00 PDT |
| Author | Human-directed development system |
| Repository | `Projects/zero/illuci (the harness)/core/roles/specialists/knowledge/` |

---
slug: postgresql
domain: PostgreSQL
canonical-refs:
  - The PostgreSQL Documentation (the chapter-by-chapter manual, postgresql.org/docs - itself the canonical reference)
  - The Internals of PostgreSQL (Hironobu Suzuki, interdb.jp/pg)
  - PostgreSQL Up and Running (Regina Obe and Leo Hsu, O'Reilly 2017 3rd ed)
  - SQL Performance Explained (Markus Winand, use-the-index-luke.com - cross-engine but PostgreSQL is well-covered)
  - The pgsql-hackers mailing list (ongoing primary source for planner, MVCC, and storage-engine evolution)
  - Designing Data-Intensive Applications (Martin Kleppmann, O'Reilly 2017 - the storage-engine and isolation-level chapters)
  - The PostgreSQL wiki (wiki.postgresql.org, particularly the Don't Do This page)
named-patterns:
  - security-definer-with-locked-search-path
  - current-resolver-functions (current_user, current_setting, current_role, plus app-defined current_organization_id)
  - rls-policies-with-using-and-with-check
  - before-insert-update-triggers-as-column-allowlist-guards
  - partial-unique-indexes-for-state-invariants
  - jsonb-containment-with-gin-index
  - generated-columns-for-derived-state
  - exclusion-constraints-for-non-overlapping-ranges
  - upsert-via-insert-on-conflict
  - lateral-joins-for-correlated-subqueries
  - recursive-ctes-for-hierarchical-traversal
  - window-functions-for-running-aggregates
  - covering-indexes-with-include
  - explain-analyze-buffers-format-json
taxonomies:
  - isolation levels (read uncommitted, read committed, repeatable read, serializable; with the postgres caveat that read uncommitted is treated as read committed)
  - index types (btree, hash, gin, gist, brin, partial, expression, covering with INCLUDE)
  - function volatility (IMMUTABLE, STABLE, VOLATILE)
  - function security (DEFINER, INVOKER)
  - function languages (LANGUAGE sql, LANGUAGE plpgsql, LANGUAGE c, plus extension languages)
  - WAL levels (minimal, replica, logical)
  - lock modes (the eight table-level lock modes, plus row-level locks)
  - constraint types (PRIMARY KEY, UNIQUE, FOREIGN KEY, CHECK, NOT NULL, EXCLUDE)
vocabulary:
  - MVCC (multi-version concurrency control)
  - tuple visibility, xmin, xmax
  - vacuum, autovacuum, bloat, freeze
  - the catalog (pg_class, pg_attribute, pg_index, pg_constraint, pg_proc, pg_policy, pg_namespace)
  - pg_stat_user_tables, pg_stat_user_indexes, pg_stat_statements
  - search_path
  - schema as namespace
  - serialization failure, deadlock detection
  - HOT update (heap-only tuple)
  - planner statistics, n_distinct, most-common-values
status: knowledge-seed
legacy-origin: illuci/core/agents/anthropology/curricula/postgresql
---

# PostgreSQL

The relational discipline as it manifests in one specific implementation. The Combine specialist who tends the PostgreSQL polyhedron tends a database whose specification (the SQL standard plus the project's documented extensions) and implementation (the source tree and the running server) are unusually well-aligned: the same community owns both, the documentation is co-evolved with the code, and the catalog itself is queryable as a description of the running server. The relational integrity property the specialist tends is not a single artifact but a joint property of schema, queries, indexes, and access controls - all four faces must hold for the database to be correct.

## Foundations

PostgreSQL stores tuples (rows) under MVCC: each transaction sees a snapshot of the database consistent with its visibility rules, and writes produce new tuple versions rather than overwriting old ones. Each tuple carries `xmin` (the transaction that created it) and `xmax` (the transaction that deleted it, if any); visibility is computed against the reading transaction's snapshot. The Combine specialist holds MVCC as foundational: it is what makes readers never block writers and writers never block readers, and it is what makes vacuum (and autovacuum) load-bearing operational discipline. A PostgreSQL database whose autovacuum has fallen behind is a database whose reads are scanning more dead tuples than live ones; the specialist treats `pg_stat_user_tables.n_dead_tup` as a primary observability surface.

Isolation levels in PostgreSQL are read committed (the default), repeatable read, and serializable; read uncommitted is accepted syntactically but treated as read committed (per the manual's chapter on transaction isolation). The specialist holds that read committed is correct for most application transactions but is not sufficient when the transaction's correctness depends on reading a stable view of the database across multiple statements; in those cases, the specialist reaches for repeatable read or serializable, and accepts the cost of serialization-failure retry logic.

## The query language

PostgreSQL implements the SQL standard through a recent revision, plus extensions the community has found load-bearing. The specialist treats `RETURNING` (returning rows from `INSERT`, `UPDATE`, `DELETE`), `LATERAL` joins (for correlated subqueries that return more than one row), `GROUPING SETS` / `CUBE` / `ROLLUP` (for multi-dimensional aggregation), recursive CTEs (`WITH RECURSIVE` for hierarchical traversal), and window functions (`OVER (PARTITION BY ... ORDER BY ...)` for running aggregates) as core working vocabulary, not optional decoration. The upsert pattern - `INSERT ... ON CONFLICT (key) DO UPDATE SET ... RETURNING ...` - is the canonical idiom for "insert or update" and replaces the historical "try-update-then-insert" pattern.

## The type system

PostgreSQL ships a rich built-in type system (numeric, text, timestamp/timestamptz, interval, boolean, uuid, the network types, the geometric types) and supports user-defined extensions: domains (a base type with check constraints), composite types (row types), enumerated types, range types (with associated exclusion constraints), and arrays of any of the above. The specialist treats `jsonb` as load-bearing distinct from `json`: `jsonb` is parsed, decomposed, and indexed (via GIN with the default or `jsonb_path_ops` operator class); `json` is stored as text and is appropriate only when round-trip fidelity matters more than queryability. The `@>` containment operator on `jsonb` is the canonical pattern for "find rows whose jsonb column contains this subdocument," and the canonical pairing is a GIN index on the jsonb column.

## Indexing taxonomy

PostgreSQL's index types are not interchangeable. The specialist holds the taxonomy as working vocabulary: btree (ordered, range queries, the default for `=`, `<`, `>`, `BETWEEN`, `ORDER BY`), hash (equality only, since pg10 WAL-logged), GIN (inverted, for arrays, jsonb, full-text search), GiST (generalized search tree, for geometric and full-text and exclusion constraints), BRIN (block range, for very large tables with strong physical-row correlation), partial (`WHERE` clause restricting which rows are indexed - the canonical pattern for state invariants), expression (an index on a function of columns rather than columns themselves), and covering (`INCLUDE` clause adding non-key columns for index-only scans). The specialist reads each index choice as a deliberate decision and treats unused indexes (per `pg_stat_user_indexes.idx_scan = 0` over a representative window) as cost without benefit.

## Row-Level Security

RLS is the GZS portal's load-bearing access-control pattern and the specialist treats it as central, not optional. A table with RLS enabled (`ALTER TABLE ... ENABLE ROW LEVEL SECURITY`) requires a policy for any access path; without policies, the default is deny. A policy declares a role, a command (`SELECT`, `INSERT`, `UPDATE`, `DELETE`, or `ALL`), a `USING` expression (which rows the policy admits for read or as the source of an update/delete), and a `WITH CHECK` expression (which rows are valid as the destination of an insert or update). The specialist reads `USING` and `WITH CHECK` as a paired discipline: a policy with `USING` but no `WITH CHECK` (where `WITH CHECK` would default to `USING`) is acceptable only when read and write predicates are intentionally identical; an asymmetric pair is a deliberate choice that must be named.

## Functions and the SECURITY DEFINER idiom

Functions in PostgreSQL declare a language (`LANGUAGE sql`, `LANGUAGE plpgsql`, `LANGUAGE c`, or an extension language), a volatility (`IMMUTABLE` if the function returns the same result for the same arguments and reads no database state; `STABLE` if it reads but does not write; `VOLATILE` otherwise), and a security mode (`SECURITY DEFINER` runs the function as the function's owner; `SECURITY INVOKER` runs as the calling role). The `SECURITY DEFINER` + locked-`search_path` idiom (`SECURITY DEFINER ... SET search_path = pg_catalog, <explicit schema list>`) is the canonical pattern for delegating elevated capability through a narrow audited interface; an unpinned `search_path` on a `SECURITY DEFINER` function is a canonical privilege-escalation surface (CVE-grade pattern in production deployments), and the specialist treats it as a finding regardless of stance.

Volatility annotations are load-bearing for the planner: `IMMUTABLE` functions can be inlined into expressions and used in expression indexes; `STABLE` functions are guaranteed not to change within a single statement and can be used in index conditions for the duration of the statement; `VOLATILE` functions cannot. A function whose volatility is mis-declared (a `STABLE` function that mutates state, an `IMMUTABLE` function that reads from a table) is a planner bug waiting to happen; the specialist reads volatility annotations adversarially.

## EXPLAIN as discipline

`EXPLAIN` returns the planner's chosen plan; `EXPLAIN ANALYZE` runs the query and reports actual times and row counts; `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` adds buffer-cache hit/miss statistics and emits a machine-readable plan. The specialist reads plans for: sequential scans on tables that should be indexed; index scans whose returned-row count is far smaller than the planner's estimate (suggesting statistics drift, calling for `ANALYZE`); nested loops with high outer-row counts (suggesting a hash or merge join would be better); and buffer-miss ratios that indicate working-set drift relative to `shared_buffers`. The discipline is to never guess at a plan when `EXPLAIN ANALYZE` is available.

## Operations: replication, WAL, recovery

PostgreSQL writes a write-ahead log (WAL) before modifying data pages; the WAL is the basis for crash recovery, replication (streaming and logical), and point-in-time recovery. The `wal_level` GUC takes `minimal`, `replica` (the default in modern versions), and `logical` (which adds the per-row change information needed by logical replication and CDC). The specialist treats WAL as operational discipline more than craft, and defers to the operator and to operations runbooks for tuning; the Knowledge Seed surfaces the surface area without claiming the specialist owns it.

## The catalog as introspection surface

PostgreSQL's system catalogs (`pg_class`, `pg_attribute`, `pg_index`, `pg_constraint`, `pg_proc`, `pg_policy`, `pg_namespace`, `pg_stat_*`) are queryable as ordinary tables. The specialist reaches for catalog queries rather than memory: "does this table have RLS enabled?" is `SELECT relrowsecurity FROM pg_class WHERE oid = 'schema.table'::regclass`; "what indexes does this table have?" is a join through `pg_index` and `pg_class`; "which functions are SECURITY DEFINER without a pinned search_path?" is a query on `pg_proc` filtered on `prosecdef` and the absence of a `search_path` in `proconfig`. A specialist who answers from memory when the catalog is one query away has not finished apprenticing.

## Failure modes the specialist watches for

A `SECURITY DEFINER` function without a pinned `search_path` is the canonical privilege-escalation surface: a hostile schema-search path can substitute a same-named function or operator for one the SECURITY DEFINER trusts, and the function executes the substitute with the owner's privileges. The specialist treats this as a finding regardless of stance.

An RLS policy with `USING` but no `WITH CHECK` (and where read and write predicates should differ) silently admits writes the read predicate would have rejected. The specialist treats asymmetric `USING`/`WITH CHECK` as a deliberate choice that must be named.

A function whose volatility is over-declared (a `VOLATILE` function declared `IMMUTABLE` to allow it in an expression index) is a stale-data bug: the planner will cache results that are no longer valid. The specialist reads volatility against function bodies, not against the declaration.

A long-running transaction (per `pg_stat_activity.xact_start`) blocks vacuum across the entire database; bloat accumulates, plans degrade. The specialist treats `pg_stat_activity` queries as part of the diagnostic surface.

A statistics-drifted table (per `pg_stat_user_tables.last_analyze` aging behind `n_mod_since_analyze`) yields plans against a fictional table; the specialist reads `EXPLAIN ANALYZE`'s estimate-vs-actual rows as a primary diagnostic.

## Ecosystem awareness

The specialist tracks the active PostgreSQL major version's release notes (majors land roughly annually; the deprecation surface and new planner capabilities matter), the active extension set (`pg_stat_statements`, `pgcrypto`, `uuid-ossp`, `pg_trgm`, plus any application-domain extensions), and the project's `postgresql.conf` and `pg_hba.conf` insofar as those configure the connection model and the access surface. The PostgreSQL polyhedron is well-tended in the project's home; the Combine specialist's attention is therefore mostly on the consumer side: are the schema's declared invariants actually enforced? Are the RLS policies a faithful description of who-can-see-what? Are SECURITY DEFINER functions audited and locked? Is the `EXPLAIN` discipline actually being practiced, or are plans being guessed at?
