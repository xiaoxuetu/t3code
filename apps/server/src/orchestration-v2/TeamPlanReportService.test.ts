import { assert, it } from "@effect/vitest";
import {
  EventId,
  OrchestrationV2Command,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
  type TeamPlanReportOccurrence,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as Scheduler from "../scheduling/Scheduler.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as TeamPlanReportService from "./TeamPlanReportService.ts";
import { teamPlanReportCommand } from "./TeamPlanReport.ts";

const now = "2026-11-13T12:00:00.000Z";
const decodeClientCommand = Schema.decodeUnknownOption(OrchestrationV2Command);
function occurrence(name: string, dueAt = now): TeamPlanReportOccurrence {
  return {
    threadId: ThreadId.make(`thread:report:${name}`),
    planCreatedAt: "2026-11-13T10:00:00.000Z",
    generation: 1,
    dueAt,
  };
}
interface Fixture {
  candidates: readonly TeamPlanReportOccurrence[];
  reads: number;
  commands: OrchestrationV2ServerCommand[];
  sources: string[];
  failThread?: string;
  afterDispatch?: () => void;
}
function serviceLayer(
  fixture: Fixture,
  events: Stream.Stream<OrchestrationV2DomainEvent> = Stream.never,
) {
  return TeamPlanReportService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getTeamPlanReportCandidates: () =>
            Effect.sync(() => {
              fixture.reads++;
              return fixture.candidates;
            }),
        }),
        Layer.mock(Orchestrator.OrchestratorV2)({
          streamDomainEvents: events,
          dispatch: (command) =>
            Effect.gen(function* () {
              fixture.commands.push(command);
              if ("threadId" in command && command.threadId === fixture.failThread)
                return yield* Effect.die("synthetic report commit failure");
              fixture.afterDispatch?.();
              return { sequence: 1, storedEvents: [] };
            }),
        }),
        Layer.mock(Scheduler.Scheduler)({
          register: (name) =>
            Effect.sync(() => {
              fixture.sources.push(name);
            }),
        }),
      ),
    ),
  );
}
function fixture(candidates: readonly TeamPlanReportOccurrence[]): Fixture {
  return { candidates, reads: 0, commands: [], sources: [] };
}

it.effect("uses the existing scheduler and only submits passive internal report commands", () => {
  const state = fixture([occurrence("due"), occurrence("future", "2026-11-13T12:01:00.000Z")]);
  return Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(now));
    const service = yield* TeamPlanReportService.TeamPlanReportService;
    assert.deepEqual(state.sources, ["team-plan-reports"]);
    yield* service.sweep();
    assert.deepEqual(state.commands, [teamPlanReportCommand(state.candidates[0]!)]);
    assert.isTrue(
      Option.isNone(decodeClientCommand(state.commands[0])),
      "the report command must remain excluded from RPC/client command decoding",
    );
  }).pipe(Effect.provide(serviceLayer(state)));
});

it.effect(
  "retains the persisted overdue identity across repeated sweeps and a service restart",
  () => {
    const oldDue = occurrence("overdue", "2026-11-12T12:00:00.000Z");
    const state = fixture([oldDue]);
    const sweep = Effect.gen(function* () {
      const service = yield* TeamPlanReportService.TeamPlanReportService;
      yield* service.sweep();
    });
    return Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(now));
      yield* sweep.pipe(Effect.provide(serviceLayer(state)));
      yield* TestClock.adjust("10 minutes");
      yield* sweep.pipe(Effect.provide(serviceLayer(state)));
      assert.lengthOf(state.commands, 2);
      assert.equal(state.commands[0]?.commandId, state.commands[1]?.commandId);
      assert.deepEqual(state.commands[0], teamPlanReportCommand(oldDue));
    });
  },
);

it.effect(
  "emits one current report after missed periods and waits for the advanced due date",
  () => {
    const overdue = occurrence("missed", "2026-11-12T12:00:00.000Z");
    const state = fixture([overdue]);
    state.afterDispatch = () => {
      state.candidates = [{ ...overdue, dueAt: "2026-11-13T12:01:00.000Z" }];
    };
    return Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(now));
      const service = yield* TeamPlanReportService.TeamPlanReportService;
      yield* service.sweep();
      yield* service.sweep();
      yield* service.sweep();
      assert.lengthOf(state.commands, 1);
      assert.equal(state.reads, 2, "future due hint avoids repeating the candidate query");
    }).pipe(Effect.provide(serviceLayer(state)));
  },
);

it.effect(
  "does not let a failed report block another plan or generate a new retry identity",
  () => {
    const first = occurrence("failed");
    const second = occurrence("healthy");
    const state = fixture([first, second]);
    state.failThread = first.threadId;
    return Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(now));
      const service = yield* TeamPlanReportService.TeamPlanReportService;
      yield* service.sweep();
      yield* service.sweep();
      assert.deepEqual(state.commands, [
        teamPlanReportCommand(first),
        teamPlanReportCommand(second),
        teamPlanReportCommand(first),
        teamPlanReportCommand(second),
      ]);
    }).pipe(Effect.provide(serviceLayer(state)));
  },
);

it.effect("invalidates an idle hint when a plan schedule changes without touching providers", () =>
  Effect.gen(function* () {
    const events = yield* PubSub.unbounded<OrchestrationV2DomainEvent>();
    const state = fixture([]);
    yield* Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(now));
      const service = yield* TeamPlanReportService.TeamPlanReportService;
      yield* Effect.yieldNow;
      yield* service.sweep();
      state.candidates = [occurrence("enabled")];
      yield* service.sweep();
      assert.lengthOf(state.commands, 0);
      const event: OrchestrationV2DomainEvent = {
        id: EventId.make("event:report-enabled"),
        type: "team-plan.updated",
        threadId: state.candidates[0]!.threadId,
        occurredAt: yield* DateTime.now,
        payload: {
          threadId: state.candidates[0]!.threadId,
          plan: {
            threadId: state.candidates[0]!.threadId,
            version: 1,
            revision: 1,
            goal: "Synthetic report fixture",
            confirmedRevision: null,
            tasks: [],
            createdAt: now,
            updatedAt: now,
          },
        },
      };
      yield* PubSub.publish(events, event);
      yield* Effect.yieldNow;
      yield* service.sweep();
      assert.deepEqual(state.commands, [teamPlanReportCommand(state.candidates[0]!)]);
    }).pipe(Effect.provide(serviceLayer(state, Stream.fromPubSub(events))));
  }),
);
