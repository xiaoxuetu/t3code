import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  RunId,
  type OrchestrationV2Command,
  type TeamPlanOperation,
  type TeamPlanTaskRef,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "fixture-model" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Team plan CRUD must not open a provider process"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const database = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  database,
  ProjectionStore.layer.pipe(Layer.provide(database)),
  EffectOutbox.layer.pipe(Layer.provide(database)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "team-plan-crud" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  ),
);

const createThread = Effect.fn("TeamPlanCrud.createThread")(function* (threadId: ThreadId) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create:${threadId}`),
    threadId,
    projectId: ProjectId.make("project:team-plan-crud"),
    title: "Team plan CRUD fixture",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
});

function patch(
  threadId: ThreadId,
  key: string,
  expectedPlanVersion: number,
  operations: ReadonlyArray<TeamPlanOperation>,
  createdBy: "user" | "agent" = "user",
): Extract<OrchestrationV2Command, { type: "thread.team-plan.patch" }> {
  return {
    type: "thread.team-plan.patch",
    commandId: CommandId.make(`plan:${threadId}:${key}`),
    threadId,
    expectedPlanVersion,
    operations,
    createdBy,
    creationSource: createdBy === "agent" ? "mcp" : "web",
  };
}

const initialOperations: ReadonlyArray<TeamPlanOperation> = [
  { type: "set_goal", goal: "Review two synthetic files" },
  ...["readme", "package"].map((taskId, index) => ({
    type: "add_task" as const,
    task: {
      taskId,
      title: `Review ${taskId}`,
      prompt: `Read the synthetic ${taskId} fixture`,
      role: "research",
      modelSelection,
      dependencies: [],
      priority: index,
    },
  })),
];

const assertNoExecution = Effect.fn("TeamPlanCrud.assertNoExecution")(function* (
  threadId: ThreadId,
  commandId: CommandId,
) {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  const sql = yield* SqlClient.SqlClient;
  assert.deepEqual(yield* outbox.listByCommandId(commandId), []);
  const records = yield* projections.getThreadRecords(threadId, ["runs", "providerSessions"]);
  assert.deepEqual(records.runs, []);
  assert.deepEqual(records.providerSessions, []);
  const [counts] = yield* sql<{ effects: number; runs: number }>`
    SELECT
      (SELECT COUNT(*) FROM orchestration_v2_effect_outbox) AS effects,
      (SELECT COUNT(*) FROM orchestration_v2_projection_runs) AS runs
  `;
  assert.deepEqual(counts, { effects: 0, runs: 0 });
});

type Coordinator = {
  parentThreadId: ThreadId;
  parentRunId: RunId;
  parentNodeId: NodeId;
};
const dependentOperations: ReadonlyArray<TeamPlanOperation> = [
  { type: "set_goal", goal: "Review A before reviewing B" },
  ...["A", "B"].map((taskId, priority) => ({
    type: "add_task" as const,
    task: {
      taskId,
      title: `Confirmed task ${taskId}`,
      prompt: `Read only synthetic fixture ${taskId}`,
      role: "research",
      modelSelection,
      priority,
      dependencies: taskId === "B" ? [{ taskId: "A", revision: 1 }] : [],
    },
  })),
];

const plannedCoordinator = Effect.fn("TeamPlanRef.plannedCoordinator")(function* (
  name: string,
  confirmed = true,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const parentThreadId = ThreadId.make(`thread:team-plan-ref:${name}`);
  yield* createThread(parentThreadId);
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`coordinator:${name}`),
    messageId: MessageId.make(`message:coordinator:${name}`),
    threadId: parentThreadId,
    createdBy: "user",
    creationSource: "web",
    text: "Prepare the synthetic team plan.",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
  });
  yield* orchestrator.dispatch(patch(parentThreadId, "dependent-draft", 0, dependentOperations));
  const draft = yield* projections.getTeamPlan(parentThreadId);
  if (draft === null) return yield* Effect.die("Synthetic coordinator has no plan");
  if (confirmed) {
    yield* orchestrator.dispatch(
      patch(parentThreadId, "confirm-dependent-plan", draft.version, [
        { type: "confirm_plan", revision: draft.revision },
      ]),
    );
  }
  const records = yield* projections.getThreadRecords(parentThreadId, ["runs"]);
  const run = records.runs[0];
  if (run === undefined || run.rootNodeId === null)
    return yield* Effect.die("Synthetic coordinator has no active root run");
  return {
    parentThreadId,
    parentRunId: run.id,
    parentNodeId: run.rootNodeId,
  } satisfies Coordinator;
});

function requestPlanTask(
  coordinator: Coordinator,
  key: string,
  planTaskRef: TeamPlanTaskRef = { taskId: "A", revision: 1 },
): Extract<OrchestrationV2Command, { type: "delegated_task.request" }> {
  return {
    type: "delegated_task.request",
    ...coordinator,
    commandId: CommandId.make(`request:${coordinator.parentThreadId}:${key}`),
    createdBy: "agent",
    creationSource: "mcp",
    planTaskRef,
    task: "Act as the implementer sub-agent. Caller text must not replace the confirmed task scope",
    title: "Caller title must not replace the confirmed title",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
  };
}

const executionSnapshot = Effect.fn("TeamPlanRef.executionSnapshot")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* Effect.all({
    threads: sql<{
      thread_id: string;
    }>`SELECT thread_id FROM orchestration_v2_projection_threads ORDER BY thread_id`,
    runs: sql<{
      run_id: string;
      payload_json: string;
    }>`SELECT run_id, payload_json FROM orchestration_v2_projection_runs ORDER BY run_id`,
    effects: sql<{
      effect_id: string;
      status: string;
      payload_json: string;
    }>`SELECT effect_id, status, payload_json FROM orchestration_v2_effect_outbox ORDER BY effect_id`,
  });
});

const boundTaskA = Effect.fn("TeamPlanRef.boundTaskA")(function* (name: string) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const coordinator = yield* plannedCoordinator(name);
  const request = requestPlanTask(coordinator, "first");
  const first = yield* orchestrator.dispatch(request);
  const parent = yield* projections.getThreadProjection(coordinator.parentThreadId);
  const plan = yield* projections.getTeamPlan(coordinator.parentThreadId);
  const execution = plan?.tasks.find((task) => task.taskId === "A")?.executions[0];
  if (plan === null || execution === undefined)
    return yield* Effect.die("Synthetic plan task was not bound to its execution");
  const child = yield* projections.getThreadProjection(execution.threadId);
  return { coordinator, request, first, parent, plan, execution, child };
});

it.effect("persists plan edits and priority changes without effects or new runs", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const threadId = ThreadId.make("thread:team-plan-crud:edits");
    yield* createThread(threadId);
    const commands = [
      patch(threadId, "initial", 0, initialOperations),
      patch(threadId, "edit", 1, [
        {
          type: "edit_task",
          taskId: "readme",
          changes: { prompt: "Read the revised synthetic README" },
        },
      ]),
      patch(threadId, "priority", 2, [{ type: "reprioritize", taskId: "package", priority: -10 }]),
    ];
    for (const command of commands) {
      const result = yield* orchestrator.dispatch(command);
      assert.deepEqual(
        result.storedEvents.map((stored) => stored.event.type),
        ["team-plan.updated"],
      );
      yield* assertNoExecution(threadId, command.commandId);
    }
    const plan = yield* projections.getTeamPlan(threadId);
    assert.isNotNull(plan);
    if (plan === null) return;
    assert.equal(plan.version, 3);
    const readme = plan.tasks.find((task) => task.taskId === "readme");
    assert.equal(readme?.revision, 2);
    assert.equal(readme?.prompt, "Read the revised synthetic README");
    assert.equal(readme?.history[0]?.prompt, "Read the synthetic readme fixture");
    assert.equal(plan.tasks.find((task) => task.taskId === "package")?.priority, -10);
    const [row] = yield* sql<{ version: number; payload_json: string }>`
      SELECT version, payload_json FROM orchestration_v2_projection_team_plans WHERE thread_id = ${threadId}
    `;
    assert.equal(row?.version, 3);
    assert.deepEqual(JSON.parse(row!.payload_json), plan);
    yield* Effect.gen(function* () {
      const freshStore = yield* ProjectionStore.ProjectionStoreV2;
      assert.deepEqual(yield* freshStore.getTeamPlan(threadId), plan);
    }).pipe(Effect.provide(ProjectionStore.layer));
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "replays an accepted receipt and rejects stale expectedPlanVersion without changing the plan",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:team-plan-crud:receipt");
      yield* createThread(threadId);
      const command = patch(threadId, "accepted", 0, initialOperations);
      const first = yield* orchestrator.dispatch(command);
      const plan = yield* projections.getTeamPlan(threadId);
      const sequence = yield* orchestrator.getThreadEventSequence(threadId);
      const replay = yield* orchestrator.dispatch(command);
      assert.isTrue(replay.replayed);
      assert.equal(replay.sequence, first.sequence);
      assert.deepEqual(replay.storedEvents, first.storedEvents);
      assert.deepEqual(yield* projections.getTeamPlan(threadId), plan);
      assert.equal(yield* orchestrator.getThreadEventSequence(threadId), sequence);
      const stale = patch(threadId, "stale", 0, [{ type: "set_goal", goal: "Stale replacement" }]);
      const error = yield* orchestrator.dispatch(stale).pipe(Effect.flip);
      assert.instanceOf(error, Orchestrator.OrchestratorTeamPlanPatchError);
      if (error._tag === "OrchestratorTeamPlanPatchError") {
        assert.equal(error.reason, "version-conflict");
        assert.equal(error.expectedPlanVersion, 0);
        assert.equal(error.actualPlanVersion, 1);
      }
      assert.deepEqual(yield* projections.getTeamPlan(threadId), plan);
      assert.equal(yield* orchestrator.getThreadEventSequence(threadId), sequence);
      yield* assertNoExecution(threadId, command.commandId);
      yield* assertNoExecution(threadId, stale.commandId);
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "rejects unconfirmed, unaccepted-dependency and mismatched-model requests without child work",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const coordinator = yield* plannedCoordinator("prerequisites", false);
      const before = yield* executionSnapshot();
      const { planTaskRef: _omitted, ...withoutPlanRef } = requestPlanTask(
        coordinator,
        "missing-reference",
      );
      const missingReference = yield* orchestrator.dispatch(withoutPlanRef).pipe(Effect.flip);
      assert.instanceOf(missingReference, Orchestrator.OrchestratorTeamPlanPatchError);
      if (missingReference._tag === "OrchestratorTeamPlanPatchError")
        assert.equal(missingReference.reason, "plan-task-reference-required");
      assert.deepEqual(yield* executionSnapshot(), before);
      const unconfirmed = yield* orchestrator
        .dispatch(requestPlanTask(coordinator, "unconfirmed"))
        .pipe(Effect.flip);
      assert.instanceOf(unconfirmed, Orchestrator.OrchestratorTeamPlanPatchError);
      if (unconfirmed._tag === "OrchestratorTeamPlanPatchError")
        assert.equal(unconfirmed.reason, "unconfirmed-task");
      assert.deepEqual(yield* executionSnapshot(), before);
      const draft = yield* projections.getTeamPlan(coordinator.parentThreadId);
      if (draft === null) return yield* Effect.die("Synthetic coordinator lost its draft");
      yield* orchestrator.dispatch(
        patch(coordinator.parentThreadId, "confirm", draft.version, [
          { type: "confirm_plan", revision: draft.revision },
        ]),
      );
      const confirmed = yield* projections.getTeamPlan(coordinator.parentThreadId);
      const blocked = yield* orchestrator
        .dispatch(requestPlanTask(coordinator, "dependency", { taskId: "B", revision: 1 }))
        .pipe(Effect.flip);
      assert.instanceOf(blocked, Orchestrator.OrchestratorTeamPlanPatchError);
      if (blocked._tag === "OrchestratorTeamPlanPatchError")
        assert.equal(blocked.reason, "dependency-unaccepted");
      assert.deepEqual(yield* executionSnapshot(), before);
      const mismatched = yield* orchestrator
        .dispatch({
          ...requestPlanTask(coordinator, "wrong-model"),
          modelSelection: { ...modelSelection, model: "different-fixture-model" },
        })
        .pipe(Effect.flip);
      assert.instanceOf(mismatched, Orchestrator.OrchestratorTeamPlanPatchError);
      if (mismatched._tag === "OrchestratorTeamPlanPatchError")
        assert.equal(mismatched.reason, "model-selection-mismatch");
      assert.deepEqual(yield* projections.getTeamPlan(coordinator.parentThreadId), confirmed);
      assert.deepEqual(yield* executionSnapshot(), before);
      yield* orchestrator.dispatch(requestPlanTask(coordinator, "ready-after-refusals"));
      const ready = yield* projections.getTeamPlan(coordinator.parentThreadId);
      assert.equal(ready?.tasks.find((task) => task.taskId === "A")?.executions.length, 1);
      if (ready === null) return yield* Effect.die("Synthetic coordinator lost its ready plan");
      const beforeGoalEdit = yield* executionSnapshot();
      yield* orchestrator.dispatch(
        patch(coordinator.parentThreadId, "goal-change", ready.version, [
          { type: "set_goal", goal: "Reassess the synthetic review goal" },
        ]),
      );
      const revisedGoal = yield* projections.getTeamPlan(coordinator.parentThreadId);
      assert.equal(revisedGoal?.tasks.find((task) => task.taskId === "B")?.confirmedRevision, null);
      assert.deepEqual(
        revisedGoal?.tasks.find((task) => task.taskId === "A")?.executions,
        ready.tasks.find((task) => task.taskId === "A")?.executions,
      );
      const goalUnconfirmed = yield* orchestrator
        .dispatch(requestPlanTask(coordinator, "goal-unconfirmed", { taskId: "B", revision: 1 }))
        .pipe(Effect.flip);
      assert.instanceOf(goalUnconfirmed, Orchestrator.OrchestratorTeamPlanPatchError);
      if (goalUnconfirmed._tag === "OrchestratorTeamPlanPatchError")
        assert.equal(goalUnconfirmed.reason, "unconfirmed-task");
      assert.deepEqual(yield* executionSnapshot(), beforeGoalEdit);
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "binds task, child and run atomically and replays a plan reference across command IDs",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const bound = yield* boundTaskA("stable-identity");
      assert.equal(bound.parent.subagents.length, 1);
      const task = bound.parent.subagents[0]!;
      assert.equal(task.id, bound.execution.subagentId);
      assert.equal(task.childThreadId, bound.execution.threadId);
      assert.equal(bound.child.runs.length, 1);
      assert.equal(bound.child.runs[0]?.id, bound.execution.runId);
      assert.equal(bound.child.thread.lineage.parentThreadId, bound.coordinator.parentThreadId);
      assert.equal(
        task.prompt,
        "Act as the research sub-agent for this task.\n\nRead only synthetic fixture A",
      );
      assert.equal(task.title, "Confirmed task A");
      assert.equal(
        bound.child.messages[0]?.text,
        "Act as the research sub-agent for this task.\n\nRead only synthetic fixture A",
      );
      assert.include(
        bound.first.storedEvents.map((stored) => stored.event.type),
        "team-plan.updated",
      );
      const before = yield* executionSnapshot();
      const repeated = yield* orchestrator.dispatch(
        requestPlanTask(bound.coordinator, "another-session-command"),
      );
      assert.isTrue(repeated.replayed);
      assert.equal(repeated.sequence, bound.first.sequence);
      // Receipts persist JSON, which omits optional properties whose value was undefined.
      assert.deepEqual(
        JSON.parse(JSON.stringify(repeated.storedEvents)),
        JSON.parse(JSON.stringify(bound.first.storedEvents)),
      );
      assert.deepEqual(yield* executionSnapshot(), before);
      assert.deepEqual(
        yield* projections.getTeamPlan(bound.coordinator.parentThreadId),
        bound.plan,
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect("reprioritizes a bound task without new effects, runs or execution identities", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const bound = yield* boundTaskA("bound-priority");
    const before = yield* executionSnapshot();
    const command = patch(bound.coordinator.parentThreadId, "bound-priority", bound.plan.version, [
      { type: "reprioritize", taskId: "A", priority: 50 },
    ]);
    yield* orchestrator.dispatch(command);
    const plan = yield* projections.getTeamPlan(bound.coordinator.parentThreadId);
    const task = plan?.tasks.find((candidate) => candidate.taskId === "A");
    assert.equal(task?.priority, 50);
    assert.equal(task?.revision, 1);
    assert.deepEqual(task?.executions, [bound.execution]);
    assert.deepEqual(yield* executionSnapshot(), before);
    assert.deepEqual(yield* outbox.listByCommandId(command.commandId), []);
    assert.deepEqual(
      (yield* projections.getThreadProjection(bound.coordinator.parentThreadId)).subagents,
      bound.parent.subagents,
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "retains a bound revision and its running child when the scope receives a new revision",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const bound = yield* boundTaskA("scope-revision");
      const before = yield* executionSnapshot();
      const command = patch(bound.coordinator.parentThreadId, "new-scope", bound.plan.version, [
        { type: "edit_task", taskId: "A", changes: { prompt: "Read a revised synthetic scope" } },
      ]);
      yield* orchestrator.dispatch(command);
      const plan = yield* projections.getTeamPlan(bound.coordinator.parentThreadId);
      const task = plan?.tasks.find((candidate) => candidate.taskId === "A");
      assert.equal(task?.revision, 2);
      assert.equal(task?.confirmedRevision, null);
      assert.deepEqual(task?.executions, []);
      assert.equal(task?.history[0]?.revision, 1);
      assert.deepEqual(task?.history[0]?.executions, [bound.execution]);
      assert.deepEqual(task?.history[0]?.prompt, "Read only synthetic fixture A");
      const oldRevision = yield* orchestrator.dispatch(
        requestPlanTask(bound.coordinator, "old-revision"),
      );
      assert.isTrue(oldRevision.replayed);
      assert.equal(oldRevision.sequence, bound.first.sequence);
      const newRevision = yield* orchestrator
        .dispatch(requestPlanTask(bound.coordinator, "new-revision", { taskId: "A", revision: 2 }))
        .pipe(Effect.flip);
      assert.instanceOf(newRevision, Orchestrator.OrchestratorTeamPlanPatchError);
      if (newRevision._tag === "OrchestratorTeamPlanPatchError")
        assert.equal(newRevision.reason, "unconfirmed-task");
      assert.deepEqual(
        (yield* projections.getThreadProjection(bound.execution.threadId)).runs,
        bound.child.runs,
      );
      assert.deepEqual(
        (yield* projections.getThreadProjection(bound.coordinator.parentThreadId)).subagents,
        bound.parent.subagents,
      );
      assert.deepEqual(yield* executionSnapshot(), before);
      assert.deepEqual(yield* outbox.listByCommandId(command.commandId), []);
      if (plan === null) return yield* Effect.die("Synthetic revised scope lost its plan");
      const confirmation = patch(
        bound.coordinator.parentThreadId,
        "confirm-new-scope",
        plan.version,
        [{ type: "confirm_task", taskId: "A", revision: 2 }],
      );
      yield* orchestrator.dispatch(confirmation);
      assert.deepEqual(yield* executionSnapshot(), before);
      assert.deepEqual(yield* outbox.listByCommandId(confirmation.commandId), []);
      const restarted = yield* orchestrator.dispatch(
        requestPlanTask(bound.coordinator, "confirmed-new-revision", { taskId: "A", revision: 2 }),
      );
      const restored = yield* projections.getTeamPlan(bound.coordinator.parentThreadId);
      const restoredTask = restored?.tasks.find((candidate) => candidate.taskId === "A");
      const restoredExecution = restoredTask?.executions[0];
      if (restoredExecution === undefined)
        return yield* Effect.die("Confirmed new revision did not receive an execution");
      assert.equal(restoredTask?.confirmedRevision, 2);
      assert.deepEqual(restoredTask?.modelSelection, modelSelection);
      assert.equal(restoredTask?.executions.length, 1);
      assert.notEqual(restoredExecution.subagentId, bound.execution.subagentId);
      assert.notEqual(restoredExecution.threadId, bound.execution.threadId);
      assert.notEqual(restoredExecution.runId, bound.execution.runId);
      const restoredChild = yield* projections.getThreadProjection(restoredExecution.threadId);
      assert.equal(restoredChild.runs[0]?.id, restoredExecution.runId);
      assert.equal(
        restoredChild.messages[0]?.text,
        "Act as the research sub-agent for this task.\n\nRead a revised synthetic scope",
      );
      const restoredParent = yield* projections.getThreadRecords(bound.coordinator.parentThreadId, [
        "subagents",
      ]);
      assert.equal(
        restoredParent.subagents.find((candidate) => candidate.id === restoredExecution.subagentId)
          ?.childThreadId,
        restoredExecution.threadId,
      );
      assert.deepEqual(restoredTask?.history[0]?.executions, [bound.execution]);
      assert.deepEqual(
        (yield* projections.getThreadProjection(bound.execution.threadId)).runs,
        bound.child.runs,
      );
      const beforeReplay = yield* executionSnapshot();
      const restartedReplay = yield* orchestrator.dispatch(
        requestPlanTask(bound.coordinator, "replay-new-revision", { taskId: "A", revision: 2 }),
      );
      assert.isTrue(restartedReplay.replayed);
      assert.equal(restartedReplay.sequence, restarted.sequence);
      assert.deepEqual(
        JSON.parse(JSON.stringify(restartedReplay.storedEvents)),
        JSON.parse(JSON.stringify(restarted.storedEvents)),
      );
      assert.deepEqual(yield* executionSnapshot(), beforeReplay);
      assert.deepEqual(yield* projections.getTeamPlan(bound.coordinator.parentThreadId), restored);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("refuses an agent verdict while its bound child has not completed", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const bound = yield* boundTaskA("premature-verdict");
    assert.notEqual(bound.child.runs[0]?.status, "completed");
    const before = yield* executionSnapshot();
    const command = patch(
      bound.coordinator.parentThreadId,
      "agent-verdict",
      bound.plan.version,
      [
        {
          type: "accept_task",
          taskId: "A",
          revision: 1,
          status: "accepted",
          note: "Synthetic verdict before worker completion",
        },
      ],
      "agent",
    );
    const error = yield* orchestrator.dispatch(command).pipe(Effect.flip);
    assert.instanceOf(error, Orchestrator.OrchestratorTeamPlanPatchError);
    if (error._tag === "OrchestratorTeamPlanPatchError")
      assert.equal(error.reason, "execution-not-completed");
    assert.deepEqual(yield* projections.getTeamPlan(bound.coordinator.parentThreadId), bound.plan);
    assert.deepEqual(yield* executionSnapshot(), before);
    let planVersion = bound.plan.version;
    for (const [taskId, status] of [
      ["A", "issues"],
      ["A", "pending"],
      ["B", "blocked"],
    ] as const) {
      const emptyNote = patch(
        bound.coordinator.parentThreadId,
        `empty-${taskId}-${status}`,
        planVersion,
        [{ type: "accept_task", taskId, revision: 1, status, note: " " }],
        "agent",
      );
      const missingReview = yield* orchestrator.dispatch(emptyNote).pipe(Effect.flip);
      assert.instanceOf(missingReview, Orchestrator.OrchestratorTeamPlanPatchError);
      if (missingReview._tag === "OrchestratorTeamPlanPatchError")
        assert.equal(missingReview.reason, "independent-review-required");
      const noted = patch(
        bound.coordinator.parentThreadId,
        `noted-${taskId}-${status}`,
        planVersion,
        [
          {
            type: "accept_task",
            taskId,
            revision: 1,
            status,
            note: "Synthetic coordinator reports an unresolved dependency",
          },
        ],
        "agent",
      );
      yield* orchestrator.dispatch(noted);
      planVersion++;
      const updated = yield* projections.getTeamPlan(bound.coordinator.parentThreadId);
      assert.equal(
        updated?.tasks.find((task) => task.taskId === taskId)?.acceptance.status,
        status,
      );
      assert.deepEqual(yield* executionSnapshot(), before);
    }
    const acceptUnstarted = patch(
      bound.coordinator.parentThreadId,
      "accept-unstarted",
      planVersion,
      [
        {
          type: "accept_task",
          taskId: "B",
          revision: 1,
          status: "accepted",
          note: "Cannot accept an unstarted task",
        },
      ],
      "agent",
    );
    const unstarted = yield* orchestrator.dispatch(acceptUnstarted).pipe(Effect.flip);
    assert.instanceOf(unstarted, Orchestrator.OrchestratorTeamPlanPatchError);
    if (unstarted._tag === "OrchestratorTeamPlanPatchError")
      assert.equal(unstarted.reason, "independent-review-required");
    assert.deepEqual(yield* executionSnapshot(), before);
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "requires the bound child's original run before accepting A and unblocking dependent B",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const bound = yield* boundTaskA("linked-run-review");
      const original = bound.child.runs[0]!;
      const task = bound.parent.subagents[0]!;
      const originalReport = "Original accepted A/r1 artifact evidence.";
      const laterReport = "UNRELATED LATER RUN CONTENT MUST NOT REACH DEPENDENT";
      const unrelatedRun = {
        ...original,
        id: RunId.make("run:unrelated-later-child-run"),
        ordinal: original.ordinal + 1,
        delegatedTaskId: undefined,
        status: "completed" as const,
        completedAt: now,
      };
      yield* sink.write({
        events: [
          {
            id: EventId.make("event:unrelated-later-run"),
            type: "run.created",
            threadId: bound.execution.threadId,
            runId: unrelatedRun.id,
            occurredAt: now,
            payload: unrelatedRun,
          },
          ...[
            { id: "original", run: original, text: originalReport },
            { id: "later", run: unrelatedRun, text: laterReport },
          ].map(({ id, run, text }) => ({
            id: EventId.make(`event:dependency-report:${id}`),
            type: "message.updated" as const,
            threadId: bound.execution.threadId,
            runId: run.id,
            occurredAt: now,
            payload: {
              id: MessageId.make(`message:dependency-report:${id}`),
              threadId: bound.execution.threadId,
              runId: run.id,
              nodeId: run.rootNodeId,
              role: "assistant" as const,
              text,
              attachments: [],
              streaming: false,
              createdBy: "agent" as const,
              creationSource: "provider" as const,
              createdAt: now,
              updatedAt: now,
            },
          })),
          {
            id: EventId.make("event:synthetic-subagent-completed"),
            type: "subagent.updated",
            threadId: bound.coordinator.parentThreadId,
            occurredAt: now,
            payload: { ...task, status: "completed", result: laterReport },
          },
          {
            id: EventId.make("event:later-child-workspace"),
            type: "thread.metadata-updated",
            threadId: bound.execution.threadId,
            occurredAt: now,
            payload: {
              ...bound.child.thread,
              worktreePath: "/synthetic/unrelated-later-worktree",
              branch: "unrelated-later-branch",
            },
          },
        ],
      });
      const beforeRefusal = yield* executionSnapshot();
      const bindUnrelated = patch(
        bound.coordinator.parentThreadId,
        "wrong-run-evidence",
        bound.plan.version,
        [
          {
            type: "bind_execution",
            taskId: "A",
            revision: 1,
            execution: { ...bound.execution, runId: unrelatedRun.id },
          },
        ],
      );
      const wrongRun = yield* orchestrator.dispatch(bindUnrelated).pipe(Effect.flip);
      assert.instanceOf(wrongRun, Orchestrator.OrchestratorTeamPlanPatchError);
      if (wrongRun._tag === "OrchestratorTeamPlanPatchError")
        assert.equal(wrongRun.reason, "execution-not-owned");
      const accept = patch(
        bound.coordinator.parentThreadId,
        "review-original-run",
        bound.plan.version,
        [
          {
            type: "accept_task",
            taskId: "A",
            revision: 1,
            status: "accepted",
            note: "Synthetic coordinator verifies the original bound execution",
          },
        ],
        "agent",
      );
      const notCompleted = yield* orchestrator.dispatch(accept).pipe(Effect.flip);
      assert.instanceOf(notCompleted, Orchestrator.OrchestratorTeamPlanPatchError);
      if (notCompleted._tag === "OrchestratorTeamPlanPatchError")
        assert.equal(notCompleted.reason, "execution-not-completed");
      assert.deepEqual(
        yield* projections.getTeamPlan(bound.coordinator.parentThreadId),
        bound.plan,
      );
      assert.deepEqual(yield* executionSnapshot(), beforeRefusal);
      yield* sink.write({
        events: [
          {
            id: EventId.make("event:original-bound-run-completed"),
            type: "run.updated",
            threadId: bound.execution.threadId,
            runId: original.id,
            occurredAt: now,
            payload: { ...original, status: "completed", completedAt: now },
          },
        ],
      });
      const beforeReview = yield* executionSnapshot();
      yield* orchestrator.dispatch({
        ...accept,
        commandId: CommandId.make("review:original-run-completed"),
      });
      const reviewed = yield* projections.getTeamPlan(bound.coordinator.parentThreadId);
      assert.equal(
        reviewed?.tasks.find((candidate) => candidate.taskId === "A")?.acceptance.status,
        "accepted",
      );
      assert.deepEqual(yield* executionSnapshot(), beforeReview);
      yield* orchestrator.dispatch(
        patch(bound.coordinator.parentThreadId, "propose-new-A-scope", reviewed!.version, [
          {
            type: "edit_task",
            taskId: "A",
            changes: { prompt: "Proposed A/r2 must not replace accepted A/r1 inputs." },
          },
        ]),
      );
      yield* orchestrator.dispatch(
        requestPlanTask(bound.coordinator, "dependency-ready", { taskId: "B", revision: 1 }),
      );
      const afterDependency = yield* projections.getTeamPlan(bound.coordinator.parentThreadId);
      const dependent = afterDependency?.tasks.find((candidate) => candidate.taskId === "B");
      assert.equal(dependent?.executions.length, 1);
      assert.notEqual(dependent?.executions[0]?.threadId, bound.execution.threadId);
      const dependentTask = (yield* orchestrator.getThreadProjection(
        bound.coordinator.parentThreadId,
      )).subagents.find((candidate) => candidate.id === dependent?.executions[0]?.subagentId)!;
      assert.include(
        dependentTask.prompt,
        "Act as the research sub-agent for this task.\n\nRead only synthetic fixture B",
      );
      assert.notInclude(dependentTask.prompt, laterReport);
      assert.notInclude(dependentTask.prompt, "Proposed A/r2");
      assert.notInclude(dependentTask.prompt, "/synthetic/unrelated-later-worktree");
      assert.notInclude(dependentTask.prompt, "unrelated-later-branch");
      const handoff = JSON.parse(
        dependentTask.prompt.split("\n```json\n")[1]!.split("\n```")[0]!,
      ) as {
        dependencies: Array<{
          taskId: string;
          revision: number;
          executions: Array<{
            threadId: string;
            runId: string;
            result: string;
            checkpoint: unknown;
          }>;
        }>;
      };
      assert.equal(handoff.dependencies[0]?.taskId, "A");
      assert.equal(handoff.dependencies[0]?.revision, 1);
      assert.deepEqual(
        handoff.dependencies[0]?.executions.map(({ threadId, runId, result, checkpoint }) => ({
          threadId,
          runId,
          result,
          checkpoint,
        })),
        [
          {
            threadId: bound.execution.threadId,
            runId: original.id,
            result: originalReport,
            checkpoint: null,
          },
        ],
      );
      assert.equal(
        (yield* projections.getThreadRecords(bound.coordinator.parentThreadId, ["subagents"]))
          .subagents.length,
        2,
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["failed", "cancelled"] as const)(
  "records issues and blockers for a %s child while refusing acceptance",
  (status) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const bound = yield* boundTaskA(`terminal-${status}`);
      const run = bound.child.runs[0]!;
      const task = bound.parent.subagents[0]!;
      yield* sink.write({
        events: [
          {
            id: EventId.make(`event:terminal-run-${status}`),
            type: "run.updated",
            threadId: bound.execution.threadId,
            runId: run.id,
            occurredAt: now,
            payload: { ...run, status, completedAt: now },
          },
          {
            id: EventId.make(`event:terminal-task-${status}`),
            type: "subagent.updated",
            threadId: bound.coordinator.parentThreadId,
            occurredAt: now,
            payload: { ...task, status },
          },
        ],
      });
      const before = yield* executionSnapshot();
      const accepted = patch(
        bound.coordinator.parentThreadId,
        "accept-terminal",
        bound.plan.version,
        [
          {
            type: "accept_task",
            taskId: "A",
            revision: 1,
            status: "accepted",
            note: "A terminal failure must not pass acceptance",
          },
        ],
        "agent",
      );
      const error = yield* orchestrator.dispatch(accepted).pipe(Effect.flip);
      assert.instanceOf(error, Orchestrator.OrchestratorTeamPlanPatchError);
      if (error._tag === "OrchestratorTeamPlanPatchError")
        assert.equal(error.reason, "execution-not-completed");
      assert.deepEqual(
        yield* projections.getTeamPlan(bound.coordinator.parentThreadId),
        bound.plan,
      );
      let version = bound.plan.version;
      for (const review of ["issues", "blocked"] as const) {
        yield* orchestrator.dispatch(
          patch(
            bound.coordinator.parentThreadId,
            `report-${review}`,
            version,
            [
              {
                type: "accept_task",
                taskId: "A",
                revision: 1,
                status: review,
                note: `Synthetic child ended ${status}; coordinator reports ${review}`,
              },
            ],
            "agent",
          ),
        );
        version++;
        const plan = yield* projections.getTeamPlan(bound.coordinator.parentThreadId);
        const acceptance = plan?.tasks.find((candidate) => candidate.taskId === "A")?.acceptance;
        assert.equal(acceptance?.status, review);
        assert.equal(acceptance?.actor, "coordinator");
        assert.equal(acceptance?.reviewerThreadId, bound.coordinator.parentThreadId);
        assert.deepEqual(yield* executionSnapshot(), before);
      }
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "requires every linked execution to complete before accepting a partially successful task",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const bound = yield* boundTaskA("partial-success");
      yield* orchestrator.dispatch(
        patch(bound.coordinator.parentThreadId, "add-second-worker", bound.plan.version, [
          {
            type: "add_task",
            task: {
              taskId: "C",
              title: "Synthetic second worker",
              prompt: "Read only synthetic fixture C",
              role: "research",
              modelSelection,
              dependencies: [],
              priority: 2,
            },
          },
          { type: "confirm_task", taskId: "C", revision: 1 },
        ]),
      );
      yield* orchestrator.dispatch(
        requestPlanTask(bound.coordinator, "second-worker", { taskId: "C", revision: 1 }),
      );
      const withSecondWorker = yield* projections.getTeamPlan(bound.coordinator.parentThreadId);
      const secondExecution = withSecondWorker?.tasks.find((task) => task.taskId === "C")
        ?.executions[0];
      if (withSecondWorker === null || secondExecution === undefined)
        return yield* Effect.die("Synthetic second worker has no real owned execution");
      const secondChild = yield* projections.getThreadProjection(secondExecution.threadId);
      const parent = yield* projections.getThreadRecords(bound.coordinator.parentThreadId, [
        "subagents",
      ]);
      yield* orchestrator.dispatch(
        patch(bound.coordinator.parentThreadId, "link-second-execution", withSecondWorker.version, [
          { type: "bind_execution", taskId: "A", revision: 1, execution: secondExecution },
        ]),
      );
      const linked = yield* projections.getTeamPlan(bound.coordinator.parentThreadId);
      if (linked === null) return yield* Effect.die("Synthetic plan lost linked executions");
      assert.equal(linked.tasks.find((task) => task.taskId === "A")?.executions.length, 2);
      const originalRun = bound.child.runs[0]!;
      const secondRun = secondChild.runs[0]!;
      const originalTask = parent.subagents.find((task) => task.id === bound.execution.subagentId)!;
      const secondTask = parent.subagents.find((task) => task.id === secondExecution.subagentId)!;
      yield* sink.write({
        events: [
          {
            id: EventId.make("event:partial-success-first-run"),
            type: "run.updated",
            threadId: bound.execution.threadId,
            runId: originalRun.id,
            occurredAt: now,
            payload: { ...originalRun, status: "completed", completedAt: now },
          },
          {
            id: EventId.make("event:partial-success-first-task"),
            type: "subagent.updated",
            threadId: bound.coordinator.parentThreadId,
            occurredAt: now,
            payload: { ...originalTask, status: "completed" },
          },
          {
            id: EventId.make("event:partial-success-second-run"),
            type: "run.updated",
            threadId: secondExecution.threadId,
            runId: secondRun.id,
            occurredAt: now,
            payload: { ...secondRun, status: "failed", completedAt: now },
          },
          {
            id: EventId.make("event:partial-success-second-task"),
            type: "subagent.updated",
            threadId: bound.coordinator.parentThreadId,
            occurredAt: now,
            payload: { ...secondTask, status: "failed" },
          },
        ],
      });
      const before = yield* executionSnapshot();
      const verdict = patch(
        bound.coordinator.parentThreadId,
        "partial-verdict",
        linked.version,
        [
          {
            type: "accept_task",
            taskId: "A",
            revision: 1,
            status: "accepted",
            note: "One worker completed and another failed",
          },
        ],
        "agent",
      );
      const refused = yield* orchestrator.dispatch(verdict).pipe(Effect.flip);
      assert.instanceOf(refused, Orchestrator.OrchestratorTeamPlanPatchError);
      if (refused._tag === "OrchestratorTeamPlanPatchError")
        assert.equal(refused.reason, "execution-not-completed");
      assert.deepEqual(yield* projections.getTeamPlan(bound.coordinator.parentThreadId), linked);
      assert.deepEqual(yield* executionSnapshot(), before);
      yield* orchestrator.dispatch(
        patch(
          bound.coordinator.parentThreadId,
          "report-partial-issue",
          linked.version,
          [
            {
              type: "accept_task",
              taskId: "A",
              revision: 1,
              status: "issues",
              note: "The second synthetic worker failed; review is incomplete",
            },
          ],
          "agent",
        ),
      );
      assert.equal(
        (yield* projections.getTeamPlan(bound.coordinator.parentThreadId))?.tasks.find(
          (task) => task.taskId === "A",
        )?.acceptance.status,
        "issues",
      );
      assert.deepEqual(yield* executionSnapshot(), before);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("accepts only one concurrent patch against the same persisted version", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:team-plan-crud:cas");
    yield* createThread(threadId);
    yield* orchestrator.dispatch(patch(threadId, "initial", 0, initialOperations));
    const sequence = yield* orchestrator.getThreadEventSequence(threadId);
    const commands = ["first", "second"].map((key) =>
      patch(threadId, key, 1, [{ type: "set_goal", goal: `Goal from ${key}` }]),
    );
    const outcomes = yield* Effect.forEach(
      commands,
      (command) => orchestrator.dispatch(command).pipe(Effect.result),
      { concurrency: "unbounded" },
    );
    const successes = outcomes.filter(Result.isSuccess);
    const failures = outcomes.filter(Result.isFailure);
    assert.equal(successes.length, 1);
    assert.equal(failures.length, 1);
    const winner = outcomes.findIndex(Result.isSuccess);
    const error = failures[0]!.failure;
    assert.instanceOf(error, Orchestrator.OrchestratorTeamPlanPatchError);
    if (error._tag === "OrchestratorTeamPlanPatchError") {
      assert.equal(error.reason, "version-conflict");
      assert.equal(error.expectedPlanVersion, 1);
      assert.equal(error.actualPlanVersion, 2);
    }
    const plan = yield* projections.getTeamPlan(threadId);
    assert.equal(plan?.version, 2);
    assert.equal(plan?.goal, winner === 0 ? "Goal from first" : "Goal from second");
    assert.equal(yield* orchestrator.getThreadEventSequence(threadId), sequence + 1);
    for (const command of commands) yield* assertNoExecution(threadId, command.commandId);
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "requires a user to confirm the plan or task and keeps confirmation free of execution",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:team-plan-crud:confirmation");
      yield* createThread(threadId);
      const initial = patch(threadId, "agent-draft", 0, initialOperations, "agent");
      yield* orchestrator.dispatch(initial);
      const draft = yield* projections.getTeamPlan(threadId);
      assert.isNotNull(draft);
      if (draft === null) return;
      const operations: ReadonlyArray<TeamPlanOperation> = [
        { type: "confirm_plan", revision: draft.revision },
        { type: "confirm_task", taskId: "readme", revision: 1 },
      ];
      for (const [index, operation] of operations.entries()) {
        const refused = patch(threadId, `agent-confirm:${index}`, 1, [operation], "agent");
        const error = yield* orchestrator.dispatch(refused).pipe(Effect.flip);
        assert.instanceOf(error, Orchestrator.OrchestratorTeamPlanPatchError);
        if (error._tag === "OrchestratorTeamPlanPatchError")
          assert.equal(error.reason, "user-confirmation-required");
        assert.deepEqual(yield* projections.getTeamPlan(threadId), draft);
        yield* assertNoExecution(threadId, refused.commandId);
      }
      const confirm = patch(threadId, "user-confirm", 1, [operations[0]!]);
      yield* orchestrator.dispatch(confirm);
      const confirmed = yield* projections.getTeamPlan(threadId);
      assert.equal(confirmed?.version, 2);
      assert.equal(confirmed?.confirmedRevision, draft.revision);
      assert.isTrue(confirmed?.tasks.every((task) => task.confirmedRevision === task.revision));
      yield* assertNoExecution(threadId, initial.commandId);
      yield* assertNoExecution(threadId, confirm.commandId);
    }).pipe(Effect.provide(layerTest)),
);
