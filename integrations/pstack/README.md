# pstack team workflow for T3 Code

This is an opt-in coordination workflow for T3 Code. It adapts two small parts of Lauren Tan's pstack: frame work before fan-out, assign one owner per task, and require evidence plus independent review before acceptance. T3 is the workbench and the single runtime for multiple executor sessions; its existing delegated tasks, child threads, worktrees, and scheduler do the execution. pstack supplies working conventions. The requested Grok Bot / DeepSeek SuperAgent style of task routing, continued follow-up, and blocker recovery is expressed as coordinator guidance, without combining two complete runtimes.

Start a coordinator thread in your project and explicitly ask it to read [t3-team.md](t3-team.md). See the [team tasks guide](../../docs/user/team-tasks.md) for a starter prompt. Nothing in this folder installs a plugin, registers a hook, runs an upstream script, or writes user configuration. Reading this file does not start agents or schedules.

## Expanding the team on demand

The default is to assemble a temporary team automatically for each approved task, using T3's existing delegation within available providers, concurrency, and budget. An extra implementation, research, or review worker can be added as needed. Saving a reusable role is optional and requested separately. Keep three concepts separate:

| Concept | Meaning and current scope |
| --- | --- |
| Role profile | Reusable responsibilities, preferences, and capability boundaries. Today these belong in the task brief; persistent, configurable role profiles are not implemented. |
| Executor | A T3 provider instance plus a model, discovered through existing T3 capabilities. |
| Temporary worker | A concrete child conversation created by `delegate_task`, with existing task and session identifiers. |

This supports temporary expansion for approved work. Long-term member identity, cross-task memory, and organization management remain future features. The MVP adds no second runtime or employee directory.

## Choose available executors and models

The coordinator and task owners are not fixed to Codex. Select the executor and model per task from the user's approved, actually available Codex, Qoder, and Antigravity (AGY) instances. T3 capability discovery supplies the real account's model catalog and constraints. Qoder might expose Kimi models and AGY might expose Gemini models; neither example guarantees access or availability. Preserve task needs, provider/model preferences, budget, and permissions rather than assigning a product-wide default.

An explicitly requested model that is unavailable blocks that assignment. Report its reason and any exact replacement; do not silently fall back. A replacement needs either an applicable existing user-approved fallback policy or new approval, and must be disclosed. Distinguish selected model/options from a provider-reported executed model. Report configured effort only when its selected option is actually available, and actual effort only when the provider reports it; unknown values stay unknown. Capability discovery does not install software, authenticate, or read credentials.

## A task list that can change

The coordinator can add tasks, edit scope, and adjust priorities in chat. Stable task keys, revisions, and issued dispatch keys do not change with display order. Priority affects only ready tasks not yet dispatched; submitted, running, and completed work is neither restarted nor interrupted by reordering. Missing prerequisites, self-dependencies, and cycles block dispatch. Scope changes require the relevant confirmation and a new revision, preserving prior briefs, IDs, results, and review history.

Each observation records when evidence was actually read, separately from source update, start, or end times. These are behavior rules in the coordinator's chat ledger. Persistent planning, editable priority controls, dependency enforcement, saved role profiles, and revision storage are not implemented by this slice.

For model selection, an omitted target inherits the current T3 provider and model; options inherit only for the same instance and resolved model. Explicit options override matching IDs, while an empty array or object clears them. For a local child, a different provider without a model uses its first advertised model; a remote child switching providers requires an explicit model. A changed target does not inherit old options. Read live capabilities instead of assuming a fixed model or effort default.

A nonempty advertised catalog rejects an unknown explicitly requested model with `model_unavailable`; an empty catalog accepts arbitrary slugs and is not account-access proof. The provider may report a different executed model. The coordinator must flag that mismatch before acceptance; this preview does not add backend enforcement of request/execution equality.

The mapping is grounded in [T3's target resolver](../../apps/server/src/mcp/OrchestratorMcpService.ts) and [its existing option-inheritance cases](../../apps/server/src/mcp/OrchestratorMcpService.test.ts).

## Upstream provenance

The unchanged references are:

- [Swarm](upstream/skills/swarm/SKILL.md): frame, fan out, aggregate, report; self-contained briefs and evidence.
- [Orchestrate](upstream/skills/poteto-mode/playbooks/orchestrate.md): single ownership, bounded scope, and an independent verifier.
- [MIT license](upstream/LICENSE), Copyright (c) 2026 Lauren Tan.

[UPSTREAM.json](UPSTREAM.json) pins the official `cursor/plugins` commit, source paths, immutable URLs, and SHA-256 hashes. These are reference documents, not installed skills. Their Cursor tool names, cloud execution, model defaults, configuration paths, and merge instructions are not the T3 adapter. The adapted workflow is in `t3-team.md`; do not execute the reference documents as a separate workflow. The full `poteto-mode` skill and `poteto-agent` definition are not bundled.

To verify the vendored bytes offline:

```sh
node integrations/pstack/verify-upstream.mjs
```

Updating the pin is a deliberate source review: download from one new official commit, compare the changes, retain its license, update the manifest hashes, and rerun the verifier. Downloaded code is never executed by this integration.

## Compatibility and verification

The adapter was checked against T3 commit `5f85768394f417f5bd098ca7fe4fc41ef07a7cda`:

- [Orchestrator tools](../../apps/server/src/mcp/toolkits/orchestrator/tools.ts) and [project tools](../../apps/server/src/mcp/toolkits/project/tools.ts).
- [MCP schemas](../../packages/contracts/src/orchestratorMcp.ts) and [schedule schemas](../../packages/contracts/src/scheduledTask.ts).

Tool examples use schema field names, not a new executor API. The runtime's live tool schemas remain authoritative. No existing model-facing T3 instructions or MCP tool schemas are changed.

The first Mac preview targets a minimal task-to-session-to-progress-and-review loop. It does not establish complete support across providers or platforms. This slice includes the workflow, source provenance, and a view of currently loaded app-owned delegated tasks in Thread details. It does not add project-wide task storage or install providers. Historical pagination, mobile presentation, and real model behavior have not been verified for this integration. A completed provider run is not evidence of task acceptance.

Codex and Antigravity use their existing T3 adapters when available. Qoder has an upstream ACP Registry entry, but Qoder execution, MCP injection, approval behavior, and this workflow have not been tested together. Do not advertise verified Qoder support or bundle its proprietary CLI. Detect actual availability before assigning it work.

`evals/README.md` and `evals/mcp-tool-use/README.md` were reviewed. Their paid model evals and real provider turns were deliberately not run for this slice. Static provenance and example checks do not establish model compliance or end-to-end support.
