// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Fixed synthetic timestamps never access wall-clock time.
import { ThreadId, type TeamPlan, type TeamPlanPatch } from "@t3tools/contracts";
import { applyTeamPlanPatch } from "@t3tools/shared/teamPlan";
import { expect, it } from "vite-plus/test";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { DESKTOP_TEAM_PLAN_EXPECTED } from "./lib/desktop-team-plan-ui.ts";
import { MacIsolationProcessError } from "./lib/mac-isolation-process.ts";
import {
  classifyTeamPlanSmokeFailure,
  isDisposableTeamPlanHost,
  isExpectedStoredTeamPlan,
  requireFreshElectronProfile,
  TeamPlanSmokeError,
} from "./smoke-workbench-team-plan.ts";

const host = {
  platform: "darwin",
  arch: "arm64",
  actions: "true",
  repository: "xiaoxuetu/t3code",
  runnerEnvironment: "github-hosted",
  home: "/Users/runner",
  environmentHome: "/Users/runner",
  runnerTemp: "/Users/runner/work/_temp",
  workspace: "/Users/runner/work/t3code/t3code",
  executable: "/Users/runner/work/_temp/private/app.app/Contents/MacOS/workbench",
  output: "/Users/runner/work/t3code/t3code/macos-validation/launch",
};
it("refuses non-disposable hosts and sibling-prefix, traversal or control-character paths", () => {
  expect(isDisposableTeamPlanHost(host)).toBe(true);
  for (const change of [
    { platform: "linux" },
    { arch: "x64" },
    { actions: "false" },
    { repository: "other/t3code" },
    { runnerEnvironment: "self-hosted" },
    { home: "/Users/developer", environmentHome: "/Users/developer" },
    { environmentHome: "/Users/other" },
    { executable: "/Users/runner/work/_temporary/app" },
    { executable: "/Users/runner/work/_temp/../app" },
    { output: "/Users/runner/work/t3code/t3code-else/report" },
    { output: "/Users/runner/work/t3code/t3code/../report" },
    { output: "/Users/runner/work/t3code/t3code/report\n" },
    { runnerTemp: "/tmp/private", executable: "/tmp/private/app" },
    { workspace: "/Users/other/project", output: "/Users/other/project/report" },
    { output: host.workspace },
    { executable: host.runnerTemp },
  ])
    expect(isDisposableTeamPlanHost({ ...host, ...change }), JSON.stringify(change)).toBe(false);
});

