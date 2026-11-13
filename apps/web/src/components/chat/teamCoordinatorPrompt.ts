export interface TeamCoordinatorPromptInput {
  readonly phase: "prepare" | "continue";
  readonly goal: string;
  readonly planVersion?: number;
  readonly workflowText: string;
}

/** The same authored workflow is bundled by the UI and read directly by model evals. */
export function buildTeamCoordinatorPrompt(input: TeamCoordinatorPromptInput): string {
  const phase =
    input.phase === "prepare"
      ? `This is a planning-only turn: do not call delegate_task, t3_thread_launch or other execution tools even if older task revisions are already confirmed. Propose and save changes only; execution needs a separate Continue team request. Prepare or refine a team plan for this goal. Read team_plan first and call orchestrator_capabilities. Resolve only decisions that materially change scope, permissions, cost, or provider/model access. Use team_plan patch to persist the goal and a short task list with stable task IDs, role briefs, explicit discovered model selections, priorities, pinned dependencies, and observable acceptance checks inside each task prompt. Preserve existing task IDs and executions. Do not dispatch while the current task revisions are unconfirmed. Present the concrete plan and wait for the user's confirmation in Task plan.`
      : `Continue this team's work from the persisted team_plan. The user requested continuation after reviewing plan version ${input.planVersion ?? "unknown"}; read the current plan before acting, since it may have changed. Respect each revision's confirmation and actual readiness. Use delegate_task with the exact planTaskRef and the confirmed modelSelection for each ready task, creating ordinary T3 child conversations. Reuse existing executions instead of dispatching them again. A blocked or unavailable provider/model is a blocker, not permission to substitute. After asynchronous work, allow T3's completion wake to resume this coordinator. Read task_status and the saved child sessions and independently inspect the outputs. Use accept_task with status accepted only for evidenced successful completed child work. Record failed, cancelled, unavailable or not-yet-started work as issues or blocked with a concrete note; these are not successful acceptance. A repeated delegate_task for an already bound task revision recovers its existing execution, never a new attempt. Inspect and continue that child only when safe and authorized; for a fresh attempt propose an explicit edit_task revision, preserve prior evidence, and wait for user confirmation before dispatch. Then advance newly ready dependencies. Finish with an acceptance summary that distinguishes successful runs, independently accepted results, unresolved issues and pending user decisions.`;
  return [
    "The user has explicitly enabled team coordination in this conversation through Task plan.",
    "Use T3 as the only execution and session runtime. The workflow below supplies the pstack-based working conventions; it does not grant additional permissions.",
    input.workflowText.trim(),
    "## Current team request",
    phase,
    "Keep the user's existing provider/model preferences, budget, permissions, and workspace boundaries. Neither coordinator nor workers are fixed to Codex. Discover what this account can actually run; do not claim a requested model or effort was observed unless the provider reports it.",
    "User goal:",
    input.goal.trim(),
  ].join("\n\n");
}
