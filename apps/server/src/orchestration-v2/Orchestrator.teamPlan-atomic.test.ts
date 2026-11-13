import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import { teamPlanTaskCommandId } from "@t3tools/shared/teamPlan";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventStore from "./EventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as ProjectionReplay from "./testkit/ProjectionReplay.ts";

const owner = ThreadId.make("thread:team-plan-atomic");
const selection = { instanceId: ProviderInstanceId.make("codex"), model: "fixture-model" };
const planRef = { taskId: "work", revision: 1 };
const stableId = teamPlanTaskCommandId(owner, planRef);
const adapter = {
  instanceId: selection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Atomic plan tests never start a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

type FailureFixture = { injected: boolean; sawChild: boolean };

function testLayer(cwd: string, failure?: FailureFixture) {
  const database = SqlitePersistence.layerMemory;
  return Layer.mergeAll(
    database,
    ProjectionStore.layer.pipe(Layer.provide(database)),
    CommandReceiptStore.layer.pipe(Layer.provide(database)),
    EffectOutbox.layer.pipe(Layer.provide(database)),
    EventStore.layer.pipe(Layer.provide(database)),
    ProviderReplayHarness.layerWithRegistry(
      { name: "team-plan-atomic", runtimePolicyOverride: { cwd } },
      ProviderAdapterRegistry.layerFromAdapters([adapter]),
      {
        databaseLayer: database,
        runEffectWorker: false,
        ...(failure === undefined
          ? {}
          : {
              wrapProjectionStore: (store: ProjectionStore.ProjectionStoreV2Shape) => ({
                ...store,
                apply: (event) => {
                  if (
                    event.type === "team-plan.updated" &&
                    event.payload.plan.tasks.some((task) => task.executions.length > 0) &&
                    !failure.injected
                  ) {
                    failure.injected = true;
                    assert.isTrue(
                      failure.sawChild,
                      "the transaction must have applied the child before its binding",
                    );
                    return Effect.fail(
                      new ProjectionStore.ProjectionStoreApplyEventError({ eventType: event.type }),
                    );
                  }
                  return store.apply(event).pipe(
                    Effect.tap(() =>
                      Effect.sync(() => {
                        if (event.type === "thread.created" && event.threadId !== owner)
                          failure.sawChild = true;
                      }),
                    ),
                  );
                },
              }),
            }),
      },
    ),
  );
}

const initialize = Effect.fn("TeamPlanAtomic.initialize")(function* (cwd: string) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("atomic:create"),
    threadId: owner,
    projectId: ProjectId.make("project:atomic"),
    title: "Coordinator",
    modelSelection: selection,
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: cwd,
    createdBy: "user",
    creationSource: "web",
  });
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make("atomic:start"),
    threadId: owner,
    messageId: MessageId.make("atomic:start"),
    text: "Prepare the synthetic plan.",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
  });
  yield* orchestrator.dispatch({
    type: "thread.team-plan.patch",
    commandId: CommandId.make("atomic:draft"),
    threadId: owner,
    createdBy: "agent",
    creationSource: "mcp",
    expectedPlanVersion: 0,
    operations: [
      { type: "set_goal", goal: "Inspect a synthetic fixture" },
      {
        type: "add_task",
        task: {
          taskId: planRef.taskId,
          title: "Read the fixture",
          prompt: "Read the synthetic README only.",
          role: "research",
          priority: 0,
          modelSelection: selection,
          dependencies: [],
        },
      },
    ],
  });
  const draft = yield* projections.getTeamPlan(owner);
  assert.isNotNull(draft);
  yield* orchestrator.dispatch({
    type: "thread.team-plan.patch",
    commandId: CommandId.make("atomic:confirm"),
    threadId: owner,
    createdBy: "user",
    creationSource: "web",
    expectedPlanVersion: draft!.version,
    operations: [{ type: "confirm_plan", revision: draft!.revision }],
  });
  const parent = yield* projections.getThreadRecords(owner, ["runs"]);
  const run = parent.runs[0]!;
  return (
    request: string,
  ): Extract<OrchestrationV2Command, { type: "delegated_task.request" }> => ({
    type: "delegated_task.request",
    commandId: CommandId.make(request),
    createdBy: "agent",
    creationSource: "mcp",
    parentThreadId: owner,
    parentRunId: run.id,
    parentNodeId: run.rootNodeId!,
    planTaskRef: planRef,
    task: "An unconfirmed replacement must not execute.",
    title: "Unconfirmed title",
    modelSelection: selection,
    runtimeMode: "approval-required",
    interactionMode: "default",
  });
});

