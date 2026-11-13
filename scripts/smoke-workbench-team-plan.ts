// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalProcess:off globalTimers:off - This disposable CI host owns only synthetic fixture state and captured processes.
import { TeamPlan } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Schema from "effect/Schema";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeUtil from "node:util";
import { _electron, type ElectronApplication } from "playwright-core";
import {
  SIMPLE_FIXTURE_MESSAGE,
  SIMPLE_FIXTURE_TITLE,
  verifyFixtureWindow,
} from "./lib/desktop-fixture-ui.ts";
import {
  assertSavedDesktopTeamPlan,
  DESKTOP_TEAM_PLAN_EXPECTED,
  verifyDesktopTeamPlan,
} from "./lib/desktop-team-plan-ui.ts";
import { createIsolationEnvironment } from "./lib/mac-isolation-workspace.ts";
import {
  MacIsolationProcessError,
  verifyDatabaseOwner,
  waitForOwnedProcessExit,
} from "./lib/mac-isolation-process.ts";
import { parseWorkbenchPreviewVersion } from "./lib/mac-workbench-build-input.ts";

const FIXTURE_SHA256 = "e65f15f89a847a264cf4366cd7bcdc31cef1d5fbfd07707ed497cc0f045357b5";
const TIMEOUT_MS = 60_000;
const decodeTeamPlan = Schema.decodeUnknownSync(TeamPlan);
const FAILURE_CODES = [
  "invalid-arguments",
  "unsupported-host",
  "unsafe-path",
  "existing-electron-profile",
  "invalid-version",
  "invalid-fixture",
  "ownership-lost",
  "launch-unverified",
  "app-identity-mismatch",
  "database-owner-unverified",
  "database-invalid",
  "execution-count-changed",
  "stored-plan-mismatch",
  "ui-check-failed",
  "close-unverified",
  "owned-process-exit-unverified",
  "cleanup-unverified",
  "verification-failed",
] as const;
type FailureCode = (typeof FAILURE_CODES)[number];
type Phase =
  | "host-guard"
  | "seed-fixture"
  | "first-launch"
  | "edit-metadata"
  | "first-close"
  | "restart"
  | "restart-read"
  | "second-close"
  | "cleanup"
  | "passed";
// @effect-diagnostics-next-line extendsNativeError:off - Only fixed codes may cross this host CLI's error boundary.
export class TeamPlanSmokeError extends Error {
  readonly code: FailureCode;
  constructor(code: FailureCode) {
    super("Team-plan smoke did not pass.");
    this.code = code;
  }
}
function check(value: unknown, code: FailureCode): asserts value {
  if (!value) throw new TeamPlanSmokeError(code);
}
export function classifyTeamPlanSmokeFailure(error: unknown): FailureCode {
  if (error instanceof TeamPlanSmokeError && FAILURE_CODES.includes(error.code)) return error.code;
  if (error instanceof MacIsolationProcessError) return "database-owner-unverified";
  return "verification-failed";
}

function within(parent: string, child: string): boolean {
  return (
    NodePath.isAbsolute(parent) &&
    NodePath.isAbsolute(child) &&
    child.startsWith(parent + NodePath.sep) &&
    !/[\0\r\n]/u.test(parent + child)
  );
}
export function isDisposableTeamPlanHost(input: {
  readonly platform: string;
  readonly arch: string;
  readonly actions?: string;
  readonly repository?: string;
  readonly runnerEnvironment?: string;
  readonly home: string;
  readonly environmentHome?: string;
  readonly runnerTemp: string;
  readonly workspace: string;
  readonly executable: string;
  readonly output: string;
}): boolean {
  return (
    input.platform === "darwin" &&
    input.arch === "arm64" &&
    input.actions === "true" &&
    input.repository === "xiaoxuetu/t3code" &&
    input.runnerEnvironment === "github-hosted" &&
    input.home === "/Users/runner" &&
    input.environmentHome === input.home &&
    within(input.home, input.runnerTemp) &&
    within(input.home, input.workspace) &&
    within(input.runnerTemp, input.executable) &&
    within(input.workspace, input.output) &&
    [input.runnerTemp, input.workspace, input.executable, input.output].every(
      (path) => NodePath.resolve(path) === path,
    )
  );
}

