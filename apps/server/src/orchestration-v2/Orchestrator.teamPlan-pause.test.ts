import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2Command,
  type TeamPlanOperation,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const selection = { instanceId: ProviderInstanceId.make("codex"), model: "fixture-model" };
const adapter = {
  instanceId: selection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Pause tests never start a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const database = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  database,
  ProjectionStore.layer.pipe(Layer.provide(database)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "team-plan-pause" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  ),
);

function planPatch(
  owner: ThreadId,
  key: string,
  expectedPlanVersion: number,
  operations: readonly TeamPlanOperation[],
  createdBy: "user" | "agent" = "user",
): Extract<OrchestrationV2Command, { type: "thread.team-plan.patch" }> {
  return {
    type: "thread.team-plan.patch",
    commandId: CommandId.make(`${owner}:${key}`),
    threadId: owner,
    expectedPlanVersion,
    operations,
    createdBy,
    creationSource: createdBy === "user" ? "web" : "mcp",
  };
}

const setup = Effect.fn("TeamPlanPause.setup")(function* (
  name: string,
  taskIds: readonly string[] = ["A", "B"],
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const owner = ThreadId.make(`thread:team-plan-pause:${name}`);
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`${owner}:create`),
    threadId: owner,
    projectId: ProjectId.make("project:team-plan-pause"),
    title: "Pause fixture coordinator",
    modelSelection: selection,
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  yield* orchestrator.dispatch(
    planPatch(owner, "draft", 0, [
      { type: "set_goal", goal: "Inspect synthetic files" },
      ...taskIds.map((taskId) => ({
        type: "add_task" as const,
        task: {
          taskId,
          title: `Inspect ${taskId}`,
          prompt: `Inspect synthetic fixture ${taskId} only.`,
          role: "research",
          modelSelection: selection,
          priority: 0,
          dependencies: [],
        },
      })),
    ]),
  );
  const getPlan = Effect.gen(function* () {
    const plan = yield* store.getTeamPlan(owner);
    if (plan === null) return yield* Effect.die("Missing synthetic plan");
    return plan;
  });
  const confirm = Effect.gen(function* () {
    const plan = yield* getPlan;
    return yield* orchestrator.dispatch(
      planPatch(owner, "confirm", plan.version, [
        { type: "confirm_plan", revision: plan.revision },
      ]),
    );
  });
  const start = Effect.gen(function* () {
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`${owner}:start`),
      threadId: owner,
      messageId: MessageId.make(`${owner}:start`),
      text: "A controlled planning turn.",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const parent = yield* store.getThreadRecords(owner, ["runs"]);
    const run = parent.runs[0]!;
    return (
      taskId: string,
    ): Extract<OrchestrationV2Command, { type: "delegated_task.request" }> => ({
      type: "delegated_task.request",
      commandId: CommandId.make(`${owner}:request:${taskId}`),
      createdBy: "agent",
      creationSource: "mcp",
      parentThreadId: owner,
      parentRunId: run.id,
      parentNodeId: run.rootNodeId!,
      planTaskRef: { taskId, revision: 1 },
      task: "Caller text cannot replace the confirmed brief.",
      modelSelection: selection,
      runtimeMode: "approval-required",
      interactionMode: "default",
    });
  });
  return { owner, getPlan, confirm, start };
});

const executionSnapshot = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* Effect.all({
    runs: sql`SELECT run_id, payload_json FROM orchestration_v2_projection_runs ORDER BY run_id`,
    tasks: sql`SELECT subagent_id, payload_json FROM orchestration_v2_projection_subagents ORDER BY subagent_id`,
    effects: sql`SELECT effect_id, status, payload_json FROM orchestration_v2_effect_outbox ORDER BY effect_id`,
  });
});

