import {
  NodeId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type TeamPlan,
  type TeamPlanOperation,
  type TeamPlanTaskDraft,
} from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import {
  applyTeamPlanPatch,
  createTeamPlan,
  teamPlanExecutionCount,
  teamPlanTaskCommandId,
  teamPlanTaskReadiness,
  validateTeamPlan,
} from "./teamPlan.ts";

const threadId = ThreadId.make("coordinator");
const now = "2026-11-13T00:00:00.000Z";
const selection = { instanceId: ProviderInstanceId.make("approved-seat"), model: "approved-model" };
const draft = (
  taskId: string,
  dependencies: TeamPlanTaskDraft["dependencies"] = [],
): TeamPlanTaskDraft => ({
  taskId,
  title: taskId,
  prompt: "Implement with explicit scope and acceptance",
  role: "implementation",
  priority: 1,
  modelSelection: selection,
  dependencies,
});
function patch(plan: TeamPlan, operations: ReadonlyArray<TeamPlanOperation>): TeamPlan {
  const result = applyTeamPlanPatch(
    plan,
    { expectedPlanVersion: plan.version, operations },
    { threadId, now },
  );
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.code);
  return result.plan;
}
const initial = () => createTeamPlan({ threadId, now, goal: "Deliver approved work" });

it("pauses only new dispatch without changing confirmed scope, history or execution links", () => {
  let plan = patch(initial(), [
    { type: "add_task", task: draft("T1") },
    { type: "add_task", task: draft("T2") },
  ]);
  plan = patch(plan, [{ type: "confirm_plan", revision: plan.revision }]);
  plan = patch(plan, [
    {
      type: "bind_execution",
      taskId: "T2",
      revision: 1,
      execution: {
        subagentId: NodeId.make("existing-worker"),
        threadId: ThreadId.make("existing-child"),
        runId: RunId.make("existing-run"),
      },
    },
    { type: "edit_task", taskId: "T2", changes: { prompt: "Proposed later scope" } },
  ]);
  plan = patch(plan, [{ type: "confirm_plan", revision: plan.revision }]);
  const before = structuredClone(plan);
  expect(plan).not.toHaveProperty("dispatchPaused");
  expect(teamPlanTaskReadiness(plan, "T1")).toEqual({ ready: true, reason: null });
  plan = patch(plan, [{ type: "set_dispatch_paused", paused: true }]);
  expect(plan.dispatchPaused).toBe(true);
  expect(plan.version).toBe(before.version + 1);
  expect(plan.revision).toBe(before.revision);
  expect(plan.confirmedRevision).toBe(before.confirmedRevision);
  expect(plan.tasks).toEqual(before.tasks);
  expect(teamPlanTaskReadiness(plan, "T1")).toEqual({
    ready: false,
    reason: "dispatch-paused",
  });
  plan = patch(plan, [{ type: "set_dispatch_paused", paused: false }]);
  expect(plan.dispatchPaused).toBe(false);
  expect(plan.version).toBe(before.version + 2);
  expect(plan.revision).toBe(before.revision);
  expect(plan.tasks).toEqual(before.tasks);
  expect(teamPlanTaskReadiness(plan, "T1")).toEqual({ ready: true, reason: null });
  const resumed = structuredClone(plan);
  plan = patch(plan, [
    {
      type: "set_dispatch_limits",
      limits: { maxConcurrentTasks: 1, maxTaskExecutions: 1 },
    },
  ]);
  expect(plan.version).toBe(resumed.version + 1);
  expect(plan.revision).toBe(resumed.revision);
  expect(plan.confirmedRevision).toBe(resumed.confirmedRevision);
  expect(plan.tasks).toEqual(resumed.tasks);
  expect(teamPlanExecutionCount(plan)).toBe(1);
  expect(teamPlanTaskReadiness(plan, "T1")).toEqual({
    ready: false,
    reason: "task-execution-limit",
  });
});

