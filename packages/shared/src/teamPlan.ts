import {
  CommandId,
  type TeamPlan,
  type TeamPlanDependency,
  type TeamPlanExecutionRef,
  type TeamPlanPatch,
  type TeamPlanTask,
  type TeamPlanTaskRef,
  type TeamPlanTaskRevision,
  type ThreadId,
} from "@t3tools/contracts";

type Mutable<T> = T extends string | number | boolean | null | undefined
  ? T
  : T extends ReadonlyArray<infer Item>
    ? Mutable<Item>[]
    : { -readonly [Key in keyof T]: Mutable<T[Key]> };
function mutableCopy<Value>(value: Value): Mutable<Value> {
  return structuredClone(value) as Mutable<Value>;
}

type WorkingPlan = Mutable<TeamPlan>;
type WorkingTask = Mutable<TeamPlanTask>;
type WorkingRevision = Mutable<TeamPlanTaskRevision>;
export type TeamPlanFailureCode =
  | "version-conflict"
  | "thread-mismatch"
  | "missing-task"
  | "duplicate-task"
  | "missing-dependency"
  | "self-dependency"
  | "dependency-cycle"
  | "missing-revision"
  | "stale-revision"
  | "invalid-operation"
  | "unconfirmed-task"
  | "execution-conflict";
export interface TeamPlanPatchFailure {
  readonly code: TeamPlanFailureCode;
  readonly expectedPlanVersion?: number;
  readonly actualPlanVersion?: number;
}
export type TeamPlanPatchResult =
  | { readonly ok: true; readonly plan: TeamPlan }
  | { readonly ok: false; readonly error: TeamPlanPatchFailure };

