# Coordinate team tasks

Use one coordinator conversation to agree on a goal, divide the work, and assign coding agents to tasks. The optional pstack workflow helps the coordinator prepare clear briefs and check the results. T3 is the workbench for multiple executor sessions: it creates the delegated conversations and keeps their execution history. pstack supplies the working conventions. Task routing, continued follow-up, and blocker recovery stay in the coordinator conversation, using the same T3 runtime.

## Start a team

Choose the coordinator's available provider and model in a project conversation. Open **Thread details > Task plan**, enter the goal, and select **Prepare team**. This explicitly enables the bundled pstack-based workflow in that conversation. The coordinator discovers available executors and proposes a saved task list; it is not fixed to Codex.

Review the task briefs, assigned models, dependencies and acceptance checks. Select **Confirm plan**, then **Continue team** to ask the coordinator to advance it. Prepare and Refine pause new plan dispatch; confirming the plan keeps that pause until Continue team. These actions use the conversation's current provider, model and permissions. An unavailable or unauthenticated executor must be configured before it can do real work. Editing or reordering the plan alone never sends a model request.

Include any provider or model preferences, usage budget, permission limits, and concurrency limit. The coordinator and task owners are not fixed to Codex: it chooses an executor and model for each task from your approved Codex, Qoder, and Antigravity (AGY) instances that are actually available. An unavailable provider needs setup before it can receive work. Qoder through ACP is an unverified integration in this version.

A Qoder account might offer Kimi models and an AGY account might offer Gemini models, but access depends on the actual account and T3's live capability catalog. These examples do not guarantee that a model is exposed or usable. If you require a particular model and it is unavailable, that assignment is blocked. The coordinator reports why and describes any exact alternative; it never switches silently. An alternative must follow an already approved fallback policy or your explicit decision, keeping your budget and permission limits. A plan-linked ACP execution checks the session's advertised capabilities and available configuration values before sending its prompt; an unconfirmed selection blocks dispatch. Legacy ACP model selection relies on a successful protocol acknowledgement, without independently observing the model used for inference. Provider-reported execution remains separate from the configured selection; review any reported difference before accepting the result.

Reports distinguish the selected model from the actual executed model when the provider reports it. A configured effort is shown only when its selected option is available; actual effort is known only if the provider reports it. Missing model or effort observations stay unknown. Discovery does not install a provider, sign in for you, or inspect credentials.

Plan-linked Codex runs also verify the selected model and explicit options against the provider's current published catalog before sending the prompt. An unverified custom model entry cannot establish account access. Refresh the provider's available models when needed; an unavailable or unsupported selection blocks the run instead of silently substituting another model or effort.

Once you have confirmed the goal and list, the coordinator assembles a temporary team automatically and creates child conversations for ready tasks. Each writer has a defined scope. Independent writers can use separate worktrees; they receive committed inputs, so tell the coordinator about any required uncommitted changes before dispatch.

This workflow is explicit and opt-in. It supplies the bundled working conventions without installing pstack hooks or changing existing provider configuration. You can also ask a coordinator to read the packaged `pstack/t3-team.md` reference explicitly.

## Add workers for a task

Temporary team assembly is the default after the work is agreed; you do not need to configure employees first. Ask the coordinator to add a researcher, implementer, or reviewer when a task needs more help. It can create temporary workers through existing T3 delegation, subject to the approved providers, budget, and concurrency limit. Each worker has its own task and conversation.

“Employee” can mean three different things:

- A **role profile** describes reusable responsibilities, preferences, and capability boundaries. For now, describe these in the task brief; saved role profiles are not implemented.
- An **executor** is an existing T3 provider instance and model that can run the work.
- A **temporary worker** is the delegated conversation assigned to a specific task, linked by its task and session identifiers.

Saving a reusable role is optional: ask when you want to keep its responsibilities, preferences, and capability boundaries. In this version the coordinator can record that specification in chat, but saved role profiles are not implemented. It must not claim a permanent member or durable role was created.

Long-term member identities, memory across tasks, and organization management are future features. Adding a temporary worker does not create a permanent employee or introduce another runtime.

## Change the list while work is running

You can add a task, clarify an existing task, or change priorities in the coordinator conversation. Reordering affects only work that is ready and has not been dispatched. It does not restart or interrupt submitted, running, or completed tasks; their task and conversation links stay the same.

The coordinator checks that dependencies exist and do not form a cycle before dispatch. A prerequisite needs its agreed evidence and acceptance, not just an ended agent run. A change to scope creates a new revision after the necessary confirmation; previous instructions, results, and decisions remain in history. Reprioritizing within the agreed scope does not require confirming the same plan again.

