import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";
import { TeamPlanAgentOperation, TeamPlanOperation, TeamPlanTaskRef } from "./teamPlan.ts";

const isTeamPlanOperation = Schema.is(TeamPlanOperation);
const isTeamPlanAgentOperation = Schema.is(TeamPlanAgentOperation);
const isTeamPlanTaskRef = Schema.is(TeamPlanTaskRef);

it("keeps confirmation and execution binding outside agent operations", () => {
  const confirm = { type: "confirm_task", taskId: "T1", revision: 1 };
  expect(isTeamPlanOperation(confirm)).toBe(true);
  expect(isTeamPlanAgentOperation(confirm)).toBe(false);
  expect(isTeamPlanAgentOperation({ type: "confirm_plan", revision: 1 })).toBe(false);
  expect(isTeamPlanAgentOperation({ type: "bind_execution", taskId: "T1", revision: 1 })).toBe(
    false,
  );
  for (const paused of [true, false]) {
    const dispatchControl = { type: "set_dispatch_paused", paused };
    expect(isTeamPlanOperation(dispatchControl)).toBe(true);
    expect(isTeamPlanAgentOperation(dispatchControl)).toBe(false);
  }
  for (const limits of [
    { maxConcurrentTasks: null, maxTaskExecutions: null },
    { maxConcurrentTasks: 1, maxTaskExecutions: Number.MAX_SAFE_INTEGER },
  ]) {
    const dispatchControl = { type: "set_dispatch_limits", limits };
    expect(isTeamPlanOperation(dispatchControl)).toBe(true);
    expect(isTeamPlanAgentOperation(dispatchControl)).toBe(false);
  }
  for (const maxConcurrentTasks of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "2"]) {
    expect(
      isTeamPlanOperation({
        type: "set_dispatch_limits",
        limits: { maxConcurrentTasks, maxTaskExecutions: null },
      }),
    ).toBe(false);
  }
  for (const enabled of [false, true]) {
    const schedule = { type: "set_report_schedule", enabled, everyMs: 60_000 };
    expect(isTeamPlanOperation(schedule)).toBe(true);
    expect(isTeamPlanAgentOperation(schedule)).toBe(false);
  }
  for (const everyMs of [0, 59_999, Number.MAX_SAFE_INTEGER + 1, "60000"]) {
    expect(isTeamPlanOperation({ type: "set_report_schedule", enabled: true, everyMs })).toBe(
      false,
    );
  }
  expect(
    isTeamPlanAgentOperation({
      type: "accept_task",
      taskId: "T1",
      revision: 1,
      status: "accepted",
      note: "Reviewed completed child evidence",
    }),
  ).toBe(true);
});

it("requires a stable nonempty task key and positive pinned revision", () => {
  expect(isTeamPlanTaskRef({ taskId: "T1", revision: 1 })).toBe(true);
  expect(isTeamPlanTaskRef({ taskId: "", revision: 1 })).toBe(false);
  expect(isTeamPlanTaskRef({ taskId: "T1", revision: 0 })).toBe(false);
  expect(isTeamPlanTaskRef({ taskId: "T1", revision: 1.5 })).toBe(false);
});
