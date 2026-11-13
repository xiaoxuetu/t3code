import * as NodeURL from "node:url";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  isProviderNativeSubagentThread,
  MessageId,
  type ModelSelection,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpTeamPlanResult,
  OrchestratorMcpThreadInterruptResult,
  OrchestratorMcpThreadSendResult,
  OrchestratorMcpThreadReadResult,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import { McpSchema, McpServer } from "effect/ai";

import { CodexOrchestratorReplayHarness } from "../orchestration-v2/Adapters/CodexAdapterV2.testkit.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import {
  decodeProviderReplayNdjson,
  materializeReplayTranscriptWorkspace,
} from "@t3tools/provider-testing/replayTranscript";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as PeerLinkRequests from "../peer/PeerLinkRequests.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";

const layerOrchestratorToolkit = McpHttpServer.layerOrchestratorToolkit.pipe(
  Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
  Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
);

/** A task delegated here always has a local child thread. */
const localChild = (childThreadId: ThreadId | null): ThreadId => {
  if (childThreadId === null) throw new Error("expected a local delegated child");
  return childThreadId;
};

// Effect returns a declared tool failure as `isError` with its encoded payload
// as JSON text, never as `structuredContent`.

const parentThreadId = ThreadId.make("thread:mcp-orchestrator-parent");
const projectId = ProjectId.make("project:mcp-orchestrator");
const codexInstanceId = ProviderInstanceId.make("codex");
const codexModel = "gpt-5.4";
const parentPrompt = "Keep this parent turn active while orchestration tools are tested.";
const delegatedPrompt = "Inspect the delegated API boundary and return the result.";
const delegatedResult = "Delegated API boundary inspected.";
const cancellationPrompt = "Remain active until the parent cancels this delegated task.";
const queuedFollowupPrompt = "Complete the queued follow-up and return the final result.";
const queuedFollowupResult = "Queued delegated follow-up completed.";
const decodeThreadRead = Schema.decodeUnknownEffect(OrchestratorMcpThreadReadResult);
const longFollowupResult = "Long delegated follow-up line. ".repeat(1_500);

const decodeDelegateTaskResult = Schema.decodeUnknownEffect(OrchestratorMcpDelegateTaskResult);
const decodeThreadInterruptResult = Schema.decodeUnknownEffect(
  OrchestratorMcpThreadInterruptResult,
);
const decodeThreadSendResult = Schema.decodeUnknownEffect(OrchestratorMcpThreadSendResult);

const codexSelection = {
  instanceId: codexInstanceId,
  model: codexModel,
} satisfies ModelSelection;

const delegatedTaskStatusTranscriptFile = new URL(
  "../orchestration-v2/testkit/fixtures/delegated_task_status/codex_transcript.ndjson",
  import.meta.url,
);

const readDelegatedTaskStatusTranscript = Effect.fn("readDelegatedTaskStatusTranscript")(
  function* (followupResult: string) {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(NodeURL.fileURLToPath(delegatedTaskStatusTranscriptFile));
    const transcript = yield* decodeProviderReplayNdjson(
      text.replaceAll(queuedFollowupResult, followupResult),
    );
    // The recording ends when the recorder closes the app-server while the parent
    // turn is still open. This test keeps acting as that parent afterwards, and
    // replaying the exit would kill the shared process and fail the parent run.
    return {
      ...transcript,
      entries: transcript.entries.filter((entry) => entry.type !== "runtime_exit"),
    };
  },
  Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

function makeProviderSnapshot(input: {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly model: string;
  readonly optionDescriptors?: ReadonlyArray<ProviderOptionDescriptor>;
}): ServerProvider {
  return {
    instanceId: input.instanceId,
    driver: input.driver,
    enabled: true,
    installed: true,
    version: "test",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-06-17T00:00:00.000Z",
    models: [
      {
        slug: input.model,
        name: input.model,
        isCustom: false,
        capabilities:
          input.optionDescriptors === undefined
            ? null
            : { optionDescriptors: input.optionDescriptors },
      },
    ],
    slashCommands: [],
    skills: [],
  };
}

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "orchestrator-mcp-test", version: "1.0.0" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "orchestrator-mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const layerMemorySecretStore = Layer.sync(ServerSecretStore.ServerSecretStore, () => {
  const stored = new Map<string, Uint8Array>();
  return ServerSecretStore.ServerSecretStore.of({
    get: (name) => Effect.succeed(Option.fromNullishOr(stored.get(name))),
    set: (name, value) => Effect.sync(() => void stored.set(name, value)),
    create: (name, value) => Effect.sync(() => void stored.set(name, value)),
    getOrCreateRandom: (name, bytes) =>
      Effect.sync(() => {
        const existing = stored.get(name);
        if (existing) return existing;
        const value = new Uint8Array(bytes).fill(7);
        stored.set(name, value);
        return value;
      }),
    remove: (name) => Effect.sync(() => void stored.delete(name)),
  });
});

const layerUnusedScheduledTaskStub = Layer.succeed(
  ScheduledTaskService.ScheduledTaskService,
  ScheduledTaskService.ScheduledTaskService.of({
    list: () => Effect.succeed({ tasks: [] }),
    subscribeList: () => Stream.succeed({ tasks: [] }),
    upsert: () => Effect.die("ScheduledTaskService.upsert is unused in this test"),
    setEnabled: () => Effect.die("ScheduledTaskService.setEnabled is unused in this test"),
    delete: () => Effect.die("ScheduledTaskService.delete is unused in this test"),
    deleteForThread: () => Effect.die("unused in this test"),
    moveThreadTasks: () => Effect.die("unused in this test"),
    runNow: () => Effect.die("ScheduledTaskService.runNow is unused in this test"),
    rotateWebhookToken: () => Effect.die("unused in this test"),
    listWebhookDeliveries: () => Effect.die("unused in this test"),
    getWebhookDelivery: () => Effect.die("unused in this test"),
    triggerWebhook: () => Effect.die("unused in this test"),
  }),
);

