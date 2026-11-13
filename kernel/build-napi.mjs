#!/usr/bin/env node
/**
 * kernel/build-napi.mjs — build the persona-kernel-napi Tier-1 addon locally
 * ([A82]/DR-175). LOCAL + OPT-IN by design: CI is node-only, the addon is
 * gitignored, and `core/agents/persona-kernel.js` optional-loads it — the
 * engine is fully functional without it (the DR-170 D6 napi-gate simply stays
 * closed where the addon is absent).
 *
 * Windows notes (kernel/README.md): build with the msvc target (the gnu
 * toolchain lacks dlltool) and redirect CARGO_TARGET_DIR to a short path
 * (MAX_PATH). Override with CARGO_TARGET_DIR / ILLUCI_KERNEL_TARGET.
 *
 * Usage: npm run kernel:napi:build   (or: node kernel/build-napi.mjs)
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const KERNEL_DIR = dirname(fileURLToPath(import.meta.url));
const isWindows = process.platform === "win32";
const target = isWindows ? "x86_64-pc-windows-msvc" : null;
const targetDir =
  process.env.CARGO_TARGET_DIR ||
  process.env.ILLUCI_KERNEL_TARGET ||
  (isWindows ? "C:/t/pk" : join(KERNEL_DIR, "target"));

const args = [
  "build",
  "-p", "persona-kernel-napi",
  "--release",
  "--manifest-path", join(KERNEL_DIR, "Cargo.toml"),
];
if (target) args.push("--target", target);

console.log(`[kernel:napi] cargo ${args.join(" ")}  (CARGO_TARGET_DIR=${targetDir})`);
execFileSync("cargo", args, {
  stdio: "inherit",
  env: { ...process.env, CARGO_TARGET_DIR: targetDir },
});

const libName = isWindows
  ? "persona_kernel_napi.dll"
  : process.platform === "darwin"
    ? "libpersona_kernel_napi.dylib"
    : "libpersona_kernel_napi.so";
const built = join(targetDir, ...(target ? [target] : []), "release", libName);
if (!existsSync(built)) {
  console.error(`[kernel:napi] build product not found at ${built}`);
  process.exit(1);
}

const out = join(KERNEL_DIR, "persona-kernel-napi", "persona-kernel.node");
mkdirSync(dirname(out), { recursive: true });
copyFileSync(built, out);
console.log(`[kernel:napi] addon ready: ${out}`);
