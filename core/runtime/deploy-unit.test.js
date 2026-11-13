// core/runtime/deploy-unit.test.js — [A22.6] the deploy unit renderer is deterministic + fail-closed.
import test from "node:test";
import assert from "node:assert/strict";
import { renderRuntimeUnit } from "./deploy-unit.js";

test("loopback unit needs no token and no EnvironmentFile", () => {
  const u = renderRuntimeUnit();
  assert.match(u, /Environment=ILLUCI_RUNTIME_HOST=127\.0\.0\.1/);
  assert.match(u, /ExecStart=node .*cli\/illuci\.mjs runtime serve --host 127\.0\.0\.1 --port 7473 --tenant default/);
  assert.doesNotMatch(u, /EnvironmentFile/);
  assert.match(u, /Restart=always/);
  assert.match(u, /WantedBy=default\.target/);
});

test("a LAN-bound unit loads its token from a mode-600 EnvironmentFile, never inline", () => {
  const u = renderRuntimeUnit({ host: "0.0.0.0", port: 7473, tenant: "zerostation" });
  assert.match(u, /Environment=ILLUCI_RUNTIME_HOST=0\.0\.0\.0/);
  assert.match(u, /EnvironmentFile=%h\/\.config\/illuci\/runtime\.env/);
  assert.match(u, /--host 0\.0\.0\.0 --port 7473 --tenant zerostation/);
  // the token value itself is never rendered into the unit
  assert.doesNotMatch(u, /ILLUCI_RUNTIME_TOKEN=\S/);
});

test("a non-loopback host with no tokenEnv is refused (never a credential-free exposed service)", () => {
  assert.throws(() => renderRuntimeUnit({ host: "0.0.0.0", tokenEnv: "" }), /non-loopback host must carry a tokenEnv/);
});

test("overrides flow through deterministically", () => {
  const u = renderRuntimeUnit({ repoDir: "/opt/illuci", node: "/usr/bin/node", port: 8080, restartSec: 5 });
  assert.match(u, /WorkingDirectory=\/opt\/illuci/);
  assert.match(u, /ExecStart=\/usr\/bin\/node \/opt\/illuci\/cli\/illuci\.mjs/);
  assert.match(u, /Environment=ILLUCI_RUNTIME_PORT=8080/);
  assert.match(u, /RestartSec=5/);
  assert.equal(renderRuntimeUnit({ port: 8080 }), renderRuntimeUnit({ port: 8080 })); // deterministic
});
