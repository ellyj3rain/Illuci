// core/runtime/deploy-unit.js
//
// [A22.6] Illuci Runtime service — deploy unit renderer. Produces the rootless systemd --user unit
// text that runs `illuci runtime serve` on a host (e.g. the Zerostation VM), mirroring the operator's
// existing rootless-podman --user + linger pattern. Pure + deterministic (no I/O) so the deploy
// runbook's unit is DERIVED and TESTABLE, never hand-copied drift.

const DEFAULTS = Object.freeze({
  description: "Illuci Runtime service (illuci runtime serve)",
  repoDir: "%h/illuci",          // where the source checkout lives on the host
  node: "node",               // node on PATH (VM has node 22)
  port: 7473,
  host: "127.0.0.1",          // loopback by default; a real deploy passes 0.0.0.0 + a token
  tenant: "default",
  tokenEnv: "ILLUCI_RUNTIME_TOKEN",
  restartSec: 3,
});

/**
 * Render a rootless `systemd --user` unit for the runtime service.
 * @param {object} opts  overrides for DEFAULTS; `host` other than loopback REQUIRES `tokenEnv`.
 * @returns {string} the unit file text
 */
export function renderRuntimeUnit(opts = {}) {
  const c = { ...DEFAULTS, ...opts };
  const loopback = c.host === "127.0.0.1" || c.host === "localhost";
  if (!loopback && !c.tokenEnv) {
    throw new Error("renderRuntimeUnit: a non-loopback host must carry a tokenEnv (never expose a credential-free service)");
  }
  const env = [
    `Environment=ILLUCI_RUNTIME_HOST=${c.host}`,
    `Environment=ILLUCI_RUNTIME_PORT=${c.port}`,
  ];
  // The token itself is NOT written into the unit — it is loaded from a mode-600 EnvironmentFile
  // so the secret never lives in a world-readable unit. The runbook creates that file.
  const envFileLine = loopback ? null : `EnvironmentFile=%h/.config/illuci/runtime.env`;
  const serveArgs = [`runtime`, `serve`, `--host`, c.host, `--port`, String(c.port), `--tenant`, c.tenant];

  return [
    `[Unit]`,
    `Description=${c.description}`,
    `After=network-online.target`,
    `Wants=network-online.target`,
    ``,
    `[Service]`,
    `Type=simple`,
    `WorkingDirectory=${c.repoDir}`,
    ...env,
    ...(envFileLine ? [envFileLine] : []),
    `ExecStart=${c.node} ${c.repoDir}/cli/illuci.mjs ${serveArgs.join(" ")}`,
    `Restart=always`,
    `RestartSec=${c.restartSec}`,
    ``,
    `[Install]`,
    `WantedBy=default.target`,
    ``,
  ].join("\n");
}

export const RUNTIME_UNIT_DEFAULTS = DEFAULTS;
export default { renderRuntimeUnit, RUNTIME_UNIT_DEFAULTS };