it("persists report generations without postponing an unchanged schedule or revising task scope", () => {
  let plan = patch(initial(), [{ type: "add_task", task: draft("T1") }]);
  plan = patch(plan, [{ type: "confirm_plan", revision: plan.revision }]);
  const approved = structuredClone(plan);
  plan = patch(plan, [{ type: "set_report_schedule", enabled: true, everyMs: 60_000 }]);
  expect(plan.reportSchedule).toEqual({
    enabled: true,
    everyMs: 60_000,
    generation: 1,
    nextReportAt: "2026-11-13T00:01:00.000Z",
  });
  expect(plan.revision).toBe(approved.revision);
  expect(plan.confirmedRevision).toBe(approved.confirmedRevision);
  expect(plan.tasks).toEqual(approved.tasks);
  const unchanged = applyTeamPlanPatch(
    plan,
    {
      expectedPlanVersion: plan.version,
      operations: [{ type: "set_report_schedule", enabled: true, everyMs: 60_000 }],
    },
    { threadId, now: "2026-11-13T00:10:00.000Z" },
  );
  expect(unchanged.ok).toBe(true);
  if (!unchanged.ok) throw new Error(unchanged.error.code);
  expect(unchanged.plan.reportSchedule).toEqual(plan.reportSchedule);
  plan = patch(plan, [{ type: "set_report_schedule", enabled: false, everyMs: 60_000 }]);
  expect(plan.reportSchedule).toMatchObject({ generation: 2, enabled: false, nextReportAt: null });
  plan = patch(plan, [{ type: "set_report_schedule", enabled: true, everyMs: 120_000 }]);
  expect(plan.reportSchedule).toMatchObject({
    generation: 3,
    enabled: true,
    nextReportAt: "2026-11-13T00:02:00.000Z",
  });
  for (const everyMs of [59_999, Number.MAX_SAFE_INTEGER]) {
    expect(
      applyTeamPlanPatch(
        plan,
        {
          expectedPlanVersion: plan.version,
          operations: [{ type: "set_report_schedule", enabled: true, everyMs }],
        },
        { threadId, now },
      ),
    ).toEqual({ ok: false, error: { code: "invalid-operation" } });
  }
  expect(plan.reportSchedule?.generation).toBe(3);
});

it("uses plan-version CAS and leaves the prior state untouched", () => {
  const plan = initial();
  const result = applyTeamPlanPatch(
    plan,
    { expectedPlanVersion: 9, operations: [{ type: "add_task", task: draft("T1") }] },
    { threadId, now },
  );
  expect(result).toEqual({
    ok: false,
    error: { code: "version-conflict", expectedPlanVersion: 9, actualPlanVersion: 0 },
  });
  expect(plan.tasks).toEqual([]);
  expect(
    applyTeamPlanPatch(
      plan,
      { expectedPlanVersion: 0, operations: [{ type: "set_goal", goal: "Other" }] },
      { threadId: ThreadId.make("other"), now },
    ).ok,
  ).toBe(false);
});

it("rejects missing, self and cyclic dependencies atomically", () => {
  for (const [tasks, code] of [
    [[draft("T1", [{ taskId: "missing", revision: 1 }])], "missing-dependency"],
    [[draft("T1", [{ taskId: "T1", revision: 1 }])], "self-dependency"],
    [
      [draft("T1", [{ taskId: "T2", revision: 1 }]), draft("T2", [{ taskId: "T1", revision: 1 }])],
      "dependency-cycle",
    ],
  ] as const) {
    const plan = initial();
    const result = applyTeamPlanPatch(
      plan,
      {
        expectedPlanVersion: 0,
        operations: tasks.map((task) => ({ type: "add_task" as const, task })),
      },
      { threadId, now },
    );
    expect(result).toMatchObject({ ok: false, error: { code } });
    expect(plan.tasks).toEqual([]);
  }
});

