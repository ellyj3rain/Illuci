// Grok CLI lane OS-sandbox lever (DR-202; [A115]) — the per-lane tool-flag layer
// the DR-200 grounding boundary explicitly left as a residual, first move: JAIL GROK.
//
// DR-200 ([A108]) grounds every CLI-agent lane in a per-dispatch scratch cwd. That
// re-roots default/relative file behavior but is NOT an OS jail: F-141 proved a
// grok-composer dispatcher seat wrote its team's draft INTO the engine checkout via
// ABSOLUTE paths, three session-log-proven times, while correctly sandbox-grounded.
// Absolute-path reads/writes bypass a cwd boundary.
//
// The lever: the Grok Build CLI ships its OWN kernel-enforced sandbox
// (`--sandbox <PROFILE>` / env `GROK_SANDBOX`). Built-in profiles (grok's own docs):
//   off        unrestricted (grok default)
//   workspace  read everywhere; write CWD + ~/.grok + temp
//   read-only  read everywhere; write ~/.grok + temp only
//   strict     read CWD + system paths; write CWD + ~/.grok + temp   ← illuci default
//   devbox     read everywhere; write all top-level dirs except /data (disposable VMs)
// A custom profile named in ~/.grok/sandbox.toml (with a kernel-enforced `deny` list
// for credential paths) is also legal and passes through unchanged.
//
// illuci defaults the grok lane to `strict` — the strongest scoped built-in: it closes
// BOTH the F-141 write escape (absolute writes to the checkout are denied; writes are
// confined to CWD + ~/.grok + temp) AND the read-scope axis DR-200 named (reads are
// confined to CWD + system paths, so the engine checkout and absolute credential
// stores become unreadable). grok receives all of its context on the PROMPT channel,
// not via filesystem reads of the checkout, so `strict` does not starve it.
//
// HONESTY (F-142): grok's sandbox is kernel-enforced ONLY on Linux (Landlock) and
// macOS (Seatbelt). On Windows the flag is ACCEPTED and the lane runs, but NO sandbox
// is applied and nothing is logged — a silent no-op (empirically confirmed:
// `grok --sandbox strict` produced output with no ~/.grok/sandbox-events.jsonl entry).
// So on the operator's win32 dev machine the only containment remains the DR-200
// grounding boundary (escapable per F-141); on the DEPLOYED Linux runtime the profile
// bites. `enforced` reports this truthfully per platform; the bridge warns once when a
// profile is requested on a platform that cannot enforce it. We do not fake a jail.

export const GROK_SANDBOX_SCHEMA = "illuci.bridges.grok-sandbox/1";

/** grok's own built-in profile names (its docs). Custom profile names also pass through. */
export const GROK_BUILTIN_PROFILES = Object.freeze([
  "off",
  "workspace",
  "read-only",
  "strict",
  "devbox",
]);

/** illuci's default grok-lane profile: the strongest scoped built-in (closes write + read escapes). */
export const GROK_SANDBOX_DEFAULT = "strict";

/** Platforms whose kernel actually enforces grok's sandbox. Elsewhere the flag is a no-op. */
export const GROK_ENFORCING_PLATFORMS = Object.freeze(["linux", "darwin"]);

/**
 * A profile token safe to hand to the CLI as an argument (built-in or custom name).
 * MUST begin with an alphanumeric — a leading `-` would be parsed by grok's arg parser
 * as a flag (e.g. `--always-approve`), so such values are rejected and degrade to the
 * confined default rather than injecting an option.
 */
const SAFE_PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

let warnedUnsafeProfile = false;

/**
 * Resolve the grok-lane OS-sandbox profile for a dispatch.
 *
 * Precedence (explicit-controls law, DR-129/DR-130): dispatch option
 * `options.grokSandbox` > env `ILLUCI_GROK_SANDBOX` > default `strict`. `off` is the
 * disclosed opt-out (illuci imposes no profile; grok self-resolves via its own
 * flag/env/config chain, defaulting off). An unsafe/garbage value degrades LOUDLY to
 * the default — for a safety boundary the safe side of a typo is confinement, never
 * silent exposure. Unknown-but-safe names (custom profiles) pass through; grok fails
 * CLOSED on a missing custom profile, so pass-through cannot silently un-sandbox.
 *
 * @param {object} [options] — dispatch options (reads `grokSandbox`)
 * @param {object} [env]     — environment (reads ILLUCI_GROK_SANDBOX)
 * @param {string} [platform] — process.platform (injectable for tests)
 * @returns {{ profile: string, source: "dispatch"|"env"|"default", builtin: boolean,
 *            enforced: boolean, platform: string }}
 */
export function resolveGrokSandbox(options = {}, env = process.env, platform = process.platform) {
  let source = "default";
  let requested = GROK_SANDBOX_DEFAULT;
  if (typeof options.grokSandbox === "string" && options.grokSandbox.length > 0) {
    requested = options.grokSandbox;
    source = "dispatch";
  } else if (typeof env.ILLUCI_GROK_SANDBOX === "string" && env.ILLUCI_GROK_SANDBOX.length > 0) {
    requested = env.ILLUCI_GROK_SANDBOX;
    source = "env";
  }

  let profile = String(requested).trim();
  // Compare built-in membership case-insensitively; keep custom names verbatim.
  const lowered = profile.toLowerCase();
  if (GROK_BUILTIN_PROFILES.includes(lowered)) {
    profile = lowered;
  } else if (!SAFE_PROFILE.test(profile)) {
    if (!warnedUnsafeProfile) {
      warnedUnsafeProfile = true;
      console.warn(
        `[grok-sandbox] unusable profile ${JSON.stringify(requested)} — grounding in "${GROK_SANDBOX_DEFAULT}" (the safe side; built-ins: ${GROK_BUILTIN_PROFILES.join("|")}, or a custom profile named in ~/.grok/sandbox.toml)`,
      );
    }
    profile = GROK_SANDBOX_DEFAULT;
    source = "default";
  }

  const builtin = GROK_BUILTIN_PROFILES.includes(profile);
  const enforced = profile !== "off" && GROK_ENFORCING_PLATFORMS.includes(platform);
  return { profile, source, builtin, enforced, platform };
}

/**
 * The CLI args that impose a resolved profile. `off` means "illuci imposes nothing" — the
 * opt-out steps back and lets grok self-resolve, so it emits NO flag (mirrors DR-200's
 * `shared` opt-out). Every other profile is passed explicitly as `--sandbox <profile>`,
 * which overrides a bare `GROK_SANDBOX`/config so illuci owns the governed default.
 * @param {{ profile: string }} descriptor
 * @returns {string[]}
 */
export function grokSandboxArgs(descriptor) {
  if (!descriptor || descriptor.profile === "off") return [];
  return ["--sandbox", descriptor.profile];
}

export default {
  GROK_SANDBOX_SCHEMA,
  GROK_BUILTIN_PROFILES,
  GROK_SANDBOX_DEFAULT,
  GROK_ENFORCING_PLATFORMS,
  resolveGrokSandbox,
  grokSandboxArgs,
};
