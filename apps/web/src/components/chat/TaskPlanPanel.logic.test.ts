import {
  NodeId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type TeamPlan,
  type TeamPlanTask,
} from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import {
  nextTaskPlanKey,
  orderTaskPlanRows,
  selectTaskPlanDependency,
  taskPlanDraft,
  taskPlanDraftOperations,
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
