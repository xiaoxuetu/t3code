import { useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  AuthOrchestrationOperateScope,
  CommandId,
  type EnvironmentId,
  type OrchestrationV2ThreadProjection,
  type TeamPlanPatch,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import workflowText from "../../../../../integrations/pstack/t3-team.md?raw";

import { newMessageId, randomUUID } from "../../lib/utils";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useEnvironment } from "../../state/environments";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import type { TaskPlanPanelControls } from "./TaskPlanPanel";
import { taskPlanCoordinatorPatch } from "./TaskPlanPanel.logic";
import { buildTeamCoordinatorPrompt } from "./teamCoordinatorPrompt";

/** Plan writes and coordinator turns use the existing authenticated T3 command paths. */
export function useTeamPlanControls(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projection: OrchestrationV2ThreadProjection | null;
}): TaskPlanPanelControls {
  const { environmentId, threadId, projection } = input;
  const navigate = useNavigate();
  const environment = useEnvironment(environmentId);
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const dispatch = useAtomCommand(orchestrationEnvironment.v2.dispatchCommand, {
    reportFailure: false,
  });
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const pendingPatches = useRef(new Map<string, CommandId>());
  const requestingTurn = useRef(false);
  const canEdit =
    canOperate && environment?.connection.phase === "connected" && projection !== null;
  const plan = projection?.teamPlan ?? null;

  const onPatch = async (patch: TeamPlanPatch) => {
    if (!canEdit)
      return {
        ok: false as const,
        message: "Connect with permission to operate this conversation before editing its plan.",
      };
    const key = JSON.stringify([environmentId, threadId, patch]);
    const commandId = pendingPatches.current.get(key) ?? CommandId.make(randomUUID());
    // Keep an uncertain request's identity for an explicit retry; a CAS rejects stale edits.
    pendingPatches.current.set(key, commandId);
    const result = await dispatch({
      environmentId,
      input: {
        type: "thread.team-plan.patch",
        commandId,
        threadId,
        createdBy: "user",
        creationSource: "web",
        ...patch,
      },
    });
    if (result._tag === "Success") {
      pendingPatches.current.delete(key);
      return { ok: true as const };
    }
    const error = squashAtomCommandFailure(result);
    return {
      ok: false as const,
      message:
        error instanceof Error
          ? error.message
          : "Could not save the team plan. Check the conversation before retrying.",
    };
  };
  const coordinatorSelection = () => {
    if (!canEdit || projection === null)
      throw new Error("Connect to this conversation before requesting its coordinator.");
    if (
      requestingTurn.current ||
      projection.runs.some((run) =>
        ["preparing", "queued", "starting", "running", "waiting"].includes(run.status),
      )
    )
      throw new Error(
        "The coordinator already has active work. Follow its conversation or wait for its current turn.",
      );
    const modelSelection = projection.thread.modelSelection;
    if (modelSelection === null || !modelSelection.model.trim())
      throw new Error(
        "Choose an available coordinator provider and model before starting team planning.",
      );
    return modelSelection;
  };
  const requestCoordinator = async (phase: "prepare" | "continue", goal: string) => {
    const modelSelection = coordinatorSelection();
    if (projection === null) throw new Error("Conversation details are unavailable.");
    requestingTurn.current = true;
    try {
      const result = await startTurn({
        environmentId,
        input: {
          threadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            attachments: [],
            text: buildTeamCoordinatorPrompt({
              phase,
              goal,
              workflowText,
              ...(plan === null ? {} : { planVersion: plan.version }),
            }),
          },
          modelSelection,
          runtimeMode: projection.thread.runtimeMode,
          interactionMode: projection.thread.interactionMode,
          dispatchMode: "queue",
        },
      });
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result);
        throw new Error(
          error instanceof Error
            ? error.message
            : "Could not request the coordinator. Check the conversation before retrying.",
        );
      }
    } finally {
      requestingTurn.current = false;
    }
  };
  return {
    canEdit,
    canOpenExecution: environment?.connection.phase === "connected",
    onPatch,
    onPrepare: async (goal) => {
      const request = taskPlanCoordinatorPatch(plan, { phase: "prepare", goal });
      if (!request.ok) throw new Error(request.message);
      coordinatorSelection();
      if (request.patch !== null) {
        const result = await onPatch(request.patch);
        if (!result.ok) throw new Error(result.message);
      }
      await requestCoordinator("prepare", request.goal);
    },
    onContinue: async () => {
      coordinatorSelection();
      const request = taskPlanCoordinatorPatch(plan, { phase: "continue" });
      if (!request.ok) throw new Error(request.message);
      if (request.patch !== null) {
        const result = await onPatch(request.patch);
        if (!result.ok) throw new Error(result.message);
      }
      await requestCoordinator("continue", request.goal);
    },
    onOpenExecution: (execution) => {
      if (environment?.connection.phase !== "connected") return;
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(environmentId, execution.threadId)),
      });
    },
  };
}
