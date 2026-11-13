# Configure and verify an installation

Install the locked Node dependencies with `npm ci`. Native optional dependencies may require the toolchain documented by their upstream packages. The optional persona kernel is Rust source with an explicit build command; it is not constructed or loaded merely because the JavaScript package is installed.

Keep runtime data out of source control. `ILLUCI_CONFIG_HOME` selects the agent and user-configuration directory (default `~/.illuci`). `ILLUCI_DATA_HOME` selects the observation and session-data root. `ILLUCI_HOME` or `ILLUCI_TOOL_HOME` selects an explicit tool-state root when needed. Configure provider keys and account state through your own approved environment or provider tooling. Command overrides such as `CLAUDE_PATH`, `GROK_PATH` and the other source-defined tool settings avoid assumptions about a particular workstation.

The bundled signer registries contain no trusted contributor identity. Before enabling signed grant operations, configure your own reviewed signer registry and supply the explicit signing principal. A display name or an example principal is not an authorization.

Useful checks are:

```sh
npm run smoke:help
npm run smoke:topologies
npm run smoke:matrix
npm run test:agent
npm run test:providers
node examples/local-run.mjs
```

Choose further checks for the changed code and the behavior it affects. The retained tests include direct and council cancellation, permission rendezvous, per-turn memory, protected-context admission, provider failure/refusal, role and topology composition, and runtime contracts. Tests with fake providers establish those local control paths; they do not establish a live model route or model quality.

The hosted engine check runs `npm test` and the in-memory SDK example on Node 22 after installing the lockfile with dependency scripts and optional dependencies omitted. This verifies the selected JavaScript paths without building native database bindings or the optional Rust persona component. Those components and live provider routes need their own installation-specific checks.

To use MCP or ACP, launch the corresponding entry point from the selected source or installed package:

```sh
node core/mcp/server.js
node core/acp/server.js
```

These commands serve their stdio protocol. Configure the calling host's tool exposure and permissions before using effectful operations. In-process callers may use the exported handler maps directly.

Illuci's public project has its own development and release decisions. Changes to Ground Zero policy inputs use the adoption record, compare the affected consumer, and retain applicable evidence. A package version is not a claim that every optional provider, role or mechanism has been exercised in a particular installation.

Model registry rows name possible routing targets. They do not establish availability for your account. The installation-owned `MODEL_STATUS` map in `core/bridges/model-registry.js` can hold dated route restrictions; the public default contains no inherited personal account holds. Discovery distinguishes advertised inventory from inference and does not launch an unbound agentic process as an availability probe.
