import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type TeamPlan,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const database = SqlitePersistence.layerMemory;
const layerTest = ProjectionStore.layer.pipe(Layer.provideMerge(database));

function threadCreated(threadId: ThreadId, now: DateTime.Utc) {
  const thread: OrchestrationV2AppThread = {
    id: threadId,
    projectId: ProjectId.make("project:team-plan"),
    title: "Team plan fixture",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "fixture-model" },
    runtimeMode: "full-access",
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
    lastVisitedAt: null,
    deletedAt: null,
  };
  return {
    id: EventId.make(`event:${threadId}:created`),
    type: "thread.created",
    threadId,
    occurredAt: now,
    payload: thread,
  } satisfies OrchestrationV2DomainEvent;
}

function planUpdated(threadId: ThreadId, now: DateTime.Utc, version = 1) {
  const timestamp = DateTime.formatIso(now);
  const plan: TeamPlan = {
    threadId,
    version,
    revision: 1,
    goal: "Review the fixture without starting an executor",
    confirmedRevision: null,
    tasks: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  return {
    id: EventId.make(`event:${threadId}:plan:${version}`),
    type: "team-plan.updated",
    threadId,
    occurredAt: now,
    payload: { threadId, plan },
  } satisfies OrchestrationV2DomainEvent;
}

it.effect("keeps the team plan outside a bounded history window and filtered control reads", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:team-plan:history");
    const now = yield* DateTime.now;
    yield* store.apply(threadCreated(threadId, now));
    assert.isNull(yield* store.getTeamPlan(threadId));
    assert.isNull(
      (yield* store.getThreadSnapshotWindow(threadId, { rowLimit: 0 })).projection.teamPlan,
    );
    const event = planUpdated(threadId, now);
    yield* store.apply(event);
    for (let ordinal = 1; ordinal <= 30; ordinal++) {
      yield* store.apply({
        id: EventId.make(`event:${threadId}:item:${ordinal}`),
        type: "turn-item.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: TurnItemId.make(`item:${threadId}:${ordinal}`),
          threadId,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal,
          type: "user_message",
          status: "completed",
          title: null,
          messageId: MessageId.make(`message:${threadId}:${ordinal}`),
          createdBy: "user",
          creationSource: "web",
          inputIntent: "turn_start",
          text: `Synthetic turn ${ordinal}`,
          attachments: [],
          startedAt: now,
          completedAt: now,
          updatedAt: now,
        },
      });
    }
    const full = yield* store.getThreadSnapshot(threadId);
    const window = yield* store.getThreadSnapshotWindow(threadId, { rowLimit: 0 });
    assert.equal(full.projection.turnItems.length, 30);
    assert.isBelow(window.projection.turnItems.length, 30);
    assert.deepEqual(window.projection.teamPlan, event.payload.plan);
    assert.deepEqual(full.projection.teamPlan, event.payload.plan);
    const control = yield* store.getThreadRecords(threadId, ["teamPlan"]);
    assert.deepEqual(control.teamPlan, event.payload.plan);
    assert.deepEqual(Object.keys(control).sort(), ["teamPlan", "thread"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("reconstructs a store from the persisted plan row and replaces its current version", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const threadId = ThreadId.make("thread:team-plan:reconstructed");
    const now = yield* DateTime.now;
    yield* store.apply(threadCreated(threadId, now));
    yield* store.apply(planUpdated(threadId, now));
    const event = planUpdated(threadId, now, 2);
    yield* store.apply(event);
    yield* store.apply(event);
    const conflicting = {
      ...event,
      payload: {
        ...event.payload,
        plan: { ...event.payload.plan, goal: "Concurrent replacement" },
      },
    };
    assert.equal(
      (yield* store.apply(conflicting).pipe(Effect.flip))._tag,
      "ProjectionStoreApplyEventError",
    );
    assert.equal(
      (yield* store.apply(planUpdated(threadId, now, 4)).pipe(Effect.flip))._tag,
      "ProjectionStoreApplyEventError",
    );
    yield* Effect.gen(function* () {
      const reconstructed = yield* ProjectionStore.ProjectionStoreV2;
      assert.deepEqual(yield* reconstructed.getTeamPlan(threadId), event.payload.plan);
    }).pipe(Effect.provide(ProjectionStore.layer));
    const rows = yield* sql<{ version: number; count: number }>`
      SELECT version, COUNT(*) AS count FROM orchestration_v2_projection_team_plans
      WHERE thread_id = ${threadId}
    `;
    assert.deepEqual(rows, [{ version: 2, count: 1 }]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("rejects cross-thread plan events and clears the owned plan on thread deletion", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const threadId = ThreadId.make("thread:team-plan:delete");
    const now = yield* DateTime.now;
    const created = threadCreated(threadId, now);
    yield* store.apply(created);
    const event = planUpdated(threadId, now);
    yield* store.apply(event);
    const rejected = yield* store
      .apply({
        ...planUpdated(ThreadId.make("thread:another-owner"), now),
        threadId,
      })
      .pipe(Effect.flip);
    assert.equal(rejected._tag, "ProjectionStoreApplyEventError");
    assert.deepEqual(yield* store.getTeamPlan(threadId), event.payload.plan);
    yield* store.apply({
      ...created,
      id: EventId.make(`event:${threadId}:deleted`),
      type: "thread.deleted",
      payload: { ...created.payload, deletedAt: now },
    });
    assert.isNull(yield* store.getTeamPlan(threadId));
    assert.equal(
      (yield* store.apply(event).pipe(Effect.flip))._tag,
      "ProjectionStoreApplyEventError",
    );
    const rows =
      yield* sql`SELECT thread_id FROM orchestration_v2_projection_team_plans WHERE thread_id = ${threadId}`;
    assert.deepEqual(rows, []);
  }).pipe(Effect.provide(layerTest)),
);
