import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import {
  latestProviderTurnForAttempt,
  type EnvironmentId,
  type OrchestrationV2Subagent,
  type ServerProvider,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { REASONING_EFFORT_OPTION_IDS } from "@t3tools/client-runtime/state/thread-execution";
import { tickTextContent } from "../../lib/tickTextContent";
import { useQuietThreadProjection, useThreadStatus } from "../../state/entities";
import { subagentDetailPreview } from "@t3tools/client-runtime/state/subagent-display";

import { useEnvironment } from "../../state/environments";
import { buildThreadRouteParams } from "../../threadRoutes";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { ThreadRelationshipIcon } from "./ThreadRelationshipIcon";
import {
  findTeamTaskRun,
  orderTeamTasks,
  teamTaskElapsedMs,
  teamTaskPresentation,
  teamTaskSummary,
  teamTaskTarget,
} from "./TeamTaskBoard.logic";

const INITIAL_TASK_COUNT = 6;

function TaskTimestamp(props: { readonly label: string; readonly value: string | null }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{props.label}</dt>
      <dd className="m-0 truncate">
        {props.value === null ? "Not observed" : (
          <time dateTime={props.value} title={props.value}>
            {props.value.slice(0, 10)} {props.value.slice(11, 19)} UTC
          </time>
        )}
      </dd>
    </div>
  );
}

function TeamTaskRow(props: {
  readonly task: OrchestrationV2Subagent;
  readonly environmentId: EnvironmentId;
  readonly providers: ReadonlyMap<EnvironmentId, ReadonlyArray<ServerProvider>>;
  readonly observingTiming: boolean;
  readonly onObserveTiming: () => void;
}) {
  const navigate = useNavigate();
  const { task } = props;
  const target = teamTaskTarget(task, props.environmentId);
  const environment = useEnvironment(target?.environmentId ?? null);
  const connected = environment?.connection.phase === "connected";
  const timingRef = target !== null && connected && props.observingTiming
    ? scopeThreadRef(target.environmentId, target.threadId)
    : null;
  const child = useQuietThreadProjection(timingRef);
  const childStatus = useThreadStatus(timingRef);
  const matchingRun = findTeamTaskRun(task, child?.projection.runs ?? [], {
    initialTaskId: child?.projection.thread.forkedFrom?.type === "node"
      ? child.projection.thread.forkedFrom.nodeId
      : null,
    transfers: child?.projection.contextTransfers ?? [],
  });
  const createdAt = task.startedAt === null ? null : DateTime.formatIso(task.startedAt);
  const startedAt = matchingRun?.startedAt == null
    ? null
    : DateTime.formatIso(matchingRun.startedAt);
  const finishedAt = matchingRun?.completedAt == null
    ? null
    : DateTime.formatIso(matchingRun.completedAt);
  const reportedAt = task.completedAt === null ? null : DateTime.formatIso(task.completedAt);
  const active = connected && childStatus === "live" &&
    ["pending", "running", "waiting"].includes(task.status) &&
    matchingRun !== undefined &&
    ["preparing", "starting", "running", "waiting"].includes(matchingRun.status);
  const timing = { startedAt, finishedAt, active };
  const presentation = teamTaskPresentation(task);
  const selection = matchingRun?.modelSelection ?? task.modelSelection;
  const assignedModel = selection?.model ?? presentation.model;
  const assignedEffort = REASONING_EFFORT_OPTION_IDS
    .map((id) => getModelSelectionStringOptionValue(selection, id)?.trim())
    .find(Boolean);
  const reportedModel = child === null || matchingRun === undefined
    ? null
    : latestProviderTurnForAttempt(
        child.projection.providerTurns,
        matchingRun.activeAttemptId,
      )?.model ?? null;
  const providerInstanceId = matchingRun?.providerInstanceId ?? task.providerInstanceId;
  const provider = props.providers
    .get(target?.environmentId ?? props.environmentId)
    ?.find((entry) => entry.instanceId === providerInstanceId);
  const canOpen = target !== null && connected;
  const detail = subagentDetailPreview({
    status: task.status,
    result: presentation.detail,
    progress: presentation.detail,
  });
  const updatedAt = DateTime.formatIso(task.updatedAt);
  const sessionHint =
    target === null
      ? "No separate session recorded"
      : !connected
        ? `Connect to ${task.remoteChild?.label ?? "the environment"} to open the session`
        : "Open session";
  return (
    <li className="rounded-lg border border-border/65 p-2.5">
      <div className="flex items-start gap-2">
        <ThreadRelationshipIcon driver={provider?.driver ?? task.driver} provider={provider} status={task.status} />
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-sm font-medium" title={presentation.title}>
            {presentation.title}
          </p>
          <p className="mt-1 truncate text-2xs text-muted-foreground" title={providerInstanceId}>
            Executor: {provider?.displayName ?? providerInstanceId}
          </p>
          <p className="mt-1 text-2xs font-medium">{presentation.statusLabel}</p>
        </div>
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-x-2 gap-y-1 text-2xs">
        <div className="min-w-0">
          <dt className="text-muted-foreground">Assigned model</dt>
          <dd className="m-0 truncate" title={assignedModel}>{assignedModel}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-muted-foreground">Provider reported model</dt>
          <dd className="m-0 truncate" title={reportedModel ?? undefined}>
            {reportedModel ?? "Not reported"}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Assigned effort</dt>
          <dd className="m-0">{assignedEffort ?? "Not recorded"}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Provider reported effort</dt>
          <dd className="m-0">Not reported</dd>
        </div>
      </dl>
      <p className="mt-2 line-clamp-3 break-words text-xs text-muted-foreground">
        {detail}
      </p>
      <dl className="mt-2 grid grid-cols-2 gap-x-2 gap-y-1 text-2xs">
        <TaskTimestamp label="Created at dispatch" value={createdAt} />
        <TaskTimestamp label="Started" value={startedAt} />
        <div>
          <dt className="text-muted-foreground">Run elapsed · includes waits</dt>
          <dd
            className="m-0 tabular-nums"
            ref={tickTextContent((nowMs) => {
              const elapsed = teamTaskElapsedMs(timing, nowMs);
              return elapsed === null ? "Not observed" : formatDuration(elapsed);
            }, active && startedAt !== null && finishedAt === null)}
          />
        </div>
        <TaskTimestamp label="Finished (run)" value={finishedAt} />
        {reportedAt === null ? null : (
          <TaskTimestamp label="Result reported" value={reportedAt} />
        )}
      </dl>
      {matchingRun === undefined ? (
        <p className="mt-1 text-2xs text-muted-foreground">
          {props.observingTiming
            ? "Run timing and reported model are unavailable in the loaded history."
            : "Select Observe run to load this run's timestamps and reported model."}
        </p>
      ) : null}
      <div className="mt-1 flex items-center justify-between gap-2">
        <ThreadDetailsControl
          part="meta"
          variant="ghost"
          disabled={!props.observingTiming && !canOpen}
          onClick={props.onObserveTiming}
        >
          {props.observingTiming ? "Stop observing run" : "Observe run"}
        </ThreadDetailsControl>
        {props.observingTiming ? (
          <span className="text-2xs text-muted-foreground">Run details: {childStatus}</span>
        ) : null}
      </div>
      {task.status === "completed" ? (
        <p className="mt-1 text-2xs text-muted-foreground">Acceptance requires review.</p>
      ) : null}
      <div className="mt-2 flex min-w-0 items-center justify-between gap-2">
        <time className="truncate text-2xs text-muted-foreground" dateTime={updatedAt} title={updatedAt}>
          Updated {updatedAt.slice(0, 10)} {updatedAt.slice(11, 19)} UTC
        </time>
        <ThreadDetailsControl
          part="meta"
          variant="ghost"
          disabled={!canOpen}
          aria-label={`Open session for ${presentation.title}`}
          title={sessionHint}
          onClick={() => {
            if (!canOpen || target === null) return;
            void navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(scopeThreadRef(target.environmentId, target.threadId)),
            });
          }}
        >
          Open session
        </ThreadDetailsControl>
      </div>
      {!canOpen ? <p className="mt-1 text-2xs text-muted-foreground">{sessionHint}</p> : null}
    </li>
  );
}

