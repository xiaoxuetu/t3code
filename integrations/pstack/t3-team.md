# T3 team coordination workflow

Apply this workflow only when the user explicitly asks this coordinator thread to read it. Follow the user's existing authorization, provider preferences, budget, and workspace restrictions. Reuse T3's live tools; their names may have a harness prefix. Never install providers, run downloaded scripts, change user configuration, read credentials, publish, push, or merge merely because an upstream reference describes those actions.

T3 remains the workbench and session runtime; pstack supplies working conventions. Neither the coordinator nor task owners are fixed to Codex: the coordinator can use any user-approved available provider, and each task can select a different approved executor and model. Route tasks, follow them through review, and recover blockers in this coordinator conversation, using T3's existing services rather than introducing a second runtime. This guidance has not been validated by model evals.

The vendored pstack [Swarm](upstream/skills/swarm/SKILL.md) and [Orchestrate](upstream/skills/poteto-mode/playbooks/orchestrate.md) are design references. This file supplies the T3 mapping. Do not invoke their Cursor tools, hardcoded model defaults, global configuration paths, or unbundled skills.

## 1. Agree on the work in chat

Before the first dispatch, restate the goal and propose a short task table. Assemble a temporary team automatically for the task within the approved providers, budget, and concurrency; do not make the user configure employees first. Each task needs a stable human-readable key, revision, priority, one responsible owner role, writable and excluded paths, dependencies pinned to task revisions, an artifact or report, and an observable acceptance check. Record a reviewer for each behavioral change. Clarify only missing decisions that change this scope; preserve answers and authorization already given in this thread.

Show the concrete table and let the user confirm or correct it before starting agents. If the user has already approved that goal and task list, continue without asking again. A suggested row is:

| Task / revision | Priority | Owner role | Scope and exclusions | Acceptance evidence | Dependencies | Reviewer |
| --- | --- | --- | --- | --- | --- | --- |
| T1 / r1 | Normal | Implementation | Named paths; explicit exclusions | Exact check plus expected behavior | None | Independent review |

Keep this ledger in coordinator messages. It is a chat ledger, not a persistent task planner or a saved role-profile store. Do not create a second task database or write a tracker into the user's repository unless requested. The Team tasks panel reflects T3 delegation records; proposed rows do not appear there until dispatched.

Default to task-specific workers. If the user asks to save a role, capture its responsibilities, preferences, and capability boundaries in the chat ledger and explain that persistent, configurable role profiles are not implemented. Do not claim a durable member was saved or silently write a global profile; a durable export needs a named destination and appropriate authorization outside this slice.

### Maintain the task list while work continues

- **Stable identity:** keep the task key and revision separate from row position. Preserve every issued `taskId`, session ID, dispatch key, and result. Never renumber tasks or derive dispatch keys from sort order. For a new dispatch use a key derived from team ID, task key, revision, role, and round; a retry of that same operation reuses its original key.
- **Add tasks:** allocate a new task key and initial revision, record scope and acceptance, and validate its dependencies. Dispatch only when that work is authorized and ready. A new row is not permission to start an ambiguous or out-of-scope task.
- **Reprioritize:** reorder only tasks not yet dispatched whose dependencies are satisfied. Preserve existing order among equal priorities. A task already submitted through `delegate_task`, including queued or pending work, keeps its identity and execution. A priority change alone must not reissue, interrupt, cancel, restart, or duplicate submitted, running, or completed work. A presentation sort in the panel is not a scheduler command.
- **Validate dependencies:** reject missing references, self-dependencies, and cycles. A task is ready only when its named prerequisite revisions are accepted with evidence; `Run completed` alone is insufficient. Higher priority cannot override a blocker. Report the concrete dependency problem and ask only for the decision needed to resolve it.
- **Change scope:** show the changed scope, dependencies, acceptance, and effects on existing work; confirm the new revision unless the user already explicitly authorized that exact change. Append the revision and its decision to history instead of rewriting an old brief or verdict. Keep active and completed revisions intact. Resolve conflicting writers before dispatching a new revision; stopping or steering an old run needs specific authority, not a reorder. Unchanged tasks keep their original IDs and request keys.
- **Observe:** each task update records `observedAt` as the actual UTC time the coordinator read the evidence, and `sourceUpdatedAt` from the native record when available. Keep those separate from source-provided start and end times. Unknown source times stay unknown; observation time is not a heartbeat, execution duration, or a new runtime event. Preserve earlier observations and evidence rather than overwriting history.