/** Only lstat is used: an existing profile or symlink is never opened, adopted or removed. */
export function requireFreshElectronProfile(home: string): string {
  check(
    NodePath.isAbsolute(home) && NodePath.resolve(home) === home && !/[\0\r\n]/u.test(home),
    "unsafe-path",
  );
  const profile = NodePath.join(home, "Library", "Application Support", "t3-pstack-workbench");
  const parents = [
    home,
    NodePath.join(home, "Library"),
    NodePath.join(home, "Library", "Application Support"),
  ];
  for (const path of [...parents, profile]) {
    let info: NodeFS.Stats;
    try {
      info = NodeFS.lstatSync(path);
    } catch (error) {
      if (
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        check(path !== home, "unsafe-path");
        return profile;
      }
      throw new TeamPlanSmokeError("unsafe-path");
    }
    check(path !== profile, "existing-electron-profile");
    check(info.isDirectory() && !info.isSymbolicLink(), "unsafe-path");
  }
  throw new TeamPlanSmokeError("existing-electron-profile");
}

type Counts = { readonly runs: number; readonly subagents: number };
function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function equalCounts(left: Counts, right: Counts): boolean {
  return left.runs === right.runs && left.subagents === right.subagents;
}

/** Schema decode rejects unknown fields; comparison includes every non-time field, including historical execution refs. */
export function isExpectedStoredTeamPlan(value: unknown, threadId: string): boolean {
  try {
    const plan = decodeTeamPlan(value, { onExcessProperty: "error" });
    const stripRevisionTimes = (revision: (typeof plan.tasks)[number]["history"][number]) => {
      const { createdAt: _created, updatedAt: _updated, acceptance, ...rest } = revision;
      const { updatedAt: _reviewed, ...verdict } = acceptance;
      return { ...rest, acceptance: verdict };
    };
    const actual = {
      threadId: plan.threadId,
      goal: plan.goal,
      version: plan.version,
      revision: plan.revision,
      confirmedRevision: plan.confirmedRevision,
      tasks: plan.tasks.map((task) => {
        const { history, ...revision } = task;
        return { ...stripRevisionTimes(revision), history: history.map(stripRevisionTimes) };
      }),
    };
    const expectedRevision = (task: (typeof DESKTOP_TEAM_PLAN_EXPECTED.tasks)[number]) => ({
      title: task.title,
      prompt: task.prompt,
      role: task.role,
      modelSelection: null,
      dependencies: task.dependencies,
      revision: task.revision,
      confirmedRevision: task.taskId === "T1" ? 1 : null,
      acceptance: { status: "pending", note: "" },
      executions: [],
    });
    const [first, second] = DESKTOP_TEAM_PLAN_EXPECTED.tasks;
    return NodeUtil.isDeepStrictEqual(actual, {
      threadId,
      goal: DESKTOP_TEAM_PLAN_EXPECTED.goal,
      version: 6,
      revision: 5,
      confirmedRevision: null,
      tasks: [
        {
          ...expectedRevision(second),
          taskId: second.taskId,
          priority: second.priority,
          history: [
            {
              ...expectedRevision(second),
              revision: 1,
              confirmedRevision: 1,
              prompt: DESKTOP_TEAM_PLAN_EXPECTED.originalSecondPrompt,
            },
          ],
        },
        { ...expectedRevision(first), taskId: first.taskId, priority: first.priority, history: [] },
      ],
    });
  } catch {
    return false;
  }
}