it.effect(
  "keeps pause controls user-owned and refuses resume until the final plan is confirmed",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const fixture = yield* setup("confirmation");
      const initial = yield* fixture.getPlan;
      for (const paused of [true, false]) {
        const error = yield* orchestrator
          .dispatch(
            planPatch(
              fixture.owner,
              `agent:${paused}`,
              initial.version,
              [{ type: "set_dispatch_paused", paused }],
              "agent",
            ),
          )
          .pipe(Effect.flip);
        assert.instanceOf(error, Orchestrator.OrchestratorTeamPlanPatchError);
        if (error._tag === "OrchestratorTeamPlanPatchError")
          assert.equal(error.reason, "user-confirmation-required");
        assert.deepEqual(yield* fixture.getPlan, initial);
      }
      yield* orchestrator.dispatch(
        planPatch(fixture.owner, "pause-draft", initial.version, [
          { type: "set_dispatch_paused", paused: true },
        ]),
      );
      const paused = yield* fixture.getPlan;
      const before = yield* executionSnapshot;
      const refused = yield* orchestrator
        .dispatch(
          planPatch(fixture.owner, "resume-draft", paused.version, [
            { type: "set_dispatch_paused", paused: false },
          ]),
        )
        .pipe(Effect.flip);
      assert.instanceOf(refused, Orchestrator.OrchestratorTeamPlanPatchError);
      if (refused._tag === "OrchestratorTeamPlanPatchError")
        assert.equal(refused.reason, "plan-confirmation-required");
      assert.deepEqual(yield* fixture.getPlan, paused);
      yield* orchestrator.dispatch(
        planPatch(fixture.owner, "confirm-and-resume", paused.version, [
          { type: "confirm_plan", revision: paused.revision },
          { type: "set_dispatch_paused", paused: false },
        ]),
      );
      const resumed = yield* fixture.getPlan;
      assert.isFalse(resumed.dispatchPaused);
      assert.equal(resumed.confirmedRevision, resumed.revision);
      const changedAfterResume = yield* orchestrator
        .dispatch(
          planPatch(fixture.owner, "resume-then-change", resumed.version, [
            { type: "set_dispatch_paused", paused: false },
            { type: "edit_task", taskId: "A", changes: { prompt: "Unconfirmed new scope" } },
          ]),
        )
        .pipe(Effect.flip);
      assert.instanceOf(changedAfterResume, Orchestrator.OrchestratorTeamPlanPatchError);
      if (changedAfterResume._tag === "OrchestratorTeamPlanPatchError")
        assert.equal(changedAfterResume.reason, "plan-confirmation-required");
      assert.deepEqual(yield* fixture.getPlan, resumed);
      assert.deepEqual(yield* executionSnapshot, before);
      const empty = yield* setup("empty-confirmed", []);
      yield* empty.confirm;
      const emptyPlan = yield* empty.getPlan;
      const emptyResume = yield* orchestrator
        .dispatch(
          planPatch(empty.owner, "resume", emptyPlan.version, [
            { type: "set_dispatch_paused", paused: false },
          ]),
        )
        .pipe(Effect.flip);
      assert.instanceOf(emptyResume, Orchestrator.OrchestratorTeamPlanPatchError);
      if (emptyResume._tag === "OrchestratorTeamPlanPatchError")
        assert.equal(emptyResume.reason, "plan-confirmation-required");
      assert.deepEqual(yield* empty.getPlan, emptyPlan);
    }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["pause-first", "dispatch-first"] as const)(
  "linearizes pause against dispatch (%s)",
  (order) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const fixture = yield* setup(`race:${order}`);
      yield* fixture.confirm;
      const request = yield* fixture.start;
      const before = yield* fixture.getPlan;
      const pause = orchestrator
        .dispatch(
          planPatch(fixture.owner, "racing-pause", before.version, [
            { type: "set_dispatch_paused", paused: true },
          ]),
        )
        .pipe(Effect.result);
      const dispatch = orchestrator.dispatch(request("A")).pipe(Effect.result);
      const results = yield* Effect.all(
        order === "pause-first" ? [pause, dispatch] : [dispatch, pause],
        {
          concurrency: "unbounded",
        },
      );
      const outcomes = {
        pause: results[order === "pause-first" ? 0 : 1]!,
        dispatch: results[order === "pause-first" ? 1 : 0]!,
      };
      const plan = yield* fixture.getPlan;
      if (Result.isSuccess(outcomes.pause)) {
        assert.isTrue(plan.dispatchPaused);
        const pauseSequence = outcomes.pause.success.storedEvents[0]!.sequence;
        if (Result.isSuccess(outcomes.dispatch)) {
          const childStart = outcomes.dispatch.success.storedEvents.find(
            (stored) =>
              stored.event.type === "run.created" && stored.event.threadId !== fixture.owner,
          );
          assert.isDefined(childStart);
          assert.isBelow(childStart!.sequence, pauseSequence);
          assert.lengthOf(plan.tasks.find((task) => task.taskId === "A")!.executions, 1);
        } else {
          assert.instanceOf(outcomes.dispatch.failure, Orchestrator.OrchestratorTeamPlanPatchError);
          if (outcomes.dispatch.failure._tag === "OrchestratorTeamPlanPatchError")
            assert.equal(outcomes.dispatch.failure.reason, "dispatch-paused");
          assert.lengthOf(plan.tasks.find((task) => task.taskId === "A")!.executions, 0);
        }
      } else {
        assert.instanceOf(outcomes.pause.failure, Orchestrator.OrchestratorTeamPlanPatchError);
        if (outcomes.pause.failure._tag === "OrchestratorTeamPlanPatchError")
          assert.equal(outcomes.pause.failure.reason, "version-conflict");
        assert.isTrue(Result.isSuccess(outcomes.dispatch));
        assert.notProperty(plan, "dispatchPaused");
        assert.lengthOf(plan.tasks.find((task) => task.taskId === "A")!.executions, 1);
      }
    }).pipe(Effect.provide(layerTest)),
);

