import { useState } from "react";
import type { ReactNode } from "react";
import type {
  TeamPlan,
  TeamPlanAcceptanceStatus,
  TeamPlanExecutionRef,
  TeamPlanPatch,
  TeamPlanTask,
} from "@t3tools/contracts";
import { teamPlanTaskReadiness } from "@t3tools/shared/teamPlan";

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
  taskPlanDependencyLabel,
  taskPlanHistoricalExecutions,
  type TaskPlanDraft,
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

type Editor =
  | { readonly kind: "goal"; readonly version: number; readonly value: string }
  | {
      readonly kind: "task";
      readonly version: number;
      readonly taskId: string;
      readonly original: TeamPlanTask | null;
      readonly draft: TaskPlanDraft;
    }
  | {
      readonly kind: "verdict";
      readonly version: number;
      readonly taskId: string;
      readonly revision: number;
      readonly status: TeamPlanAcceptanceStatus;
      readonly note: string;
    };

function PlanField(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <label className="grid min-w-0 gap-1 text-xs">
      <span>{props.label}</span>
      {props.children}
    </label>
  );
}

function PlanTime(props: { readonly label: string; readonly value: string | null }) {
  return (
    <p className="break-words text-2xs text-muted-foreground">
      {props.label}:{" "}
      {props.value ? <time dateTime={props.value}>{props.value}</time> : "Not recorded"}
    </p>
  );
}

export function TaskPlanPanel(props: TaskPlanPanelProps) {
  const { plan, canEdit } = props;
  const version = plan?.version ?? 0;
  const [editor, setEditor] = useState<Editor | null>(() =>
    plan === null ? { kind: "goal", version: 0, value: "" } : null,
  );
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
    if (editor === null) return;
    if (editor.kind === "goal") {
      const goal = editor.value.trim();
      if (!goal) {
        setError("Enter the team's goal.");
        return;
      }
      if (editor.version === version && plan?.goal === goal) {
        setEditor(null);
        return;
      }
      void run("Saving goal", () =>
        patch({ expectedPlanVersion: editor.version, operations: [{ type: "set_goal", goal }] }),
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
        patch({ expectedPlanVersion: editor.version, operations: result.operations }),
      );
    } else {
      void run("Saving review verdict", () =>
        patch({
          expectedPlanVersion: editor.version,
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
            <PlanTime label="Plan created" value={plan.createdAt} />
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="xs"
                disabled={!editable || editor !== null}
                onClick={() => setEditor({ kind: "goal", version, value: plan.goal })}
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
                    version,
                    taskId: nextTaskPlanKey(plan),
                    original: null,
                    draft: taskPlanDraft(),
                  })
                }
              >
                Add task
              </Button>
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
                Refine team asks for proposed plan changes. Review and confirm new revisions before
                continuing.
              </p>
            ) : null}
            {confirmed ? (
              <p className="text-2xs text-muted-foreground">
                Continue team asks the coordinator to advance this confirmed plan.
              </p>
            ) : null}
          </>
        ) : null}
        {!plan && editor === null ? (
          <Button
            variant="outline"
            size="xs"
            disabled={!editable}
            onClick={() => setEditor({ kind: "goal", version, value: "" })}
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
            {editor.version !== version ? (
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
                    disabled={!editable || !editor.value.trim() || editor.version !== version}
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
              <Button type="submit" size="xs" disabled={!editable || editor.version !== version}>
                Save {editor.kind === "verdict" ? "verdict" : editor.kind}
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
                          version,
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
                          version,
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