export function TeamTaskBoard(props: {
  readonly tasks: ReadonlyArray<OrchestrationV2Subagent>;
  readonly environmentId: EnvironmentId;
  readonly providers: ReadonlyMap<EnvironmentId, ReadonlyArray<ServerProvider>>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [timingTaskId, setTimingTaskId] = useState<string | null>(null);
  const summary = teamTaskSummary(props.tasks);
  if (summary.total === 0) return null;
  const orderedTasks = orderTeamTasks(props.tasks, (task) => DateTime.toEpochMillis(task.updatedAt));
  const visibleTasks = expanded ? orderedTasks : orderedTasks.slice(0, INITIAL_TASK_COUNT);
  return (
    <ThreadDetailsSection headingId="thread-details-team-heading" title="Team tasks">
      <div className="space-y-2 px-2.5">
        <p className="text-2xs text-muted-foreground" aria-live="polite">
          {summary.active} active · {summary.completed}/{summary.total} runs completed
          {summary.failed > 0 ? ` · ${summary.failed} failed` : ""}
        </p>
        <p className="text-2xs text-muted-foreground">
          Delegations loaded in this conversation. Select one task to observe its run details.
        </p>
        <ul
          aria-label="Team tasks"
          className="m-0 max-h-[min(36rem,60dvh)] list-none space-y-2 overflow-y-auto p-0"
        >
          {visibleTasks.map((task) => (
            <TeamTaskRow
              key={task.id}
              task={task}
              environmentId={props.environmentId}
              providers={props.providers}
              observingTiming={timingTaskId === task.id}
              onObserveTiming={() => setTimingTaskId(timingTaskId === task.id ? null : task.id)}
            />
          ))}
        </ul>
        {props.tasks.length > INITIAL_TASK_COUNT ? (
          <ThreadDetailsControl variant="ghost" onClick={() => setExpanded(!expanded)}>
            {expanded ? "Show fewer tasks" : `Show all ${summary.total} tasks`}
          </ThreadDetailsControl>
        ) : null}
      </div>
    </ThreadDetailsSection>
  );
}
