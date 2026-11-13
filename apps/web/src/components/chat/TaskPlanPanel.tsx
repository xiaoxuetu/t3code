import { useState } from "react";
import type { ReactNode } from "react";
import { MIN_TEAM_PLAN_REPORT_INTERVAL_MS } from "@t3tools/contracts";
import type {
  TeamPlan,
  TeamPlanAcceptanceStatus,
  TeamPlanDispatchLimits,
  TeamPlanExecutionRef,
  TeamPlanLatestReport,
  TeamPlanPatch,
  TeamPlanReportSchedule,
  TeamPlanTask,
} from "@t3tools/contracts";
import { teamPlanExecutionCount, teamPlanTaskReadiness } from "@t3tools/shared/teamPlan";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";

import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import {
  nextTaskPlanKey,
  orderTaskPlanRows,
  selectTaskPlanDependency,
  taskPlanDraft,
  taskPlanDraftOperations,
  taskPlanDispatchLimitsDraft,
  taskPlanDispatchLimitsOperations,
  taskPlanReportScheduleOperations,
  taskPlanEditorSaveVersion,
  taskPlanDependencyLabel,
  taskPlanHistoricalExecutions,
  type TaskPlanDraft,
  type TaskPlanDispatchLimitsDraft,
} from "./TaskPlanPanel.logic";

export interface TaskPlanPanelControls {
  readonly canEdit: boolean;
  readonly onPatch: (
    patch: TeamPlanPatch,
  ) => Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }>;
  readonly onPrepare?: (goal: string) => Promise<void>;
  readonly onContinue?: () => Promise<void>;
  readonly onOpenExecution?: (execution: TeamPlanExecutionRef) => void;
  readonly canOpenExecution?: boolean;
}

export interface TaskPlanPanelProps extends TaskPlanPanelControls {
  readonly plan: TeamPlan | null;
}

type Editor = { readonly baseline: TeamPlan | null } & (
  | { readonly kind: "goal"; readonly value: string }
  | {
      readonly kind: "task";
      readonly taskId: string;
      readonly original: TeamPlanTask | null;
      readonly draft: TaskPlanDraft;
    }
  | {
      readonly kind: "limits";
      readonly original: TeamPlanDispatchLimits | undefined;
      readonly draft: TaskPlanDispatchLimitsDraft;
    }
  | {
      readonly kind: "reports";
      readonly original: TeamPlanReportSchedule | undefined;
      readonly minutes: string;
    }
  | {
      readonly kind: "verdict";
      readonly taskId: string;
      readonly revision: number;
      readonly status: TeamPlanAcceptanceStatus;
      readonly note: string;
    }
);

function PlanField(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <label className="grid min-w-0 gap-1 text-xs">
      <span>{props.label}</span>
      {props.children}
    </label>
  );
}

function PlanTime(props: {
  readonly label: string;
  readonly value: string | null;
  readonly missingText?: string;
}) {
  return (
    <p className="break-words text-2xs text-muted-foreground">
      {props.label}:{" "}
      {props.value ? (
        <time dateTime={props.value}>{props.value}</time>
      ) : (
        (props.missingText ?? "Not recorded")
      )}
    </p>
  );
}

