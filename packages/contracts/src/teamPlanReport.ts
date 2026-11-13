import * as Schema from "effect/Schema";
import { IsoDateTime, NodeId, RunId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

const SafeNonNegativeInt = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const SafePositiveInt = SafeNonNegativeInt.check(Schema.isGreaterThan(0));
export const MIN_TEAM_PLAN_REPORT_INTERVAL_MS = 60_000;

export const TeamPlanReportSchedule = Schema.Struct({
  enabled: Schema.Boolean,
  everyMs: SafePositiveInt.check(Schema.isGreaterThanOrEqualTo(MIN_TEAM_PLAN_REPORT_INTERVAL_MS)),
  generation: SafePositiveInt,
  nextReportAt: Schema.NullOr(IsoDateTime),
});
export type TeamPlanReportSchedule = typeof TeamPlanReportSchedule.Type;

export const TeamPlanReportOccurrence = Schema.Struct({
  threadId: ThreadId,
  planCreatedAt: IsoDateTime,
  generation: SafePositiveInt,
  dueAt: IsoDateTime,
});
export type TeamPlanReportOccurrence = typeof TeamPlanReportOccurrence.Type;

export const TeamPlanLatestReport = Schema.Struct({
  planCreatedAt: IsoDateTime,
  planVersion: SafeNonNegativeInt,
  planRevision: SafePositiveInt,
  generation: SafePositiveInt,
  dueAt: IsoDateTime,
  observedAt: IsoDateTime,
  dispatchPaused: Schema.Boolean,
  tasks: Schema.Array(
    Schema.Struct({
      taskId: TrimmedNonEmptyString,
      revision: SafePositiveInt,
      current: Schema.Boolean,
      title: TrimmedNonEmptyString,
      role: TrimmedNonEmptyString,
      priority: Schema.Int,
      acceptance: Schema.Literals(["pending", "accepted", "issues", "blocked"]),
      executions: Schema.Array(
        Schema.Struct({
          subagentId: NodeId,
          threadId: ThreadId,
          runId: Schema.NullOr(RunId),
          status: Schema.Literals([
            "unknown",
            "preparing",
            "queued",
            "starting",
            "running",
            "waiting",
            "completed",
            "interrupted",
            "failed",
            "cancelled",
            "rolled_back",
          ]),
          modelSelection: Schema.NullOr(ModelSelection),
          startedAt: Schema.NullOr(IsoDateTime),
          completedAt: Schema.NullOr(IsoDateTime),
          elapsedMs: Schema.NullOr(SafeNonNegativeInt),
          unavailableReason: Schema.NullOr(
            Schema.Literals(["missing-source", "execution-not-owned", "run-unverified"]),
          ),
        }),
      ),
    }),
  ),
});
export type TeamPlanLatestReport = typeof TeamPlanLatestReport.Type;
