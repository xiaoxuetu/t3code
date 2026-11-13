import assert from "node:assert/strict";
import { test } from "node:test";
import {
  delegatedTeamTasks,
  findTeamTaskRun,
  teamTaskElapsedMs,
  visibleDelegatedTeamTasks,
  orderTeamTasks,
  teamTaskTarget,
  teamTaskSummary,
  teamTaskPresentation,
} from "../apps/web/src/components/chat/TeamTaskBoard.logic.ts";

function task(overrides = {}) {
  return {
    id: "task-1",
    threadId: "parent-1",
    origin: "app_owned",
    childThreadId: "child-1",
    title: "Implement parser",
    prompt: "Implement parser\nwith tests",
    driver: "codex",
    providerInstanceId: "codex-work",
    model: "model-fallback",
    status: "running",
    progress: "Reproduced the issue",
    result: null,
    ...overrides,
  };
}

test("keeps distinct delegated attempts while excluding provider-native duplicates", () => {
  const first = task();
  const retry = task({ id: "retry", status: "pending" });
  assert.deepEqual(delegatedTeamTasks([first, task({ origin: "provider_native" }), retry]), [first, retry]);
});

test("opens remote children on their own environment and never fabricates a session", () => {
  assert.deepEqual(teamTaskTarget(task(), "local"), { environmentId: "local", threadId: "child-1" });
  assert.deepEqual(teamTaskTarget(task({ remoteChild: { environmentId: "remote", threadId: "remote-child", label: "Build host" } }), "local"), { environmentId: "remote", threadId: "remote-child" });
  assert.equal(teamTaskTarget(task({ childThreadId: null }), "local"), null);
});

test("reports completed runs separately from waiting, failed, interrupted, and cancelled work", () => {
  const tasks = ["pending", "running", "waiting", "completed", "failed", "interrupted", "cancelled", "idle"].map((status) => task({ status }));
  assert.deepEqual(teamTaskSummary(tasks), { total: 8, active: 3, completed: 1, failed: 1 });
  assert.equal(teamTaskPresentation(tasks[3]).statusLabel, "Run completed");
  assert.equal(teamTaskPresentation(tasks[5]).statusLabel, "Interrupted");
});

test("shows live progress for active tasks and the result for settled attempts", () => {
  assert.equal(teamTaskPresentation(task({ result: "stale old result" })).detail, "Reproduced the issue");
  assert.equal(teamTaskPresentation(task({ status: "completed", result: "Tests passed", progress: "stale progress" })).detail, "Tests passed");
  assert.equal(teamTaskPresentation(task({ status: "failed", result: "Dependency failed" })).detail, "Dependency failed");
  assert.equal(teamTaskPresentation(task({ status: "waiting", progress: " " })).detail, "Waiting for input or a dependency.");
  assert.equal(teamTaskPresentation(task({ status: "completed", result: " " })).detail, "No result text recorded.");
});

test("uses the recorded model selection and readable title without inventing assignments", () => {
  const value = teamTaskPresentation(task({ title: " ", modelSelection: { model: " selected-model " } }));
  assert.equal(value.title, "Implement parser");
  assert.equal(value.model, "selected-model");
  assert.equal(teamTaskPresentation(task({ title: null, prompt: "", model: null })).title, "Untitled task");
  assert.equal(teamTaskPresentation(task({ model: null })).model, "Model not recorded");
});

test("hides remote targets using the destination environment, leaving unlinked tasks visible", () => {
  const local = task();
  const remote = task({ id: "remote-task", childThreadId: null, remoteChild: { environmentId: "remote", threadId: "hidden-child", label: "Build host" } });
  const unlinked = task({ id: "unlinked", childThreadId: null });
  const hidden = (target) => target.environmentId === "remote" && target.threadId === "hidden-child";
  assert.deepEqual(visibleDelegatedTeamTasks([local, remote, unlinked], "local", hidden), [local, unlinked]);
});

test("keeps attention and active work ahead of old completions in a collapsed board", () => {
  const old = Array.from({ length: 7 }, (_, index) => task({ id: `done-${index}`, status: "completed", time: index }));
  const running = task({ id: "running", time: 20 });
  const failed = task({ id: "failed", status: "failed", time: 10 });
  const waiting = task({ id: "waiting", status: "waiting", time: 30 });
  const all = [...old, running, failed, waiting];
  const ordered = orderTeamTasks(all, (value) => value.time);
  assert.deepEqual(ordered.slice(0, 4).map((value) => value.id), ["waiting", "failed", "running", "done-6"]);
  assert.equal(all[0].id, "done-0");
});

test("matches the task's own run instead of a later session follow-up", () => {
  const original = { id: "original", delegatedTaskId: "task-1" };
  const followUp = { id: "later", delegatedTaskId: "task-2" };
  assert.equal(findTeamTaskRun(task(), [followUp, original]), original);
  assert.equal(findTeamTaskRun(task(), [followUp]), undefined);
  const firstRun = { id: "first-run" };
  const spawn = { type: "subagent_spawn", sourceThreadId: "parent-1", targetThreadId: "child-1", targetRunId: "first-run" };
  const link = { initialTaskId: "task-1", transfers: [spawn] };
  assert.equal(findTeamTaskRun(task(), [followUp, firstRun], link), firstRun);
  assert.equal(findTeamTaskRun(task({ id: "follow-up-task" }), [firstRun], link), undefined);
  assert.equal(findTeamTaskRun(task(), [firstRun], { initialTaskId: "task-1", transfers: [{ ...spawn, sourceThreadId: "wrong-parent" }] }), undefined);
  const remote = task({ remoteChild: { environmentId: "remote", threadId: "child", runId: "remote-run" } });
  const remoteRun = { id: "remote-run" };
  assert.equal(findTeamTaskRun(remote, [original, remoteRun]), remoteRun);
  assert.equal(findTeamTaskRun(task({ remoteChild: { environmentId: "remote", threadId: "child" } }), [original]), undefined);
});

test("elapsed time excludes the queue and freezes at the recorded finish", () => {
  const startedAt = "2026-11-13T10:05:00.000Z";
  const finishedAt = "2026-11-13T10:07:30.000Z";
  const later = Date.parse("2026-11-13T11:00:00.000Z");
  assert.equal(teamTaskElapsedMs({ startedAt, finishedAt, active: false }, later), 150000);
  assert.equal(teamTaskElapsedMs({ startedAt, finishedAt: null, active: true }, Date.parse(finishedAt)), 150000);
  assert.equal(teamTaskElapsedMs({ startedAt: null, finishedAt: null, active: true }, later), null);
  assert.equal(teamTaskElapsedMs({ startedAt, finishedAt: null, active: false }, later), null);
});

test("does not manufacture a duration from missing or inconsistent timestamps", () => {
  assert.equal(teamTaskElapsedMs({ startedAt: "invalid", finishedAt: null, active: true }, 100), null);
  assert.equal(teamTaskElapsedMs({ startedAt: "2026-11-13T10:05:00Z", finishedAt: "2026-11-13T10:04:00Z", active: false }, 100), null);
});
