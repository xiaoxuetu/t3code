import { assert, it } from "@effect/vitest";
import {
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2AppThread,
  type TeamPlan,
  type TeamPlanReportSchedule,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const layerTest = ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));
const timestamp = "2026-11-13T12:00:00.000Z";
const schedule = {
  enabled: true,
  everyMs: 60_000,
  generation: 2,
  nextReportAt: "2026-11-13T12:01:00.000Z",
} satisfies TeamPlanReportSchedule;

function seed(name: string, reportSchedule: TeamPlanReportSchedule = schedule) {
  return Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const now = DateTime.makeUnsafe(timestamp);
    const threadId = ThreadId.make(`thread:report-query:${name}`);
    const thread: OrchestrationV2AppThread = {
      id: threadId,
      projectId: ProjectId.make("project:report-query"),
      title: "Synthetic report query fixture",
      providerInstanceId: ProviderInstanceId.make("codex"),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "synthetic-model" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdBy: "user",
      creationSource: "web",
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
    yield* store.apply({
      id: EventId.make(`event:${name}:thread`),
      type: "thread.created",
      threadId,
      occurredAt: now,
      payload: thread,
    });
    const plan: TeamPlan = {
      threadId,
      version: 1,
      revision: 1,
      goal: "Observe only synthetic saved state",
      confirmedRevision: null,
      tasks: [],
      reportSchedule,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    yield* store.apply({
      id: EventId.make(`event:${name}:plan`),
      type: "team-plan.updated",
      threadId,
      occurredAt: now,
      payload: { threadId, plan },
    });
    return threadId;
  });
}

it.effect(
  "reads persisted due and future report identities without requiring transcript records",
  () =>
    Effect.gen(function* () {
      const first = yield* seed("first");
      const overdue = yield* seed("overdue", {
        ...schedule,
        nextReportAt: "2026-11-12T12:00:00.000Z",
      });
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const expected = [
        { threadId: first, planCreatedAt: timestamp, generation: 2, dueAt: schedule.nextReportAt },
        {
          threadId: overdue,
          planCreatedAt: timestamp,
          generation: 2,
          dueAt: "2026-11-12T12:00:00.000Z",
        },
      ];
      assert.deepEqual(yield* store.getTeamPlanReportCandidates(), expected);
      // Constructing a second projection service reads the same SQLite state, not process memory.
      const reconstructed = yield* ProjectionStore.ProjectionStoreV2.pipe(
        Effect.flatMap((next) => next.getTeamPlanReportCandidates()),
        Effect.provide(ProjectionStore.layer),
      );
      assert.deepEqual(reconstructed, expected);
      assert.equal((yield* store.getTeamPlan(first))?.version, 1);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("excludes disabled, unarmed, deleted, archived and foreign-owner schedules", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const enabled = yield* seed("enabled");
    yield* seed("disabled", { ...schedule, enabled: false, nextReportAt: null });
    yield* seed("unarmed", { ...schedule, nextReportAt: null });
    const archived = yield* seed("archived");
    const deleted = yield* seed("deleted");
    const foreign = yield* seed("foreign");
    yield* sql`UPDATE orchestration_v2_projection_threads
      SET payload_json = json_set(payload_json, '$.archivedAt', ${timestamp})
      WHERE thread_id = ${archived}`;
    yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at = ${timestamp}
      WHERE thread_id = ${deleted}`;
    yield* sql`UPDATE orchestration_v2_projection_team_plans
      SET payload_json = json_set(payload_json, '$.threadId', 'thread:foreign-owner')
      WHERE thread_id = ${foreign}`;
    assert.deepEqual(yield* store.getTeamPlanReportCandidates(), [
      { threadId: enabled, planCreatedAt: timestamp, generation: 2, dueAt: schedule.nextReportAt },
    ]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("skips malformed schedule metadata without hiding another plan's report", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const healthy = yield* seed("healthy");
    for (const [index, invalid] of [
      { ...schedule, generation: 0 },
      { ...schedule, generation: 1.5 },
      { ...schedule, everyMs: 1 },
      { ...schedule, nextReportAt: "invalid-date" },
      { ...schedule, nextReportAt: null },
    ].entries()) {
      const id = yield* seed(`invalid-${index}`);
      yield* sql`UPDATE orchestration_v2_projection_team_plans
        SET payload_json = json_set(payload_json, '$.reportSchedule', json(${JSON.stringify(invalid)}))
        WHERE thread_id = ${id}`;
    }
    assert.deepEqual(yield* store.getTeamPlanReportCandidates(), [
      { threadId: healthy, planCreatedAt: timestamp, generation: 2, dueAt: schedule.nextReportAt },
    ]);
  }).pipe(Effect.provide(layerTest)),
);
