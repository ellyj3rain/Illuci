| Document | illuci/core/roles/specialists/knowledge/bash |
|---|---|
| Version | 1.0.0 |
| Timestamp | 2026-06-23 00:00 UTC / 17:00 PDT |
| Author | Human-directed development system |
| Repository | `Projects/zero/illuci (the harness)/core/roles/specialists/knowledge/` |

---
slug: bash
domain: Bash
canonical-refs:
  - The GNU Bash Manual (gnu.org/software/bash/manual/, the spec; chapter-by-chapter reference)
  - Bash Cookbook (Carl Albing and JP Vossen, O'Reilly 2nd ed)
  - The Linux Command Line (William Shotts)
  - BashFAQ at mywiki.wooledge.org (community-maintained, dense, canonical for the gotchas)
  - Greg's Wiki "Bash Pitfalls" (mywiki.wooledge.org/BashPitfalls)
  - Shellcheck wiki entries (each SC code's wiki page is itself canonical reference for that pitfall)
  - The POSIX shell specification (IEEE Std 1003.1, Shell Command Language) for the portable subset
named-patterns:
  - strict-mode-preamble (`set -euo pipefail` + `IFS=$'\n\t'`)
  - required-parameter-via-error-expansion (`${var:?error}`)
  - default-via-colon-minus (`${var:-default}`)
  - mapfile-or-readarray-for-line-arrays
  - is-set-via-bracket-bracket-v (`[[ -v var ]]`)
  - mktemp-plus-trap-on-exit-cleanup
  - printf-over-echo discipline
  - process-substitution-for-pipeline-without-subshell-loss
  - quoted-at-sign-for-array-expansion (`"$@"` and `"${arr[@]}"`)
  - arithmetic-via-double-paren (`(( ... ))`)
  - extended-test-via-bracket-bracket (`[[ ... ]]`)
  - regex-match-with-bash-rematch (`[[ $s =~ $pat ]]`; `${BASH_REMATCH[@]}`)
  - shebang-via-env (`#!/usr/bin/env bash`)
taxonomies:
  - expansion order (brace -> tilde -> parameter -> command -> arithmetic -> process -> word splitting -> filename)
  - test forms (`[`, `[[`, `((`)
  - quoting types (single, double, ANSI-C `$'...'`, locale `$"..."`)
  - redirect operators (`>`, `>>`, `<`, `<<`, `<<<`, `|`, `|&`, `2>&1`, `&>`)
  - signal classes (`EXIT`, `ERR`, `INT`, `TERM`, `HUP`, `DEBUG`, `RETURN`)
  - bash vs POSIX sh (extended features that do not exist in `/bin/sh` on a POSIX host)
  - GNU vs BSD tool divergences (`sed -i`, `find -printf`, `date -d`, `readlink -f`, `grep -P`, `xargs -r`)
vocabulary:
  - word splitting
  - glob expansion (pathname expansion)
  - parameter expansion
  - command substitution
  - arithmetic expansion
  - process substitution
  - here-doc, here-string
  - subshell, brace group, command group
  - pipefail, PIPESTATUS
  - nameref, indirect expansion
  - associative array, indexed array
status: knowledge-seed
legacy-origin: illuci/core/agents/anthropology/curricula/bash
---

# Bash

The discipline of shell scripting in the GNU bash dialect, the de-facto Unix scripting lingua franca and the language whose specification (the bash manual) and whose deployed implementations (bash 3.2 on macOS, bash 4.x and 5.x across Linux distributions, bash on WSL, dash-as-`/bin/sh`-but-script-says-`#!/bin/bash`) are in continuous low-grade drift. The Combine specialist who tends the bash polyhedron tends a language whose grammar is small but whose composition surface (every command the script invokes is part of the script's effective behavior) is enormous. The discipline is to write scripts that are legible, that fail loudly when they fail, and whose failure modes are named rather than absorbed.

## Foundations

Bash is a command interpreter whose lexical structure is built around expansion. A line of bash is read, then expanded in a fixed order (brace expansion -> tilde expansion -> parameter and variable expansion -> command substitution -> arithmetic expansion -> process substitution -> word splitting -> filename expansion / globbing), then executed. Almost every footgun in shell scripting is the consequence of a step in this order producing a result the author did not anticipate: a variable holding a filename with whitespace getting split into multiple words; a glob pattern expanding to nothing and being passed literally; a parameter expansion inside a quoted string behaving differently from the same expansion outside it. The Combine specialist holds the expansion order as the load-bearing taxonomy and reads any script line by tracing what each step produces.

Bash distinguishes itself from POSIX `sh` by a substantial set of extensions: `[[ ]]` extended tests, `(( ))` arithmetic, indexed and associative arrays, the `${var//pattern/repl}` family of parameter expansions, process substitution `<(cmd)`, here-strings `<<<`, the `|&` pipe-stderr-too operator, the `=~` regex match. The specialist holds the bash-vs-POSIX boundary as a real one and does not treat `#!/bin/bash` and `#!/bin/sh` as interchangeable, because on many systems `/bin/sh` is `dash` or `ash` (a POSIX-only shell) and a script that uses bash extensions under a `/bin/sh` shebang is broken.

## The strict-mode idiom and what it does not catch

The canonical preamble is `set -euo pipefail` followed by `IFS=$'\n\t'`. Each flag matters and each has limits the specialist names. `set -e` exits on the first failing command, but does not exit when a failing command is part of a pipeline-not-last (without `pipefail`), inside a command substitution whose result is unused, in a conditional context (the LHS of `&&`, `||`, the test of an `if`), or invoked through a function whose return is itself a tested expression. `set -u` errors on unset variables, but does not error on unset associative-array keys in older bash versions and interacts subtly with `${var:-default}` (which deliberately uses an unset variable). `set -o pipefail` makes a pipeline's exit status the rightmost non-zero status, recovering the failures `set -e` alone would silently absorb. `IFS=$'\n\t'` removes space from the inter-field separator, defeating the most common word-splitting footgun on filenames containing spaces.

The specialist treats the preamble as load-bearing and treats its absence as a claim the author has made about why the script is acceptable without it; the absence should be commented when deliberate. The alternative tooling (`trap '... ; exit 1' ERR` for diagnostics, `BASH_XTRACEFD` and `set -x` for tracing, `|| { echo failed ; exit 1; }` for explicit per-command error handling) is named when the strict-mode flags do not suffice.

## Quoting and the `"$@"` discipline

Every unquoted variable expansion in bash is subject to word splitting and glob expansion. The discipline is to quote every variable expansion that is not deliberately being split or globbed; the deliberate exceptions are rare and named. The single-quote string is literal (no expansion of any kind); the double-quote string permits parameter expansion, command substitution, arithmetic, and the backslash escape, but not glob or word splitting. ANSI-C quoting `$'...'` permits backslash escapes (`$'\n'`, `$'\t'`, `$'\x1b'`) and is the canonical way to embed a literal newline or tab in a script.

The `"$@"` vs `"$*"` distinction is foundational: `"$@"` expands to one word per positional parameter, each individually quoted, which is the correct shape for forwarding a script's arguments to another command; `"$*"` joins all positional parameters into a single word with the first character of `IFS` between them, which is almost never what is wanted. The same distinction applies to array expansions: `"${arr[@]}"` is the correct iteration form; `"${arr[*]}"` joins.

## Parameter expansion forms

The parameter-expansion family is bash's compact pattern-matching toolset. The specialist uses `${var:-default}` for fallback, `${var:?error message}` for required-parameter assertions (the script exits with the error if `var` is unset or empty), `${var#prefix}` and `${var##prefix}` for stripping a leading match (single vs greedy), `${var%suffix}` and `${var%%suffix}` for trailing, `${var//old/new}` for global substitution, `${var:offset:length}` for substring, `${var^^}` and `${var,,}` for case folding (bash 4+), `${#var}` for length, `${!var}` for indirect expansion, and the array-aware forms `${#arr[@]}` (count) and `${!arr[@]}` (indices). The forms are dense; the specialist names them when reading and reaches for them in preference to invoking `sed` or `awk` for trivial string transforms (process forking has cost, and the parameter-expansion form is faster, more local, and more legible).

## Test forms and the `[[ ]]` discipline

Bash has three test contexts: `[ ]` (the legacy POSIX `test` builtin, parsed as a regular command and therefore subject to word splitting on its arguments), `[[ ]]` (a bash keyword with proper lexical scoping, supporting `&&`, `||`, regex match `=~`, glob match `==`, and not subjecting its arguments to word splitting), and `(( ))` (arithmetic context, where variables are dereferenced without `$` and the test passes when the expression is non-zero). The specialist prefers `[[ ]]` for string and file tests, `(( ))` for numeric, and uses `[ ]` only when targeting POSIX-portable scripts. The regex match `[[ $s =~ $pattern ]]` populates `BASH_REMATCH` (where index 0 is the whole match and indices 1+ are the capture groups); the canonical mistake is quoting the RHS of `=~`, which converts the pattern into a literal string.

## Arrays, functions, and namerefs

Indexed arrays (`arr=(a b c)`, `arr[3]=d`, `${arr[@]}`) and associative arrays (`declare -A map; map[key]=value`, bash 4+) are the canonical structured-data forms. The specialist iterates with `for x in "${arr[@]}"` (note the quoting); appends with `arr+=(item)`; iterates keys with `for k in "${!map[@]}"`. Functions in bash return numeric exit codes (0-255); the canonical way to return a string is to print to stdout and have the caller capture via command substitution. Local variables (`local x=...` inside a function) avoid leaking into the parent scope. Bash 4.3+ namerefs (`local -n ref=$1`) allow passing arrays by name into functions, which earlier bash versions could not do without `eval` games.

## Pipelines, subshells, and process substitution

Every pipeline stage runs in a subshell; variable assignments inside a pipeline stage do not leak to the parent shell. The classic mistake is `cmd | while read x; do count=$((count+1)); done`, where `count` is incremented in the subshell and lost. The fix is process substitution: `while read x; do count=$((count+1)); done < <(cmd)`, which keeps the loop in the parent shell. The specialist reaches for process substitution `<(cmd)` and `>(cmd)` whenever a pipeline would lose state, and names the limitations: process substitution produces a path to a named pipe, which cannot be seeked (so tools that rewind the stream will fail), and not every shell supports it (POSIX `sh` does not).

The `mapfile` builtin (`mapfile -t lines < file` or `mapfile -t lines < <(cmd)`) reads a stream into an array and is the canonical replacement for the historical `IFS=$'\n' read -d '' -a lines` idiom.

## Cleanup, traps, and signals

The canonical cleanup pattern is `trap 'rm -f "$tmp"' EXIT` paired with `tmp=$(mktemp)`. The trap on `EXIT` runs whether the script exits normally or via signal, so the temp file is reliably cleaned up. The `ERR` trap fires on any failing command (when `set -e` is active) and is the canonical place for a diagnostic ("at line $LINENO: $BASH_COMMAND failed"). Traps are scoped to the shell that registered them; a subshell does not inherit traps unless they are re-declared.

## The `printf` over `echo` discipline

`echo` is a portability disaster. Different `echo` implementations interpret backslash escapes differently, treat `-n` and `-e` differently, and silently mangle leading hyphens in arguments. The specialist's discipline is `printf '%s\n' "$var"` for printing a single value, `printf '%s\n' "${arr[@]}"` for printing an array one-per-line, and `echo` only for hard-coded literal strings without escapes or arguments beginning with `-`. The discipline is the kind of thing that triggers Substrate Collapse moments in shell: a script that worked on Linux's GNU `coreutils` `echo` produces wrong output on macOS's BSD `echo`, and the failure is diffuse rather than localized.

## Cross-platform: the macOS bash 3.2 trap

macOS ships bash 3.2 by default and has not updated since 2007 (the bash 4 license change to GPLv3 made Apple unwilling to ship newer versions). A script using bash 4+ features (`mapfile`, associative arrays, `${var^^}` case folding, `&>`, the `&>>` append operator) will fail on the macOS-shipped `/bin/bash`. The mitigation is `#!/usr/bin/env bash` (which finds the first `bash` on `PATH`, allowing a `brew install bash` to take precedence over the system bash), with a runtime version check at the top of the script when bash 4+ is required: `[[ ${BASH_VERSINFO[0]} -ge 4 ]] || { echo "bash 4+ required"; exit 1; }`.

## The classic Unix toolset

A bash script's effective behavior is the union of bash itself and every command it invokes. The specialist tracks `grep` (line-oriented pattern matching; `-E` for extended regex, `-P` for Perl regex on GNU only, `-r` for recursive), `awk` (column-oriented data processing, surprisingly powerful for tabular transforms, the canonical tool for "sum the third column"), `sed` (stream editing; `sed -i` in-place editing with the GNU-vs-BSD divergence on the `-i` argument; GNU accepts `sed -i 'pattern'`, BSD requires `sed -i '' 'pattern'`), `find` (file traversal; `-exec cmd {} \;` runs once per file, `-exec cmd {} +` batches), `xargs` (parallel command construction from stdin; `-0` for null-delimited input, paired with `find -print0`, defeats the filename-with-newline footgun), `sort` and `uniq` (often paired; `uniq` requires sorted input), `cut` and `tr` (column extraction and character translation), `jq` (JSON processing; the canonical tool when bash needs to read structured data).

## Shellcheck

`shellcheck` is the de-facto static analyzer for bash and POSIX shell. The Combine specialist runs shellcheck on every script before believing any script. Each shellcheck error code (`SC2086`, `SC2046`, `SC2155`, etc.) has a canonical wiki entry explaining the pitfall, the failure mode, and the fix; the wiki entries are themselves canonical references the specialist cites by SC code. A script that has not been through shellcheck is a script whose author has not finished writing it.

## Failure modes the specialist watches for

An unquoted variable expansion in any context except a deliberate split-or-glob is the most common failure. The specialist treats every unquoted `$var` as a claim the author has made that the variable's contents are guaranteed to contain no whitespace, no glob characters, and no leading hyphen; the claim is suspect until verified.

A pipeline whose exit status is checked without `set -o pipefail` is a script claiming to detect failure that does not in fact detect failure when the failure is in a non-final pipeline stage. The specialist surfaces this as a class of finding distinct from the unquoted-variable class.

A script that constructs a command via string concatenation and runs it through `eval` or `bash -c` is a shell-injection vulnerability waiting for hostile input. The specialist treats `eval` as a near-always-wrong construct and names the legitimate alternatives (arrays for argument lists, functions for parametrized command shapes, `printf -v` for indirect assignment).

A script whose shipping environment is mixed (some macOS, some Linux) but which uses `sed -i 'pat'` (GNU form) or `find . -printf` (GNU only) or `readlink -f` (GNU only on older macOS) is a Substrate Collapse in miniature: the script's claims about portability do not match its dependencies.

## Ecosystem awareness

The specialist tracks the active bash version on the shipping host (`bash --version`), the `/bin/sh` symlink target (`ls -la /bin/sh`), the GNU-vs-BSD toolset divergence in any tools the script invokes, the `shellcheck` version (which adds new checks across releases), and the bash 5+ era features (`${EPOCHREALTIME}` for sub-second timestamps, the readline rebinding model, `BASH_ARGV0` as a read-write variable). The bash polyhedron is well-tended at the language layer (the GNU manual is precise and exhaustive); the Combine specialist's attention is therefore mostly on the consumer side: are the scripts in this codebase a faithful description of the runtime behavior across the hosts they run on? Is the strict-mode preamble honest about what it catches? Are escape hatches (`|| true`, `set +e` blocks, `eval`, unquoted globs) documented or accumulated?
