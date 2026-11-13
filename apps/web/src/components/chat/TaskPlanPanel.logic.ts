import { teamPlanTaskRevision } from "@t3tools/shared/teamPlan";
import {
  MIN_TEAM_PLAN_REPORT_INTERVAL_MS,
  TeamPlan,
  type TeamPlanDependency,
  type TeamPlanDispatchLimits,
  type TeamPlanOperation,
  type TeamPlanPatch,
  TeamPlanReportSchedule,
  type TeamPlanTask,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

// Report ticks can advance CAS without changing anything the user is editing.
const sameEditablePlan = Schema.toEquivalence(
  TeamPlan.mapFields(
    ({ version: _version, updatedAt: _updatedAt, latestReport: _latestReport, ...fields }) => ({
      ...fields,
      reportSchedule: Schema.optionalKey(
        TeamPlanReportSchedule.mapFields(
          ({ nextReportAt: _nextReportAt, ...scheduleFields }) => scheduleFields,
        ),
      ),
    }),
  ),
);

export function taskPlanEditorSaveVersion(
  baseline: TeamPlan | null,
  current: TeamPlan | null,
): number | null {
  if (baseline === null || current === null) return baseline === current ? 0 : null;
  if (
    current.version < baseline.version ||
    current.threadId !== baseline.threadId ||
    current.createdAt !== baseline.createdAt
  ) {
    return null;
  }
  return sameEditablePlan(baseline, current) ? current.version : null;
}

export interface TaskPlanDraft {
  readonly title: string;
  readonly prompt: string;
  readonly role: string;
  readonly priority: string;
  readonly dependencies: ReadonlyArray<TeamPlanDependency>;
}

export interface TaskPlanDispatchLimitsDraft {
  readonly maxConcurrentTasks: string;
  readonly maxTaskExecutions: string;
}

export function taskPlanDispatchLimitsDraft(
  limits: TeamPlanDispatchLimits | undefined,
): TaskPlanDispatchLimitsDraft {
  return {
    maxConcurrentTasks: limits?.maxConcurrentTasks?.toString() ?? "",
    maxTaskExecutions: limits?.maxTaskExecutions?.toString() ?? "",
  };
}

function parseDispatchLimit(value: string): number | null | undefined {
  const text = value.trim();
  if (!text) return null;
  if (!/^\d+$/u.test(text)) return undefined;
  const limit = Number(text);
  return Number.isSafeInteger(limit) && limit > 0 ? limit : undefined;
}

export function taskPlanDispatchLimitsOperations(
  draft: TaskPlanDispatchLimitsDraft,
  original: TeamPlanDispatchLimits | undefined,
):
  | { readonly ok: true; readonly operations: ReadonlyArray<TeamPlanOperation> }
  | { readonly ok: false; readonly message: string } {
  const maxConcurrentTasks = parseDispatchLimit(draft.maxConcurrentTasks);
  const maxTaskExecutions = parseDispatchLimit(draft.maxTaskExecutions);
  if (maxConcurrentTasks === undefined || maxTaskExecutions === undefined) {
    return {
      ok: false,
      message: `${maxConcurrentTasks === undefined ? "Concurrent task limit" : "Total task executions"} must be a positive safe whole number, or left empty.`,
    };
  }
  if (
    maxConcurrentTasks === (original?.maxConcurrentTasks ?? null) &&
    maxTaskExecutions === (original?.maxTaskExecutions ?? null)
  ) {
    return { ok: true, operations: [] };
  }
  return {
    ok: true,
    operations: [
      { type: "set_dispatch_limits", limits: { maxConcurrentTasks, maxTaskExecutions } },
    ],
  };
}

export function taskPlanReportScheduleOperations(
  value: string,
  original: TeamPlanReportSchedule | undefined,
):
  | { readonly ok: true; readonly operations: ReadonlyArray<TeamPlanOperation> }
  | { readonly ok: false; readonly message: string } {
  const minutes = parseDispatchLimit(value);
  const everyMs = typeof minutes === "number" ? minutes * MIN_TEAM_PLAN_REPORT_INTERVAL_MS : null;
  if (everyMs === null || !Number.isSafeInteger(everyMs)) {
    return {
      ok: false,
      message: "Enter a positive whole number of minutes within the safe range.",
    };
  }
  if (original?.enabled && original.everyMs === everyMs) {
    return { ok: true, operations: [] };
  }
  return {
    ok: true,
    operations: [{ type: "set_report_schedule", enabled: true, everyMs }],
  };
}

export function taskPlanCoordinatorPatch(
  plan: TeamPlan | null,
  request: { readonly phase: "prepare"; readonly goal: string } | { readonly phase: "continue" },
):
  | { readonly ok: true; readonly goal: string; readonly patch: TeamPlanPatch | null }
  | { readonly ok: false; readonly message: string } {
  if (request.phase === "prepare") {
    const goal = request.goal.trim();
    if (!goal) return { ok: false, message: "Enter the team's goal." };
    const operations: TeamPlanOperation[] = [];
    if (plan?.goal !== goal) operations.push({ type: "set_goal", goal });
    if (plan?.dispatchPaused !== true)
      operations.push({ type: "set_dispatch_paused", paused: true });
    return {
      ok: true,
      goal,
      patch:
        operations.length === 0 ? null : { expectedPlanVersion: plan?.version ?? 0, operations },
    };
  }
  if (
    plan === null ||
    !plan.goal.trim() ||
    plan.tasks.length === 0 ||
    plan.confirmedRevision !== plan.revision
  ) {
    return {
      ok: false,
      message: "Review and confirm the current task plan before continuing the team.",
    };
  }
  return {
    ok: true,
    goal: plan.goal,
    patch:
      plan.dispatchPaused === true
        ? {
            expectedPlanVersion: plan.version,
            operations: [{ type: "set_dispatch_paused", paused: false }],
          }
        : null,
  };
}

export function nextTaskPlanKey(plan: TeamPlan | null): string {
  const used = new Set(plan?.tasks.map((task) => task.taskId) ?? []);
  for (let index = 1; ; index += 1) {
    const key = `T${index}`;
    if (!used.has(key)) return key;
  }
}

export function taskPlanDraft(task?: TeamPlanTask): TaskPlanDraft {
  return {
    title: task?.title ?? "",
    prompt: task?.prompt ?? "",
    role: task?.role ?? "implementation",
    priority: String(task?.priority ?? 100),
    dependencies: task?.dependencies ?? [],
  };
}

export function selectTaskPlanDependency(
  dependencies: ReadonlyArray<TeamPlanDependency>,
  dependency: TeamPlanDependency,
  selected: boolean,
): ReadonlyArray<TeamPlanDependency> {
  const remaining = dependencies.filter((entry) => entry.taskId !== dependency.taskId);
  return selected ? [...remaining, dependency] : remaining;
}

function sameDependencies(
  left: ReadonlyArray<TeamPlanDependency>,
  right: ReadonlyArray<TeamPlanDependency>,
) {
  const keys = (values: ReadonlyArray<TeamPlanDependency>) =>
    values.map((entry) => JSON.stringify([entry.taskId, entry.revision])).sort();
  return JSON.stringify(keys(left)) === JSON.stringify(keys(right));
}

export function taskPlanDraftOperations(
  taskId: string,
  draft: TaskPlanDraft,
  original: TeamPlanTask | null,
):
  | { readonly ok: true; readonly operations: ReadonlyArray<TeamPlanOperation> }
  | { readonly ok: false; readonly message: string } {
  const title = draft.title.trim();
  const prompt = draft.prompt.trim();
  const role = draft.role.trim();
  if (!title || !prompt || !role) {
    return {
      ok: false,
      message: "Enter a title, task brief with acceptance checks, and owner role.",
    };
  }
  const priority = Number(draft.priority);
  if (!draft.priority.trim() || !Number.isSafeInteger(priority)) {
    return { ok: false, message: "Priority must be a whole number." };
  }
  if (original === null) {
    return {
      ok: true,
      operations: [
        {
          type: "add_task",
          task: {
            taskId,
            title,
            prompt,
            role,
            priority,
            modelSelection: null,
            dependencies: draft.dependencies,
          },
        },
      ],
    };
  }
  const changes = {
    ...(title === original.title ? {} : { title }),
    ...(prompt === original.prompt ? {} : { prompt }),
    ...(role === original.role ? {} : { role }),
    ...(sameDependencies(draft.dependencies, original.dependencies)
      ? {}
      : { dependencies: draft.dependencies }),
  };
  const operations: TeamPlanOperation[] = [];
  if (Object.keys(changes).length > 0) operations.push({ type: "edit_task", taskId, changes });
  if (priority !== original.priority) operations.push({ type: "reprioritize", taskId, priority });
  return { ok: true, operations };
}

export function orderTaskPlanRows(tasks: ReadonlyArray<TeamPlanTask>) {
  return tasks
    .map((task, index) => ({ task, index }))
    .sort((left, right) => left.task.priority - right.task.priority || left.index - right.index)
    .map(({ task }) => task);
}

export function taskPlanDependencyLabel(task: TeamPlanTask, revision: number): string {
  const source = teamPlanTaskRevision(task, revision);
  return `${task.taskId} · ${source?.title ?? "Revision unavailable"} · r${revision}`;
}

export function taskPlanHistoricalExecutions(task: TeamPlanTask) {
  return task.history.flatMap((revision) =>
    revision.executions.map((execution) => ({
      taskId: task.taskId,
      revision: revision.revision,
      execution,
      taskCreatedAt: revision.createdAt,
      recordUpdatedAt: revision.updatedAt,
    })),
  );
}