function PlanReportSnapshot({ report }: { readonly report: TeamPlanLatestReport }) {
  const current = report.tasks.filter((task) => task.current);
  const historicalCount = report.tasks.length - current.length;
  return (
    <details data-plan-latest-report className="rounded-lg border border-border p-3">
      <summary className="cursor-pointer text-xs font-medium">Latest status snapshot</summary>
      <div className="mt-2 space-y-2">
        <p className="text-2xs text-muted-foreground">
          Saved observation, not live status. Plan r{report.planRevision} · version{" "}
          {report.planVersion}
        </p>
        <PlanTime label="Observed at" value={report.observedAt} missingText="unknown" />
        <PlanTime label="Scheduled for" value={report.dueAt} missingText="unknown" />
        <p className="text-2xs text-muted-foreground">
          Dispatch at observation: {report.dispatchPaused ? "paused" : "not paused"}
        </p>
        <ul aria-label="Snapshot tasks" className="m-0 list-none space-y-3 p-0">
          {current.map((task) => (
            <li key={task.taskId} className="space-y-1 border-t border-border pt-2">
              <p className="text-xs font-medium">
                {task.taskId} · r{task.revision} · {task.title}
              </p>
              <p className="text-xs">Role: {task.role}</p>
              <p className="text-xs">Acceptance: {task.acceptance}</p>
              {task.executions.length === 0 ? (
                <p className="text-xs">Runtime: unknown (no recorded execution)</p>
              ) : (
                <ul aria-label={`Snapshot executions for ${task.taskId}`} className="space-y-2">
                  {task.executions.map((execution) => (
                    <li key={execution.subagentId} className="space-y-1 break-words text-2xs">
                      <p>Runtime: {execution.status}</p>
                      <p className="text-muted-foreground">
                        Selected executor/model:{" "}
                        {execution.modelSelection
                          ? `${execution.modelSelection.instanceId} · ${execution.modelSelection.model}`
                          : "unknown"}
                      </p>
                      {execution.unavailableReason ? (
                        <p className="text-muted-foreground">
                          Observation unavailable: {execution.unavailableReason}
                        </p>
                      ) : null}
                      <PlanTime label="Started" value={execution.startedAt} missingText="unknown" />
                      <PlanTime
                        label="Finished (run)"
                        value={execution.completedAt}
                        missingText="unknown"
                      />
                      <p className="text-muted-foreground">
                        Elapsed at observation:{" "}
                        {execution.elapsedMs === null
                          ? "unknown"
                          : formatDuration(execution.elapsedMs)}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
        {current.length === 0 ? (
          <p className="text-2xs text-muted-foreground">No current tasks in this snapshot.</p>
        ) : null}
        <p className="text-2xs text-muted-foreground">
          Historical task revisions in snapshot: {historicalCount}. A completed run is separate from
          acceptance.
        </p>
      </div>
    </details>
  );
}

export function TaskPlanPanel(props: TaskPlanPanelProps) {
  const { plan, canEdit } = props;
  const version = plan?.version ?? 0;
  const reportSchedule = plan?.reportSchedule;
  const [editor, setEditor] = useState<Editor | null>(() =>
    plan === null ? { kind: "goal", baseline: null, value: "" } : null,
  );
  const saveVersion = editor === null ? null : taskPlanEditorSaveVersion(editor.baseline, plan);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [requested, setRequested] = useState(false);
  const editable = canEdit && busy === null;
  const confirmed = plan !== null && plan.confirmedRevision === plan.revision;

  const run = async (label: string, action: () => Promise<boolean>) => {
    if (!canEdit || busy !== null) return;
    setBusy(label);
    setError(null);
    try {
      if (await action()) setEditor(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update the task plan.");
    } finally {
      setBusy(null);
    }
  };
  const patch = async (input: TeamPlanPatch) => {
    const result = await props.onPatch(input);
    if (!result.ok) setError(result.message);
    return result.ok;
  };
  const save = () => {
    if (editor === null || saveVersion === null) return;
    if (editor.kind === "goal") {
      const goal = editor.value.trim();
      if (!goal) {
        setError("Enter the team's goal.");
        return;
      }
      if (plan?.goal === goal) {
        setEditor(null);
        return;
      }
      void run("Saving goal", () =>
        patch({ expectedPlanVersion: saveVersion, operations: [{ type: "set_goal", goal }] }),
      );
    } else if (editor.kind === "task") {
      const result = taskPlanDraftOperations(editor.taskId, editor.draft, editor.original);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      if (result.operations.length === 0) {
        setEditor(null);
        return;
      }
      void run("Saving task", () =>
        patch({ expectedPlanVersion: saveVersion, operations: result.operations }),
      );
    } else if (editor.kind === "limits") {
      const result = taskPlanDispatchLimitsOperations(editor.draft, editor.original);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      if (result.operations.length === 0) {
        setEditor(null);
        return;
      }
      void run("Saving dispatch limits", () =>
        patch({ expectedPlanVersion: saveVersion, operations: result.operations }),
      );
    } else if (editor.kind === "reports") {
      const result = taskPlanReportScheduleOperations(editor.minutes, editor.original);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      if (result.operations.length === 0) {
        setEditor(null);
        return;
      }
      void run("Saving report schedule", () =>
        patch({ expectedPlanVersion: saveVersion, operations: result.operations }),
      );
    } else {
      void run("Saving review verdict", () =>
        patch({
          expectedPlanVersion: saveVersion,
          operations: [
            {
              type: "accept_task",
              taskId: editor.taskId,
              revision: editor.revision,
              status: editor.status,
              note: editor.note.trim(),
              actor: "user",
            },
          ],
        }),
      );
    }
  };

  return (
    <ThreadDetailsSection
      headingId="thread-details-task-plan-heading"
      title="Task plan"
      data-thread-team-plan-panel
    >
      <div
        data-thread-team-plan-scroll
        className="max-h-[min(36rem,60dvh)] space-y-3 overflow-y-auto overscroll-contain px-2.5"
      >
        <p className="text-2xs text-muted-foreground">
          Saved with this conversation. Editing or reordering a plan does not start or restart
          workers.
        </p>
        {plan ? (
          <>
            <p className="whitespace-pre-wrap break-words text-sm">{plan.goal || "Goal not set"}</p>
            <p className="text-xs font-medium">
              Plan r{plan.revision} · {confirmed ? "Confirmed" : "Needs confirmation"}
            </p>
            {plan.dispatchPaused === true ? (
              <p data-plan-dispatch-paused className="text-2xs text-muted-foreground">
                Plan dispatch paused. New plan tasks will wait; employees already running continue.
              </p>
            ) : null}
            <div data-plan-dispatch-limits className="space-y-1 text-2xs text-muted-foreground">
              <p>Concurrent task limit: {plan.dispatchLimits?.maxConcurrentTasks ?? "Not set"}</p>
              <p>
                Task executions used: {teamPlanExecutionCount(plan)} · Total limit:{" "}
                {plan.dispatchLimits?.maxTaskExecutions ?? "Not set"}
              </p>
              <p>
                These limits cover initial employee tasks dispatched by this plan, not coordinator
                turns, manual follow-ups, native tools, or money/token budgets.
              </p>
            </div>
            <div data-plan-report-schedule className="space-y-1 text-2xs text-muted-foreground">
              <p>
                Status reports:{" "}
                {plan.reportSchedule?.enabled
                  ? `Every ${plan.reportSchedule.everyMs / MIN_TEAM_PLAN_REPORT_INTERVAL_MS} min`
                  : "Off"}
              </p>
              {plan.reportSchedule?.enabled ? (
                <PlanTime
                  label="Next snapshot due"
                  value={plan.reportSchedule.nextReportAt}
                  missingText="unknown"
                />
              ) : null}
              <p>
                Passive snapshots appear here while the server is running. They do not call a model,
                execute tasks, or send external notifications.
              </p>
            </div>
            {plan.latestReport ? (
              <PlanReportSnapshot report={plan.latestReport} />
            ) : (
              <p className="text-2xs text-muted-foreground">No status snapshot recorded.</p>
            )}
            <PlanTime label="Plan created" value={plan.createdAt} />
            <div className="flex flex-wrap gap-2">
              {plan.dispatchPaused !== true ? (
                <Button
                  variant="outline"
                  size="xs"
                  disabled={!editable || editor !== null}
                  onClick={() =>
                    void run("Pausing new tasks", () =>
                      patch({
                        expectedPlanVersion: version,
                        operations: [{ type: "set_dispatch_paused", paused: true }],
                      }),
                    )
                  }
                >
                  Pause new tasks
                </Button>
              ) : null}
              <Button
                variant="outline"
                size="xs"
                disabled={!editable || editor !== null}
                onClick={() =>
                  setEditor({ kind: "goal", baseline: structuredClone(plan), value: plan.goal })
                }
              >
                Edit goal
              </Button>
              <Button
                variant="outline"
                size="xs"
                disabled={!editable || editor !== null}
                onClick={() =>
                  setEditor({
                    kind: "task",
                    baseline: structuredClone(plan),
                    taskId: nextTaskPlanKey(plan),
                    original: null,
                    draft: taskPlanDraft(),
                  })
                }
              >
                Add task
              </Button>
              <Button
                variant="outline"
                size="xs"
                disabled={!editable || editor !== null}
                onClick={() =>
                  setEditor({
                    kind: "limits",
                    baseline: structuredClone(plan),
                    original: plan.dispatchLimits,
                    draft: taskPlanDispatchLimitsDraft(plan.dispatchLimits),
                  })
                }
              >
                Edit dispatch limits
              </Button>
              <Button
                variant="outline"
                size="xs"
                disabled={!editable || editor !== null}
                onClick={() =>
                  setEditor({
                    kind: "reports",
                    baseline: structuredClone(plan),
                    original: plan.reportSchedule,
                    minutes: plan.reportSchedule
                      ? String(plan.reportSchedule.everyMs / MIN_TEAM_PLAN_REPORT_INTERVAL_MS)
                      : "",
                  })
                }
              >
                {plan.reportSchedule?.enabled ? "Edit report schedule" : "Schedule reports"}
              </Button>
              {reportSchedule?.enabled ? (
                <Button
                  variant="outline"
                  size="xs"
                  disabled={!editable || editor !== null}
                  onClick={() =>
                    void run("Stopping reports", () =>
                      patch({
                        expectedPlanVersion: version,
                        operations: [
                          {
                            type: "set_report_schedule",
                            enabled: false,
                            everyMs: reportSchedule.everyMs,
                          },
                        ],
                      }),
                    )
                  }
                >
                  Stop reports
                </Button>
              ) : null}
              {props.onPrepare ? (
                <Button
                  variant="outline"
                  size="xs"
                  disabled={!editable || editor !== null || !plan.goal.trim()}
                  onClick={() =>
                    void run("Refining team", async () => {
                      await props.onPrepare?.(plan.goal);
                      setRequested(true);
                      return true;
                    })
                  }
                >
                  Refine team
                </Button>
              ) : null}
              {!confirmed ? (
                <Button
                  size="xs"
                  disabled={!editable || plan.tasks.length === 0 || editor !== null}
                  onClick={() =>
                    void run("Confirming plan", () =>
                      patch({
                        expectedPlanVersion: version,
                        operations: [{ type: "confirm_plan", revision: plan.revision }],
                      }),
                    )
                  }
                >
                  Confirm plan
                </Button>
              ) : null}
              {confirmed && props.onContinue ? (
                <Button
                  size="xs"
                  disabled={!editable || editor !== null}
                  onClick={() =>
                    void run("Requesting coordinator", async () => {
                      await props.onContinue?.();
                      setRequested(true);
                      return true;
                    })
                  }
                >
                  Continue team
                </Button>
              ) : null}
            </div>
            {props.onPrepare ? (
              <p className="text-2xs text-muted-foreground">
                Refine team pauses new plan tasks and asks for proposed changes. Review and confirm
                new revisions before continuing.
              </p>
            ) : null}
            {confirmed ? (
              <p className="text-2xs text-muted-foreground">
                Continue team resumes new plan tasks and asks the coordinator to advance this
                confirmed plan.
              </p>
            ) : null}
          </>
        ) : null}
        {!plan && editor === null ? (
          <Button
            variant="outline"
            size="xs"
            disabled={!editable}
            onClick={() => setEditor({ kind: "goal", baseline: null, value: "" })}
          >
            Set team goal
          </Button>
        ) : null}
        {requested ? (
          <p role="status" className="text-xs text-muted-foreground">
            Coordinator requested. Follow its response in this conversation.
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
        {busy ? (
          <p role="status" className="text-xs text-muted-foreground">
            {busy}…
          </p>
        ) : null}
        {editor ? (
          <form
            className="space-y-3 rounded-lg border border-border p-3"
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            {saveVersion === null ? (
              <p role="status" className="text-xs text-destructive">
                The saved plan changed while this form was open. Your draft is kept; cancel and
                reopen to use the latest revision.
              </p>
            ) : null}
            {editor.kind === "goal" ? (
              <>
                <PlanField label="Team goal">
                  <Textarea
                    size="sm"
                    rows={3}
                    value={editor.value}
                    disabled={!editable}
                    aria-label="Team goal"
                    onChange={(event) => setEditor({ ...editor, value: event.target.value })}
                  />
                </PlanField>
                {(plan?.tasks.length ?? 0) === 0 && props.onPrepare ? (
                  <Button
                    size="xs"
                    disabled={!editable || !editor.value.trim() || saveVersion === null}
                    onClick={() =>
                      void run("Preparing team", async () => {
                        await props.onPrepare?.(editor.value.trim());
                        setRequested(true);
                        return true;
                      })
                    }
                  >
                    Prepare team
                  </Button>
                ) : null}
              </>
            ) : editor.kind === "task" ? (
              <>
                <p className="text-xs font-medium">
                  {editor.original
                    ? `Edit ${editor.taskId} · r${editor.original.revision}`
                    : `New task ${editor.taskId}`}
                </p>
                <PlanField label="Task title">
                  <Input
                    size="compact"
                    value={editor.draft.title}
                    disabled={!editable}
                    aria-label="Task title"
                    onChange={(event) =>
                      setEditor({
                        ...editor,
                        draft: { ...editor.draft, title: event.target.value },
                      })
                    }
                  />
                </PlanField>
                <PlanField label="Task brief and acceptance checks">
                  <Textarea
                    size="sm"
                    rows={4}
                    value={editor.draft.prompt}
                    disabled={!editable}
                    aria-label="Task brief and acceptance checks"
                    onChange={(event) =>
                      setEditor({
                        ...editor,
                        draft: { ...editor.draft, prompt: event.target.value },
                      })
                    }
                  />
                </PlanField>
                <PlanField label="Owner role">
                  <Input
                    size="compact"
                    value={editor.draft.role}
                    disabled={!editable}
                    aria-label="Owner role"
                    onChange={(event) =>
                      setEditor({ ...editor, draft: { ...editor.draft, role: event.target.value } })
                    }
                  />
                </PlanField>
                <PlanField label="Priority · smaller numbers appear first">
                  <Input
                    size="compact"
                    type="number"
                    step={1}
                    value={editor.draft.priority}
                    disabled={!editable}
                    aria-label="Task priority"
                    onChange={(event) =>
                      setEditor({
                        ...editor,
                        draft: { ...editor.draft, priority: event.target.value },
                      })
                    }
                  />
                </PlanField>
                <p className="text-2xs text-muted-foreground">
                  Assigned executor:{" "}
                  {editor.original?.modelSelection
                    ? `${editor.original.modelSelection.instanceId} · ${editor.original.modelSelection.model}`
                    : "Unassigned. Ask the coordinator to propose an available executor."}
                </p>
                <fieldset disabled={!editable} className="space-y-2">
                  <legend className="text-xs">
                    Dependencies · acceptance is required for the selected revision
                  </legend>
                  {(plan?.tasks ?? [])
                    .filter((task) => task.taskId !== editor.taskId)
                    .map((task) => {
                      const dependency = editor.draft.dependencies.find(
                        (entry) => entry.taskId === task.taskId,
                      );
                      return (
                        <div key={task.taskId} className="space-y-1">
                          <label className="flex items-start gap-2 text-xs">
                            <Checkbox
                              checked={dependency !== undefined}
                              onCheckedChange={(selected) =>
                                setEditor({
                                  ...editor,
                                  draft: {
                                    ...editor.draft,
                                    dependencies: selectTaskPlanDependency(
                                      editor.draft.dependencies,
                                      { taskId: task.taskId, revision: task.revision },
                                      selected,
                                    ),
                                  },
                                })
                              }
                            />
                            <span>
                              {taskPlanDependencyLabel(task, dependency?.revision ?? task.revision)}
                            </span>
                          </label>
                          {dependency && dependency.revision !== task.revision ? (
                            <Button
                              variant="ghost"
                              size="xs"
                              onClick={() =>
                                setEditor({
                                  ...editor,
                                  draft: {
                                    ...editor.draft,
                                    dependencies: selectTaskPlanDependency(
                                      editor.draft.dependencies,
                                      { taskId: task.taskId, revision: task.revision },
                                      true,
                                    ),
                                  },
                                })
                              }
                            >
                              Use current r{task.revision}
                            </Button>
                          ) : null}
                        </div>
                      );
                    })}
                  {(plan?.tasks.length ?? 0) <= (editor.original ? 1 : 0) ? (
                    <p className="text-2xs text-muted-foreground">No other tasks yet.</p>
                  ) : null}
                </fieldset>
              </>
            ) : editor.kind === "limits" ? (
              <>
                <PlanField label="Concurrent task limit">
                  <Input
                    size="compact"
                    type="text"
                    inputMode="numeric"
                    value={editor.draft.maxConcurrentTasks}
                    placeholder="Not set"
                    disabled={!editable}
                    aria-label="Concurrent task limit"
                    onChange={(event) =>
                      setEditor({
                        ...editor,
                        draft: { ...editor.draft, maxConcurrentTasks: event.target.value },
                      })
                    }
                  />
                </PlanField>
                <PlanField label="Total task executions">
                  <Input
                    size="compact"
                    type="text"
                    inputMode="numeric"
                    value={editor.draft.maxTaskExecutions}
                    placeholder="Not set"
                    disabled={!editable}
                    aria-label="Total task executions"
                    onChange={(event) =>
                      setEditor({
                        ...editor,
                        draft: { ...editor.draft, maxTaskExecutions: event.target.value },
                      })
                    }
                  />
                </PlanField>
                <p className="text-2xs text-muted-foreground">
                  Leave a field empty for no configured cap. Queued, waiting, and unknown-state
                  employees count toward concurrency. Total executions include current and
                  historical attempts, including failed or cancelled ones. Lowering either cap does
                  not stop employees already dispatched.
                </p>
              </>
            ) : editor.kind === "reports" ? (
              <>
                <PlanField label="Report interval (minutes)">
                  <Input
                    size="compact"
                    type="text"
                    inputMode="numeric"
                    value={editor.minutes}
                    placeholder="Enter minutes"
                    disabled={!editable}
                    aria-label="Report interval (minutes)"
                    onChange={(event) => setEditor({ ...editor, minutes: event.target.value })}
                  />
                </PlanField>
                <p className="text-2xs text-muted-foreground">
                  Enter a positive whole number of minutes. Saving enables passive status snapshots
                  in this Task plan. It does not ask the coordinator to report, start work, or send
                  external notifications. Use Stop reports to disable future snapshots; the last
                  saved snapshot remains available.
                </p>
              </>
            ) : (
              <>
                <p className="text-xs font-medium">
                  Review {editor.taskId} · r{editor.revision}
                </p>
                <PlanField label="Acceptance verdict">
                  <Select
                    value={editor.status}
                    onValueChange={(status) => {
                      if (status !== null) setEditor({ ...editor, status });
                    }}
                    disabled={!editable}
                  >
                    <SelectTrigger size="compact" aria-label="Acceptance verdict">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup>
                      {(["pending", "accepted", "issues", "blocked"] as const).map((status) => (
                        <SelectItem key={status} value={status}>
                          {status}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </PlanField>
                <PlanField label="Evidence or review note">
                  <Textarea
                    size="sm"
                    rows={3}
                    value={editor.note}
                    disabled={!editable}
                    aria-label="Evidence or review note"
                    onChange={(event) => setEditor({ ...editor, note: event.target.value })}
                  />
                </PlanField>
              </>
            )}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" size="xs" disabled={!editable || saveVersion === null}>
                Save{" "}
                {editor.kind === "limits"
                  ? "dispatch limits"
                  : editor.kind === "reports"
                    ? "report schedule"
                    : editor.kind}
              </Button>
              <Button
                variant="ghost"
                size="xs"
                disabled={busy !== null}
                onClick={() => {
                  setEditor(null);
                  setError(null);
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        ) : null}
        {plan?.tasks.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No saved tasks yet. Add a task before confirming the plan.
          </p>
        ) : null}
        {plan ? (
          <ul aria-label="Planned tasks" className="m-0 list-none space-y-3 p-0">
            {orderTaskPlanRows(plan.tasks).map((task) => {
              const readiness = teamPlanTaskReadiness(plan, task.taskId);
              const historicalExecutions = taskPlanHistoricalExecutions(task);
              return (
                <li
                  key={task.taskId}
                  data-plan-task-id={task.taskId}
                  className="space-y-2 rounded-lg border border-border p-3"
                >
                  <p className="text-sm font-medium">
                    {task.taskId} · {task.title}
                  </p>
                  <p className="text-2xs text-muted-foreground">
                    r{task.revision} · Priority {task.priority} · {task.role} ·{" "}
                    {task.confirmedRevision === task.revision ? "Confirmed" : "Needs confirmation"}
                  </p>
                  <p className="text-xs">
                    {readiness.ready
                      ? "Ready for coordinator"
                      : `Not ready: ${readiness.reason?.replaceAll("-", " ") ?? "Unknown reason"}`}
                  </p>
                  <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
                    {task.prompt}
                  </p>
                  <p className="text-2xs text-muted-foreground">
                    Dependencies:{" "}
                    {task.dependencies.length === 0
                      ? "None"
                      : task.dependencies
                          .map((dependency) => `${dependency.taskId}/r${dependency.revision}`)
                          .join(", ")}
                  </p>
                  <p className="text-2xs text-muted-foreground">
                    Assigned executor:{" "}
                    {task.modelSelection
                      ? `${task.modelSelection.instanceId} · ${task.modelSelection.model}`
                      : "Unassigned"}
                  </p>
                  <p className="text-xs">
                    Acceptance: {task.acceptance.status}
                    {task.acceptance.actor ? ` · ${task.acceptance.actor}` : ""}
                  </p>
                  {task.acceptance.note ? (
                    <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
                      {task.acceptance.note}
                    </p>
                  ) : null}
                  <PlanTime label="Task added to plan" value={task.createdAt} />
                  <p className="text-2xs text-muted-foreground">
                    {task.executions.length} execution records. Observe matching run times in Team
                    tasks below; saved session links are available here.
                  </p>
                  {task.executions.map((execution) => (
                    <div key={execution.subagentId} className="space-y-1">
                      <p className="break-all text-2xs text-muted-foreground">
                        Task {execution.subagentId} · Session {execution.threadId} · Run{" "}
                        {execution.runId ?? "Not recorded"}
                      </p>
                      {props.onOpenExecution ? (
                        <Button
                          variant="ghost"
                          size="xs"
                          disabled={props.canOpenExecution === false}
                          aria-label={`Open ${task.taskId} revision ${task.revision} session`}
                          onClick={() => props.onOpenExecution?.(execution)}
                        >
                          Open task session
                        </Button>
                      ) : null}
                    </div>
                  ))}
                  {task.history.length > 0 ? (
                    <details className="text-xs text-muted-foreground">
                      <summary>Earlier revisions ({task.history.length})</summary>
                      <ul className="m-0 list-none space-y-1 p-0">
                        {task.history.map((revision) => (
                          <li
                            key={revision.revision}
                            data-plan-revision={revision.revision}
                            className="space-y-1"
                          >
                            <p>
                              r{revision.revision} · {revision.title} · Acceptance:{" "}
                              {revision.acceptance.status}
                            </p>
                            <p>Owner role: {revision.role}</p>
                            <p>
                              Assigned executor:{" "}
                              {revision.modelSelection
                                ? `${revision.modelSelection.instanceId} · ${revision.modelSelection.model}`
                                : "Unassigned"}
                            </p>
                            <p className="whitespace-pre-wrap break-words">{revision.prompt}</p>
                            <p>
                              Dependencies:{" "}
                              {revision.dependencies.length === 0
                                ? "None"
                                : revision.dependencies
                                    .map(
                                      (dependency) =>
                                        `${dependency.taskId}/r${dependency.revision}`,
                                    )
                                    .join(", ")}
                            </p>
                            {revision.acceptance.note ? (
                              <p className="whitespace-pre-wrap break-words">
                                {revision.acceptance.note}
                              </p>
                            ) : null}
                            <PlanTime
                              label="Task added to plan"
                              value={revision.createdAt || null}
                            />
                            <PlanTime
                              label="Historical plan record updated"
                              value={revision.updatedAt || null}
                            />
                            <p>{revision.executions.length} recorded executions</p>
                          </li>
                        ))}
                      </ul>
                      {historicalExecutions.length > 0 ? (
                        <div className="mt-2 space-y-2">
                          <p>Earlier execution sessions</p>
                          <p>
                            Run start and finish: Not observed here. Session links remain available
                            when execution history is not loaded; the stored run ID identifies the
                            original run.
                          </p>
                          {historicalExecutions.map((target) => (
                            <div
                              key={`${target.revision}:${target.execution.subagentId}`}
                              className="space-y-1"
                            >
                              <p className="break-all">
                                r{target.revision} · Task {target.execution.subagentId} · Session{" "}
                                {target.execution.threadId} · Run{" "}
                                {target.execution.runId ?? "Not recorded"}
                              </p>
                              {props.onOpenExecution ? (
                                <Button
                                  variant="ghost"
                                  size="xs"
                                  disabled={props.canOpenExecution === false}
                                  aria-label={`Open ${task.taskId} revision ${target.revision} session`}
                                  onClick={() => props.onOpenExecution?.(target.execution)}
                                >
                                  Open r{target.revision} session
                                </Button>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </details>
                  ) : null}
                  {props.canOpenExecution === false &&
                  (task.executions.length > 0 || historicalExecutions.length > 0) ? (
                    <p className="text-2xs text-muted-foreground">
                      Connect this environment to open the recorded sessions. Their task, revision,
                      and run references are retained.
                    </p>
                  ) : null}
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      size="xs"
                      disabled={!editable || editor !== null}
                      onClick={() =>
                        setEditor({
                          kind: "task",
                          baseline: structuredClone(plan),
                          taskId: task.taskId,
                          original: task,
                          draft: taskPlanDraft(task),
                        })
                      }
                    >
                      Edit task
                    </Button>
                    <Button
                      variant="outline"
                      size="xs"
                      disabled={!editable || editor !== null}
                      onClick={() =>
                        setEditor({
                          kind: "verdict",
                          baseline: structuredClone(plan),
                          taskId: task.taskId,
                          revision: task.revision,
                          status: task.acceptance.status,
                          note: task.acceptance.note,
                        })
                      }
                    >
                      Record review
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </ThreadDetailsSection>
  );
}