export function createTeamPlan({
  threadId,
  now,
  goal = "",
}: {
  readonly threadId: ThreadId;
  readonly now: string;
  readonly goal?: string;
}): TeamPlan {
  return {
    threadId,
    version: 0,
    revision: 1,
    goal,
    confirmedRevision: null,
    tasks: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function teamPlanTaskCommandId(threadId: ThreadId, ref: TeamPlanTaskRef): CommandId {
  return CommandId.make(
    `team-plan-delegate:${JSON.stringify([threadId, ref.taskId, ref.revision])}`,
  );
}

export function teamPlanTaskRevision(
  task: TeamPlanTask,
  revision: number,
): TeamPlanTaskRevision | undefined {
  return task.revision === revision
    ? task
    : task.history.find((entry) => entry.revision === revision);
}

/** This checks only planning prerequisites. The server still validates live provider access and actual execution refs. */
export function teamPlanTaskReadiness(
  plan: TeamPlan,
  taskId: string,
): { ready: boolean; reason: string | null } {
  const task = plan.tasks.find((entry) => entry.taskId === taskId);
  if (task === undefined) return { ready: false, reason: "missing-task" };
  if (!plan.goal.trim()) return { ready: false, reason: "missing-goal" };
  if (task.modelSelection === null || !task.modelSelection.model.trim())
    return { ready: false, reason: "unassigned-model" };
  if (task.confirmedRevision !== task.revision) return { ready: false, reason: "unconfirmed-task" };
  if (task.executions.length > 0) return { ready: false, reason: "already-dispatched" };
  if (task.acceptance.status !== "pending")
    return { ready: false, reason: `task-${task.acceptance.status}` };
  for (const dependency of task.dependencies) {
    const prerequisite = plan.tasks.find((entry) => entry.taskId === dependency.taskId);
    const revision =
      prerequisite === undefined
        ? undefined
        : teamPlanTaskRevision(prerequisite, dependency.revision);
    if (revision?.acceptance.status !== "accepted")
      return { ready: false, reason: "dependency-unaccepted" };
  }
  return { ready: true, reason: null };
}

const revisionKey = (taskId: string, revision: number) => JSON.stringify([taskId, revision]);

/** Graph validation includes historical revisions, so pinned accepted evidence survives later scope changes. */
export function validateTeamPlan(plan: TeamPlan): TeamPlanPatchFailure | null {
  if (
    !Number.isSafeInteger(plan.version) ||
    plan.version < 0 ||
    !Number.isSafeInteger(plan.revision) ||
    plan.revision < 1 ||
    (plan.confirmedRevision !== null && plan.confirmedRevision !== plan.revision)
  )
    return { code: "invalid-operation" };
  const tasks = new Map<string, TeamPlanTask>();
  const revisions = new Map<string, TeamPlanTaskRevision>();
  for (const task of plan.tasks) {
    if (!task.taskId.trim() || tasks.has(task.taskId))
      return { code: tasks.has(task.taskId) ? "duplicate-task" : "invalid-operation" };
    if (!Number.isSafeInteger(task.priority) || task.revision !== task.history.length + 1)
      return { code: "invalid-operation" };
    tasks.set(task.taskId, task);
    for (const [index, revision] of [...task.history, task].entries()) {
      if (
        revision.revision !== index + 1 ||
        !revision.title.trim() ||
        !revision.prompt.trim() ||
        !revision.role.trim() ||
        (revision.confirmedRevision !== null && revision.confirmedRevision !== revision.revision) ||
        (revision.modelSelection !== null && !revision.modelSelection.model.trim()) ||
        (revision.acceptance.status === "accepted" &&
          (revision.confirmedRevision !== revision.revision || !revision.acceptance.note.trim()))
      )
        return { code: "invalid-operation" };
      revisions.set(revisionKey(task.taskId, revision.revision), revision);
    }
  }
  for (const task of plan.tasks) {
    for (const revision of [...task.history, task]) {
      const seen = new Set<string>();
      for (const dependency of revision.dependencies) {
        if (dependency.taskId === task.taskId) return { code: "self-dependency" };
        if (!tasks.has(dependency.taskId)) return { code: "missing-dependency" };
        const key = revisionKey(dependency.taskId, dependency.revision);
        if (!revisions.has(key)) return { code: "missing-revision" };
        if (seen.has(key)) return { code: "invalid-operation" };
        seen.add(key);
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const hasCycle = (key: string): boolean => {
    if (visiting.has(key)) return true;
    if (visited.has(key)) return false;
    visiting.add(key);
    const revision = revisions.get(key);
    for (const dependency of revision?.dependencies ?? [])
      if (hasCycle(revisionKey(dependency.taskId, dependency.revision))) return true;
    visiting.delete(key);
    visited.add(key);
    return false;
  };
  for (const key of revisions.keys()) if (hasCycle(key)) return { code: "dependency-cycle" };
  return null;
}

function reviseTask(
  task: WorkingTask,
  changes: Partial<
    Pick<WorkingTask, "title" | "prompt" | "role" | "modelSelection" | "dependencies">
  >,
  now: string,
): void {
  const { taskId: _taskId, priority: _priority, history: _history, ...previous } = task;
  task.history.push(structuredClone(previous));
  Object.assign(task, structuredClone(changes));
  task.revision += 1;
  task.confirmedRevision = null;
  task.executions = [];
  task.acceptance = { status: "pending", note: "", updatedAt: now };
  task.updatedAt = now;
}

function workingRevision(task: WorkingTask, revision: number): WorkingRevision | undefined {
  return task.revision === revision
    ? task
    : task.history.find((entry) => entry.revision === revision);
}

export function applyTeamPlanPatch(
  existing: TeamPlan | null,
  patch: TeamPlanPatch,
  context: { readonly threadId: ThreadId; readonly now: string },
): TeamPlanPatchResult {
  const reject = (code: TeamPlanFailureCode): TeamPlanPatchResult => ({
    ok: false,
    error: { code },
  });
  const actualPlanVersion = existing?.version ?? 0;
  if (patch.expectedPlanVersion !== actualPlanVersion)
    return {
      ok: false,
      error: {
        code: "version-conflict",
        expectedPlanVersion: patch.expectedPlanVersion,
        actualPlanVersion,
      },
    };
  if (existing !== null && existing.threadId !== context.threadId) return reject("thread-mismatch");
  if (
    !Number.isSafeInteger(actualPlanVersion) ||
    actualPlanVersion < 0 ||
    actualPlanVersion >= Number.MAX_SAFE_INTEGER ||
    patch.operations.length === 0
  )
    return reject("invalid-operation");
  try {
    const plan: WorkingPlan = mutableCopy(existing ?? createTeamPlan(context));
    const initialError = validateTeamPlan(plan);
    if (initialError !== null) return { ok: false, error: initialError };
    const contentChanged = () => {
      plan.revision += 1;
      plan.confirmedRevision = null;
    };
    for (const operation of patch.operations) {
      if (operation.type === "set_goal") {
        if (!operation.goal.trim()) return reject("invalid-operation");
        if (plan.goal !== operation.goal) {
          for (const task of plan.tasks) {
            if (task.executions.length === 0 && task.acceptance.status !== "accepted") {
              task.confirmedRevision = null;
              task.updatedAt = context.now;
            }
          }
          plan.goal = operation.goal;
          contentChanged();
        }
        continue;
      }
      if (operation.type === "add_task") {
        if (plan.tasks.some((task) => task.taskId === operation.task.taskId))
          return reject("duplicate-task");
        plan.tasks.push({
          ...mutableCopy(operation.task),
          revision: 1,
          confirmedRevision: null,
          acceptance: { status: "pending", note: "", updatedAt: context.now },
          executions: [],
          history: [],
          createdAt: context.now,
          updatedAt: context.now,
        });
        contentChanged();
        continue;
      }
      if (operation.type === "confirm_plan") {
        if (operation.revision !== plan.revision) return reject("stale-revision");
        if (!plan.goal.trim()) return reject("invalid-operation");
        plan.confirmedRevision = plan.revision;
        for (const task of plan.tasks) {
          task.confirmedRevision = task.revision;
          task.updatedAt = context.now;
        }
        continue;
      }
      const task = plan.tasks.find((entry) => entry.taskId === operation.taskId);
      if (task === undefined) return reject("missing-task");
      switch (operation.type) {
        case "edit_task": {
          const changes = Object.fromEntries(
            Object.entries(operation.changes).filter(([, value]) => value !== undefined),
          );
          if (
            Object.keys(changes).length === 0 ||
            Object.keys(changes).some(
              (key) => !["title", "prompt", "role", "modelSelection", "dependencies"].includes(key),
            )
          )
            return reject("invalid-operation");
          reviseTask(task, changes, context.now);
          contentChanged();
          break;
        }
        case "set_dependencies":
          reviseTask(
            task,
            {
              dependencies: structuredClone(
                operation.dependencies,
              ) as Mutable<TeamPlanDependency>[],
            },
            context.now,
          );
          contentChanged();
          break;
        case "reprioritize":
          if (!Number.isSafeInteger(operation.priority)) return reject("invalid-operation");
          task.priority = operation.priority;
          task.updatedAt = context.now;
          break;
        case "confirm_task":
          if (operation.revision !== task.revision) return reject("stale-revision");
          task.confirmedRevision = task.revision;
          task.updatedAt = context.now;
          break;
        case "bind_execution": {
          const revision = workingRevision(task, operation.revision);
          if (revision === undefined) return reject("missing-revision");
          if (revision.confirmedRevision !== operation.revision) return reject("unconfirmed-task");
          if (operation.execution.threadId === plan.threadId) return reject("execution-conflict");
          const prior = revision.executions.find(
            (entry) => entry.subagentId === operation.execution.subagentId,
          );
          if (prior !== undefined) {
            if (
              prior.threadId !== operation.execution.threadId ||
              (prior.runId !== null &&
                operation.execution.runId !== null &&
                prior.runId !== operation.execution.runId)
            )
              return reject("execution-conflict");
            if (prior.runId === null) prior.runId = operation.execution.runId;
          } else {
            if (revision.acceptance.status === "accepted") return reject("execution-conflict");
            revision.executions.push(
              structuredClone(operation.execution) as Mutable<TeamPlanExecutionRef>,
            );
          }
          revision.updatedAt = context.now;
          task.updatedAt = context.now;
          break;
        }
        case "accept_task": {
          const revision = workingRevision(task, operation.revision);
          if (revision === undefined) return reject("missing-revision");
          if (operation.status === "accepted") {
            if (revision.confirmedRevision !== operation.revision)
              return reject("unconfirmed-task");
            if (!operation.note.trim()) return reject("invalid-operation");
          }
          revision.acceptance = {
            status: operation.status,
            note: operation.note,
            updatedAt: context.now,
            ...(operation.actor === undefined ? {} : { actor: operation.actor }),
            ...(operation.reviewerThreadId === undefined
              ? {}
              : { reviewerThreadId: operation.reviewerThreadId }),
          };
          revision.updatedAt = context.now;
          task.updatedAt = context.now;
          break;
        }
        default:
          return reject("invalid-operation");
      }
    }
    const error = validateTeamPlan(plan);
    if (error !== null) return { ok: false, error };
    plan.tasks.sort((left, right) => left.priority - right.priority);
    plan.version = actualPlanVersion + 1;
    plan.updatedAt = context.now;
    return { ok: true, plan };
  } catch {
    return reject("invalid-operation");
  }
}