it("requires an assignment, confirmation and accepted pinned prerequisites", () => {
  let plan = patch(initial(), [
    { type: "add_task", task: draft("T1") },
    { type: "add_task", task: draft("T2", [{ taskId: "T1", revision: 1 }]) },
    { type: "add_task", task: { ...draft("T3"), modelSelection: null } },
  ]);
  expect(teamPlanTaskReadiness(plan, "T1").ready).toBe(false);
  plan = patch(plan, [{ type: "confirm_plan", revision: plan.revision }]);
  expect(teamPlanTaskReadiness(plan, "T1")).toEqual({ ready: true, reason: null });
  expect(teamPlanTaskReadiness(plan, "T2").ready).toBe(false);
  expect(teamPlanTaskReadiness(plan, "T3")).toEqual({ ready: false, reason: "unassigned-model" });
  plan = patch(plan, [
    {
      type: "bind_execution",
      taskId: "T1",
      revision: 1,
      execution: {
        subagentId: NodeId.make("actual-task"),
        threadId: ThreadId.make("actual-child"),
        runId: null,
      },
    },
  ]);
  expect(plan.tasks.find((task) => task.taskId === "T1")?.acceptance.status).toBe("pending");
  expect(teamPlanTaskReadiness(plan, "T1").ready).toBe(false);
  plan = patch(plan, [
    {
      type: "accept_task",
      taskId: "T1",
      revision: 1,
      status: "accepted",
      note: "Independent review passed",
    },
  ]);
  expect(teamPlanTaskReadiness(plan, "T2")).toEqual({ ready: true, reason: null });
});

it("preserves old execution and acceptance when scope changes to a new revision", () => {
  let plan = patch(initial(), [
    { type: "add_task", task: draft("T1") },
    { type: "add_task", task: draft("T2", [{ taskId: "T1", revision: 1 }]) },
  ]);
  plan = patch(plan, [{ type: "confirm_plan", revision: plan.revision }]);
  const execution = {
    subagentId: NodeId.make("actual-task"),
    threadId: ThreadId.make("actual-child"),
    runId: null,
  };
  plan = patch(plan, [
    { type: "bind_execution", taskId: "T1", revision: 1, execution },
    {
      type: "accept_task",
      taskId: "T1",
      revision: 1,
      status: "accepted",
      note: "Evidence reviewed",
    },
  ]);
  const before = plan;
  plan = patch(plan, [{ type: "edit_task", taskId: "T1", changes: { prompt: "New scope" } }]);
  const task = plan.tasks.find((task) => task.taskId === "T1")!;
  expect(task.revision).toBe(2);
  expect(task.confirmedRevision).toBe(null);
  expect(task.executions).toEqual([]);
  expect(task.acceptance.status).toBe("pending");
  expect(task.history[0]).toMatchObject({
    revision: 1,
    executions: [execution],
    acceptance: { status: "accepted", note: "Evidence reviewed" },
  });
  expect(before.tasks[0]?.revision).toBe(1);
  expect(teamPlanTaskReadiness(plan, "T2")).toEqual({ ready: true, reason: null });
});

it("reprioritizes without revising or redispatching and derives stable revision command IDs", () => {
  let plan = patch(initial(), [
    { type: "add_task", task: draft("T1") },
    { type: "add_task", task: draft("T2") },
  ]);
  plan = patch(plan, [
    { type: "confirm_plan", revision: plan.revision },
    {
      type: "bind_execution",
      taskId: "T1",
      revision: 1,
      execution: {
        subagentId: NodeId.make("actual-task"),
        threadId: ThreadId.make("actual-child"),
        runId: null,
      },
    },
  ]);
  const original = plan.tasks.find((task) => task.taskId === "T1")!;
  const confirmedPlanRevision = plan.revision;
  const previousVersion = plan.version;
  plan = patch(plan, [{ type: "reprioritize", taskId: "T1", priority: -10 }]);
  expect(plan.revision).toBe(confirmedPlanRevision);
  expect(plan.confirmedRevision).toBe(confirmedPlanRevision);
  expect(plan.version).toBe(previousVersion + 1);
  expect(plan.tasks.find((task) => task.taskId === "T1")).toMatchObject({
    revision: 1,
    executions: original.executions,
    confirmedRevision: 1,
    priority: -10,
  });
  expect(teamPlanTaskReadiness(plan, "T2")).toEqual({ ready: true, reason: null });
  expect(teamPlanTaskCommandId(threadId, { taskId: "T1", revision: 1 })).toBe(
    teamPlanTaskCommandId(threadId, { taskId: "T1", revision: 1 }),
  );
  expect(teamPlanTaskCommandId(threadId, { taskId: "T1", revision: 2 })).not.toBe(
    teamPlanTaskCommandId(threadId, { taskId: "T1", revision: 1 }),
  );
});