const counts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ children: number; child_runs: number; effects: number }>`
    SELECT
      (SELECT COUNT(*) FROM orchestration_v2_projection_threads WHERE thread_id != ${owner}) AS children,
      (SELECT COUNT(*) FROM orchestration_v2_projection_runs WHERE thread_id != ${owner}) AS child_runs,
      (SELECT COUNT(*) FROM orchestration_v2_effect_outbox) AS effects
  `;
  return row!;
});

const assertOneBinding = Effect.fn("TeamPlanAtomic.assertOneBinding")(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
  const parent = yield* projections.getThreadRecords(owner, ["subagents", "teamPlan"]);
  assert.lengthOf(parent.subagents, 1);
  const task = parent.subagents[0]!;
  const execution = parent.teamPlan?.tasks[0]?.executions[0];
  assert.isDefined(execution);
  assert.lengthOf(parent.teamPlan!.tasks[0]!.executions, 1);
  assert.equal(execution!.subagentId, task.id);
  assert.equal(execution!.threadId, task.childThreadId);
  const child = yield* projections.getThreadRecords(execution!.threadId, ["runs"]);
  assert.lengthOf(child.runs, 1);
  assert.equal(execution!.runId, child.runs[0]!.id);
  assert.equal(child.thread.lineage.parentThreadId, owner);
  assert.equal(
    task.prompt,
    "Act as the research sub-agent for this task.\n\nRead the synthetic README only.",
  );
  const receipt = yield* receipts.getByCommandId(stableId);
  assert.isTrue(Option.isSome(receipt));
  if (Option.isSome(receipt)) assert.equal(receipt.value.status, "accepted");
  const observed = yield* counts;
  assert.equal(observed.children, 1);
  assert.equal(observed.child_runs, 1);
  return execution!;
});