function sameIdentity(left: NodeFS.BigIntStats, right: NodeFS.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
function regularDirectory(path: string): NodeFS.BigIntStats {
  const info = NodeFS.lstatSync(path, { bigint: true });
  check(info.isDirectory() && !info.isSymbolicLink(), "unsafe-path");
  return info;
}
function prepareOutput(workspace: string, output: string): () => void {
  const workspaceInfo = regularDirectory(workspace);
  check(NodeFS.realpathSync(workspace) === workspace && within(workspace, output), "unsafe-path");
  let cursor = workspace;
  for (const component of NodePath.relative(workspace, output).split(NodePath.sep)) {
    cursor = NodePath.join(cursor, component);
    if (!NodeFS.existsSync(cursor)) NodeFS.mkdirSync(cursor, { mode: 0o700 });
    regularDirectory(cursor);
  }
  const outputInfo = regularDirectory(output);
  return () => {
    check(
      NodeFS.realpathSync(output) === output &&
        sameIdentity(regularDirectory(workspace), workspaceInfo) &&
        sameIdentity(regularDirectory(output), outputInfo),
      "ownership-lost",
    );
  };
}
function createPrivateFixture(runnerTemp: string, onCreated: () => void) {
  const parentInfo = regularDirectory(runnerTemp);
  check(NodeFS.realpathSync(runnerTemp) === runnerTemp, "unsafe-path");
  const root = NodeFS.mkdtempSync(NodePath.join(runnerTemp, "workbench-team-plan-"));
  onCreated();
  NodeFS.chmodSync(root, 0o700);
  const rootInfo = regularDirectory(root);
  const assertOwned = (path: string) => {
    check(
      sameIdentity(regularDirectory(runnerTemp), parentInfo) &&
        sameIdentity(regularDirectory(root), rootInfo) &&
        NodeFS.realpathSync(root) === root &&
        within(root, path) &&
        NodePath.resolve(path) === path,
      "ownership-lost",
    );
    let cursor = root;
    for (const component of NodePath.relative(root, path).split(NodePath.sep)) {
      cursor = NodePath.join(cursor, component);
      if (!NodeFS.existsSync(cursor)) continue;
      check(!NodeFS.lstatSync(cursor).isSymbolicLink(), "ownership-lost");
    }
  };
  const state = NodePath.join(root, "state");
  for (const path of [
    state,
    NodePath.join(state, "userdata"),
    NodePath.join(root, "config"),
    NodePath.join(root, "data"),
    NodePath.join(root, "cache"),
    NodePath.join(root, "tmp"),
  ]) {
    assertOwned(path);
    NodeFS.mkdirSync(path, { mode: 0o700 });
  }
  const fixturePath = NodePath.join(import.meta.dirname, "fixtures/desktop-launch/statev2.sqlite");
  const fixtureInfo = NodeFS.lstatSync(fixturePath, { bigint: true });
  check(
    fixtureInfo.isFile() && !fixtureInfo.isSymbolicLink() && fixtureInfo.size < 16_777_216n,
    "invalid-fixture",
  );
  const fd = NodeFS.openSync(fixturePath, NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW);
  let fixture: Buffer;
  try {
    check(sameIdentity(NodeFS.fstatSync(fd, { bigint: true }), fixtureInfo), "invalid-fixture");
    fixture = NodeFS.readFileSync(fd);
    check(
      NodeCrypto.createHash("sha256").update(fixture).digest("hex") === FIXTURE_SHA256,
      "invalid-fixture",
    );
  } finally {
    NodeFS.closeSync(fd);
  }
  const dbPath = NodePath.join(state, "userdata/statev2.sqlite");
  const comparison = NodePath.join(root, "comparison.sqlite");
  for (const path of [dbPath, comparison])
    NodeFS.writeFileSync(path, fixture, { flag: "wx", mode: 0o600 });
  const readDb = <T>(read: (db: NodeSqlite.DatabaseSync) => T): T => {
    assertOwned(dbPath);
    check(NodeFS.lstatSync(dbPath).isFile(), "database-invalid");
    const db = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
    try {
      return read(db);
    } finally {
      db.close();
    }
  };
  const threadId = readDb((db) => {
    const rows = db
      .prepare("SELECT thread_id FROM orchestration_v2_projection_threads WHERE title = ? LIMIT 2")
      .all(SIMPLE_FIXTURE_TITLE);
    const id = rows[0]?.thread_id;
    check(
      rows.length === 1 && typeof id === "string" && id.length > 0 && id.length < 256,
      "invalid-fixture",
    );
    return id;
  });
  return {
    root,
    state,
    dbPath,
    comparison,
    assertOwned,
    readCounts(): Counts {
      return readDb((db) => {
        const runs = db
          .prepare("SELECT COUNT(*) AS count FROM orchestration_v2_projection_runs")
          .get()?.count;
        const subagents = db
          .prepare("SELECT COUNT(*) AS count FROM orchestration_v2_projection_subagents")
          .get()?.count;
        check(count(runs) && count(subagents), "database-invalid");
        return { runs, subagents };
      });
    },
    assertEmptyPlan() {
      readDb((db) =>
        check(
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM orchestration_v2_projection_team_plans WHERE thread_id = ?",
            )
            .get(threadId)?.count === 0,
          "stored-plan-mismatch",
        ),
      );
    },
    assertPlan() {
      readDb((db) => {
        const rows = db
          .prepare(
            "SELECT version, payload_json FROM orchestration_v2_projection_team_plans WHERE thread_id = ? LIMIT 2",
          )
          .all(threadId);
        check(
          rows.length === 1 &&
            rows[0]?.version === 6 &&
            typeof rows[0].payload_json === "string" &&
            rows[0].payload_json.length < 65_536,
          "stored-plan-mismatch",
        );
        check(
          isExpectedStoredTeamPlan(JSON.parse(rows[0].payload_json), threadId),
          "stored-plan-mismatch",
        );
      });
    },
    cleanup() {
      assertOwned(dbPath);
      check((regularDirectory(root).mode & 0o777n) === 0o700n, "ownership-lost");
      NodeFS.rmSync(root, { recursive: true });
    },
  };
}