it("records late execution and independent verdict on the pinned historical revision only", () => {
  let plan = patch(initial(), [{ type: "add_task", task: draft("T1") }]);
  plan = patch(plan, [{ type: "confirm_task", taskId: "T1", revision: 1 }]);
  plan = patch(plan, [
    {
      type: "edit_task",
      taskId: "T1",
      changes: { prompt: "Revised approved scope requires new confirmation" },
    },
  ]);
  const execution = {
    subagentId: NodeId.make("actual-old-task"),
    threadId: ThreadId.make("actual-old-child"),
    runId: RunId.make("actual-old-run"),
  };
  plan = patch(plan, [
    { type: "bind_execution", taskId: "T1", revision: 1, execution },
    {
      type: "accept_task",
      taskId: "T1",
      revision: 1,
      status: "accepted",
      note: "Coordinator reviewed the completed child evidence",
      actor: "coordinator",
      reviewerThreadId: ThreadId.make("independent-reviewer"),
    },
  ]);
  expect(plan.tasks[0]).toMatchObject({
    revision: 2,
    confirmedRevision: null,
    executions: [],
    acceptance: { status: "pending" },
  });
  expect(plan.tasks[0]?.history[0]).toMatchObject({
    revision: 1,
    executions: [execution],
    acceptance: {
      status: "accepted",
      actor: "coordinator",
      reviewerThreadId: "independent-reviewer",
    },
  });
});

it("refuses stale confirmation, unconfirmed acceptance and accepted verdicts without evidence", () => {
  let plan = patch(initial(), [{ type: "add_task", task: draft("T1") }]);
  const apply = (operation: TeamPlanOperation) =>
    applyTeamPlanPatch(
      plan,
      { expectedPlanVersion: plan.version, operations: [operation] },
      { threadId, now },
    );
  expect(apply({ type: "confirm_plan", revision: plan.revision + 1 })).toMatchObject({
    ok: false,
    error: { code: "stale-revision" },
  });
  expect(
    apply({
      type: "accept_task",
      taskId: "T1",
      revision: 1,
      status: "accepted",
      note: "Not authorized yet",
    }),
  ).toMatchObject({ ok: false, error: { code: "unconfirmed-task" } });
  plan = patch(plan, [{ type: "confirm_task", taskId: "T1", revision: 1 }]);
  expect(
    apply({ type: "accept_task", taskId: "T1", revision: 1, status: "accepted", note: " " }),
  ).toMatchObject({ ok: false, error: { code: "invalid-operation" } });
  expect(plan.tasks[0]?.acceptance.status).toBe("pending");
});

it("binds one real reference idempotently and refuses conflicting child identities", () => {
  let plan = patch(initial(), [{ type: "add_task", task: draft("T1") }]);
  plan = patch(plan, [{ type: "confirm_task", taskId: "T1", revision: 1 }]);
  const execution = {
    subagentId: NodeId.make("actual-task"),
    threadId: ThreadId.make("actual-child"),
    runId: null,
  };
  plan = patch(plan, [
    { type: "bind_execution", taskId: "T1", revision: 1, execution },
    {
      type: "bind_execution",
      taskId: "T1",
      revision: 1,
      execution: { ...execution, runId: RunId.make("actual-run") },
    },
    { type: "bind_execution", taskId: "T1", revision: 1, execution },
  ]);
  expect(plan.tasks[0]?.executions).toEqual([{ ...execution, runId: "actual-run" }]);
  expect(
    applyTeamPlanPatch(
      plan,
      {
        expectedPlanVersion: plan.version,
        operations: [
          {
            type: "bind_execution",
            taskId: "T1",
            revision: 1,
            execution: { ...execution, threadId: ThreadId.make("other-child") },
          },
        ],
      },
      { threadId, now },
    ),
  ).toMatchObject({ ok: false, error: { code: "execution-conflict" } });
  expect(plan.tasks[0]?.executions).toHaveLength(1);
  expect(
    teamPlanTaskCommandId(ThreadId.make("other-owner"), { taskId: "T1", revision: 1 }),
  ).not.toBe(teamPlanTaskCommandId(threadId, { taskId: "T1", revision: 1 }));
});