Routine sorting within approved scope needs no repeated confirmation. New scope, unresolved dependency choices, changed budget or provider permissions, and interruption of active work need the relevant decision when it is not already authorized. Rebuild the ledger from available history after a restart; if history is incomplete, report the gap before dispatching work that could duplicate an existing assignment.

## 2. Discover and assign available executors

Call `orchestrator_capabilities` before selecting executors. For this environment the input is:

```json
{}
```

Choose each role's executor and model from the user-approved Codex, Qoder, or Antigravity (AGY) instances actually available for that account and task. Use only instances with `canRunChildTask: true`. Inspect their `constraints`, advertised `models`, model `options`, and `runtimeModes`; use `search` if the short model list omits a requested model. For cross-provider assignments also check `canRunCrossProviderChildTask`. Availability requires the existing T3 setup and relevant account access; a brand name does not establish model access. For example, a Qoder account might offer Kimi models and an AGY account might offer Gemini models, but neither mapping guarantees any model is exposed or usable here.

Match task requirements and allowed capabilities first, then retain user preferences, budget, permissions, and concurrency when selecting automatically. The inherited seat is a candidate only when it fits those constraints; it is not a mandatory lead or a Codex default. Never guess a model slug or option ID, and do not silently switch provider, model, cost tier, or permissions.

For a local child, an omitted `target` inherits the coordinator's provider instance and model. The resolver inherits known parent options only for the same instance and the same resolved model. Explicit `target.options` overrides matching inherited option IDs; `[]` or `{}` clears them. Changing the instance or resolved model stops that options inheritance. For a local child, if a different provider is selected without a model, the resolver uses that provider's first advertised model, not a universal best model. A remote child switching providers requires an explicit model. Prefer selecting the intended discovered model explicitly for such assignments.

Use the live `inheritedOptions` and that model's option descriptors to select effort or reasoning settings when needed. An omitted effort is not a promise of `high`, `low`, or any other fixed level; after a target change the provider may apply its own defaults. Only report a configured effort when that actual selected option is available from the request or returned selection. Distinguish it from provider-reported execution: returned `model` and `options` describe selection, while a non-null `executedModel` is an observed model. Report actual effort only if the provider supplies it; otherwise mark it unknown or not reported. Do not infer execution settings from a product name or a requested option. These rules follow the T3 resolver; no global model or effort default is supplied by this adapter.

If an approved seat or explicitly requested model is missing, unavailable, or denied, mark that assignment `BLOCKED` with the requested provider/model and reason. Do not let omitted `model` choose an alternative for a model-specific request. Describe an exact available replacement if one exists, preserving the original requirement in history. Dispatch a replacement only when that exact substitution is covered by an existing user-approved fallback policy or the user approves it; explicitly report the substitution even when already authorized. For tasks without a model-specific requirement, automatic selection among the approved available seats needs no extra confirmation. If a provider later reports a different executed model from the required one, flag the mismatch before acceptance and obtain any needed decision before more work on that basis; do not relabel the result as compliant.

A nonempty catalog rejects an unadvertised explicit model with `model_unavailable`. An empty catalog accepts arbitrary slugs, which does not prove account access. The backend does not enforce that a provider-reported execution model equals the requested model; the mismatch check above remains a coordinator rule in this preview.

Discovery never authorizes installation, authentication, or reading credentials. Ask the user to complete the relevant setup when needed. Codex and Antigravity rely on their existing T3 adapters. Treat Qoder as unverified even if an ACP Registry instance appears available: protocol availability alone does not prove this workflow works.

## 3. Dispatch independent tasks through T3

Use `delegate_task` for ordinary fan-out. Each `task` is a standalone brief: goal, approved scope, exclusions, required input or dependency report, named base commit, acceptance commands and expected behavior, and report format. Children receive no parent history. Include no secrets. Require `PASS`, `ISSUES`, or `BLOCKED`, with artifact paths or commit SHA, commands actually run, observed results, and remaining gaps.

For independent writers use `isolation: "worktree"`; it starts from the parent's local commit and excludes uncommitted edits. Ensure required inputs are available in that commit before dispatch. Do not make commits or change workspaces without existing authority. Use a shared checkout only when the approved scopes cannot collide. A worktree isolates files on the same environment; it is not a cloud VM or an extra permission boundary.

