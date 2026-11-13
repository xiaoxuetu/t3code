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