it("a dependency edit creates a new confirmation gate and waits for the exact new prerequisite", () => {
  let plan = patch(initial(), [
    { type: "add_task", task: draft("T1") },
    { type: "add_task", task: draft("T2", [{ taskId: "T1", revision: 1 }]) },
  ]);
  plan = patch(plan, [{ type: "confirm_plan", revision: plan.revision }]);
  plan = patch(plan, [
    {
      type: "accept_task",
      taskId: "T1",
      revision: 1,
      status: "accepted",
      note: "User accepted evidence",
    },
    { type: "edit_task", taskId: "T1", changes: { prompt: "New prerequisite scope" } },
    { type: "set_dependencies", taskId: "T2", dependencies: [{ taskId: "T1", revision: 2 }] },
  ]);
  expect(plan.tasks.find((task) => task.taskId === "T2")).toMatchObject({
    revision: 2,
    confirmedRevision: null,
  });
  plan = patch(plan, [{ type: "confirm_plan", revision: plan.revision }]);
  expect(teamPlanTaskReadiness(plan, "T2").ready).toBe(false);
  plan = patch(plan, [
    {
      type: "accept_task",
      taskId: "T1",
      revision: 2,
      status: "accepted",
      note: "New revision evidence reviewed",
    },
  ]);
  expect(teamPlanTaskReadiness(plan, "T2")).toEqual({ ready: true, reason: null });
});

it("requires fresh confirmation of undispatched work after the goal changes", () => {
  let plan = patch(
    initial(),
    ["pending", "issues", "blocked", "accepted", "running"].map((taskId) => ({
      type: "add_task" as const,
      task: draft(taskId),
    })),
  );
  plan = patch(plan, [{ type: "confirm_plan", revision: plan.revision }]);
  plan = patch(plan, [
    {
      type: "accept_task",
      taskId: "issues",
      revision: 1,
      status: "issues",
      note: "Review found issues",
    },
    {
      type: "accept_task",
      taskId: "blocked",
      revision: 1,
      status: "blocked",
      note: "Awaiting input",
    },
    {
      type: "accept_task",
      taskId: "accepted",
      revision: 1,
      status: "accepted",
      note: "User reviewed evidence",
    },
    {
      type: "bind_execution",
      taskId: "running",
      revision: 1,
      execution: {
        subagentId: NodeId.make("running-agent"),
        threadId: ThreadId.make("running-child"),
        runId: null,
      },
    },
  ]);
  const before = plan;
  const unchanged = patch(plan, [{ type: "set_goal", goal: plan.goal }]);
  expect(unchanged.tasks.find((task) => task.taskId === "pending")?.confirmedRevision).toBe(1);
  expect(unchanged.revision).toBe(plan.revision);
  expect(unchanged.confirmedRevision).toBe(plan.confirmedRevision);
  plan = patch(plan, [{ type: "set_goal", goal: "A materially different outcome" }]);
  expect(plan.confirmedRevision).toBe(null);
  for (const taskId of ["pending", "issues", "blocked"]) {
    expect(plan.tasks.find((task) => task.taskId === taskId)?.confirmedRevision).toBe(null);
    expect(teamPlanTaskReadiness(plan, taskId)).toEqual({
      ready: false,
      reason: "unconfirmed-task",
    });
  }
  expect(plan.tasks.find((task) => task.taskId === "accepted")?.acceptance).toEqual(
    before.tasks.find((task) => task.taskId === "accepted")?.acceptance,
  );
  expect(plan.tasks.find((task) => task.taskId === "running")).toEqual(
    before.tasks.find((task) => task.taskId === "running"),
  );
  expect(before.tasks.find((task) => task.taskId === "pending")?.confirmedRevision).toBe(1);
  plan = patch(plan, [{ type: "confirm_task", taskId: "pending", revision: 1 }]);
  expect(teamPlanTaskReadiness(plan, "pending")).toEqual({ ready: true, reason: null });
});

