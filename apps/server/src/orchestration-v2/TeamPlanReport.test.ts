import { describe, expect, it } from "vite-plus/test";
import {
  MIN_TEAM_PLAN_REPORT_INTERVAL_MS,
  NodeId,
  ProviderInstanceId,
  RunId,
  TeamPlanLatestReport,
  TeamPlanReportSchedule,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import {
  buildTeamPlanReport,
  teamPlanReportCommand,
  teamPlanReportTransition,
} from "./TeamPlanReport.ts";

type Input = Parameters<typeof teamPlanReportTransition>[0];
const isReportSchedule = Schema.is(TeamPlanReportSchedule);
const isLatestReport = Schema.is(TeamPlanLatestReport);

function fixture(): Input {
  const parentId = ThreadId.make("parent");
  const childId = ThreadId.make("child");
  const subagentId = NodeId.make("employee");
  const runId = RunId.make("initial-run");
  const parentRunId = RunId.make("parent-run");
  const createdAt = "2026-11-13T00:00:00.000Z";
  const dueAt = "2026-11-13T00:01:00.000Z";
  const execution = { subagentId, threadId: childId, runId };
  const modelSelection = {
    instanceId: ProviderInstanceId.make("available-provider"),
    model: "available-model",
    options: [{ id: "effort", value: "high" }],
  };
  return {
    plan: {
      threadId: parentId,
      version: 4,
      revision: 2,
      goal: "Confirmed goal",
      confirmedRevision: 2,
      dispatchPaused: true,
      createdAt,
      updatedAt: createdAt,
      reportSchedule: {
        enabled: true,
        everyMs: MIN_TEAM_PLAN_REPORT_INTERVAL_MS,
        generation: 1,
        nextReportAt: dueAt,
      },
      tasks: [
        {
          taskId: "task",
          title: "Confirmed task",
          prompt: "WORKER_FREE_TEXT_MUST_NOT_APPEAR",
          role: "implementer",
          modelSelection,
          dependencies: [],
          priority: 10,
          revision: 1,
          confirmedRevision: 1,
          acceptance: {
            status: "pending",
            note: "ACCEPTANCE_FREE_TEXT_MUST_NOT_APPEAR",
            updatedAt: createdAt,
          },
          executions: [execution],
          history: [],
          createdAt,
          updatedAt: createdAt,
        },
      ],
    },
    occurrence: { threadId: parentId, planCreatedAt: createdAt, generation: 1, dueAt },
    observedAt: dueAt,
    observations: [
      {
        execution,
        task: {
          id: subagentId,
          threadId: parentId,
          runId: parentRunId,
          origin: "app_owned",
          childThreadId: childId,
        },
        child: {
          thread: {
            id: childId,
            lineage: {
              parentThreadId: parentId,
              rootThreadId: parentId,
              relationshipToParent: "subagent",
            },
            forkedFrom: { type: "node", nodeId: subagentId },
          },
          runs: [
            {
              id: runId,
              threadId: childId,
              delegatedTaskId: subagentId,
              status: "running",
              modelSelection,
              startedAt: DateTime.makeUnsafe("2026-11-13T00:00:30.000Z"),
              completedAt: null,
            },
          ],
          contextTransfers: [],
        },
      },
    ],
  };
}

function execution(input: Input) {
  return buildTeamPlanReport(input).tasks[0]!.executions[0]!;
}

function nullableRun(input: Input): Input {
  const reference = { ...input.observations[0]!.execution, runId: null };
  return {
    ...input,
    plan: {
      ...input.plan,
      tasks: input.plan.tasks.map((task) => ({ ...task, executions: [reference] })),
    },
    observations: [{ ...input.observations[0]!, execution: reference }],
  };
}

describe("passive team plan reports", () => {
  it("constrains persisted schedule intervals and generations to safe integers", () => {
    const schedule = fixture().plan.reportSchedule!;
    expect(isReportSchedule(schedule)).toBe(true);
    for (const everyMs of [59_999, 60_000.5, Number.MAX_SAFE_INTEGER + 1, Infinity]) {
      expect(isReportSchedule({ ...schedule, everyMs })).toBe(false);
    }
    for (const generation of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(isReportSchedule({ ...schedule, generation })).toBe(false);
    }
  });

  it("uses an encoded occurrence identity independent of observation time or provider session", () => {
    const original = fixture().occurrence;
    const command = teamPlanReportCommand(original);
    expect(command).toMatchObject({
      ...original,
      type: "thread.team-plan.report",
      createdBy: "system",
      creationSource: "server",
    });
    expect(teamPlanReportCommand({ ...original })).toEqual(command);
    const extraFields = {
      ...original,
      type: "delegated_task.request",
      commandId: "forged-command",
    };
    expect(teamPlanReportCommand(extraFields)).toEqual(command);
    const changed = [
      { ...original, threadId: ThreadId.make("parent:other") },
      { ...original, planCreatedAt: "2026-11-13T00:00:01.000Z" },
      { ...original, generation: 2 },
      { ...original, dueAt: "2026-11-13T00:02:00.000Z" },
    ];
    const ids = changed.map((occurrence) => teamPlanReportCommand(occurrence).commandId);
    expect(new Set([command.commandId, ...ids]).size).toBe(5);
    expect(
      teamPlanReportCommand({ ...original, threadId: ThreadId.make("a:b") }).commandId,
    ).not.toBe(teamPlanReportCommand({ ...original, threadId: ThreadId.make("a%3Ab") }).commandId);
  });

  it("records one late snapshot and preserves all task, confirmation and dispatch state", () => {
    const input = { ...fixture(), observedAt: "2026-11-13T00:10:00.000Z" };
    const before = JSON.stringify(input.plan);
    const result = teamPlanReportTransition(input);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.plan).toMatchObject({
      version: 5,
      revision: 2,
      confirmedRevision: 2,
      dispatchPaused: true,
      updatedAt: input.observedAt,
      reportSchedule: { nextReportAt: "2026-11-13T00:11:00.000Z" },
    });
    expect(result.plan.tasks).toBe(input.plan.tasks);
    expect(result.plan.latestReport).toMatchObject({ planVersion: 4, planRevision: 2 });
    expect(isLatestReport(result.plan.latestReport)).toBe(true);
    expect(JSON.stringify(input.plan)).toBe(before);
    expect(teamPlanReportTransition({ ...input, plan: result.plan })).toEqual({
      ok: false,
      reason: "schedule-not-current",
    });
  });

  it("refuses early, disabled, stale, malformed and overflowing occurrences", () => {
    const input = fixture();
    const { reportSchedule: _reportSchedule, ...withoutSchedule } = input.plan;
    expect(teamPlanReportTransition({ ...input, observedAt: "2026-11-13T00:00:59.000Z" })).toEqual({
      ok: false,
      reason: "not-due",
    });
    const stale = [
      { ...input, plan: withoutSchedule },
      {
        ...input,
        plan: { ...input.plan, reportSchedule: { ...input.plan.reportSchedule!, enabled: false } },
      },
      { ...input, occurrence: { ...input.occurrence, threadId: ThreadId.make("other-owner") } },
      { ...input, occurrence: { ...input.occurrence, planCreatedAt: "replacement-plan" } },
      { ...input, occurrence: { ...input.occurrence, generation: 2 } },
      { ...input, occurrence: { ...input.occurrence, dueAt: "2026-11-13T00:02:00.000Z" } },
      {
        ...input,
        plan: {
          ...input.plan,
          reportSchedule: { ...input.plan.reportSchedule!, nextReportAt: null },
        },
      },
    ];
    for (const candidate of stale) {
      expect(teamPlanReportTransition(candidate)).toEqual({
        ok: false,
        reason: "schedule-not-current",
      });
    }
    for (const candidate of [
      { ...input, observedAt: "invalid-time" },
      { ...input, plan: { ...input.plan, version: Number.MAX_SAFE_INTEGER } },
      ...[59_999, 60_000.5, Number.MAX_SAFE_INTEGER].map((everyMs) => ({
        ...input,
        plan: { ...input.plan, reportSchedule: { ...input.plan.reportSchedule!, everyMs } },
      })),
    ]) {
      expect(teamPlanReportTransition(candidate)).toEqual({
        ok: false,
        reason: "invalid-report-schedule",
      });
    }
  });

  it("reports only the bound run and excludes worker and acceptance free text", () => {
    const input = fixture();
    const observation = input.observations[0]!;
    const child = observation.child!;
    const report = buildTeamPlanReport({
      ...input,
      observations: [
        {
          ...observation,
          child: {
            ...child,
            runs: [
              ...child.runs,
              {
                ...child.runs[0]!,
                id: RunId.make("later-run"),
                delegatedTaskId: undefined,
                status: "completed",
              },
            ],
          },
        },
      ],
    });
    expect(report.tasks[0]!.acceptance).toBe("pending");
    expect(report.tasks[0]!.executions[0]).toMatchObject({
      runId: RunId.make("initial-run"),
      status: "running",
      startedAt: "2026-11-13T00:00:30.000Z",
      completedAt: null,
      elapsedMs: 30_000,
      unavailableReason: null,
    });
    expect(JSON.stringify(report)).not.toContain("FREE_TEXT_MUST_NOT_APPEAR");
    expect(
      execution({
        ...input,
        observations: [{ ...observation, child: { ...child, runs: child.runs.slice(1) } }],
      }),
    ).toMatchObject({
      status: "unknown",
      unavailableReason: "run-unverified",
      modelSelection: null,
    });
  });

  it("retains executed historical revisions and orders tasks by the existing priority convention", () => {
    const input = fixture();
    const task = input.plan.tasks[0]!;
    const { taskId: _id, priority: _priority, history: _history, ...historical } = task;
    const report = buildTeamPlanReport({
      ...input,
      plan: {
        ...input.plan,
        tasks: [
          {
            ...task,
            revision: 2,
            executions: [],
            history: [historical, { ...historical, revision: 3, executions: [] }],
          },
          { ...task, taskId: "z-higher-priority", priority: 1, executions: [] },
          { ...task, taskId: "a-same-priority", priority: 1, executions: [] },
        ],
      },
    });
    expect(
      report.tasks.map(({ taskId, revision, current }) => ({ taskId, revision, current })),
    ).toEqual([
      { taskId: "z-higher-priority", revision: 1, current: true },
      { taskId: "a-same-priority", revision: 1, current: true },
      { taskId: "task", revision: 2, current: true },
      { taskId: "task", revision: 1, current: false },
    ]);
  });

  it("keeps missing, foreign and ambiguous observations unknown", () => {
    const input = fixture();
    const observation = input.observations[0]!;
    expect(execution({ ...input, observations: [] }).unavailableReason).toBe("missing-source");
    expect(
      execution({ ...input, observations: [{ ...observation, child: null }] }).unavailableReason,
    ).toBe("missing-source");
    expect(
      execution({ ...input, observations: [{ ...observation, task: null }] }).unavailableReason,
    ).toBe("missing-source");
    for (const task of [
      { ...observation.task!, origin: "provider_native" as const },
      { ...observation.task!, threadId: ThreadId.make("foreign-parent") },
      { ...observation.task!, childThreadId: ThreadId.make("foreign-child") },
    ]) {
      expect(execution({ ...input, observations: [{ ...observation, task }] })).toMatchObject({
        status: "unknown",
        unavailableReason: "execution-not-owned",
        modelSelection: null,
      });
    }
    expect(
      execution({ ...input, observations: [observation, observation] }).unavailableReason,
    ).toBe("run-unverified");
  });

  it("resolves nullable legacy bindings only through original task or unambiguous spawn evidence", () => {
    const input = nullableRun(fixture());
    const observation = input.observations[0]!;
    const child = observation.child!;
    expect(execution(input).runId).toBe(RunId.make("initial-run"));
    const { delegatedTaskId: _delegatedTaskId, ...original } = child.runs[0]!;
    const withoutTask: Input = {
      ...input,
      observations: [{ ...observation, child: { ...child, runs: [original] } }],
    };
    expect(execution(withoutTask).unavailableReason).toBe("run-unverified");
    const transfer = {
      type: "subagent_spawn" as const,
      sourceThreadId: input.plan.threadId,
      targetThreadId: child.thread.id,
      sourcePoint: { threadId: input.plan.threadId, runId: observation.task!.runId! },
      targetRunId: original.id,
    };
    const viaSpawn: Input = {
      ...withoutTask,
      observations: [
        {
          ...withoutTask.observations[0]!,
          child: { ...withoutTask.observations[0]!.child!, contextTransfers: [transfer] },
        },
      ],
    };
    expect(execution(viaSpawn)).toMatchObject({
      runId: original.id,
      status: "running",
      unavailableReason: null,
    });
    const followUp = { ...original, id: RunId.make("follow-up"), status: "completed" as const };
    expect(
      execution({
        ...viaSpawn,
        observations: [
          { ...observation, child: { ...child, runs: [followUp], contextTransfers: [transfer] } },
        ],
      }),
    ).toMatchObject({ status: "unknown", unavailableReason: "run-unverified" });
    expect(
      execution({
        ...input,
        observations: [
          {
            ...observation,
            child: {
              ...child,
              contextTransfers: [{ ...transfer, targetRunId: followUp.id }],
            },
          },
        ],
      }).unavailableReason,
    ).toBe("run-unverified");
  });

  it("does not mistake a legacy follow-up for the original run based on fork identity alone", () => {
    const input = fixture();
    const observation = input.observations[0]!;
    const child = observation.child!;
    const { delegatedTaskId: _delegatedTaskId, ...original } = child.runs[0]!;
    const withoutProof: Input = {
      ...input,
      observations: [
        {
          ...observation,
          child: { ...child, runs: [original] },
        },
      ],
    };
    expect(execution(withoutProof).unavailableReason).toBe("run-unverified");
    const transfer = {
      type: "subagent_spawn" as const,
      sourceThreadId: input.plan.threadId,
      targetThreadId: child.thread.id,
      sourcePoint: { threadId: input.plan.threadId, runId: observation.task!.runId! },
      targetRunId: original.id,
    };
    expect(
      execution({
        ...withoutProof,
        observations: [
          {
            ...observation,
            child: { ...child, runs: [original], contextTransfers: [transfer] },
          },
        ],
      }).unavailableReason,
    ).toBeNull();
    const later = { ...original, id: RunId.make("later-legacy-run") };
    const reference = { ...observation.execution, runId: later.id };
    expect(
      execution({
        ...input,
        plan: {
          ...input.plan,
          tasks: input.plan.tasks.map((task) => ({ ...task, executions: [reference] })),
        },
        observations: [
          {
            ...observation,
            execution: reference,
            child: {
              ...child,
              runs: [original, later],
              contextTransfers: [transfer],
            },
          },
        ],
      }),
    ).toMatchObject({ status: "unknown", unavailableReason: "run-unverified" });
  });

  it("leaves invalid or incomplete durations unknown instead of manufacturing zero or continued time", () => {
    const input = fixture();
    const observation = input.observations[0]!;
    const child = observation.child!;
    const run = child.runs[0]!;
    const report = (change: Partial<typeof run>) =>
      execution({
        ...input,
        observations: [{ ...observation, child: { ...child, runs: [{ ...run, ...change }] } }],
      });
    for (const status of [
      "completed",
      "failed",
      "interrupted",
      "cancelled",
      "rolled_back",
    ] as const) {
      expect(report({ status, completedAt: null }).elapsedMs).toBeNull();
    }
    expect(
      report({ startedAt: DateTime.makeUnsafe("2026-11-13T00:02:00.000Z") }).elapsedMs,
    ).toBeNull();
    expect(
      report({ completedAt: DateTime.makeUnsafe("2026-11-13T00:00:00.000Z") }).elapsedMs,
    ).toBeNull();
    expect(
      report({
        status: "completed",
        completedAt: DateTime.makeUnsafe("2026-11-13T00:00:45.000Z"),
      }).elapsedMs,
    ).toBe(15_000);
  });
});
