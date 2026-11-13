// core/governance/grants/signing.js
//
// CAP-1: the ssh edge — grant/revocation payloads signed with the operator's
// SSH key and verified against the COMMITTED allowed_signers registry (the
// same DR-121 trust root the commit-signing gate uses; one registry, every
// governance signature). Injectable ports: the manager takes {signer,verifier}
// so tests stay hermetic with fakes; these factories are the real thing.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { GRANT_SIGNING_NAMESPACE } from "./registry.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
// Read at CALL time (not module load) so env overrides (tests, per-host keys)
// take effect regardless of import order.
export function defaultSigningKey() {
  return process.env.ILLUCI_GRANT_SIGNING_KEY || join(homedir(), ".ssh", "id_illuci_sign");
}
export const DEFAULT_ALLOWED_SIGNERS = resolve(REPO_ROOT, "core", "governance", "signing", "allowed_signers");

export function sshKeygenAvailable() {
  try {
    execFileSync("ssh-keygen", ["-?"], { stdio: ["ignore", "ignore", "pipe"] });
    return true;
  } catch (err) {
    // ssh-keygen -? exits non-zero but PRINTS usage when present; absence throws ENOENT.
    return err?.code !== "ENOENT";
  }
}

function inTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "illuci-grant-sig-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The real signer: `ssh-keygen -Y sign` over the canonical payload. */
export function createSshGrantSigner({ privateKeyPath = defaultSigningKey(), namespace = GRANT_SIGNING_NAMESPACE } = {}) {
  return {
    kind: "ssh",
    sign(payload) {
      return inTempDir((dir) => {
        const file = join(dir, "payload");
        writeFileSync(file, payload);
        execFileSync("ssh-keygen", ["-Y", "sign", "-f", privateKeyPath, "-n", namespace, file], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        return readFileSync(join(dir, "payload.sig"), "utf8");
      });
    },
  };
}

/** The real verifier: `ssh-keygen -Y verify` against the committed registry. */
export function createSshGrantVerifier({ allowedSignersPath = DEFAULT_ALLOWED_SIGNERS, namespace = GRANT_SIGNING_NAMESPACE } = {}) {
  return {
    kind: "ssh",
    verify(payload, signature, principal) {
      return inTempDir((dir) => {
        const payloadFile = join(dir, "payload");
        const sigFile = join(dir, "payload.sig");
        writeFileSync(payloadFile, payload);
        writeFileSync(sigFile, signature);
        try {
          execFileSync(
            "ssh-keygen",
            ["-Y", "verify", "-f", allowedSignersPath, "-I", principal, "-n", namespace, "-s", sigFile],
            { input: payload, stdio: ["pipe", "pipe", "pipe"] },
          );
          return true;
        } catch {
          return false;
        }
      });
    },
  };
}

export default { defaultSigningKey, DEFAULT_ALLOWED_SIGNERS, sshKeygenAvailable, createSshGrantSigner, createSshGrantVerifier };
