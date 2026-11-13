import {
  CommandId,
  MIN_TEAM_PLAN_REPORT_INTERVAL_MS,
  type OrchestrationV2AppThread,
  type OrchestrationV2ContextTransfer,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
  type RunId,
  type TeamPlan,
  type TeamPlanExecutionRef,
  type TeamPlanLatestReport,
  type TeamPlanReportOccurrence,
  type TeamPlanReportSchedule,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

export interface TeamPlanReportObservation {
  readonly execution: TeamPlanExecutionRef;
  readonly task: Pick<
    OrchestrationV2Subagent,
    "id" | "threadId" | "runId" | "origin" | "childThreadId"
  > | null;
  readonly child: {
    readonly thread: Pick<OrchestrationV2AppThread, "id" | "lineage" | "forkedFrom">;
    readonly runs: ReadonlyArray<
      Pick<
        OrchestrationV2Run,
        | "id"
        | "threadId"
        | "delegatedTaskId"
        | "status"
        | "modelSelection"
        | "startedAt"
        | "completedAt"
      >
    >;
    readonly contextTransfers: ReadonlyArray<
      Pick<
        OrchestrationV2ContextTransfer,
        "type" | "sourceThreadId" | "targetThreadId" | "sourcePoint" | "targetRunId"
      >
    >;
  } | null;
}

type ReportingPlan = TeamPlan & {
  readonly reportSchedule?: TeamPlanReportSchedule;
  readonly latestReport?: TeamPlanLatestReport;
};
interface ReportInput {
  readonly plan: ReportingPlan;
  readonly occurrence: TeamPlanReportOccurrence;
  readonly observedAt: string;
  readonly observations: ReadonlyArray<TeamPlanReportObservation>;
}
type ReportExecution = TeamPlanLatestReport["tasks"][number]["executions"][number];

export function teamPlanReportCommand(occurrence: TeamPlanReportOccurrence) {
  return {
    type: "thread.team-plan.report" as const,
    commandId: CommandId.make(
      [
        "team-plan-report",
        ...[
          occurrence.threadId,
          occurrence.planCreatedAt,
          String(occurrence.generation),
          occurrence.dueAt,
        ].map(encodeURIComponent),
      ].join(":"),
    ),
    threadId: occurrence.threadId,
    planCreatedAt: occurrence.planCreatedAt,
    generation: occurrence.generation,
    dueAt: occurrence.dueAt,
    createdBy: "system" as const,
    creationSource: "server" as const,
  };
}

function timestamp(value: string): number | null {
  const parsed = DateTime.make(value);
  return Option.isSome(parsed) ? DateTime.toEpochMillis(parsed.value) : null;
}

function executionKey(execution: TeamPlanExecutionRef): string {
  return JSON.stringify([execution.subagentId, execution.threadId, execution.runId]);
}

function reportExecution(
  plan: TeamPlan,
  execution: TeamPlanExecutionRef,
  observations: ReadonlyArray<TeamPlanReportObservation>,
  observedAt: string,
): ReportExecution {
  const unknown = (reason: NonNullable<ReportExecution["unavailableReason"]>): ReportExecution => ({
    subagentId: execution.subagentId,
    threadId: execution.threadId,
    runId: execution.runId,
    status: "unknown",
    modelSelection: null,
    startedAt: null,
    completedAt: null,
    elapsedMs: null,
    unavailableReason: reason,
  });
  if (observations.length === 0) return unknown("missing-source");
  if (observations.length !== 1) return unknown("run-unverified");
  const { task, child } = observations[0]!;
  if (task === null || child === null) return unknown("missing-source");
  if (
    task.origin !== "app_owned" ||
    task.id !== execution.subagentId ||
    task.threadId !== plan.threadId ||
    task.childThreadId !== execution.threadId ||
    child.thread.id !== execution.threadId ||
    execution.threadId === plan.threadId ||
    child.thread.lineage.relationshipToParent !== "subagent" ||
    child.thread.lineage.parentThreadId !== plan.threadId
  ) {
    return unknown("execution-not-owned");
  }

  const spawnRuns = new Set<RunId>();
  if (child.thread.forkedFrom?.type === "node" && child.thread.forkedFrom.nodeId === task.id) {
    for (const transfer of child.contextTransfers) {
      if (
        transfer.type === "subagent_spawn" &&
        transfer.sourceThreadId === plan.threadId &&
        transfer.targetThreadId === execution.threadId &&
        transfer.sourcePoint.threadId === plan.threadId &&
        task.runId !== null &&
        transfer.sourcePoint.runId === task.runId &&
        transfer.targetRunId !== null
      ) {
        spawnRuns.add(transfer.targetRunId);
      }
    }
  }
  let runId: RunId | null = execution.runId;
  if (runId === null) {
    const originalRuns = new Set<RunId>(
      child.runs
        .filter((run) => run.delegatedTaskId === task.id && run.threadId === execution.threadId)
        .map((run) => run.id),
    );
    for (const spawnedRun of spawnRuns) originalRuns.add(spawnedRun);
    if (originalRuns.size !== 1) return unknown("run-unverified");
    runId = originalRuns.values().next().value ?? null;
  }
  const matches = child.runs.filter((run) => run.id === runId);
  if (matches.length !== 1) return unknown("run-unverified");
  const run = matches[0]!;
  if (
    run.threadId !== execution.threadId ||
    (run.delegatedTaskId !== undefined && run.delegatedTaskId !== task.id) ||
    (run.delegatedTaskId === undefined && (spawnRuns.size !== 1 || !spawnRuns.has(run.id)))
  ) {
    return unknown("run-unverified");
  }
  const startedAt = run.startedAt === null ? null : DateTime.formatIso(run.startedAt);
  const completedAt = run.completedAt === null ? null : DateTime.formatIso(run.completedAt);
  const start = startedAt === null ? null : timestamp(startedAt);
  const terminal = ["completed", "failed", "interrupted", "cancelled", "rolled_back"].includes(
    run.status,
  );
  const end = completedAt === null && terminal ? null : timestamp(completedAt ?? observedAt);
  const elapsed = start === null || end === null || end < start ? null : end - start;
  return {
    subagentId: execution.subagentId,
    threadId: execution.threadId,
    runId: run.id,
    status: run.status,
    modelSelection: run.modelSelection,
    startedAt,
    completedAt,
    elapsedMs: elapsed !== null && Number.isSafeInteger(elapsed) ? elapsed : null,
    unavailableReason: null,
  };
}

export function buildTeamPlanReport(input: ReportInput): TeamPlanLatestReport {
  const observations = new Map<string, Array<TeamPlanReportObservation>>();
  for (const observation of input.observations) {
    const key = executionKey(observation.execution);
    const group = observations.get(key) ?? [];
    group.push(observation);
    observations.set(key, group);
  }
  const tasks = input.plan.tasks
    .toSorted((left, right) => left.priority - right.priority)
    .flatMap((task) =>
      [task, ...task.history.filter((revision) => revision.executions.length > 0)].map(
        (revision) => ({
          taskId: task.taskId,
          revision: revision.revision,
          current: revision === task,
          title: revision.title,
          role: revision.role,
          priority: task.priority,
          acceptance: revision.acceptance.status,
          executions: revision.executions.map((execution) =>
            reportExecution(
              input.plan,
              execution,
              observations.get(executionKey(execution)) ?? [],
              input.observedAt,
            ),
          ),
        }),
      ),
    );
  return {
    planCreatedAt: input.plan.createdAt,
    planVersion: input.plan.version,
    planRevision: input.plan.revision,
    generation: input.occurrence.generation,
    dueAt: input.occurrence.dueAt,
    observedAt: input.observedAt,
    dispatchPaused: input.plan.dispatchPaused === true,
    tasks,
  };
}

export function teamPlanReportTransition(input: ReportInput):
  | { readonly ok: true; readonly plan: ReportingPlan }
  | {
      readonly ok: false;
      readonly reason: "schedule-not-current" | "not-due" | "invalid-report-schedule";
    } {
  const schedule = input.plan.reportSchedule;
  if (schedule === undefined || !schedule.enabled)
    return { ok: false, reason: "schedule-not-current" };
  const observed = timestamp(input.observedAt);
  const due = timestamp(input.occurrence.dueAt);
  if (
    !Number.isSafeInteger(schedule.everyMs) ||
    schedule.everyMs < MIN_TEAM_PLAN_REPORT_INTERVAL_MS ||
    !Number.isSafeInteger(schedule.generation) ||
    schedule.generation < 1 ||
    observed === null ||
    due === null ||
    (schedule.nextReportAt !== null && timestamp(schedule.nextReportAt) === null) ||
    !Number.isSafeInteger(input.plan.version + 1) ||
    !Number.isSafeInteger(observed + schedule.everyMs)
  ) {
    return { ok: false, reason: "invalid-report-schedule" };
  }
  const next = DateTime.make(observed + schedule.everyMs);
  if (Option.isNone(next)) return { ok: false, reason: "invalid-report-schedule" };
  if (
    input.occurrence.threadId !== input.plan.threadId ||
    input.occurrence.planCreatedAt !== input.plan.createdAt ||
    input.occurrence.generation !== schedule.generation ||
    input.occurrence.dueAt !== schedule.nextReportAt
  ) {
    return { ok: false, reason: "schedule-not-current" };
  }
  if (due > observed) return { ok: false, reason: "not-due" };
  return {
    ok: true,
    plan: {
      ...input.plan,
      version: input.plan.version + 1,
      updatedAt: input.observedAt,
      reportSchedule: { ...schedule, nextReportAt: DateTime.formatIso(next.value) },
      latestReport: buildTeamPlanReport(input),
    },
  };
}