it("rejects inconsistent confirmation metadata and accepted verdicts without evidence", () => {
  const plan = patch(initial(), [{ type: "add_task", task: draft("T1") }]);
  const task = plan.tasks[0]!;
  for (const invalid of [
    { ...plan, confirmedRevision: plan.revision + 1 },
    { ...plan, tasks: [{ ...task, confirmedRevision: task.revision + 1 }] },
    {
      ...plan,
      tasks: [
        {
          ...task,
          confirmedRevision: 1,
          acceptance: { status: "accepted" as const, note: " ", updatedAt: now },
        },
      ],
    },
    {
      ...plan,
      tasks: [
        {
          ...task,
          acceptance: {
            status: "accepted" as const,
            note: "Evidence alone cannot replace confirmation",
            updatedAt: now,
          },
        },
      ],
    },
    { ...plan, tasks: [{ ...task, modelSelection: { ...selection, model: " " } }] },
  ]) {
    expect(validateTeamPlan(invalid)).toEqual({ code: "invalid-operation" });
    expect(
      applyTeamPlanPatch(
        invalid,
        {
          expectedPlanVersion: invalid.version,
          operations: [{ type: "reprioritize", taskId: "T1", priority: 0 }],
        },
        { threadId, now },
      ),
    ).toMatchObject({ ok: false, error: { code: "invalid-operation" } });
  }
});

it("records draft blockers without authorizing work or accepting unconfirmed evidence", () => {
  let plan = patch(initial(), [{ type: "add_task", task: draft("T1") }]);
  for (const status of ["blocked", "issues", "pending"] as const) {
    plan = patch(plan, [
      { type: "accept_task", taskId: "T1", revision: 1, status, note: "Model access needs review" },
    ]);
    expect(plan.tasks[0]?.acceptance.status).toBe(status);
    expect(teamPlanTaskReadiness(plan, "T1")).toEqual({ ready: false, reason: "unconfirmed-task" });
  }
  expect(
    applyTeamPlanPatch(
      plan,
      {
        expectedPlanVersion: plan.version,
        operations: [
          {
            type: "accept_task",
            taskId: "T1",
            revision: 1,
            status: "accepted",
            note: "Cannot bypass confirmation",
          },
        ],
      },
      { threadId, now },
    ),
  ).toMatchObject({ ok: false, error: { code: "unconfirmed-task" } });
});

it("keeps an accepted verdict tied to its execution while allowing idempotent reference enrichment", () => {
  let plan = patch(initial(), [{ type: "add_task", task: draft("T1") }]);
  const execution = {
    subagentId: NodeId.make("actual-task"),
    threadId: ThreadId.make("actual-child"),
    runId: null,
  };
  plan = patch(plan, [
    { type: "confirm_task", taskId: "T1", revision: 1 },
    { type: "bind_execution", taskId: "T1", revision: 1, execution },
    {
      type: "accept_task",
      taskId: "T1",
      revision: 1,
      status: "accepted",
      note: "Evidence for this execution reviewed",
      actor: "coordinator",
      reviewerThreadId: threadId,
    },
  ]);
  const acceptance = plan.tasks[0]?.acceptance;
  plan = patch(plan, [
    {
      type: "bind_execution",
      taskId: "T1",
      revision: 1,
      execution: { ...execution, runId: RunId.make("actual-run") },
    },
  ]);
  expect(plan.tasks[0]?.acceptance).toEqual(acceptance);
  expect(
    applyTeamPlanPatch(
      plan,
      {
        expectedPlanVersion: plan.version,
        operations: [
          {
            type: "bind_execution",
            taskId: "T1",
            revision: 1,
            execution: {
              ...execution,
              subagentId: NodeId.make("unreviewed-task"),
              threadId: ThreadId.make("unreviewed-child"),
            },
          },
        ],
      },
      { threadId, now },
    ),
  ).toMatchObject({ ok: false, error: { code: "execution-conflict" } });
  expect(plan.tasks[0]?.executions).toHaveLength(1);
});