Example: replace the uppercase placeholders using the approved task and live catalog before calling the tool. Generate a unique team ID for this approved batch. Each independent operation, task, and review round needs a distinct request key; reuse a key only to retry that exact operation. A new team or new round must not reuse an earlier key.

```json
{
  "task": "T1/r1: IMPLEMENTATION BRIEF WITH SCOPE, BASE SHA, ACCEPTANCE CHECKS AND REPORT FORMAT",
  "title": "T1: Implement approved slice",
  "role": "implementation",
  "target": {
    "providerInstanceId": "DISCOVERED_PROVIDER_INSTANCE_ID",
    "model": "DISCOVERED_MODEL_ID"
  },
  "isolation": "worktree",
  "mode": "async",
  "clientRequestId": "UNIQUE_TEAM_ID-T1-r1-implementation-round-1"
}
```

Omit `target` only when inheriting the coordinator's provider and model satisfies this task's approved selection and any exact model requirement. Set options only from that exact model's catalog. Leave runtime and interaction modes inherited; read-only review is a brief restriction, not a promise supplied by `runtimeMode`.

Immediately save the response's `taskId`, `childThreadId`, `childRunId`, `providerInstanceId`, selected `model`, available selected `options`, optional provider-reported `executedModel`, `link`, and initial status in the coordinator ledger. Keep requested, selected, and observed model/effort fields distinct; unavailable observations stay unknown. The owner is the actual assigned instance and model, not a fictional teammate identity. A remote child may have a null `childThreadId`: retain its `remoteChild.environmentId` and `remoteChild.threadId` instead. Preserve the returned `link`; do not fabricate a URL from IDs.

Launch only dependency-ready tasks within the agreed concurrency limit. Async completion wakes this thread: end the turn when waiting for the children. Do not poll `task_status` on running tasks or create timers merely to wait for a result.

Use `t3_thread_launch` only when the user requested an independently visible, long-lived thread. It takes `message` and optional `workspaceStrategy`, unlike `delegate_task`; keep its returned thread ID and link. Do not replace app-owned delegation with manually created worktrees.

## 4. Show progress and verify results

In coordinator updates include task key and revision, priority, owner/provider/model, runtime status, last observed progress, `observedAt`, source update time when available, acceptance verdict, and returned session link. Missing progress is unknown; never invent a percentage. Open Thread details > Team tasks to inspect app-owned delegated tasks from the current thread's loaded projection. The panel shares the Lineage visibility setting. Provider-native tasks remain in Lineage.

This is a current-thread view, not a project-wide board or a durable store of the proposed plan. Older tasks can be outside the loaded history. A remote session link requires its environment to be connected. The panel's `Run completed` means that the provider run ended; the reviewer still decides acceptance.

Do not reinterpret panel timing as planner history: `Created at dispatch` is delegation acceptance. The user can choose `Observe timing` for one task at a time; this loads a detail stream rather than reading a passive cache. `Started` and `Finished (run)` require the exact associated run, including its initial spawn transfer; missing or unmatched times remain `Not observed`. `Result reported` is when the coordinator recorded completion and must not replace the run's finish. Elapsed time excludes queue time and includes waits; it is not CPU time, and advances only with a connected environment and live matching execution. A later run does not replace the original task's timing.

After a completion wake, read `task_status` with the saved `taskId`. Inspect the actual artifact or diff and the supplied evidence. `workState: "waiting_for_children"` is unfinished work. Treat failed, cancelled, or interrupted work as such; a worker's `PASS` does not override missing required evidence.

For review, dispatch a fresh `delegate_task` with `role: "review"`, the exact artifact or commit SHA, acceptance criteria, and an explicit instruction not to edit files. Choose an independent reviewer within authorized seats; prefer a different model family when available and permitted, otherwise disclose the limitation. A review worktree starts at the parent commit too, so name how the reviewer can access the implementation artifact. Do not claim the reviewer examined a worker's uncommitted files from another worktree. A changed artifact or SHA needs a fresh verdict.

Track acceptance separately as `pending`, `accepted`, `issues`, or `blocked` in the coordinator ledger. The UI's runtime status does not store this verdict. Return one consolidated report, including actual evidence and every gap.