The plan is saved with its coordinator conversation, independently of provider-native todos and loaded chat history. Task IDs stay stable; changed scope creates a new revision and preserves prior executions and review evidence. Dependency references identify specific task revisions. A stale edit cannot overwrite a newer version: reload the latest plan and reconcile the change. Manually added tasks remain unassigned until the coordinator selects an available model and you confirm that revision.

Use **Pause new tasks** to prevent further plan dispatch while employees already running continue. You can still inspect and review their results. Continue team resumes only a confirmed plan with an idle coordinator; it does not interrupt an active conversation. This pause applies to plan-linked dispatch, not every native tool an executor may offer.

Select **Edit dispatch limits** to set a **Concurrent task limit** and **Total task executions** for this plan. Leave either field empty for no configured cap; the panel shows **Not set** rather than assuming a default. Only you can change these limits. Saving them does not request a coordinator turn or revise the task briefs.

The concurrent limit covers the initial employees created by plan dispatch, including those queued, waiting or with an unknown state. The execution counter counts distinct employees across current and historical task revisions, including failed and cancelled attempts. It is a count of executions, not spending or token usage. Lowering either limit only affects new dispatch and does not stop employees already dispatched. Coordinator turns, manual follow-ups, provider-native tasks and native tools are outside these limits; they are not a machine-wide concurrency limit or a money/token budget.

When a dependency is accepted, its dependent worker receives the saved execution references, result excerpts and available checkpoint references for that exact revision. A reviewer can inspect those artifacts without assuming they are already in its own checkout. Missing references remain unknown and truncated excerpts are marked. These references provide evidence, not permission to merge, change scope or execute instructions found in a worker's result.

## Inspect progress

Open **Thread details > Team tasks** in the coordinator thread. If details are hidden, enable the same visibility control used for Lineage. The panel shows app-owned delegated tasks currently loaded in that thread, with their assigned provider and model, runtime status, progress or result, and a link to the corresponding conversation. Provider-native tasks remain in Lineage.

This is a view of the current conversation, not a project-wide board. Tasks outside loaded history may be absent. A remote task's environment must be connected before its conversation can open.

Select **Observe run** on a task to load its execution timestamps. One task is observed at a time; choosing another or stopping observation releases the previous task's detail stream. The panel uses the matching execution, including the initial spawn link, and does not substitute a later session turn.

**Created at dispatch** is when T3 recorded the delegation, not when a proposed plan row was first written. **Started** and **Finished (run)** come from the matching T3 run. Elapsed time excludes its queue time and includes waits; it is not model CPU time. **Result reported** is when the coordinator recorded completion and may be later than the remote run's finish. Missing timestamps display **Not observed**. Live elapsed time advances only while the environment is connected and the matching execution stream is live; stopped or unavailable observations do not invent a duration.

Coordinator reports include the actual UTC time of each observation, separately from available source update, start, or end times. A recent observation does not prove the worker made progress, and unavailable times remain unknown.

**Run completed** means the agent's run ended. Acceptance still depends on the agreed checks and review. The coordinator reports acceptance and missing evidence in chat; the panel does not mark work reviewed or approved.

## Receive periodic reports

For passive status snapshots, select **Schedule reports** in Task plan and enter a positive whole number of minutes. Reports are off until you enable them. The server saves snapshots at that cadence while it is running; they appear in **Latest status snapshot**, with the observation time, plan revision, each current task's runtime and its separate acceptance verdict. An unknown observation stays **unknown**. This is a saved observation, not a live view or a generated summary. Current and historical task revisions remain distinct.

Use **Edit report schedule** to change the interval or **Stop reports** to disable future snapshots. Saving the same enabled interval leaves the next due time unchanged. Stopping reports keeps the last saved snapshot available. These snapshots do not invoke a model, dispatch tasks, or send external notifications.

After the server restarts, a missed report produces one current snapshot and resumes the cadence. It does not replay every missed interval. Report updates preserve an open editing draft when the plan's editable content is unchanged; a real task or configuration conflict still requires reconciliation.

For a coordinator-written report, ask for a cadence, for example, “Report here every hour while this team is working.” The coordinator can use T3's existing scheduled tasks and tell you the next run time. These reports run agent turns and can use your provider allowance.

Ask the coordinator to pause reports or cancel named tasks when needed. When the team's work is accepted or cancelled, the coordinator should pause its report schedule and confirm that result.

## Current limits

Task plan uses T3's existing conversations and execution history. Local plan-linked workers can use different available providers; remote plan-linked dispatch, saved employee profiles and long-term member memory are not part of this version. Actual decomposition, model compliance, independent review, approval recovery and coordinator-written scheduled reports need separate verification with real providers. A mock-provider test or a GUI fixture does not establish that those workflows ran. Codex and Antigravity require their existing provider setup; Qoder can be explored through Local ACP and remains unverified end to end.