it.effect("concurrent session keys share one task revision receipt and execution", () =>
  Effect.gen(function* () {
    const cwd = yield* checkpointWorkspace("team-plan-atomic-concurrent");
    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const request = yield* initialize(cwd);
      const outcomes = yield* Effect.forEach(
        ["session:first", "session:second"],
        (key) => orchestrator.dispatch(request(key)),
        { concurrency: "unbounded" },
      );
      assert.equal(outcomes[0]!.sequence, outcomes[1]!.sequence);
      assert.equal(outcomes.filter((outcome) => outcome.replayed === true).length, 1);
      yield* assertOneBinding();
      const before = yield* counts;
      yield* orchestrator.dispatch(request("session:third"));
      assert.deepEqual(yield* counts, before);
    }).pipe(Effect.provide(testLayer(cwd)));
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("rolls back child rows and outbox when binding fails after child creation", () =>
  Effect.gen(function* () {
    const cwd = yield* checkpointWorkspace("team-plan-atomic-rollback");
    const failure = { injected: false, sawChild: false };
    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
      const request = yield* initialize(cwd);
      const before = yield* counts;
      const beforePlan = yield* projections.getTeamPlan(owner);
      const outcome = yield* orchestrator
        .dispatch(request("before-bind-failure"))
        .pipe(Effect.result);
      assert.isTrue(Result.isFailure(outcome));
      assert.isTrue(failure.injected);
      assert.isTrue(failure.sawChild);
      assert.deepEqual(yield* counts, before);
      assert.deepEqual(yield* projections.getTeamPlan(owner), beforePlan);
      assert.isTrue(Option.isNone(yield* receipts.getByCommandId(stableId)));
      yield* orchestrator.dispatch(request("retry-after-rollback"));
      yield* assertOneBinding();
    }).pipe(Effect.provide(testLayer(cwd, failure)));
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("replays the committed receipt after a synthetic lost response", () =>
  Effect.gen(function* () {
    const cwd = yield* checkpointWorkspace("team-plan-atomic-response");
    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const request = yield* initialize(cwd);
      const lost = yield* orchestrator
        .dispatch(request("lost-response"))
        .pipe(Effect.andThen(Effect.fail("synthetic-transport-loss")), Effect.result);
      assert.isTrue(Result.isFailure(lost));
      const binding = yield* assertOneBinding();
      const before = yield* counts;
      const replay = yield* orchestrator.dispatch(request("new-session-after-loss"));
      assert.isTrue(replay.replayed);
      assert.deepEqual(yield* counts, before);
      assert.deepEqual(yield* assertOneBinding(), binding);
      const plan = yield* projections.getTeamPlan(owner);
      yield* Effect.gen(function* () {
        const fresh = yield* ProjectionStore.ProjectionStoreV2;
        assert.deepEqual(yield* fresh.getTeamPlan(owner), plan);
      }).pipe(Effect.provide(ProjectionStore.layer));
      const verified = yield* Effect.gen(function* () {
        const replayer = yield* ProjectionReplay.ProjectionReplay;
        return yield* replayer.rebuild;
      }).pipe(Effect.provide(ProjectionReplay.layer));
      assert.isTrue(verified.valid);
      const afterRebuild = yield* orchestrator.dispatch(
        request("session-after-projection-rebuild"),
      );
      assert.isTrue(afterRebuild.replayed);
      assert.deepEqual(yield* counts, before);
      assert.deepEqual(yield* assertOneBinding(), binding);
    }).pipe(Effect.provide(testLayer(cwd)));
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "serializes a scope edit racing dispatch and keeps the old execution on its revision",
  () =>
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("team-plan-atomic-edit");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const request = yield* initialize(cwd);
        const edit = (
          version: number,
          key: string,
        ): Extract<OrchestrationV2Command, { type: "thread.team-plan.patch" }> => ({
          type: "thread.team-plan.patch",
          commandId: CommandId.make(key),
          threadId: owner,
          createdBy: "user",
          creationSource: "web",
          expectedPlanVersion: version,
          operations: [
            {
              type: "edit_task",
              taskId: "work",
              changes: { prompt: "Read the second synthetic scope." },
            },
          ],
        });
        const results = yield* Effect.all(
          [
            orchestrator.dispatch(request("racing-dispatch")).pipe(Effect.result),
            orchestrator.dispatch(edit(2, "racing-edit")).pipe(Effect.result),
          ],
          { concurrency: "unbounded" },
        );
        assert.equal(results.filter(Result.isSuccess).length, 1);
        let plan = (yield* projections.getTeamPlan(owner))!;
        if (Result.isSuccess(results[0]!)) {
          const execution = yield* assertOneBinding();
          const before = yield* counts;
          yield* orchestrator.dispatch(edit(plan.version, "edit-after-dispatch"));
          assert.deepEqual(yield* counts, before);
          plan = (yield* projections.getTeamPlan(owner))!;
          assert.deepEqual(plan.tasks[0]!.history[0]!.executions, [execution]);
        } else {
          assert.equal((yield* counts).children, 0);
        }
        assert.equal(plan.tasks[0]!.revision, 2);
        assert.isNull(plan.tasks[0]!.confirmedRevision);
        const before = yield* counts;
        const refused = yield* orchestrator
          .dispatch({
            ...request("unconfirmed-new-revision"),
            planTaskRef: { taskId: "work", revision: 2 },
          })
          .pipe(Effect.result);
        assert.isTrue(Result.isFailure(refused));
        assert.deepEqual(yield* counts, before);
      }).pipe(Effect.provide(testLayer(cwd)));
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("refuses an unavailable confirmed provider without substituting another executor", () =>
  Effect.gen(function* () {
    const cwd = yield* checkpointWorkspace("team-plan-atomic-unavailable");
    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const request = yield* initialize(cwd);
      const unavailable = {
        instanceId: ProviderInstanceId.make("not-configured"),
        model: "unavailable-model",
      };
      yield* orchestrator.dispatch({
        type: "thread.team-plan.patch",
        commandId: CommandId.make("unavailable:selection"),
        threadId: owner,
        createdBy: "user",
        creationSource: "web",
        expectedPlanVersion: 2,
        operations: [
          { type: "edit_task", taskId: "work", changes: { modelSelection: unavailable } },
        ],
      });
      yield* orchestrator.dispatch({
        type: "thread.team-plan.patch",
        commandId: CommandId.make("unavailable:confirm"),
        threadId: owner,
        createdBy: "user",
        creationSource: "web",
        expectedPlanVersion: 3,
        operations: [{ type: "confirm_task", taskId: "work", revision: 2 }],
      });
      const before = yield* counts;
      const error = yield* orchestrator
        .dispatch({
          ...request("unavailable:dispatch"),
          planTaskRef: { taskId: "work", revision: 2 },
          modelSelection: unavailable,
        })
        .pipe(Effect.flip);
      assert.instanceOf(error, Orchestrator.OrchestratorProviderAdapterError);
      if (error._tag === "OrchestratorProviderAdapterError")
        assert.equal(error.providerInstanceId, unavailable.instanceId);
      assert.deepEqual(yield* counts, before);
      const plan = yield* projections.getTeamPlan(owner);
      assert.deepEqual(plan?.tasks[0]?.modelSelection, unavailable);
      assert.deepEqual(plan?.tasks[0]?.executions, []);
    }).pipe(Effect.provide(testLayer(cwd)));
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);