## 5. Report on a schedule only when requested

Periodic reporting is opt-in. Agree on its cadence in the opening chat when the user requests it. Reuse `schedule_task`; do not start a shell loop, external scheduler, or webhook. Scheduled prompts can consume provider usage, so retain the approved budget. This example is for an explicitly requested hourly report in the coordinator thread:

```json
{
  "title": "Team progress report",
  "prompt": "Report only on this team's approved tasks in this coordinator thread. Rebuild the task ledger from its messages; read saved child threads with t3_thread_read for observed progress and runtime status, using saved environment IDs and incremental cursors. Do not poll task_status on running tasks, launch or steer workers, create schedules, or infer acceptance from a completed run. Report task key and revision, priority, owner, status, actual UTC observation time, available source timestamps, latest evidence, gaps, and decisions needed. When every task is accepted or cancelled, pause this schedule using the saved scheduledTaskId, then give the final report. If its ID is absent from the ledger, report the missing ID rather than locating or changing other schedules.",
  "schedule": { "type": "interval", "everyMs": 3600000 },
  "bindToCurrentThread": true,
  "clientRequestId": "UNIQUE_TEAM_ID-progress-hourly-round-1"
}
```

Save the returned `scheduledTaskId`, `nextRunAt`, cadence, bound thread, and enabled state in chat; embed the actual task IDs, thread IDs, environment IDs, and coordinator thread ID into the scheduled prompt when creating it. During each report use `t3_thread_read` with the saved thread IDs and `view: "activity"`. For newer items use `afterPosition` equal to the previous response's `nextPosition`; for older items use `beforePosition` equal to `earlierPosition`. Paginate when necessary and disclose truncated or unavailable history. Reading progress must not send messages that restart workers.

When the approved task list changes, keep the same report schedule. If its prompt embeds a task ID list, update that owned prompt through `schedule_task` with its saved `scheduledTaskId` to include the new approved IDs and ledger revisions. Preserve cadence and budget; do not create a duplicate schedule or let a report tick dispatch newly added work.

Pause with `schedule_task` and `{ "scheduledTaskId": "SAVED_SCHEDULED_TASK_ID", "enabled": false }`; resume with `enabled: true` only within the user's requested reporting period. On completion or cancellation, pause the owned report schedule and confirm the returned state. Delete it with `delete_scheduled_task` only when requested. Do not substitute a guessed task ID or change unrelated schedules.

## 6. Recover without duplicating work

- **Lost dispatch response:** preserve the same `clientRequestId` within the same provider session. Before a new dispatch after restart or uncertainty, inspect the coordinator's activity and `t3_thread_list` with `includeSubagents: true` and a distinctive `titleContains`; read candidates and match their parent and brief. Recover existing IDs before retrying. Do not blindly start another writer.
- **Continuation:** use `t3_thread_send` on the saved child thread, with a stable new `clientRequestId` and an appropriate `mode`, only for a needed continuation. A later turn does not reopen or replace the original task's published result. Record that later run separately. An independent review or changed scope gets a new delegated task and request key.
- **Failure or stall:** inspect the saved child thread and concrete evidence before retrying. Narrow scope after a context limit; retry a dropped connection with the same dispatch key when safe; use an alternative seat after a provider failure only under the explicit model and fallback rules in section 2. Stop after two unsuccessful recovery attempts and report the gap. Never bypass an approval or installation denial.
- **Question or approval:** `hasPendingQuestion` and `pendingApproval` are blockers to resolve from a fresh request, not permission grants. Ask the user or use only tools and authority actually available; do not approve on the user's behalf or read secrets. Report blocked work accurately.
- **Cancellation:** use `task_cancel` with the saved `taskId` and reason for the tasks the user cancelled, then pause this team's reporting schedule when appropriate. Account for every child as completed, failed, cancelled, blocked, or still running.

## Verification boundary

This adapter is opt-in guidance, not enforced orchestration policy. Automatic team assembly, dependency checks, revision and priority handling, and observation entries are coordinator behavior rules over chat history; no persistent task planner or saved role-profile feature is implemented. Its upstream file hashes and example shapes can be checked offline. Real model compliance, Qoder integration, historical pagination, mobile presentation, recovery across provider-session changes, and scheduled reports with live providers remain unverified until exercised. State the checks actually performed and preserve these gaps in the final report.