const threadId = ThreadId.make("public-fixture-thread");
function savedPlan(): TeamPlan {
  let plan: TeamPlan | null = null;
  const patch = (operations: TeamPlanPatch["operations"]) => {
    const next = applyTeamPlanPatch(
      plan,
      { expectedPlanVersion: plan?.version ?? 0, operations },
      { threadId, now: "2026-01-01T00:00:00.000Z" },
    );
    if (!next.ok) throw new Error("Synthetic plan construction failed.");
    plan = next.plan;
    return next.plan;
  };
  const [first, second] = DESKTOP_TEAM_PLAN_EXPECTED.tasks;
  patch([{ type: "set_goal", goal: DESKTOP_TEAM_PLAN_EXPECTED.goal }]);
  patch([{ type: "add_task", task: { ...first, modelSelection: null, dependencies: [] } }]);
  patch([
    {
      type: "add_task",
      task: {
        ...second,
        modelSelection: null,
        prompt: DESKTOP_TEAM_PLAN_EXPECTED.originalSecondPrompt,
        priority: DESKTOP_TEAM_PLAN_EXPECTED.originalSecondPriority,
      },
    },
  ]);
  const ready = patch([{ type: "reprioritize", taskId: second.taskId, priority: second.priority }]);
  patch([{ type: "confirm_plan", revision: ready.revision }]);
  patch([{ type: "edit_task", taskId: second.taskId, changes: { prompt: second.prompt } }]);
  return patch([{ type: "set_dispatch_paused", paused: true }]);
}
it("accepts real pure-transition metadata and rejects execution, history, owner or confirmation deviations", () => {
  const plan = savedPlan();
  expect(plan.dispatchPaused).toBe(true);
  expect(plan.version).toBe(7);
  expect(plan.revision).toBe(5);
  expect(isExpectedStoredTeamPlan(plan, threadId)).toBe(true);
  const { dispatchPaused: _paused, ...withoutPause } = plan;
  const modified = (change: (draft: TeamPlan) => unknown) => {
    const draft = structuredClone(plan);
    return change(draft);
  };
  const candidates: unknown[] = [
    null,
    "private-diagnostic",
    { ...plan, privateDiagnostic: "must not be accepted" },
    { ...plan, threadId: "foreign-owner" },
    { ...plan, version: 6 },
    { ...plan, revision: 6 },
    { ...plan, dispatchPaused: false },
    withoutPause,
    { ...plan, confirmedRevision: plan.revision },
    { ...plan, tasks: plan.tasks.toReversed() },
    modified((draft) => ({
      ...draft,
      tasks: draft.tasks.map((task, index) =>
        index === 0
          ? { ...task, executions: [{ subagentId: "worker", threadId: "child", runId: "run" }] }
          : task,
      ),
    })),
    modified((draft) => ({
      ...draft,
      tasks: draft.tasks.map((task, index) =>
        index === 0
          ? {
              ...task,
              history: [
                {
                  ...task.history[0],
                  executions: [{ subagentId: "worker", threadId: "child", runId: "run" }],
                },
              ],
            }
          : task,
      ),
    })),
    modified((draft) => ({
      ...draft,
      tasks: draft.tasks.map((task, index) =>
        index === 0
          ? { ...task, modelSelection: { providerInstanceId: "codex", model: "not-selected" } }
          : task,
      ),
    })),
    modified((draft) => ({
      ...draft,
      tasks: draft.tasks.map((task, index) => (index === 0 ? { ...task, dependencies: [] } : task)),
    })),
    modified((draft) => ({
      ...draft,
      tasks: draft.tasks.map((task, index) =>
        index === 0 ? { ...task, acceptance: { ...task.acceptance, actor: "coordinator" } } : task,
      ),
    })),
  ];
  for (const candidate of candidates)
    expect(isExpectedStoredTeamPlan(candidate, threadId)).toBe(false);
  expect(isExpectedStoredTeamPlan(plan, "foreign-owner")).toBe(false);
});
it("classifies only known local failures and never serializes arbitrary messages, paths or codes", () => {
  const secret = "/private/runner/account-cache";
  expect(classifyTeamPlanSmokeFailure(new TeamPlanSmokeError("close-unverified"))).toBe(
    "close-unverified",
  );
  expect(classifyTeamPlanSmokeFailure(new MacIsolationProcessError("runtime-not-descendant"))).toBe(
    "database-owner-unverified",
  );
  for (const error of [
    new Error(secret),
    { code: secret, message: secret, cause: secret },
    secret,
    null,
    Object.assign(new TeamPlanSmokeError("verification-failed"), { code: secret }),
  ]) {
    expect(classifyTeamPlanSmokeFailure(error)).toBe("verification-failed");
  }
});

it("requires an absent default profile and refuses existing profiles or symlink ancestors without adopting them", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "team-plan-profile-guard-"));
  try {
    const home = NodePath.join(root, "home");
    NodeFS.mkdirSync(home, { mode: 0o700 });
    const profile = NodePath.join(home, "Library", "Application Support", "t3-pstack-workbench");
    expect(requireFreshElectronProfile(home)).toBe(profile);
    expect(NodeFS.existsSync(NodePath.join(home, "Library"))).toBe(false);
    NodeFS.mkdirSync(profile, { recursive: true, mode: 0o700 });
    const marker = NodePath.join(profile, "synthetic-marker");
    NodeFS.writeFileSync(marker, "untouched synthetic fixture", { mode: 0o600 });
    expect(() => requireFreshElectronProfile(home)).toThrowError(
      new TeamPlanSmokeError("existing-electron-profile"),
    );
    expect(NodeFS.readFileSync(marker, "utf8")).toBe("untouched synthetic fixture");
    NodeFS.rmSync(NodePath.join(home, "Library"), { recursive: true });
    const destination = NodePath.join(root, "symlink-target");
    NodeFS.mkdirSync(destination);
    NodeFS.symlinkSync(destination, NodePath.join(home, "Library"));
    expect(() => requireFreshElectronProfile(home)).toThrowError(
      new TeamPlanSmokeError("unsafe-path"),
    );
    expect(NodeFS.readdirSync(destination)).toEqual([]);
    NodeFS.unlinkSync(NodePath.join(home, "Library"));
    NodeFS.mkdirSync(NodePath.dirname(profile), { recursive: true });
    NodeFS.symlinkSync(destination, profile);
    expect(() => requireFreshElectronProfile(home)).toThrowError(
      new TeamPlanSmokeError("existing-electron-profile"),
    );
    expect(NodeFS.lstatSync(profile).isSymbolicLink()).toBe(true);
  } finally {
    NodeFS.rmSync(root, { recursive: true });
  }
});
