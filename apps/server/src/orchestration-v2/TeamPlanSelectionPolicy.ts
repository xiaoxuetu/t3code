import type {
  OrchestrationV2AppThread,
  OrchestrationV2ContextTransfer,
  OrchestrationV2Run,
  OrchestrationV2Subagent,
  TeamPlan,
} from "@t3tools/contracts";
import { modelSelectionsEqual } from "@t3tools/shared/model";

type SelectionPolicyResolution =
  | { readonly type: "compatible" }
  | { readonly type: "strict" }
  | {
      readonly type: "unverified";
      readonly reason:
        | "owner_mismatch"
        | "execution_mismatch"
        | "run_unverified"
        | "selection_mismatch";
    };

/** An execution binds its initial run; later child follow-ups do not inherit that binding. */
export function teamPlanSelectionPolicy(input: {
  readonly thread: Pick<OrchestrationV2AppThread, "id" | "lineage" | "forkedFrom">;
  readonly run: Pick<OrchestrationV2Run, "id" | "threadId" | "delegatedTaskId" | "modelSelection">;
  readonly contextTransfers: ReadonlyArray<
    Pick<
      OrchestrationV2ContextTransfer,
      "type" | "sourceThreadId" | "targetThreadId" | "sourcePoint" | "targetRunId"
    >
  >;
  readonly parent: {
    readonly thread: Pick<OrchestrationV2AppThread, "id">;
    readonly teamPlan?: TeamPlan | null | undefined;
    readonly subagents: ReadonlyArray<
      Pick<
        OrchestrationV2Subagent,
        | "id"
        | "threadId"
        | "runId"
        | "origin"
        | "childThreadId"
        | "modelSelection"
        | "providerInstanceId"
      >
    >;
  };
}): SelectionPolicyResolution {
  const { thread, run, parent } = input;
  if (thread.lineage.relationshipToParent !== "subagent" || parent.teamPlan == null) {
    return { type: "compatible" };
  }
  if (
    parent.thread.id !== thread.lineage.parentThreadId ||
    parent.teamPlan.threadId !== parent.thread.id ||
    run.threadId !== thread.id
  )
    return { type: "unverified", reason: "owner_mismatch" };
  const candidates = parent.teamPlan.tasks.flatMap((task) =>
    [task, ...task.history].flatMap((revision) =>
      revision.executions
        .filter(
          (execution) =>
            execution.threadId === thread.id || execution.subagentId === run.delegatedTaskId,
        )
        .map((execution) => ({ revision, execution })),
    ),
  );
  if (candidates.length === 0) return { type: "compatible" };
  const matchedSubagents = new Set<string>();
  for (const { revision, execution } of candidates) {
    if (execution.runId !== null && execution.runId !== run.id) {
      if (run.delegatedTaskId === execution.subagentId) {
        return { type: "unverified", reason: "run_unverified" };
      }
      continue;
    }
    const subagent = parent.subagents.find((candidate) => candidate.id === execution.subagentId);
    if (
      subagent === undefined ||
      subagent.origin !== "app_owned" ||
      subagent.threadId !== parent.thread.id ||
      subagent.childThreadId !== thread.id ||
      execution.threadId !== thread.id
    )
      return { type: "unverified", reason: "execution_mismatch" };

    if (execution.runId === null) {
      const spawnRuns = new Set(
        thread.forkedFrom?.type === "node" && thread.forkedFrom.nodeId === subagent.id
          ? input.contextTransfers
              .filter(
                (transfer) =>
                  transfer.type === "subagent_spawn" &&
                  transfer.sourceThreadId === parent.thread.id &&
                  transfer.targetThreadId === thread.id &&
                  transfer.sourcePoint.threadId === parent.thread.id &&
                  transfer.sourcePoint.runId === subagent.runId &&
                  transfer.targetRunId !== null,
              )
              .map((transfer) => transfer.targetRunId!)
          : [],
      );
      if (spawnRuns.size > 1) return { type: "unverified", reason: "run_unverified" };
      const originalRun = spawnRuns.values().next().value;
      if (originalRun !== undefined && originalRun !== run.id) {
        if (run.delegatedTaskId === execution.subagentId) {
          return { type: "unverified", reason: "run_unverified" };
        }
        continue;
      }
      if (run.delegatedTaskId !== subagent.id && originalRun === undefined) {
        return { type: "unverified", reason: "run_unverified" };
      }
    }
    if (run.delegatedTaskId !== undefined && run.delegatedTaskId !== subagent.id) {
      return { type: "unverified", reason: "execution_mismatch" };
    }
    if (
      subagent.providerInstanceId !== run.modelSelection.instanceId ||
      (revision.modelSelection !== null &&
        !modelSelectionsEqual(revision.modelSelection, run.modelSelection)) ||
      (subagent.modelSelection !== undefined &&
        !modelSelectionsEqual(subagent.modelSelection, run.modelSelection))
    )
      return { type: "unverified", reason: "selection_mismatch" };
    matchedSubagents.add(subagent.id);
  }
  if (matchedSubagents.size > 1) return { type: "unverified", reason: "execution_mismatch" };
  return { type: matchedSubagents.size === 1 ? "strict" : "compatible" };
}
