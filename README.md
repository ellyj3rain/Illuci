# Illuci

Illuci is an engine for running agents and coordinating their work. It connects model providers, tools, permissions, context and execution through one runtime. A single agent can work through a task, a group can examine it from different positions, and a pipeline can carry the result through successive stages.

The aim is to keep the work intelligible as it grows. A model response, an approved action, a changed file and a completed task are different events. Illuci retains those distinctions in its execution paths and observations so a caller can inspect what happened and decide what comes next.

**[Ground Zero](https://github.com/ellyj3rain/Ground_Zero) and Illuci are separate projects.** Ground Zero owns the development framework, Constitution and Bill of Standards. Illuci owns this engine and the mechanisms through which selected practices operate. Experience with the engine can expose a gap in the framework; a framework revision can improve the engine's operating contract. Neither update silently changes the other project. [Policy adoption and correspondence](docs/policy-adoption.md) explains the boundary.

## Start with an ordinary run

Node.js 22 is the tested JavaScript environment. Install the locked dependencies, then inspect the available surfaces:

```sh
npm ci
node cli/illuci.mjs --help
node cli/illuci.mjs topologies --json
node cli/illuci.mjs pipeline list --json
node examples/local-run.mjs
```

The example uses explicit in-memory inference and tool callbacks. It exercises the real agent loop without connecting to a provider. For a provider-backed run, configure your own provider and choose one of the model identifiers reported by `node cli/illuci.mjs models --json`:

```sh
node cli/illuci.mjs chat MODEL_ID "Explain this repository's main entry points."
node cli/illuci.mjs run dev-team "Review a bounded change and return concrete findings."
```

Provider authentication belongs to your installation. Illuci does not ship account state, signer identities or working transcripts. Command-specific executable paths and the optional `ILLUCI_VENDOR_ROOT` are explicit settings; there is no personal-machine discovery rule. [Development and configuration](docs/development.md) covers local state and checks.

## Choose the execution shape

| Surface | What it does |
|---|---|
| Agent SDK | Streams one agent or a council through the same `run()` interface. |
| CLI and terminal UI | Invokes the engine, lists its available configuration and reports outcomes. |
| Topologies and councils | Assigns models to structural roles and executes the selected phase relationships. |
| Pipelines | Connects implemented stages and carries their outputs forward. |
| Company orchestration | Coordinates selected topologies under shared budgets and stop controls; activation remains explicit. |
| MCP and ACP | Exposes the same engine through protocol adapters, preserving permission and cancellation boundaries. |
| Analysis, resilience and persona mechanisms | Retains observations and applies the implemented evaluation, routing and adaptation rules. |

A registry entry describes a configuration. It does not prove that a provider is authenticated, a model is available or a particular arrangement performs well. Check the actual route and outcome before making those claims.

## Use the SDK

```js
import { run } from './core/agent/index.js';

for await (const event of run({
  direction: { intent: 'Inspect the supplied project and explain one concrete defect.' },
  context: { cwd: process.cwd(), projectId: 'example-project' },
  config: {
    agent: 'MODEL_ID',
    tools: ['file_read'],
    maxSteps: 8,
    onPermission: async () => ({ approved: false, reason: 'Read-only example' }),
  },
})) {
  if (event.type === 'text') process.stdout.write(event.text ?? '');
  if (event.type === 'run_complete') console.log(event);
}
```

An `AbortSignal` can cancel a run. Abandoning its async iterator also stops further turns and not-yet-started tool calls. Cancellation after an external agentic provider has been entered is not proof that its effects did not occur; the dispatch path retains an unknown outcome and refuses an automatic retry where that boundary requires reconciliation.

## Find the implementation

| Responsibility | Source |
|---|---|
| Run loop, events, repair and permission rendezvous | [`core/agent/`](core/agent/) |
| Provider adapters and model dispatch | [`core/bridges/`](core/bridges/), [`core/dispatch/`](core/dispatch/) |
| Tool gates and adopted policy mechanisms | [`core/gates/`](core/gates/), [`core/governance/`](core/governance/) |
| Context, sessions and observations | [`core/context/`](core/context/), [`core/sessions/`](core/sessions/), [`core/data/`](core/data/) |
| Topology, pipeline and group execution | [`core/topologies/`](core/topologies/), [`core/pipelines/`](core/pipelines/), [`core/orchestrate/`](core/orchestrate/) |
| Analysis and measured routing adaptation | [`core/analysis/`](core/analysis/), [`core/resilience/`](core/resilience/), [`core/fleet/`](core/fleet/) |
| Agent identities, roles and dispositions | [`core/agents/`](core/agents/), [`core/roles/`](core/roles/) |
| Protocol receiving | [`core/mcp/`](core/mcp/), [`core/acp/`](core/acp/) |
| Optional fixed-point persona implementation | [`kernel/`](kernel/) |

[Architecture](docs/architecture.md) connects these parts and explains what their observations establish. [Contributing](CONTRIBUTING.md) describes a useful change and its verification.

## License

Illuci uses the GNU General Public License, version 3 only (`GPL-3.0-only`); see [LICENSE](LICENSE). Dependencies retain their own terms, recorded in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). This project does not license or distribute the separate private research and product lines from which parts of its development history originated.