type Tracked = {
  readonly app: ElectronApplication;
  readonly child: ReturnType<ElectronApplication["process"]>;
  backendPid?: number;
  closeAttempted: boolean;
};
export async function runTeamPlanSmoke(args: readonly string[]): Promise<boolean> {
  let phase: Phase = "host-guard";
  let failureCode: FailureCode | null = null;
  let expectedVersion: string | null = null;
  const checks = {
    fixtureHashVerified: false,
    freshElectronProfile: false,
    seedExecutionCountsVerified: false,
    countsUnchangedAfterFirstLaunch: false,
    firstFixtureWindow: false,
    firstBackendOwned: false,
    metadataUiVerified: false,
    storedPlanVerified: false,
    countsUnchangedAfterEdit: false,
    firstCloseVerified: false,
    restartedFixtureWindow: false,
    restartedBackendOwned: false,
    savedPlanUiVerified: false,
    restartedStoredPlanVerified: false,
    countsUnchangedAfterRestart: false,
    secondCloseVerified: false,
    ownedTempCleaned: false,
    cleanupDeferredToRunnerDestruction: false,
  };
  const counts: { baseline: Counts | null; afterEdit: Counts | null; afterRestart: Counts | null } =
    { baseline: null, afterEdit: null, afterRestart: null };
  let workspace: ReturnType<typeof createPrivateFixture> | undefined;
  let output: string | undefined;
  let assertOutput: (() => void) | undefined;
  const applications = new Set<Tracked>();
  let cleanupSafe = true;
  let privateRootCreated = false;
  let passed = false;
  async function closeTracked(tracked: Tracked) {
    tracked.closeAttempted = true;
    if (tracked.backendPid === undefined) cleanupSafe = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        tracked.app.close(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new TeamPlanSmokeError("close-unverified")), 30_000);
        }),
      ]);
      check(
        tracked.backendPid !== undefined && tracked.child.pid !== undefined,
        "close-unverified",
      );
      try {
        await waitForOwnedProcessExit(tracked.child.pid, 10_000);
        await waitForOwnedProcessExit(tracked.backendPid, 10_000);
      } catch {
        throw new TeamPlanSmokeError("owned-process-exit-unverified");
      }
      check(tracked.child.exitCode === 0 && tracked.child.signalCode === null, "close-unverified");
      applications.delete(tracked);
    } catch (error) {
      cleanupSafe = false;
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  try {
    check(
      HostProcess.Platform.defaultValue() === "darwin" &&
        HostProcess.Architecture.defaultValue() === "arm64" &&
        process.env.GITHUB_ACTIONS === "true" &&
        process.env.GITHUB_REPOSITORY === "xiaoxuetu/t3code" &&
        process.env.RUNNER_ENVIRONMENT === "github-hosted" &&
        NodeOS.homedir() === "/Users/runner" &&
        process.env.HOME === "/Users/runner",
      "unsupported-host",
    );
    let values: ReturnType<
      typeof NodeUtil.parseArgs<{
        options: {
          executable: { type: "string" };
          "expect-version": { type: "string" };
          "artifacts-dir": { type: "string" };
        };
      }>
    >["values"];
    try {
      ({ values } = NodeUtil.parseArgs({
        args: [...args],
        options: {
          executable: { type: "string" },
          "expect-version": { type: "string" },
          "artifacts-dir": { type: "string" },
        },
      }));
    } catch {
      throw new TeamPlanSmokeError("invalid-arguments");
    }
    const runnerTemp = process.env.RUNNER_TEMP;
    const checkout = process.env.GITHUB_WORKSPACE;
    check(
      runnerTemp && checkout && values.executable && values["artifacts-dir"],
      "invalid-arguments",
    );
    const realTemp = NodeFS.realpathSync(runnerTemp);
    const realCheckout = NodeFS.realpathSync(checkout);
    const executable = NodeFS.realpathSync(values.executable);
    const reportOutput = NodePath.resolve(values["artifacts-dir"]);
    check(
      isDisposableTeamPlanHost({
        platform: HostProcess.Platform.defaultValue(),
        arch: HostProcess.Architecture.defaultValue(),
        actions: process.env.GITHUB_ACTIONS,
        repository: process.env.GITHUB_REPOSITORY,
        runnerEnvironment: process.env.RUNNER_ENVIRONMENT,
        home: NodeOS.homedir(),
        environmentHome: process.env.HOME,
        runnerTemp: realTemp,
        workspace: realCheckout,
        executable,
        output: reportOutput,
      }),
      "unsupported-host",
    );
    check(NodeFS.statSync(executable).isFile(), "unsafe-path");
    assertOutput = prepareOutput(realCheckout, reportOutput);
    output = reportOutput;
    expectedVersion = parseWorkbenchPreviewVersion(values["expect-version"]);
    check(expectedVersion !== null, "invalid-version");
    const expectedProfile = requireFreshElectronProfile("/Users/runner");
    checks.freshElectronProfile = true;
    phase = "seed-fixture";
    workspace = createPrivateFixture(realTemp, () => {
      privateRootCreated = true;
    });
    checks.fixtureHashVerified = true;
    const seededCounts = workspace.readCounts();
    check(seededCounts.runs === 0 && seededCounts.subagents === 0, "invalid-fixture");
    checks.seedExecutionCountsVerified = true;
    const childEnvironment = {
      ...createIsolationEnvironment(process.env),
      T3_PSTACK_WORKBENCH_HOME: workspace.state,
      XDG_CONFIG_HOME: NodePath.join(workspace.root, "config"),
      XDG_DATA_HOME: NodePath.join(workspace.root, "data"),
      XDG_CACHE_HOME: NodePath.join(workspace.root, "cache"),
      TMPDIR: NodePath.join(workspace.root, "tmp"),
      TMP: NodePath.join(workspace.root, "tmp"),
      TEMP: NodePath.join(workspace.root, "tmp"),
    };
    const launch = async () => {
      let app: ElectronApplication;
      try {
        app = await _electron.launch({
          executablePath: executable,
          env: childEnvironment,
          timeout: TIMEOUT_MS,
        });
      } catch {
        cleanupSafe = false;
        throw new TeamPlanSmokeError("launch-unverified");
      }
      const tracked: Tracked = { app, child: app.process(), closeAttempted: false };
      applications.add(tracked);
      check(tracked.child.pid !== undefined && tracked.child.pid > 1, "launch-unverified");
      const page = await verifyFixtureWindow(app, {
        title: SIMPLE_FIXTURE_TITLE,
        message: SIMPLE_FIXTURE_MESSAGE,
      });
      const identity = await app.evaluate(({ app }) => ({
        version: app.getVersion(),
        appPath: app.getAppPath(),
        profile: app.getPath("userData"),
      }));
      const bundle = NodePath.dirname(NodePath.dirname(NodePath.dirname(executable)));
      check(
        identity.version === expectedVersion &&
          within(bundle, identity.appPath) &&
          identity.profile === expectedProfile,
        "app-identity-mismatch",
      );
      regularDirectory(expectedProfile);
      const owner = await verifyDatabaseOwner({
        runtimePath: NodePath.join(workspace!.state, "userdata/server-runtime.json"),
        electronPid: tracked.child.pid,
        ownDb: workspace!.dbPath,
        otherDb: workspace!.comparison,
        assertOwned: workspace!.assertOwned,
      });
      check(
        owner.ownedRuntime && owner.openedOwnDb && !owner.openedOtherDb,
        "database-owner-unverified",
      );
      tracked.backendPid = owner.runtimePid;
      return { tracked, page };
    };
    phase = "first-launch";
    const first = await launch();
    checks.firstFixtureWindow = true;
    checks.firstBackendOwned = true;
    counts.baseline = workspace.readCounts();
    check(equalCounts(seededCounts, counts.baseline), "execution-count-changed");
    checks.countsUnchangedAfterFirstLaunch = true;
    workspace.assertEmptyPlan();
    phase = "edit-metadata";
    try {
      await verifyDesktopTeamPlan(first.page);
    } catch {
      throw new TeamPlanSmokeError("ui-check-failed");
    }
    checks.metadataUiVerified = true;
    workspace.assertPlan();
    checks.storedPlanVerified = true;
    counts.afterEdit = workspace.readCounts();
    check(equalCounts(counts.baseline, counts.afterEdit), "execution-count-changed");
    checks.countsUnchangedAfterEdit = true;
    phase = "first-close";
    await closeTracked(first.tracked);
    check(equalCounts(counts.baseline, workspace.readCounts()), "execution-count-changed");
    workspace.assertPlan();
    checks.firstCloseVerified = true;
    phase = "restart";
    const second = await launch();
    checks.restartedFixtureWindow = true;
    checks.restartedBackendOwned = true;
    phase = "restart-read";
    try {
      await assertSavedDesktopTeamPlan(second.page);
    } catch {
      throw new TeamPlanSmokeError("ui-check-failed");
    }
    checks.savedPlanUiVerified = true;
    workspace.assertPlan();
    checks.restartedStoredPlanVerified = true;
    counts.afterRestart = workspace.readCounts();
    check(equalCounts(counts.baseline, counts.afterRestart), "execution-count-changed");
    checks.countsUnchangedAfterRestart = true;
    phase = "second-close";
    await closeTracked(second.tracked);
    counts.afterRestart = workspace.readCounts();
    check(equalCounts(counts.baseline, counts.afterRestart), "execution-count-changed");
    workspace.assertPlan();
    checks.secondCloseVerified = true;
    phase = "cleanup";
    check(cleanupSafe && applications.size === 0, "cleanup-unverified");
    workspace.cleanup();
    checks.ownedTempCleaned = true;
    phase = "passed";
    passed = true;
  } catch (error) {
    failureCode = classifyTeamPlanSmokeFailure(error);
  } finally {
    for (const tracked of applications) {
      if (tracked.closeAttempted) continue;
      try {
        await closeTracked(tracked);
      } catch {
        cleanupSafe = false;
      }
    }
    // A failed verification retains its private state and newly created default profile for runner destruction.
    // Playwright may clean up its own failed launch; this host never force-kills or deletes active state.
    // On success the fresh default profile remains for the following ordinary launch smoke.
    checks.cleanupDeferredToRunnerDestruction = privateRootCreated && !checks.ownedTempCleaned;
    if (output !== undefined && assertOutput !== undefined) {
      try {
        assertOutput();
        const fd = NodeFS.openSync(
          NodePath.join(output, "team-plan.json"),
          NodeFS.constants.O_WRONLY |
            NodeFS.constants.O_CREAT |
            NodeFS.constants.O_EXCL |
            NodeFS.constants.O_NOFOLLOW,
          0o600,
        );
        try {
          NodeFS.writeFileSync(
            fd,
            JSON.stringify(
              {
                schemaVersion: 1,
                pass: passed,
                status: passed ? "passed" : "failed",
                phase,
                failureCode,
                expectedVersion,
                counts,
                checks,
              },
              null,
              2,
            ) + "\n",
          );
        } finally {
          NodeFS.closeSync(fd);
        }
      } catch {
        passed = false;
      }
    } else {
      passed = false;
    }
  }
  return passed;
}
if (import.meta.main) {
  await runTeamPlanSmoke(process.argv.slice(2))
    .then((passed) => {
      console.log(
        passed
          ? "Workbench team-plan metadata smoke: passed."
          : "Workbench team-plan metadata smoke: failed.",
      );
      if (!passed) process.exit(1);
    })
    .catch(() => {
      console.error("Workbench team-plan metadata smoke: failed.");
      process.exit(1);
    });
}
