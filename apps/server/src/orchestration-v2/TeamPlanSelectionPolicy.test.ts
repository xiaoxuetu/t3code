import { describe, expect, it } from "vite-plus/test";
import { NodeId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";

import { teamPlanSelectionPolicy } from "./TeamPlanSelectionPolicy.ts";

type Input = Parameters<typeof teamPlanSelectionPolicy>[0];

function fixture(): Input {
  const parentId = ThreadId.make("owner");
  const childId = ThreadId.make("employee");
  const subagentId = NodeId.make("delegated-task");
  const runId = RunId.make("initial-run");
  const instanceId = ProviderInstanceId.make("local-acp");
  const modelSelection = {
    instanceId,
    model: "available-model",
    options: [{ id: "effort", value: "high" }],
  };
  const timestamp = "2026-11-13T00:00:00.000Z";
  return {
    thread: {
      id: childId,
      lineage: {
        parentThreadId: parentId,
        rootThreadId: parentId,
        relationshipToParent: "subagent",
      },
      forkedFrom: { type: "node", nodeId: subagentId },
    },
    run: { id: runId, threadId: childId, delegatedTaskId: subagentId, modelSelection },
    contextTransfers: [],
    parent: {
      thread: { id: parentId },
      subagents: [
        {
          id: subagentId,
          threadId: parentId,
          runId: RunId.make("owner-run"),
          origin: "app_owned",
          childThreadId: childId,
          modelSelection,
          providerInstanceId: instanceId,
        },
      ],
      teamPlan: {
        threadId: parentId,
        version: 1,
        revision: 1,
        goal: "A confirmed task",
        confirmedRevision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        tasks: [
          {
            taskId: "task",
            title: "Task",
            prompt: "Complete the task",
            role: "implementer",
            modelSelection,
            dependencies: [],
            revision: 1,
            confirmedRevision: 1,
            acceptance: { status: "pending", note: "", updatedAt: timestamp },
            executions: [{ subagentId, threadId: childId, runId }],
            createdAt: timestamp,
            updatedAt: timestamp,
            priority: 0,
            history: [],
          },
        ],
      },
    },
  };
}

function nullRun(input: Input): Input {
  return {
    ...input,
    parent: {
      ...input.parent,
      teamPlan: {
        ...input.parent.teamPlan!,
        tasks: input.parent.teamPlan!.tasks.map((task) => ({
          ...task,
          executions: task.executions.map((execution) => ({ ...execution, runId: null })),
        })),
      },
    },
  };
}

function withSpawn(input: Input, targetRunId = input.run.id): Input {
  return {
    ...input,
    contextTransfers: [
      {
        type: "subagent_spawn",
        sourceThreadId: input.parent.thread.id,
        targetThreadId: input.thread.id,
        sourcePoint: { threadId: input.parent.thread.id, runId: input.parent.subagents[0]!.runId! },
        targetRunId,
      },
    ],
  };
}

describe("team plan selection policy", () => {
  it("requires the exact bound initial run, preserving historical task revisions", () => {
    const input = fixture();
    expect(teamPlanSelectionPolicy(input)).toEqual({ type: "strict" });
    const task = input.parent.teamPlan!.tasks[0]!;
    const { history: _history, taskId: _taskId, priority: _priority, ...oldRevision } = task;
    const historical = {
      ...input,
      parent: {
        ...input.parent,
        teamPlan: {
          ...input.parent.teamPlan!,
          tasks: [
            { ...task, revision: 2, executions: [], modelSelection: null, history: [oldRevision] },
          ],
        },
      },
    };
    expect(teamPlanSelectionPolicy(historical)).toEqual({ type: "strict" });
    expect(
      teamPlanSelectionPolicy({
        ...input,
        run: { ...input.run, id: RunId.make("mismatched-run") },
      }),
    ).toEqual({ type: "unverified", reason: "run_unverified" });
    const { delegatedTaskId: _delegatedTaskId, ...followUp } = input.run;
    expect(
      teamPlanSelectionPolicy({ ...input, run: { ...followUp, id: RunId.make("follow-up") } }),
    ).toEqual({ type: "compatible" });
    expect(
      teamPlanSelectionPolicy({ ...input, parent: { ...input.parent, teamPlan: null } }),
    ).toEqual({ type: "compatible" });
    expect(
      teamPlanSelectionPolicy({
        ...input,
        parent: { thread: input.parent.thread, subagents: input.parent.subagents },
      }),
    ).toEqual({ type: "compatible" });
  });

  it("verifies nullable legacy run bindings with the original delegated task or spawn transfer", () => {
    const input = nullRun(fixture());
    expect(teamPlanSelectionPolicy(input)).toEqual({ type: "strict" });
    const { delegatedTaskId: _delegatedTaskId, ...run } = input.run;
    const withoutTask = { ...input, run };
    expect(teamPlanSelectionPolicy(withoutTask)).toEqual({
      type: "unverified",
      reason: "run_unverified",
    });
    expect(teamPlanSelectionPolicy(withSpawn(withoutTask))).toEqual({ type: "strict" });
    expect(
      teamPlanSelectionPolicy(withSpawn(withoutTask, RunId.make("original-other-run"))),
    ).toEqual({ type: "compatible" });
    expect(teamPlanSelectionPolicy(withSpawn(input, RunId.make("original-other-run")))).toEqual({
      type: "unverified",
      reason: "run_unverified",
    });
    const one = withSpawn(withoutTask);
    expect(
      teamPlanSelectionPolicy({
        ...one,
        contextTransfers: [
          ...one.contextTransfers,
          { ...one.contextTransfers[0]!, targetRunId: RunId.make("conflicting-spawn") },
        ],
      }),
    ).toEqual({ type: "unverified", reason: "run_unverified" });
  });

  it.each([
    [
      "unbound foreign plan owner",
      (input: Input): Input => ({
        ...input,
        parent: {
          ...input.parent,
          teamPlan: {
            ...input.parent.teamPlan!,
            threadId: ThreadId.make("other-owner"),
            tasks: [],
          },
        },
      }),
      "owner_mismatch",
    ],
    [
      "unbound foreign run owner",
      (input: Input): Input => ({
        ...input,
        run: { ...input.run, threadId: ThreadId.make("other-child") },
        parent: { ...input.parent, teamPlan: { ...input.parent.teamPlan!, tasks: [] } },
      }),
      "owner_mismatch",
    ],
    [
      "plan owner",
      (input: Input): Input => ({
        ...input,
        parent: {
          ...input.parent,
          teamPlan: {
            ...input.parent.teamPlan!,
            threadId: ThreadId.make("other-owner"),
          },
        },
      }),
      "owner_mismatch",
    ],
    [
      "provider-native employee",
      (input: Input): Input => ({
        ...input,
        parent: {
          ...input.parent,
          subagents: input.parent.subagents.map((task) => ({ ...task, origin: "provider_native" })),
        },
      }),
      "execution_mismatch",
    ],
    [
      "missing employee",
      (input: Input): Input => ({ ...input, parent: { ...input.parent, subagents: [] } }),
      "execution_mismatch",
    ],
    [
      "employee owner",
      (input: Input): Input => ({
        ...input,
        parent: {
          ...input.parent,
          subagents: input.parent.subagents.map((task) => ({
            ...task,
            threadId: ThreadId.make("other-owner"),
          })),
        },
      }),
      "execution_mismatch",
    ],
    [
      "child identity",
      (input: Input): Input => ({
        ...input,
        parent: {
          ...input.parent,
          subagents: input.parent.subagents.map((task) => ({
            ...task,
            childThreadId: ThreadId.make("other-child"),
          })),
        },
      }),
      "execution_mismatch",
    ],
    [
      "delegated task",
      (input: Input): Input => ({
        ...input,
        run: { ...input.run, delegatedTaskId: NodeId.make("other-task") },
      }),
      "execution_mismatch",
    ],
    [
      "model",
      (input: Input): Input => ({
        ...input,
        run: { ...input.run, modelSelection: { ...input.run.modelSelection, model: "different" } },
      }),
      "selection_mismatch",
    ],
    [
      "effort",
      (input: Input): Input => ({
        ...input,
        run: {
          ...input.run,
          modelSelection: {
            ...input.run.modelSelection,
            options: [{ id: "effort", value: "low" }],
          },
        },
      }),
      "selection_mismatch",
    ],
    [
      "instance",
      (input: Input): Input => ({
        ...input,
        run: {
          ...input.run,
          modelSelection: {
            ...input.run.modelSelection,
            instanceId: ProviderInstanceId.make("other-instance"),
          },
        },
      }),
      "selection_mismatch",
    ],
  ] as const)("fails closed for an unverified %s", (_name, transform, reason) => {
    expect(teamPlanSelectionPolicy(transform(fixture()))).toEqual({ type: "unverified", reason });
  });
});
