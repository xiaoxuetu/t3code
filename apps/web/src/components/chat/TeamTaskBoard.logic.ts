import type {
  EnvironmentId,
  OrchestrationV2ContextTransfer,
  OrchestrationV2Subagent,
} from "@t3tools/contracts";

export type TeamTask = Pick<
  OrchestrationV2Subagent,
  | "id"
  | "origin"
  | "childThreadId"
  | "remoteChild"
  | "title"
  | "prompt"
  | "driver"
  | "providerInstanceId"
  | "model"
  | "modelSelection"
  | "status"
  | "progress"
  | "result"
>;

export function delegatedTeamTasks<Task extends TeamTask>(tasks: ReadonlyArray<Task>) {
  return tasks.filter((task) => task.origin === "app_owned");
}

export function teamTaskTarget(task: TeamTask, environmentId: EnvironmentId) {
  if (task.remoteChild) {
    return {
      environmentId: task.remoteChild.environmentId,
      threadId: task.remoteChild.threadId,
    };
  }
  return task.childThreadId === null
    ? null
    : { environmentId, threadId: task.childThreadId };
}

export function visibleDelegatedTeamTasks<Task extends TeamTask>(
  tasks: ReadonlyArray<Task>,
  environmentId: EnvironmentId,
  isHidden: (target: NonNullable<ReturnType<typeof teamTaskTarget>>) => boolean,
) {
  return delegatedTeamTasks(tasks).filter((task) => {
    const target = teamTaskTarget(task, environmentId);
    return target === null || !isHidden(target);
  });
}

const taskPriority: Record<TeamTask["status"], number> = {
  waiting: 0,
  failed: 0,
  running: 1,
  pending: 1,
  interrupted: 2,
  idle: 3,
  cancelled: 3,
  completed: 3,
};

export function orderTeamTasks<Task extends TeamTask>(
  tasks: ReadonlyArray<Task>,
  updatedAt: (task: Task) => number,
) {
  return [...tasks].sort(
    (left, right) =>
      taskPriority[left.status] - taskPriority[right.status] || updatedAt(right) - updatedAt(left),
  );
}

export function teamTaskSummary(tasks: ReadonlyArray<TeamTask>) {
  return {
    total: tasks.length,
    active: tasks.filter((task) => ["pending", "running", "waiting"].includes(task.status)).length,
    completed: tasks.filter((task) => task.status === "completed").length,
    failed: tasks.filter((task) => task.status === "failed").length,
  };
}

const taskStatusLabels: Record<TeamTask["status"], string> = {
  idle: "Idle",
  pending: "Queued",
  running: "Running",
  waiting: "Waiting",
  completed: "Run completed",
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
};

export function teamTaskPresentation(task: TeamTask) {
  const active = ["pending", "running", "waiting"].includes(task.status);
  return {
    title: task.title?.trim() || task.prompt.trim().split("\n")[0] || "Untitled task",
    model: task.modelSelection?.model.trim() || task.model?.trim() || "Model not recorded",
    statusLabel: taskStatusLabels[task.status],
    detail:
      (active ? task.progress?.trim() : task.result?.trim()) ||
      (task.status === "completed"
        ? "No result text recorded."
        : task.status === "failed"
          ? "Open the session to inspect the failure."
          : task.status === "waiting"
            ? "Waiting for input or a dependency."
            : task.status === "pending"
              ? "Waiting to start."
              : active
                ? "No progress update recorded yet."
                : "No result text recorded."),
  };
}

export function findTeamTaskRun<Run extends { readonly id: string; readonly delegatedTaskId?: string | undefined }>(
  task: Pick<OrchestrationV2Subagent, "id" | "threadId" | "childThreadId" | "remoteChild">,
  runs: ReadonlyArray<Run>,
  link?: {
    readonly initialTaskId: string | null;
    readonly transfers: ReadonlyArray<Pick<
      OrchestrationV2ContextTransfer,
      "type" | "sourceThreadId" | "targetThreadId" | "targetRunId"
    >>;
  },
) {
  if (task.remoteChild !== undefined) {
    const runId = task.remoteChild.runId;
    return runId === undefined ? undefined : runs.find((run) => run.id === runId);
  }
  const direct = runs.find((run) => run.delegatedTaskId === task.id);
  if (direct !== undefined || link?.initialTaskId !== task.id) return direct;
  const spawn = link.transfers.find((transfer) =>
    transfer.type === "subagent_spawn" &&
    transfer.sourceThreadId === task.threadId &&
    transfer.targetThreadId === task.childThreadId,
  );
  return spawn?.targetRunId == null
    ? undefined
    : runs.find((run) => run.id === spawn.targetRunId);
}

export function teamTaskElapsedMs(
  timing: {
    readonly startedAt: string | null;
    readonly finishedAt: string | null;
    readonly active: boolean;
  },
  nowMs: number,
): number | null {
  if (timing.startedAt === null) return null;
  const start = Date.parse(timing.startedAt);
  const end = timing.finishedAt === null
    ? timing.active ? nowMs : Number.NaN
    : Date.parse(timing.finishedAt);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;
}