it("requires an explicit new revision and confirmation for retry and preserves the prior attempt", () => {
  let plan = patch(initial(), [{ type: "add_task", task: draft("T1") }]);
  const execution = {
    subagentId: NodeId.make("failed-task"),
    threadId: ThreadId.make("failed-child"),
    runId: RunId.make("failed-run"),
  };
  plan = patch(plan, [
    { type: "confirm_task", taskId: "T1", revision: 1 },
    { type: "bind_execution", taskId: "T1", revision: 1, execution },
    {
      type: "accept_task",
      taskId: "T1",
      revision: 1,
      status: "issues",
      note: "Provider failed; user can explicitly retry",
    },
  ]);
  expect(teamPlanTaskReadiness(plan, "T1").ready).toBe(false);
  const previousVersion = plan.version;
  const retry = {
    type: "edit_task" as const,
    taskId: "T1",
    changes: { prompt: plan.tasks[0]!.prompt },
  };
  const before = plan;
  plan = patch(plan, [retry]);
  expect(plan.tasks[0]).toMatchObject({
    taskId: "T1",
    revision: 2,
    confirmedRevision: null,
    executions: [],
    acceptance: { status: "pending" },
    history: [{ revision: 1, executions: [execution], acceptance: { status: "issues" } }],
  });
  expect(teamPlanTaskReadiness(plan, "T1")).toEqual({ ready: false, reason: "unconfirmed-task" });
  expect(
    applyTeamPlanPatch(
      plan,
      { expectedPlanVersion: previousVersion, operations: [retry] },
      { threadId, now },
    ),
  ).toMatchObject({ ok: false, error: { code: "version-conflict" } });
  expect(before.tasks[0]?.revision).toBe(1);
  plan = patch(plan, [{ type: "confirm_task", taskId: "T1", revision: 2 }]);
  expect(teamPlanTaskReadiness(plan, "T1")).toEqual({ ready: true, reason: null });
  expect(teamPlanTaskCommandId(threadId, { taskId: "T1", revision: 2 })).not.toBe(
    teamPlanTaskCommandId(threadId, { taskId: "T1", revision: 1 }),
  );
});

it("validates acceptance and confirmation on pinned history as well as the current scope", () => {
  let plan = patch(initial(), [{ type: "add_task", task: draft("T1") }]);
  plan = patch(plan, [
    { type: "confirm_task", taskId: "T1", revision: 1 },
    {
      type: "accept_task",
      taskId: "T1",
      revision: 1,
      status: "accepted",
      note: "Reviewed prior scope",
      actor: "user",
    },
    { type: "edit_task", taskId: "T1", changes: { prompt: "Next scope" } },
  ]);
  const task = plan.tasks[0]!;
  const historical = task.history[0]!;
  expect(validateTeamPlan(plan)).toBe(null);
  for (const invalidHistory of [
    { ...historical, confirmedRevision: 2 },
    { ...historical, acceptance: { ...historical.acceptance, note: " " } },
  ]) {
    expect(validateTeamPlan({ ...plan, tasks: [{ ...task, history: [invalidHistory] }] })).toEqual({
      code: "invalid-operation",
    });
  }
  expect(task.history[0]?.acceptance).toMatchObject({
    actor: "user",
    status: "accepted",
    note: "Reviewed prior scope",
  });
});