describe("orchestrator MCP toolkit", () => {
  it.effect("owns team-plan metadata through MCP without starting any worker", () =>
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("mcp-team-plan-metadata");
      const registry = ProviderAdapterRegistry.layerFromAdapters([
        {
          instanceId: codexInstanceId,
          driver: ProviderDriverKind.make("codex"),
          getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
          planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
          openSession: () => Effect.die("The metadata test must never open a provider session."),
        },
      ]);
      const database = SqlitePersistence.layerMemory;
      const settings = ServerSettings.layerTest();
      const orchestration = ProviderReplayHarness.layerWithRegistry(
        { name: "mcp-team-plan-metadata", runtimePolicyOverride: { cwd } },
        registry,
        { databaseLayer: database, runEffectWorker: false },
      );
      const threads = ThreadManagementService.layer.pipe(
        Layer.provideMerge(orchestration),
        Layer.provide(settings),
        Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(database))),
      );
      const testLayer = layerOrchestratorToolkit.pipe(
        Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
        Layer.provideMerge(threads),
        Layer.provide(registry),
        Layer.provide(ProviderRegistryMock.layer([])),
        Layer.provide(settings),
        Layer.provide(layerUnusedScheduledTaskStub),
        Layer.provide(Layer.mock(PeerForwarding.PeerForwarding)({})),
        Layer.provide(Layer.mock(PeerLinkRequests.PeerLinkRequests)({})),
        Layer.provide(Layer.mock(PeerLinks.PeerLinks)({})),
        Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
        Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
        Layer.provide(Layer.mock(RemoteDelegation.RemoteDelegation)({})),
        Layer.provide(Layer.mock(SecretResolver.SecretResolver)({})),
        Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const server = yield* McpServer.McpServer;
        const otherThreadId = ThreadId.make("thread:team-plan-other");
        const scope: McpInvocationContext.McpInvocationScope = {
          environmentId: EnvironmentId.make("environment:mcp-team-plan-metadata"),
          requestNamespace: "metadata-session",
          thread: {
            threadId: parentThreadId,
            providerSessionId: "metadata-session",
            providerInstanceId: codexInstanceId,
          },
          client: undefined,
          capabilities: new Set(["orchestration"]),
          issuedAt: 1,
        };
        const invoke = (args: Record<string, unknown>, caller = scope) =>
          server
            .callTool({ name: "team_plan", arguments: args })
            .pipe(
              Effect.provideService(McpInvocationContext.McpInvocationContext, caller),
              Effect.provideService(McpSchema.McpServerClient, client),
            );
        const decodePlan = Schema.decodeUnknownEffect(OrchestratorMcpTeamPlanResult);
        const failureCode = (result: {
          readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
        }) =>
          (
            JSON.parse(
              result.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
            ) as { code: string }
          ).code;
        for (const threadId of [parentThreadId, otherThreadId]) {
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`metadata:create:${threadId}`),
            createdBy: "user",
            creationSource: "web",
            threadId,
            projectId,
            title: "Metadata owner",
            modelSelection: codexSelection,
            runtimeMode: "approval-required",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
          });
        }
        expect(yield* decodePlan((yield* invoke({ action: "read" })).structuredContent)).toEqual({
          threadId: parentThreadId,
          plan: null,
        });
        const patch = {
          action: "patch",
          expectedPlanVersion: 0,
          clientRequestId: "metadata-draft",
          operations: [
            { type: "set_goal", goal: "Draft only, no execution" },
            {
              type: "add_task",
              task: {
                taskId: "T1",
                title: "Planned work",
                prompt: "Do not execute in this test.",
                role: "research",
                priority: 1,
                modelSelection: null,
                dependencies: [],
              },
            },
          ],
        };
        expect(failureCode(yield* invoke(patch))).toBe("parent_not_active");
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("metadata:active-owner"),
          createdBy: "user",
          creationSource: "web",
          threadId: parentThreadId,
          messageId: MessageId.make("metadata:active-owner"),
          text: "Maintain metadata only.",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
        });
        expect(
          failureCode(
            yield* invoke(
              { action: "read" },
              {
                ...scope,
                thread: undefined,
                client: { sessionId: "outside", label: "outside", access: "full-access" },
              },
            ),
          ),
        ).toBe("thread_credential_required");
        expect(
          failureCode(
            yield* invoke({ action: "read" }, { ...scope, capabilities: new Set(["preview"]) }),
          ),
        ).toBe("capability_denied");
        const mismatched = {
          ...scope,
          thread: { ...scope.thread!, providerInstanceId: ProviderInstanceId.make("wrong-owner") },
        };
        expect(failureCode(yield* invoke(patch, mismatched))).toBe("parent_not_active");
        const draft = yield* decodePlan((yield* invoke(patch)).structuredContent);
        expect(draft.plan?.version).toBe(1);
        expect(draft.plan?.confirmedRevision).toBeNull();
        expect(yield* decodePlan((yield* invoke(patch)).structuredContent)).toEqual(draft);
        const remoteWithoutRef = yield* server
          .callTool({
            name: "delegate_task",
            arguments: {
              task: "Do not dispatch an unconfirmed plan through a remote target.",
              target: { environmentId: "environment:other-isolated-test" },
              mode: "async",
            },
          })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
        expect(failureCode(remoteWithoutRef)).toBe("invalid_request");
        const stale = yield* invoke({ ...patch, clientRequestId: "metadata-stale" });
        expect(failureCode(stale)).toBe("invalid_request");
        expect(yield* decodePlan((yield* invoke({ action: "read" })).structuredContent)).toEqual(
          draft,
        );
        const otherScope = { ...scope, thread: { ...scope.thread!, threadId: otherThreadId } };
        const crossThread = yield* invoke(
          { action: "read", threadId: parentThreadId },
          otherScope,
        ).pipe(Effect.exit);
        expect(Exit.isFailure(crossThread)).toBe(true);
        expect(
          yield* decodePlan((yield* invoke({ action: "read" }, otherScope)).structuredContent),
        ).toEqual({ threadId: otherThreadId, plan: null });
        yield* orchestrator.dispatch({
          type: "thread.team-plan.patch",
          commandId: CommandId.make("metadata:user-confirm"),
          threadId: parentThreadId,
          createdBy: "user",
          creationSource: "web",
          expectedPlanVersion: draft.plan!.version,
          operations: [{ type: "confirm_plan", revision: draft.plan!.revision }],
        });
        const confirmed = yield* decodePlan((yield* invoke({ action: "read" })).structuredContent);
        expect(confirmed.plan?.confirmedRevision).toBe(confirmed.plan?.revision);
        expect((yield* orchestrator.getThreadProjection(parentThreadId)).subagents).toHaveLength(0);
        expect((yield* orchestrator.getThreadProjection(otherThreadId)).teamPlan).toBeNull();
      }).pipe(Effect.provide(testLayer));
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect(
    "persists coordinator plans without granting agent confirmation or duplicate dispatch",
    () =>
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("mcp-team-plan");
        const registry = ProviderAdapterRegistry.layerFromAdapters([
          {
            instanceId: codexInstanceId,
            driver: ProviderDriverKind.make("codex"),
            getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
            planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
            openSession: () => Effect.die("This integration test never starts a provider."),
          },
        ]);
        const database = SqlitePersistence.layerMemory;
        const settings = ServerSettings.layerTest();
        const orchestration = ProviderReplayHarness.layerWithRegistry(
          { name: "mcp-team-plan", runtimePolicyOverride: { cwd } },
          registry,
          { databaseLayer: database, runEffectWorker: false },
        );
        const threads = ThreadManagementService.layer.pipe(
          Layer.provideMerge(orchestration),
          Layer.provide(settings),
          Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(database))),
        );
        const testLayer = layerOrchestratorToolkit.pipe(
          Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
          Layer.provideMerge(threads),
          Layer.provide(registry),
          Layer.provide(
            ProviderRegistryMock.layer([
              makeProviderSnapshot({
                instanceId: codexInstanceId,
                driver: ProviderDriverKind.make("codex"),
                model: codexModel,
              }),
            ]),
          ),
          Layer.provide(settings),
          Layer.provide(layerUnusedScheduledTaskStub),
          Layer.provide(Layer.mock(PeerForwarding.PeerForwarding)({})),
          Layer.provide(Layer.mock(PeerLinkRequests.PeerLinkRequests)({})),
          Layer.provide(Layer.mock(PeerLinks.PeerLinks)({})),
          Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
          Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
          Layer.provide(Layer.mock(RemoteDelegation.RemoteDelegation)({})),
          Layer.provide(Layer.mock(SecretResolver.SecretResolver)({})),
          Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const server = yield* McpServer.McpServer;
          const scope: McpInvocationContext.McpInvocationScope = {
            environmentId: EnvironmentId.make("environment:mcp-team-plan"),
            requestNamespace: "team-plan-session-1",
            thread: {
              threadId: parentThreadId,
              providerSessionId: "team-plan-session-1",
              providerInstanceId: codexInstanceId,
            },
            client: undefined,
            capabilities: new Set(["orchestration"]),
            issuedAt: 1,
          };
          const invoke = (name: string, args: Record<string, unknown>, caller = scope) =>
            server
              .callTool({ name, arguments: args })
              .pipe(
                Effect.provideService(McpInvocationContext.McpInvocationContext, caller),
                Effect.provideService(McpSchema.McpServerClient, client),
              );
          const decodePlan = Schema.decodeUnknownEffect(OrchestratorMcpTeamPlanResult);
          const failureCode = (result: {
            readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
          }) => {
            const value = JSON.parse(
              result.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
            ) as { code: string };
            return value.code;
          };
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("team-plan:create"),
            createdBy: "user",
            creationSource: "web",
            threadId: parentThreadId,
            projectId,
            title: "Coordinator",
            modelSelection: codexSelection,
            runtimeMode: "approval-required",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
          });
          const empty = yield* invoke("team_plan", { action: "read" });
          expect(yield* decodePlan(empty.structuredContent)).toEqual({
            threadId: parentThreadId,
            plan: null,
          });
          const draft = {
            action: "patch",
            expectedPlanVersion: 0,
            clientRequestId: "draft-1",
            operations: [
              { type: "set_goal", goal: "Inspect a fixture" },
              {
                type: "add_task",
                task: {
                  taskId: "T1",
                  title: "Read README",
                  prompt: "Read README only.",
                  role: "research",
                  priority: 1,
                  modelSelection: codexSelection,
                  dependencies: [],
                },
              },
            ],
          };
          expect(failureCode(yield* invoke("team_plan", draft))).toBe("parent_not_active");
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("team-plan:start"),
            createdBy: "user",
            creationSource: "web",
            threadId: parentThreadId,
            messageId: MessageId.make("team-plan:start"),
            text: "Prepare a team plan.",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
          });
          const external: McpInvocationContext.McpInvocationScope = {
            ...scope,
            thread: undefined,
            client: { sessionId: "outside", label: "outside", access: "full-access" },
          };
          expect(failureCode(yield* invoke("team_plan", { action: "read" }, external))).toBe(
            "thread_credential_required",
          );
          expect(
            failureCode(
              yield* invoke("team_plan", draft, { ...scope, capabilities: new Set(["preview"]) }),
            ),
          ).toBe("capability_denied");
          const drafted = yield* decodePlan((yield* invoke("team_plan", draft)).structuredContent);
          expect(drafted.plan?.version).toBe(1);
          expect(drafted.plan?.confirmedRevision).toBeNull();
          const duplicateDraft = yield* decodePlan(
            (yield* invoke("team_plan", draft)).structuredContent,
          );
          expect(duplicateDraft).toEqual(drafted);
          const stale = yield* invoke("team_plan", { ...draft, clientRequestId: "stale-draft" });
          expect(stale.isError).toBe(true);
          expect(
            yield* decodePlan((yield* invoke("team_plan", { action: "read" })).structuredContent),
          ).toEqual(drafted);
          const plan = drafted.plan!;
          const ref = { taskId: "T1", revision: plan.tasks[0]!.revision };
          const delegation = {
            task: "Read README only.",
            title: "T1: Read README",
            role: "research",
            planTaskRef: ref,
            target: { providerInstanceId: codexInstanceId, model: codexModel },
            isolation: "shared",
            mode: "async",
            clientRequestId: "dispatch-session-1",
          };
          expect((yield* invoke("delegate_task", delegation)).isError).toBe(true);
          expect((yield* orchestrator.getThreadProjection(parentThreadId)).subagents).toHaveLength(
            0,
          );
          yield* orchestrator.dispatch({
            type: "thread.team-plan.patch",
            commandId: CommandId.make("team-plan:user-confirm"),
            threadId: parentThreadId,
            createdBy: "user",
            creationSource: "web",
            expectedPlanVersion: plan.version,
            operations: [{ type: "confirm_plan", revision: plan.revision }],
          });
          const first = yield* decodeDelegateTaskResult(
            (yield* invoke("delegate_task", delegation)).structuredContent,
          );
          const secondScope = {
            ...scope,
            requestNamespace: "team-plan-session-2",
            thread: { ...scope.thread!, providerSessionId: "team-plan-session-2" },
          };
          const repeated = yield* decodeDelegateTaskResult(
            (yield* invoke(
              "delegate_task",
              { ...delegation, clientRequestId: "different-session-key" },
              secondScope,
            )).structuredContent,
          );
          expect(repeated.taskId).toBe(first.taskId);
          expect(repeated.childThreadId).toBe(first.childThreadId);
          expect((yield* orchestrator.getThreadProjection(parentThreadId)).subagents).toHaveLength(
            1,
          );
          const linked = yield* decodePlan(
            (yield* invoke("team_plan", { action: "read" })).structuredContent,
          );
          expect(linked.plan?.tasks[0]?.executions).toHaveLength(1);
          const childScope = {
            ...scope,
            requestNamespace: "child-session",
            thread: {
              threadId: localChild(first.childThreadId),
              providerSessionId: "child-session",
              providerInstanceId: codexInstanceId,
            },
          };
          const foreignPlanRead = yield* invoke(
            "team_plan",
            { action: "read", threadId: parentThreadId },
            childScope,
          ).pipe(Effect.flip);
          expect(foreignPlanRead).toMatchObject({
            _tag: "InvalidParams",
            code: -32602,
            message: expect.stringContaining('Unknown argument "threadId"'),
          });
          const childPlan = yield* decodePlan(
            (yield* invoke("team_plan", { action: "read" }, childScope)).structuredContent,
          );
          expect(childPlan.threadId).toBe(first.childThreadId);
          expect(childPlan.plan).toBeNull();
          const prematureAcceptance = yield* invoke("team_plan", {
            action: "patch",
            expectedPlanVersion: linked.plan!.version,
            operations: [
              {
                type: "accept_task",
                ...ref,
                status: "accepted",
                note: "Cannot accept an unfinished worker.",
              },
            ],
          });
          expect(prematureAcceptance.isError).toBe(true);
          const after = yield* decodePlan(
            (yield* invoke("team_plan", { action: "read" })).structuredContent,
          );
          expect(after).toEqual(linked);
        }).pipe(Effect.provide(testLayer));
      }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.live.each([
    { label: "distinct", result: queuedFollowupResult, latestSummary: queuedFollowupResult },
    { label: "identical", result: delegatedResult, latestSummary: null },
    { label: "emoji", result: "😀", latestSummary: "😀" },
    { label: "long", result: longFollowupResult, latestSummary: longFollowupResult },
  ])("reports $label child results", ({ result, latestSummary }) =>
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("delegated-task-status");
      const rawTranscript = yield* readDelegatedTaskStatusTranscript(result);
      const transcript = yield* CodexOrchestratorReplayHarness.decodeTranscript(
        materializeReplayTranscriptWorkspace(rawTranscript, cwd),
      );
      const layerOrchestrator = ProviderReplayHarness.layerProviderReplay(
        {
          name: "delegated-task-status/codex",
          transcript,
          commands: [],
          runtimePolicyOverride: { cwd },
        },
        CodexOrchestratorReplayHarness,
      );
      // SQL spans carry no bound parameters, so this records which thread each tool read.
      const threadRecordReads: Array<{
        readonly threadId: ThreadId;
        readonly fields: ReadonlyArray<string>;
      }> = [];
      const layerOrchestration = Layer.merge(
        layerOrchestrator,
        Layer.effect(
          ThreadManagementService.ThreadManagementService,
          Effect.gen(function* () {
            const service = yield* ThreadManagementService.ThreadManagementService;
            return ThreadManagementService.ThreadManagementService.of({
              ...service,
              getThreadRecords: (threadId, fields, filter) =>
                Effect.sync(() => threadRecordReads.push({ threadId, fields })).pipe(
                  Effect.andThen(service.getThreadRecords(threadId, fields, filter)),
                ),
            });
          }),
        ).pipe(
          Layer.provide(
            ThreadManagementService.layer.pipe(
              Layer.provide(layerOrchestrator),
              Layer.provide(ServerSettings.layerTest()),
              Layer.provide(
                CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
              ),
            ),
          ),
        ),
      );
      const layerProviderRegistry = ProviderRegistryMock.layer([
        makeProviderSnapshot({
          instanceId: codexInstanceId,
          driver: ProviderDriverKind.make("codex"),
          model: codexModel,
        }),
      ]);
      const layerTest = layerOrchestratorToolkit.pipe(
        Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
        Layer.provideMerge(layerOrchestration),
        Layer.provide(
          CodexOrchestratorReplayHarness.makeProviderAdapterRegistryLayer(transcript).pipe(
            Layer.provide(McpProviderSessions.layer),
          ),
        ),
        Layer.provide(layerProviderRegistry),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(layerUnusedScheduledTaskStub),
        Layer.provide(Layer.mock(PeerForwarding.PeerForwarding)({})),
        Layer.provide(Layer.mock(PeerLinkRequests.PeerLinkRequests)({})),
        Layer.provide(Layer.mock(PeerLinks.PeerLinks)({})),
        Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
        Layer.provideMerge(
          SecretRequests.layer.pipe(
            Layer.provide(layerMemorySecretStore),
            Layer.provide(Layer.mock(SecretResolver.SecretResolver)({})),
            Layer.provide(layerOrchestration),
          ),
        ),
        Layer.provide(Layer.mock(RemoteDelegation.RemoteDelegation)({})),
        Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      );

      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const server = yield* McpServer.McpServer;
        const parentCreate = yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:mcp-replay-parent:create"),
          threadId: parentThreadId,
          projectId,
          title: "MCP replay parent",
          modelSelection: codexSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:mcp-replay-parent:start"),
          threadId: parentThreadId,
          messageId: MessageId.make("message:mcp-replay-parent:start"),
          text: parentPrompt,
          attachments: [],
          modelSelection: codexSelection,
          dispatchMode: { type: "start_immediately" },
        });
        yield* orchestrator
          .streamStoredEventsFrom({
            threadId: parentThreadId,
            afterSequence: parentCreate.sequence,
          })
          .pipe(
            Stream.filter(
              (stored) =>
                stored.event.type === "provider-turn.updated" &&
                stored.event.payload.status === "running",
            ),
            Stream.runHead,
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.die("Parent provider turn did not start."),
                onSome: () => Effect.void,
              }),
            ),
          );

        const invocation: McpInvocationContext.McpInvocationScope = {
          environmentId: EnvironmentId.make("environment:mcp-replay"),
          requestNamespace: "mcp-provider-session-replay-parent",
          thread: {
            threadId: parentThreadId,
            providerSessionId: "mcp-provider-session-replay-parent",
            providerInstanceId: codexInstanceId,
          },
          client: undefined,
          capabilities: new Set(["orchestration"]),
          issuedAt: 1,
        };
        const invoke = (name: string, args: Record<string, unknown>, scope = invocation) =>
          server
            .callTool({ name, arguments: args })
            .pipe(
              Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
              Effect.provideService(McpSchema.McpServerClient, client),
            );

        const delegationStartSequence = yield* orchestrator.getThreadEventSequence(parentThreadId);
        const delegatedCall = yield* invoke("delegate_task", {
          task: delegatedPrompt,
          target: {
            providerInstanceId: codexInstanceId,
            model: codexModel,
          },
          mode: "async",
          clientRequestId: "delegate-codex-replay-1",
        });
        const delegatedStart = yield* decodeDelegateTaskResult(
          delegatedCall.structuredContent,
        ).pipe(Effect.orDie);
        expect(delegatedStart.childRunId).not.toBeNull();
        yield* orchestrator
          .streamStoredEventsFrom({
            threadId: parentThreadId,
            afterSequence: delegationStartSequence,
          })
          .pipe(
            Stream.filter(
              (stored) =>
                stored.event.type === "context-transfer.created" &&
                stored.event.payload.type === "subagent_result" &&
                stored.event.payload.sourceThreadId === delegatedStart.childThreadId &&
                stored.event.payload.sourcePoint.runId === delegatedStart.childRunId,
            ),
            Stream.runHead,
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.die("Delegated result transfer was not created."),
                onSome: () => Effect.void,
              }),
            ),
          );
        const delegatedStatusCall = yield* invoke("task_status", {
          taskId: delegatedStart.taskId,
        });
        const delegated = yield* decodeDelegateTaskResult(
          delegatedStatusCall.structuredContent,
        ).pipe(Effect.orDie);
        expect(delegated).toMatchObject({
          status: "completed",
          summary: delegatedResult,
          providerInstanceId: codexInstanceId,
          hasPendingChildRuns: false,
          latestTerminalRunId: delegated.childRunId,
          latestTerminalStatus: "completed",
          latestTerminalSummary: null,
          latestTerminalResultContextTransferId: null,
        });
        expect(delegated.resultContextTransferId).not.toBeNull();

        const delegatedChild = yield* orchestrator.getThreadProjection(
          localChild(delegated.childThreadId),
        );
        expect(delegatedChild.thread.lineage.relationshipToParent).toBe("subagent");
        expect(isProviderNativeSubagentThread(delegatedChild.thread)).toBe(false);
        const followupStartSequence = yield* orchestrator.getThreadEventSequence(
          localChild(delegated.childThreadId),
        );
        const runningFollowupCall = yield* invoke("t3_thread_send", {
          threadId: localChild(delegated.childThreadId),
          message: cancellationPrompt,
          clientRequestId: "delegated-child-replay-running-1",
        });
        const runningFollowup = yield* decodeThreadSendResult(
          runningFollowupCall.structuredContent,
        ).pipe(Effect.orDie);
        yield* orchestrator
          .streamStoredEventsFrom({
            threadId: localChild(delegated.childThreadId),
            afterSequence: followupStartSequence,
          })
          .pipe(
            Stream.filter(
              (stored) =>
                stored.event.type === "provider-turn.updated" &&
                stored.event.payload.status === "running",
            ),
            Stream.runHead,
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.die("Follow-up provider turn did not start."),
                onSome: () => Effect.void,
              }),
            ),
          );

        const queuedFollowupCall = yield* invoke("t3_thread_send", {
          threadId: localChild(delegated.childThreadId),
          message: queuedFollowupPrompt,
          mode: "queue",
          clientRequestId: "delegated-child-replay-queued-1",
        });
        const queuedFollowup = yield* decodeThreadSendResult(
          queuedFollowupCall.structuredContent,
        ).pipe(Effect.orDie);
        expect(queuedFollowup).toMatchObject({
          status: "queued",
          delivery: "queued",
        });

        const pendingProjection = yield* orchestrator.getThreadProjection(
          localChild(delegated.childThreadId),
        );
        const followupTasks = (yield* orchestrator.getThreadProjection(
          parentThreadId,
        )).subagents.filter(
          (task) => task.childThreadId === delegated.childThreadId && task.id !== delegated.taskId,
        );
        expect(followupTasks).toHaveLength(2);
        expect(followupTasks.every((task) => task.result === null)).toBe(true);
        expect(followupTasks.map((task) => task.id)).toEqual([
          runningFollowup.taskId,
          queuedFollowup.taskId,
        ]);
        expect(pendingProjection.runs.find((run) => run.id === delegated.childRunId)?.status).toBe(
          "completed",
        );
        expect(pendingProjection.runs.find((run) => run.id === runningFollowup.runId)?.status).toBe(
          "running",
        );
        expect(pendingProjection.runs.find((run) => run.id === queuedFollowup.runId)?.status).toBe(
          "queued",
        );
        expect(
          (yield* orchestrator.getThreadProjection(parentThreadId)).runs.some(
            (run) => run.status === "running",
          ),
        ).toBe(true);

        const pendingStatusCall = yield* invoke("task_status", {
          taskId: delegated.taskId,
        });
        const pendingStatus = yield* decodeDelegateTaskResult(
          pendingStatusCall.structuredContent,
        ).pipe(Effect.orDie);
        expect(pendingStatus).toMatchObject({
          childRunId: delegated.childRunId,
          status: "completed",
          summary: delegatedResult,
          resultContextTransferId: delegated.resultContextTransferId,
          hasPendingChildRuns: true,
          latestTerminalRunId: delegated.childRunId,
          latestTerminalStatus: "completed",
          latestTerminalSummary: null,
          latestTerminalResultContextTransferId: null,
        });

        const finalSequence = yield* orchestrator.getThreadEventSequence(
          localChild(delegated.childThreadId),
        );
        const interruptCall = yield* invoke("t3_thread_interrupt", {
          threadId: localChild(delegated.childThreadId),
          runId: runningFollowup.runId,
          reason: "Allow the queued replay follow-up to run.",
          clientRequestId: "interrupt-delegated-child-replay-1",
        });
        const interrupt = yield* decodeThreadInterruptResult(interruptCall.structuredContent).pipe(
          Effect.orDie,
        );
        expect(interrupt).toMatchObject({
          runId: runningFollowup.runId,
          status: "interrupt_requested",
        });
        yield* orchestrator
          .streamStoredEventsFrom({
            threadId: localChild(delegated.childThreadId),
            afterSequence: finalSequence,
          })
          .pipe(
            Stream.filter(
              (stored) =>
                stored.event.type === "run.updated" &&
                stored.event.payload.id === queuedFollowup.runId &&
                stored.event.payload.status === "completed",
            ),
            Stream.runHead,
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.die("Queued follow-up did not complete."),
                onSome: () => Effect.void,
              }),
            ),
          );

        const finalProjection = yield* orchestrator.getThreadProjection(
          localChild(delegated.childThreadId),
        );
        expect(finalProjection.runs.find((run) => run.id === runningFollowup.runId)?.status).toBe(
          "interrupted",
        );
        expect(finalProjection.runs.find((run) => run.id === queuedFollowup.runId)?.status).toBe(
          "completed",
        );
        expect(
          finalProjection.turnItems.find(
            (item) => item.runId === runningFollowup.runId && item.type === "run_interrupt_result",
          ),
        ).toMatchObject({
          message: "Stopped by an agent: Allow the queued replay follow-up to run.",
        });
        yield* orchestrator
          .streamStoredEventsFrom({
            threadId: parentThreadId,
            afterSequence: finalSequence,
          })
          .pipe(
            Stream.filter(
              (stored) =>
                stored.event.type === "subagent.updated" &&
                stored.event.payload.id === followupTasks[1]!.id &&
                stored.event.payload.status === "completed",
            ),
            Stream.runHead,
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.die("Follow-up task did not settle."),
                onSome: () => Effect.void,
              }),
            ),
          );
        const finishedParent = yield* orchestrator.getThreadProjection(parentThreadId);
        expect(
          finishedParent.subagents.find((task) => task.id === followupTasks[0]!.id)?.status,
        ).toBe("interrupted");
        expect(
          finishedParent.subagents.find((task) => task.id === followupTasks[1]!.id),
        ).toMatchObject({
          status: "completed",
          result,
        });
        expect(
          finishedParent.contextTransfers.filter(
            (transfer) =>
              transfer.type === "subagent_result" &&
              transfer.sourceThreadId === delegated.childThreadId,
          ),
        ).toHaveLength(3);
        expect(
          finishedParent.subagents.find((task) => task.id === followupTasks[1]!.id)
            ?.completionDelivery?.state,
        ).toBe("claimed");
        const finalStatusCall = yield* invoke("task_status", {
          taskId: delegated.taskId,
        });
        const finalStatus = yield* decodeDelegateTaskResult(finalStatusCall.structuredContent).pipe(
          Effect.orDie,
        );
        expect(finalStatus).toMatchObject({
          childRunId: delegated.childRunId,
          status: "completed",
          summary: delegatedResult,
          resultContextTransferId: delegated.resultContextTransferId,
          hasPendingChildRuns: false,
          latestTerminalRunId: queuedFollowup.runId,
          latestTerminalStatus: "completed",
          latestTerminalSummary: latestSummary,
        });
        const followupTransfer = finishedParent.contextTransfers.find(
          (transfer) =>
            transfer.type === "subagent_result" &&
            transfer.sourcePoint.runId === queuedFollowup.runId,
        );
        expect(followupTransfer).toBeDefined();
        expect(finalStatus.latestTerminalResultContextTransferId).toBe(followupTransfer?.id);
        expect(finalStatus.latestTerminalResultContextTransferId).not.toBe(
          delegated.resultContextTransferId,
        );
        const transferReads: Array<string> = [];
        const messageReads: Array<string> = [];
        const runReads: Array<string> = [];
        const projectionTableReads: Array<string> = [];
        const acknowledgementReads: Array<string> = [];
        const tracer = Tracer.make({
          span(options) {
            const span = new Tracer.NativeSpan(options);
            const end = span.end.bind(span);
            span.end = (endTime, exit) => {
              end(endTime, exit);
              const query = span.attributes.get("db.query.text");
              if (typeof query !== "string") return;
              let parent = Option.getOrUndefined(span.parent);
              while (parent?._tag === "Span") {
                if (
                  parent.name === "Orchestrator.dispatchDelegatedTaskCompletionDeliveryResolution"
                ) {
                  acknowledgementReads.push(query);
                  break;
                }
                parent = Option.getOrUndefined(parent.parent);
              }
              for (const [, table] of query.matchAll(/FROM orchestration_v2_projection_(\w+)/gi)) {
                projectionTableReads.push(table!);
              }
              if (/SELECT[\s\S]*FROM orchestration_v2_projection_context_transfers/i.test(query)) {
                transferReads.push(query);
              }
              if (/SELECT\s+payload_json\s+FROM orchestration_v2_projection_runs/i.test(query)) {
                runReads.push(query);
              }
              if (
                /SELECT\s+payload_json\s+FROM orchestration_v2_projection_messages/i.test(query)
              ) {
                messageReads.push(query);
              }
            };
            return span;
          },
        });
        const wait = yield* invoke(
          "t3_thread_wait",
          { threadId: delegated.childThreadId, runId: queuedFollowup.runId },
          { ...invocation, thread: undefined },
        ).pipe(Effect.withTracer(tracer));
        expect(wait.isError).not.toBe(true);
        const expectedWait = {
          threadId: delegated.childThreadId,
          runId: queuedFollowup.runId,
          status: "completed",
          timedOut: false,
        };
        expect(wait.structuredContent).toEqual(expectedWait);
        expect(messageReads).toEqual([]);
        expect(transferReads).toHaveLength(0);
        const settledWait = yield* invoke(
          "t3_thread_wait",
          {
            threadId: delegated.childThreadId,
            runId: queuedFollowup.runId,
            untilDelegatedWorkSettled: true,
          },
          { ...invocation, thread: undefined },
        ).pipe(Effect.withTracer(tracer));
        expect(settledWait.isError).not.toBe(true);
        expect(settledWait.structuredContent).toMatchObject({
          ...expectedWait,
          resultRun: { runId: queuedFollowup.runId, status: "completed" },
        });
        expect(messageReads.length).toBeGreaterThan(0);
        expect(
          messageReads.filter((query) => query.includes("$.notification.source.kind")),
        ).toHaveLength(1);
        // The orchestrator's restart-continuation guard still reads its own records.
        expect(
          messageReads.filter((query) => !query.includes("$.notification.source.kind")),
        ).toHaveLength(1);
        const parentlessRead = yield* invoke(
          "t3_thread_read",
          {
            threadId: delegated.childThreadId,
            limit: 100,
            maxCharsPerItem: result === "😀" ? 1 : 50_000,
          },
          { ...invocation, thread: undefined },
        ).pipe(Effect.withTracer(tracer));
        expect(parentlessRead.isError).not.toBe(true);
        expect(transferReads).toHaveLength(0);
        const afterParentlessRead = yield* orchestrator.getThreadProjection(parentThreadId);
        expect(
          afterParentlessRead.subagents.find((task) => task.id === queuedFollowup.taskId)
            ?.completionDelivery?.state,
        ).toBe("claimed");

        const read = yield* invoke("t3_thread_read", {
          threadId: delegated.childThreadId,
          limit: 100,
          ...(result === "😀" ? { maxCharsPerItem: 1 } : {}),
        }).pipe(Effect.withTracer(tracer));
        expect(read.isError).not.toBe(true);
        expect(transferReads.length).toBeGreaterThan(0);
        const firstPage = yield* decodeThreadRead(read.structuredContent);
        const finalItem = firstPage.items.find((item) => item.text === result.slice(0, 500));
        expect(finalItem).toBeDefined();
        if (result.length > 500) {
          yield* invoke("t3_thread_read", {
            threadId: delegated.childThreadId,
            itemId: finalItem!.itemId,
            textOffset: result.length,
          });
        } else {
          expect(read.structuredContent).toEqual(parentlessRead.structuredContent);
        }
        let text = finalItem!.text ?? "";
        let nextTextOffset = finalItem?.nextTextOffset ?? null;
        while (nextTextOffset !== null) {
          const beforeContinuation = yield* orchestrator.getThreadProjection(parentThreadId);
          expect(
            beforeContinuation.subagents.find((task) => task.id === queuedFollowup.taskId)
              ?.completionDelivery?.state,
          ).toBe("claimed");
          const continuation = yield* invoke("t3_thread_read", {
            threadId: delegated.childThreadId,
            itemId: finalItem!.itemId,
            textOffset: nextTextOffset,
            maxCharsPerItem: 50_000,
          }).pipe(Effect.withTracer(tracer));
          const nextPage = yield* decodeThreadRead(continuation.structuredContent);
          text += nextPage.items[0]?.text ?? "";
          nextTextOffset = nextPage.items[0]?.nextTextOffset ?? null;
        }
        expect(text).toBe(result);
        // The acknowledgement reads the task and its spawning run by id, not the parent's history.
        expect(acknowledgementReads.length).toBeGreaterThan(0);
        expect(
          acknowledgementReads.filter(
            (query) =>
              /FROM orchestration_v2_projection_(nodes|run_attempts)\b/.test(query) ||
              (/FROM orchestration_v2_projection_runs\b/.test(query) &&
                !query.includes("AND run_id IN")) ||
              (/FROM orchestration_v2_projection_subagents\b/.test(query) &&
                !query.includes("AND subagent_id IN")),
          ),
        ).toEqual([]);
        const afterRead = yield* orchestrator.getThreadProjection(parentThreadId);
        expect(
          afterRead.subagents.find((task) => task.id === queuedFollowup.taskId)?.completionDelivery
            ?.state,
        ).toBe("acknowledged");

        const messageReadsBeforeCapabilities = messageReads.length;
        const tableReadsBeforeCapabilities = projectionTableReads.length;
        const capabilities = yield* invoke("orchestrator_capabilities", {}).pipe(
          Effect.withTracer(tracer),
        );
        expect(capabilities.isError).not.toBe(true);
        expect(messageReads).toHaveLength(messageReadsBeforeCapabilities);
        // The caller check reads only the thread row, never its history.
        expect(new Set(projectionTableReads.slice(tableReadsBeforeCapabilities))).toEqual(
          new Set(["threads"]),
        );
        const runReadsBeforeStatus = runReads.length;
        const transferReadsBeforeStatus = transferReads.length;
        const threadRecordReadsBeforeStatus = threadRecordReads.length;
        const statusAgain = yield* invoke("task_status", { taskId: delegated.taskId }).pipe(
          Effect.withTracer(tracer),
        );
        expect(statusAgain.isError).not.toBe(true);
        // A task wait reads result transfers and runs from the child; the parent's stay unread.
        expect(runReads).toHaveLength(runReadsBeforeStatus + 1);
        expect(transferReads).toHaveLength(transferReadsBeforeStatus + 1);
        expect(
          threadRecordReads
            .slice(threadRecordReadsBeforeStatus)
            .filter(({ fields }) => fields.includes("runs") || fields.includes("contextTransfers"))
            .map(({ threadId }) => threadId),
        ).toEqual([delegated.childThreadId]);
      }).pipe(Effect.provide(layerTest));
    }),
  );
});
