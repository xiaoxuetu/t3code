import {
  NodeId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type TeamPlan,
  type TeamPlanTask,
  type TeamPlanReportSchedule,
} from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
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
  taskPlanCoordinatorPatch,
} from "./TaskPlanPanel.logic";

const at = "2026-11-13T10:00:00.000Z";
function task(overrides: Partial<TeamPlanTask> = {}): TeamPlanTask {
  return {
    taskId: "T1",
    revision: 2,
    title: "Implement parser",
    prompt: "Fix the parser; pass the regression suite.",
    role: "implementation",
    priority: 100,
    modelSelection: {
      instanceId: ProviderInstanceId.make("fixture-executor"),
      model: "fixture-model",
    },
    dependencies: [{ taskId: "T2", revision: 1 }],
    confirmedRevision: 2,
    acceptance: { status: "pending", note: "", updatedAt: at },
    executions: [
      { subagentId: NodeId.make("existing-task"), threadId: ThreadId.make("child"), runId: null },
    ],
    history: [],
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}
function plan(tasks: ReadonlyArray<TeamPlanTask>): TeamPlan {
  return {
    threadId: ThreadId.make("parent"),
    version: 8,
    revision: 3,
    goal: "Ship a parser fix",
    confirmedRevision: 3,
    tasks,
    createdAt: at,
    updatedAt: at,
  };
}

function reportingPlan(): TeamPlan {
  return {
    ...plan([task()]),
    dispatchPaused: true,
    dispatchLimits: { maxConcurrentTasks: 2, maxTaskExecutions: 8 },
    reportSchedule: {
      enabled: true,
      everyMs: 60_000,
      generation: 4,
      nextReportAt: "2026-11-13T10:01:00.000Z",
    },
  };
}
function reportTick(current: TeamPlan): TeamPlan {
  return {
    ...current,
    version: current.version + 1,
    updatedAt: "2026-11-13T10:01:00.000Z",
    reportSchedule: {
      ...reportingPlan().reportSchedule!,
      nextReportAt: "2026-11-13T10:02:00.000Z",
    },
    latestReport: {
      planCreatedAt: current.createdAt,
      planVersion: current.version,
      planRevision: current.revision,
      generation: 4,
      dueAt: "2026-11-13T10:01:00.000Z",
      observedAt: "2026-11-13T10:01:00.000Z",
      dispatchPaused: true,
      tasks: [],
    },
  };
}

it("rebases an unchanged editor over passive report ticks without mutating its baseline", () => {
  const baseline = reportingPlan();
  const snapshot = structuredClone(baseline);
  const current = reportTick(reportTick(baseline));
  expect(taskPlanEditorSaveVersion(baseline, current)).toBe(current.version);
  expect(taskPlanEditorSaveVersion(baseline, structuredClone(baseline))).toBe(baseline.version);
  expect(baseline).toEqual(snapshot);
});

const substantivePlanChanges: ReadonlyArray<readonly [string, (current: TeamPlan) => TeamPlan]> = [
  ["goal", (current) => ({ ...current, goal: "A different goal" })],
  ["plan revision", (current) => ({ ...current, revision: current.revision + 1 })],
  ["plan confirmation", (current) => ({ ...current, confirmedRevision: null })],
  ["dispatch pause", (current) => ({ ...current, dispatchPaused: false })],
  [
    "limits",
    (current) => ({ ...current, dispatchLimits: { maxConcurrentTasks: 1, maxTaskExecutions: 8 } }),
  ],
  [
    "schedule enabled",
    (current) => ({
      ...current,
      reportSchedule: { enabled: false, everyMs: 60_000, generation: 4, nextReportAt: null },
    }),
  ],
  [
    "schedule interval",
    (current) => ({
      ...current,
      reportSchedule: { enabled: true, everyMs: 120_000, generation: 4, nextReportAt: at },
    }),
  ],
  [
    "schedule generation",
    (current) => ({
      ...current,
      reportSchedule: { enabled: true, everyMs: 60_000, generation: 5, nextReportAt: at },
    }),
  ],
  ["task brief", (current) => ({ ...current, tasks: [task({ prompt: "Changed scope" })] })],
  ["task title", (current) => ({ ...current, tasks: [task({ title: "Changed title" })] })],
  ["task role", (current) => ({ ...current, tasks: [task({ role: "review" })] })],
  ["task priority", (current) => ({ ...current, tasks: [task({ priority: 1 })] })],
  ["task confirmation", (current) => ({ ...current, tasks: [task({ confirmedRevision: null })] })],
  ["task model", (current) => ({ ...current, tasks: [task({ modelSelection: null })] })],
  ["task dependencies", (current) => ({ ...current, tasks: [task({ dependencies: [] })] })],
  [
    "task acceptance",
    (current) => ({
      ...current,
      tasks: [task({ acceptance: { status: "issues", note: "Missing evidence", updatedAt: at } })],
    }),
  ],
  [
    "execution references",
    (current) => ({
      ...current,
      tasks: [
        task({
          executions: [
            {
              subagentId: NodeId.make("existing-task"),
              threadId: ThreadId.make("child"),
              runId: RunId.make("newly-bound-run"),
            },
          ],
        }),
      ],
    }),
  ],
  [
    "task history",
    (current) => ({ ...current, tasks: [task({ history: [{ ...task(), revision: 1 }] })] }),
  ],
  [
    "nested task timestamp",
    (current) => ({ ...current, tasks: [task({ updatedAt: "2026-11-13T10:01:00.000Z" })] }),
  ],
];
it.each(substantivePlanChanges)(
  "keeps the editor conflicted when %s changes alongside a report tick",
  (_label, change) => {
    const baseline = reportingPlan();
    expect(taskPlanEditorSaveVersion(baseline, change(reportTick(baseline)))).toBeNull();
    expect(taskPlanEditorSaveVersion(baseline, change(baseline))).toBeNull();
  },
);

it("rejects a different plan identity, removal, creation or a backwards version", () => {
  const baseline = reportingPlan();
  const current = reportTick(baseline);
  expect(taskPlanEditorSaveVersion(null, null)).toBe(0);
  expect(taskPlanEditorSaveVersion(null, current)).toBeNull();
  expect(taskPlanEditorSaveVersion(baseline, null)).toBeNull();
  expect(
    taskPlanEditorSaveVersion(baseline, { ...current, threadId: ThreadId.make("other-thread") }),
  ).toBeNull();
  expect(
    taskPlanEditorSaveVersion(baseline, { ...current, createdAt: "2026-11-13T09:00:00.000Z" }),
  ).toBeNull();
  expect(
    taskPlanEditorSaveVersion(baseline, { ...current, version: baseline.version - 1 }),
  ).toBeNull();
});

it("compares typed plan contents independently of object property insertion order", () => {
  const baseline = reportingPlan();
  const current = reportTick(baseline);
  const first = current.tasks[0]!;
  expect(
    taskPlanEditorSaveVersion(baseline, {
      ...current,
      tasks: [
        {
          ...first,
          modelSelection: {
            model: "fixture-model",
            instanceId: ProviderInstanceId.make("fixture-executor"),
          },
        },
      ],
    }),
  ).toBe(current.version);
});

it("opens legacy and explicitly unset dispatch limits without inventing a cap", () => {
  expect(taskPlanDispatchLimitsDraft(undefined)).toEqual({
    maxConcurrentTasks: "",
    maxTaskExecutions: "",
  });
  expect(
    taskPlanDispatchLimitsDraft({ maxConcurrentTasks: null, maxTaskExecutions: null }),
  ).toEqual(taskPlanDispatchLimitsDraft(undefined));
  expect(taskPlanDispatchLimitsDraft({ maxConcurrentTasks: 2, maxTaskExecutions: 10 })).toEqual({
    maxConcurrentTasks: "2",
    maxTaskExecutions: "10",
  });
});

it("changes independent dispatch limits and can clear either cap", () => {
  const original = { maxConcurrentTasks: 4, maxTaskExecutions: 8 };
  expect(
    taskPlanDispatchLimitsOperations(
      { maxConcurrentTasks: " 12 ", maxTaskExecutions: " " },
      original,
    ),
  ).toEqual({
    ok: true,
    operations: [
      {
        type: "set_dispatch_limits",
        limits: { maxConcurrentTasks: 12, maxTaskExecutions: null },
      },
    ],
  });
  expect(
    taskPlanDispatchLimitsOperations({ maxConcurrentTasks: "", maxTaskExecutions: "1" }, original),
  ).toEqual({
    ok: true,
    operations: [
      {
        type: "set_dispatch_limits",
        limits: { maxConcurrentTasks: null, maxTaskExecutions: 1 },
      },
    ],
  });
  expect(original).toEqual({ maxConcurrentTasks: 4, maxTaskExecutions: 8 });
});

it("does not write semantically unchanged or legacy unset dispatch limits", () => {
  expect(
    taskPlanDispatchLimitsOperations({ maxConcurrentTasks: " ", maxTaskExecutions: "" }, undefined),
  ).toEqual({ ok: true, operations: [] });
  expect(
    taskPlanDispatchLimitsOperations(
      { maxConcurrentTasks: "02", maxTaskExecutions: " 10 " },
      { maxConcurrentTasks: 2, maxTaskExecutions: 10 },
    ),
  ).toEqual({ ok: true, operations: [] });
});

it("accepts the positive safe integer boundary without rounding the execution cap", () => {
  expect(
    taskPlanDispatchLimitsOperations(
      { maxConcurrentTasks: "1", maxTaskExecutions: String(Number.MAX_SAFE_INTEGER) },
      undefined,
    ),
  ).toEqual({
    ok: true,
    operations: [
      {
        type: "set_dispatch_limits",
        limits: { maxConcurrentTasks: 1, maxTaskExecutions: Number.MAX_SAFE_INTEGER },
      },
    ],
  });
});

it.each(["0", "-1", "1.5", "1e3", "0x10", "NaN", "Infinity", "9007199254740992"])(
  "rejects invalid dispatch cap %s without interpreting it as an unset cap",
  (value) => {
    for (const field of ["maxConcurrentTasks", "maxTaskExecutions"] as const) {
      const result = taskPlanDispatchLimitsOperations(
        { maxConcurrentTasks: "", maxTaskExecutions: "", [field]: value },
        { maxConcurrentTasks: 2, maxTaskExecutions: 10 },
      );
      expect(result.ok).toBe(false);
    }
  },
);

it("enables passive reports from minutes without changing any task or dispatch limits", () => {
  expect(taskPlanReportScheduleOperations(" 2 ", undefined)).toEqual({
    ok: true,
    operations: [{ type: "set_report_schedule", enabled: true, everyMs: 120_000 }],
  });
});

it("keeps an unchanged enabled report schedule due time and re-enables a stopped schedule", () => {
  const original: TeamPlanReportSchedule = {
    enabled: true,
    everyMs: 60_000,
    generation: 4,
    nextReportAt: "2026-11-13T10:01:00.000Z",
  };
  expect(taskPlanReportScheduleOperations("01", original)).toEqual({ ok: true, operations: [] });
  expect(
    taskPlanReportScheduleOperations("1", { ...original, enabled: false, nextReportAt: null }),
  ).toEqual({
    ok: true,
    operations: [{ type: "set_report_schedule", enabled: true, everyMs: 60_000 }],
  });
  expect(original.generation).toBe(4);
  expect(original.nextReportAt).toBe("2026-11-13T10:01:00.000Z");
});

it.each(["", " ", "0", "-1", "1.5", "1e3", "0x10", "9007199254740991"])(
  "rejects invalid or unsafe report minutes %s without enabling a schedule",
  (minutes) => {
    expect(taskPlanReportScheduleOperations(minutes, undefined).ok).toBe(false);
  },
);

it("pauses an existing confirmed plan before refining its unchanged goal", () => {
  const current = plan([task()]);
  const snapshot = structuredClone(current);
  expect(
    taskPlanCoordinatorPatch(current, { phase: "prepare", goal: ` ${current.goal} ` }),
  ).toEqual({
    ok: true,
    goal: current.goal,
    patch: {
      expectedPlanVersion: current.version,
      operations: [{ type: "set_dispatch_paused", paused: true }],
    },
  });
  expect(current).toEqual(snapshot);
});

it("saves a new goal and pauses dispatch in one versioned plan write", () => {
  expect(taskPlanCoordinatorPatch(null, { phase: "prepare", goal: " Inspect samples " })).toEqual({
    ok: true,
    goal: "Inspect samples",
    patch: {
      expectedPlanVersion: 0,
      operations: [
        { type: "set_goal", goal: "Inspect samples" },
        { type: "set_dispatch_paused", paused: true },
      ],
    },
  });
});

it("resumes a paused confirmed plan without revising or reissuing its existing work", () => {
  const current = { ...plan([task()]), dispatchPaused: true };
  const snapshot = structuredClone(current);
  expect(taskPlanCoordinatorPatch(current, { phase: "continue" })).toEqual({
    ok: true,
    goal: current.goal,
    patch: {
      expectedPlanVersion: current.version,
      operations: [{ type: "set_dispatch_paused", paused: false }],
    },
  });
  expect(current).toEqual(snapshot);
});

it("avoids another plan mutation when the requested dispatch state already applies", () => {
  const current = plan([task()]);
  expect(
    taskPlanCoordinatorPatch(
      { ...current, dispatchPaused: true },
      { phase: "prepare", goal: current.goal },
    ),
  ).toEqual({ ok: true, goal: current.goal, patch: null });
  expect(taskPlanCoordinatorPatch(current, { phase: "continue" })).toEqual({
    ok: true,
    goal: current.goal,
    patch: null,
  });
});

it.each([
  null,
  plan([]),
  { ...plan([task()]), goal: " " },
  { ...plan([task()]), confirmedRevision: null },
  { ...plan([task()]), confirmedRevision: 2 },
])("requires a nonempty confirmed task plan before resuming dispatch", (current) => {
  expect(taskPlanCoordinatorPatch(current, { phase: "continue" }).ok).toBe(false);
});

it("changes priority without revising content, clearing the executor, or touching a dispatched attempt", () => {
  const original = task();
  const result = taskPlanDraftOperations(
    original.taskId,
    { ...taskPlanDraft(original), priority: "1" },
    original,
  );
  expect(result).toEqual({
    ok: true,
    operations: [{ type: "reprioritize", taskId: "T1", priority: 1 }],
  });
  expect(original.executions).toHaveLength(1);
  expect(original.modelSelection?.model).toBe("fixture-model");
  expect(original.revision).toBe(2);
});

it("keeps a task's stable identity and selected executor when its brief changes", () => {
  const original = task();
  expect(
    taskPlanDraftOperations(
      "T1",
      { ...taskPlanDraft(original), prompt: "Add the edge case regression." },
      original,
    ),
  ).toEqual({
    ok: true,
    operations: [
      { type: "edit_task", taskId: "T1", changes: { prompt: "Add the edge case regression." } },
    ],
  });
});

it("does not revise a task just because dependency presentation order changed", () => {
  const original = task({
    dependencies: [
      { taskId: "T2", revision: 1 },
      { taskId: "T3", revision: 4 },
    ],
  });
  expect(
    taskPlanDraftOperations(
      "T1",
      { ...taskPlanDraft(original), dependencies: [...original.dependencies].reverse() },
      original,
    ),
  ).toEqual({ ok: true, operations: [] });
});

it("updates one pinned dependency without changing other revisions or the source array", () => {
  const dependencies = [
    { taskId: "T2", revision: 1 },
    { taskId: "T3", revision: 4 },
  ];
  expect(selectTaskPlanDependency(dependencies, { taskId: "T2", revision: 2 }, true)).toEqual([
    { taskId: "T3", revision: 4 },
    { taskId: "T2", revision: 2 },
  ]);
  expect(selectTaskPlanDependency(dependencies, { taskId: "T2", revision: 1 }, false)).toEqual([
    { taskId: "T3", revision: 4 },
  ]);
  expect(dependencies[0]?.revision).toBe(1);
});

it("creates an unassigned plan row without inventing an executor or a run", () => {
  const draft = { ...taskPlanDraft(), title: " Investigate ", prompt: " Measure and report. " };
  const result = taskPlanDraftOperations("T4", draft, null);
  expect(result).toEqual({
    ok: true,
    operations: [
      {
        type: "add_task",
        task: {
          taskId: "T4",
          title: "Investigate",
          prompt: "Measure and report.",
          role: "implementation",
          priority: 100,
          modelSelection: null,
          dependencies: [],
        },
      },
    ],
  });
});

it.each([
  { title: " ", prompt: "Check", priority: "100" },
  { title: "Check", prompt: " ", priority: "100" },
  { title: "Check", prompt: "Check", priority: "1.5" },
  { title: "Check", prompt: "Check", priority: "" },
])("rejects an incomplete task or invalid integer priority before dispatch", (fields) => {
  expect(taskPlanDraftOperations("T1", { ...taskPlanDraft(), ...fields }, null).ok).toBe(false);
});

it("sorts by user priority while preserving equal-priority order and every task identity", () => {
  const tasks = [
    task({ taskId: "T8" }),
    task({ taskId: "T2", priority: 1 }),
    task({ taskId: "T1" }),
  ];
  expect(orderTaskPlanRows(tasks).map((value) => value.taskId)).toEqual(["T2", "T8", "T1"]);
  expect(tasks.map((value) => value.taskId)).toEqual(["T8", "T2", "T1"]);
  expect(nextTaskPlanKey(plan(tasks))).toBe("T3");
});

it("labels a pinned dependency with its historical title instead of the current revision's scope", () => {
  const previous = task({ revision: 1, title: "Investigate parser", confirmedRevision: 1 });
  const current = task({ title: "Replace parser", history: [previous] });
  expect(taskPlanDependencyLabel(current, 1)).toBe("T1 · Investigate parser · r1");
  expect(taskPlanDependencyLabel(current, 2)).toBe("T1 · Replace parser · r2");
  expect(taskPlanDependencyLabel(current, 3)).toBe("T1 · Revision unavailable · r3");
});

it("retains every historical session target without requiring loaded execution history or inventing run timing", () => {
  const history = Array.from({ length: 80 }, (_, index) =>
    task({
      revision: index + 1,
      title: `Scope ${index + 1}`,
      executions: [
        {
          subagentId: NodeId.make(`old-task-${index}`),
          threadId: ThreadId.make(`old-child-${index}`),
          runId: index === 0 ? RunId.make("original-run") : null,
        },
      ],
    }),
  );
  const current = task({ revision: 81, history });
  const targets = taskPlanHistoricalExecutions(current);
  expect(targets).toHaveLength(80);
  expect(targets[0]).toEqual({
    taskId: "T1",
    revision: 1,
    execution: history[0]?.executions[0],
    taskCreatedAt: at,
    recordUpdatedAt: at,
  });
  expect(targets.at(-1)?.execution.threadId).toBe("old-child-79");
  expect(targets[0]?.execution.runId).toBe("original-run");
  expect(targets.slice(1).every((target) => target.execution.runId === null)).toBe(true);
  expect(targets.some((target) => target.execution.subagentId === "existing-task")).toBe(false);
  expect(current.history).toHaveLength(80);
});
