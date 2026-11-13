import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as DueHint from "../scheduling/DueHint.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { teamPlanReportCommand } from "./TeamPlanReport.ts";

export class TeamPlanReportService extends Context.Service<
  TeamPlanReportService,
  {
    readonly sweep: () => Effect.Effect<void, ProjectionStore.ProjectionStoreV2Error>;
  }
>()("t3/orchestration-v2/TeamPlanReportService") {}

const affectsReportSchedule = (event: OrchestrationV2DomainEvent) =>
  event.type === "team-plan.updated" || event.type.startsWith("thread.");

/** One existing scheduler source. A tick can only submit a passive snapshot command. */
export const layer = Layer.effect(
  TeamPlanReportService,
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const scheduler = yield* Scheduler.Scheduler;
    const due = DueHint.make();
    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
        affectsReportSchedule(event) ? due.invalidate : Effect.void,
      ),
    );
    const sweep = Effect.fn("TeamPlanReportService.sweep")(function* () {
      const now = yield* DateTime.now;
      const nowMs = DateTime.toEpochMillis(now);
      if (yield* due.isIdle(nowMs)) return;
      const readVersion = yield* due.version;
      const candidates = yield* projections.getTeamPlanReportCandidates();
      let nextAt = Infinity;
      let acted = false;
      for (const candidate of candidates) {
        const dueAt = Date.parse(candidate.dueAt);
        if (!Number.isFinite(dueAt)) continue;
        if (dueAt > nowMs) {
          nextAt = Math.min(nextAt, dueAt);
          continue;
        }
        acted = true;
        // The command rechecks owner, generation, enabled and dueAt under the parent lock.
        // Its receipt identity survives sessions and restarts; no provider request is made here.
        yield* orchestrator.dispatch(teamPlanReportCommand(candidate)).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("orchestration-v2.team-plan-report.dispatch-failed", {
              threadId: candidate.threadId,
              cause,
            }),
          ),
        );
      }
      // Re-read after work, including an uncertain outcome. Never synthesize a replacement dueAt.
      if (!acted) yield* due.record(readVersion, nextAt, nowMs);
    });
    yield* scheduler.register("team-plan-reports", sweep());
    return TeamPlanReportService.of({ sweep });
  }),
);