it.effect("refuses resume while a preparing, waiting or queued coordinator turn exists", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const sink = yield* EventSink.EventSinkV2;
    const fixture = yield* setup("active-coordinator");
    yield* fixture.confirm;
    yield* fixture.start;
    const plan = yield* fixture.getPlan;
    yield* orchestrator.dispatch(
      planPatch(fixture.owner, "pause-active", plan.version, [
        { type: "set_dispatch_paused", paused: true },
      ]),
    );
    const paused = yield* fixture.getPlan;
    const parent = yield* store.getThreadRecords(fixture.owner, ["runs"]);
    const run = parent.runs[0]!;
    const now = yield* DateTime.now;
    for (const status of ["preparing", "waiting", "queued"] as const) {
      yield* sink.write({
        events: [
          {
            id: EventId.make(`${fixture.owner}:${status}`),
            type: "run.updated",
            threadId: fixture.owner,
            runId: run.id,
            occurredAt: now,
            payload: { ...run, status },
          },
        ],
      });
      const before = yield* executionSnapshot;
      const error = yield* orchestrator
        .dispatch(
          planPatch(fixture.owner, `resume:${status}`, paused.version, [
            { type: "set_dispatch_paused", paused: false },
          ]),
        )
        .pipe(Effect.flip);
      assert.instanceOf(error, Orchestrator.OrchestratorTeamPlanPatchError);
      if (error._tag === "OrchestratorTeamPlanPatchError")
        assert.equal(error.reason, "coordinator-active");
      assert.deepEqual(yield* fixture.getPlan, paused);
      assert.deepEqual(yield* executionSnapshot, before);
    }
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "pauses new plan dispatch without cancelling a child or rejecting its committed retry",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const fixture = yield* setup("dispatch");
      yield* fixture.confirm;
      const request = yield* fixture.start;
      const first = yield* orchestrator.dispatch(request("A"));
      const plan = yield* fixture.getPlan;
      assert.notProperty(plan, "dispatchPaused");
      const before = yield* executionSnapshot;
      yield* orchestrator.dispatch(
        planPatch(fixture.owner, "pause", plan.version, [
          { type: "set_dispatch_paused", paused: true },
        ]),
      );
      const paused = yield* fixture.getPlan;
      assert.isTrue(paused.dispatchPaused);
      assert.equal(paused.revision, plan.revision);
      assert.equal(paused.confirmedRevision, plan.confirmedRevision);
      assert.deepEqual(paused.tasks, plan.tasks);
      assert.deepEqual(yield* executionSnapshot, before);
      const retried = yield* orchestrator.dispatch({
        ...request("A"),
        commandId: CommandId.make(`${fixture.owner}:another-session-retry`),
      });
      assert.isTrue(retried.replayed);
      assert.deepEqual(
        retried.storedEvents.map((stored) => [stored.sequence, stored.commandId, stored.event.id]),
        first.storedEvents.map((stored) => [stored.sequence, stored.commandId, stored.event.id]),
      );
      const refused = yield* orchestrator.dispatch(request("B")).pipe(Effect.flip);
      assert.instanceOf(refused, Orchestrator.OrchestratorTeamPlanPatchError);
      if (refused._tag === "OrchestratorTeamPlanPatchError")
        assert.equal(refused.reason, "dispatch-paused");
      assert.deepEqual(yield* executionSnapshot, before);
      assert.deepEqual(yield* fixture.getPlan, paused);
    }).pipe(Effect.provide(layerTest)),
);
