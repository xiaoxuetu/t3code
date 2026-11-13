// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalProcess:off globalTimers:off globalDate:off - Disposable-runner host verification owns its fixtures and captured processes.
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeUtil from "node:util";
import { _electron, type ElectronApplication, type Page } from "playwright-core";
import {
  createIsolationEnvironment,
  createIsolationWorkspace,
  MacIsolationWorkspaceError,
} from "./lib/mac-isolation-workspace.ts";
import {
  verifyDatabaseOwner,
  waitForOwnedProcessExit,
  MacIsolationProcessError,
  type IsolationCommandFailure,
} from "./lib/mac-isolation-process.ts";
import {
  SIMPLE_FIXTURE_TITLE,
  SIMPLE_FIXTURE_MESSAGE,
  verifyFixtureWindow,
  renameFixtureThread,
  isDesktopFixtureRenameError,
} from "./lib/desktop-fixture-ui.ts";

import {
  DEFAULT_WORKBENCH_VERSION,
  parseWorkbenchPreviewVersion,
} from "./lib/mac-workbench-build-input.ts";

const titles = {
  official: "Official coexistence fixture",
  workbench: "Workbench coexistence fixture",
} as const;
const finalTitles = {
  official: "Official persisted fixture",
  workbench: "Workbench persisted fixture",
} as const;
type Kind = "official" | "workbench";
type Tracked = {
  app: ElectronApplication;
  child: ReturnType<ElectronApplication["process"]>;
  backendPid?: number;
};
// @effect-diagnostics-next-line extendsNativeError:off - This host CLI reports fixed check codes outside an Effect error channel.
class IsolationCheckError extends Error {
  readonly code: string;
  constructor(code: string) {
    super("Mac isolation check did not pass.");
    this.code = code;
  }
}
function requireCheck(value: unknown, code: string): asserts value {
  if (!value) throw new IsolationCheckError(code);
}
async function main() {
  const { values } = NodeUtil.parseArgs({
    options: {
      "official-executable": { type: "string" },
      "workbench-executable": { type: "string" },
      "workbench-version": { type: "string", default: DEFAULT_WORKBENCH_VERSION },
      "artifacts-dir": { type: "string", default: "macos-isolation-validation" },
    },
  });
  const output = NodePath.resolve(values["artifacts-dir"]!);
  const versions = { official: "0.1.9", workbench: DEFAULT_WORKBENCH_VERSION };
  const checks: Record<string, boolean | number> = {
    officialWarmupRenameBegan: false,
    officialWarmupRenameCompleted: false,
    officialWarmupTitlePersisted: false,
    officialWarmupAppClosed: false,
  };
  let phase = "host-guard";
  let status = "failed";
  let failureCode: string | null = null;
  let commandFailure: IsolationCommandFailure | null = null;
  let workspace: ReturnType<typeof createIsolationWorkspace> | undefined;
  const applications = new Set<Tracked>();
  let cleanupSafe = true;

  const closeTracked = async (tracked: Tracked) => {
    // If startup failed before ancestry verification, do not delete data a backend may still use.
    if (tracked.backendPid === undefined) cleanupSafe = false;
    let closeFailure: string | undefined;
    try {
      await Promise.race([
        tracked.app.close(),
        NodeTimersPromises.setTimeout(30_000, undefined, { ref: false }).then(() => {
          throw new IsolationCheckError("app-close-timeout");
        }),
      ]);
    } catch {
      cleanupSafe = false;
      closeFailure = "app-close-unverified";
    }
    try {
      if (tracked.child.exitCode === null && tracked.child.signalCode === null) {
        // A forced shutdown cannot establish that all Chromium helpers exited cleanly.
        cleanupSafe = false;
        closeFailure ??= "app-force-terminated";
        tracked.child.kill("SIGKILL");
      }
      if (tracked.child.pid !== undefined) await waitForOwnedProcessExit(tracked.child.pid, 10_000);
      if (tracked.backendPid !== undefined)
        await waitForOwnedProcessExit(tracked.backendPid, 10_000);
      applications.delete(tracked);
    } catch {
      cleanupSafe = false;
      closeFailure ??= "owned-process-exit-unverified";
    }
    if (closeFailure !== undefined) throw new IsolationCheckError(closeFailure);
  };
  const expectedState = (kind: Kind) =>
    kind === "official" ? workspace!.layout.officialState : workspace!.layout.workbenchState;
  const expectedProfile = (kind: Kind) =>
    kind === "official" ? workspace!.layout.officialProfile : workspace!.layout.workbenchProfile;
  const database = (kind: Kind) =>
    kind === "official" ? workspace!.officialDb : workspace!.workbenchDb;

  async function verifyIdentity(tracked: Tracked, kind: Kind, executable: string) {
    const identity = await tracked.app.evaluate(({ app }) => ({
      version: app.getVersion(),
      profile: app.getPath("userData"),
      appPath: app.getAppPath(),
    }));
    requireCheck(identity.version === versions[kind], "app-version-mismatch");
    requireCheck(identity.profile === expectedProfile(kind), "default-profile-mismatch");
    const bundle = NodePath.dirname(NodePath.dirname(NodePath.dirname(executable)));
    requireCheck(identity.appPath.startsWith(bundle + NodePath.sep), "app-bundle-mismatch");
    checks[`${kind}DefaultProfile`] = true;
  }
  async function verifyDatabase(tracked: Tracked, kind: Kind) {
    const owner = await verifyDatabaseOwner({
      runtimePath: NodePath.join(expectedState(kind), "userdata", "server-runtime.json"),
      electronPid: tracked.child.pid!,
      ownDb: database(kind),
      otherDb: database(kind === "official" ? "workbench" : "official"),
      assertOwned: (path) => workspace!.assertOwned(path),
    });
    requireCheck(
      owner.ownedRuntime && owner.openedOwnDb && !owner.openedOtherDb,
      "database-ownership-unverified",
    );
    tracked.backendPid = owner.runtimePid;
    checks[`${kind}DefaultDatabaseOpened`] = true;
    checks[`${kind}OtherDatabaseNotOpenObserved`] = true;
  }
  async function launch(
    kind: Kind,
    executable: string,
    title: string,
    otherTitle: string,
  ): Promise<{ tracked: Tracked; page: Page }> {
    let app: ElectronApplication;
    try {
      app = await _electron.launch({
        executablePath: executable,
        env: createIsolationEnvironment(process.env),
        timeout: 60_000,
      });
    } catch {
      // No handle means no captured process tree: leave roots for the disposable VM's destruction.
      cleanupSafe = false;
      throw new IsolationCheckError("app-launch-unverified");
    }
    const tracked: Tracked = { app, child: app.process() };
    applications.add(tracked);
    const page = await verifyFixtureWindow(app, {
      title,
      message: SIMPLE_FIXTURE_MESSAGE,
      unexpectedTitle: otherTitle,
    });
    checks[`${kind}RealFixtureWindow`] = true;
    await verifyIdentity(tracked, kind, executable);
    await verifyDatabase(tracked, kind);
    return { tracked, page };
  }
  async function persistedTitle(kind: Kind, title: string) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (workspace!.readThreadTitle(kind) === title) return;
      await NodeTimersPromises.setTimeout(100);
    }
    throw new IsolationCheckError("fixture-title-not-persisted");
  }

  try {
    requireCheck(
      HostProcess.Platform.defaultValue() === "darwin" &&
        HostProcess.Architecture.defaultValue() === "arm64" &&
        process.env.GITHUB_ACTIONS === "true" &&
        process.env.GITHUB_REPOSITORY === "xiaoxuetu/t3code",
      "unsupported-host",
    );
    const workbenchVersion = parseWorkbenchPreviewVersion(values["workbench-version"]);
    requireCheck(workbenchVersion !== null, "invalid-workbench-version");
    versions.workbench = workbenchVersion;
    const home = NodeOS.homedir();
    requireCheck(home === "/Users/runner" && process.env.HOME === home, "unexpected-runner-home");
    const runnerTemp = process.env.RUNNER_TEMP;
    const officialExecutable = values["official-executable"];
    const workbenchExecutable = values["workbench-executable"];
    requireCheck(
      runnerTemp !== undefined &&
        officialExecutable !== undefined &&
        workbenchExecutable !== undefined,
      "missing-input",
    );
    for (const executable of [officialExecutable, workbenchExecutable]) {
      requireCheck(
        NodePath.resolve(executable).startsWith(NodePath.resolve(runnerTemp) + NodePath.sep),
        "executable-outside-runner-temp",
      );
    }
    requireCheck(
      process.env.GITHUB_WORKSPACE !== undefined &&
        output.startsWith(NodePath.resolve(process.env.GITHUB_WORKSPACE) + NodePath.sep),
      "invalid-evidence-directory",
    );
    NodeFS.mkdirSync(output, { recursive: true, mode: 0o700 });
    phase = "claim-fresh-owned-default-paths";
    workspace = createIsolationWorkspace({
      home,
      fixturePath: NodePath.join(import.meta.dirname, "fixtures/desktop-launch/statev2.sqlite"),
    });
    checks.freshDefaultPathsOwned = true;

    phase = "official-default-warmup";
    const warm = await launch(
      "official",
      officialExecutable,
      SIMPLE_FIXTURE_TITLE,
      titles.workbench,
    );
    checks.officialWarmupRenameBegan = true;
    await renameFixtureThread(warm.page, SIMPLE_FIXTURE_TITLE, titles.official);
    checks.officialWarmupRenameCompleted = true;
    await persistedTitle("official", titles.official);
    checks.officialWarmupTitlePersisted = true;
    await closeTracked(warm.tracked);
    checks.officialWarmupAppClosed = true;
    const beforeFork = workspace.snapshotOfficial();
    checks.officialWarmupClosedBeforeSnapshot = true;

    phase = "workbench-default-paths";
    const fork = await launch(
      "workbench",
      workbenchExecutable,
      SIMPLE_FIXTURE_TITLE,
      titles.official,
    );
    await renameFixtureThread(fork.page, SIMPLE_FIXTURE_TITLE, titles.workbench);
    await persistedTitle("workbench", titles.workbench);
    // Snapshot before reopening the official SQLite file: even a read-only connection
    // may manage WAL/SHM files and must not be attributed to the fork.
    const comparison = workspace.compareOfficial(beforeFork);
    checks.officialMetadataChangesDuringForkOnly = comparison.changedCount;
    requireCheck(comparison.unchanged, "official-metadata-changed-during-fork");
    checks.forkOnlyOfficialSnapshotUnchanged = true;
    requireCheck(
      workspace.readThreadTitle("official") === titles.official,
      "official-fixture-changed",
    );

    phase = "real-app-coexistence";
    const official = await launch(
      "official",
      officialExecutable,
      titles.official,
      titles.workbench,
    );
    requireCheck(
      official.tracked.child.pid !== fork.tracked.child.pid &&
        official.tracked.backendPid !== fork.tracked.backendPid,
      "shared-app-or-backend-process",
    );
    requireCheck(
      official.tracked.child.exitCode === null && fork.tracked.child.exitCode === null,
      "app-not-alive",
    );
    await verifyFixtureWindow(fork.tracked.app, {
      title: titles.workbench,
      message: SIMPLE_FIXTURE_MESSAGE,
      unexpectedTitle: titles.official,
    });
    await verifyDatabase(official.tracked, "official");
    await verifyDatabase(fork.tracked, "workbench");
    checks.twoRealAppsAndBackendsAlive = true;

    phase = "independent-persistent-renames";
    await renameFixtureThread(official.page, titles.official, finalTitles.official);
    await persistedTitle("official", finalTitles.official);
    requireCheck(
      workspace.readThreadTitle("workbench") === titles.workbench,
      "workbench-fixture-cross-write",
    );
    await renameFixtureThread(fork.page, titles.workbench, finalTitles.workbench);
    await persistedTitle("workbench", finalTitles.workbench);
    requireCheck(
      workspace.readThreadTitle("official") === finalTitles.official,
      "official-fixture-cross-write",
    );
    await closeTracked(official.tracked);
    await closeTracked(fork.tracked);

    phase = "restart-persistence-and-coexistence";
    const restartedFork = await launch(
      "workbench",
      workbenchExecutable,
      finalTitles.workbench,
      finalTitles.official,
    );
    const restartedOfficial = await launch(
      "official",
      officialExecutable,
      finalTitles.official,
      finalTitles.workbench,
    );
    requireCheck(
      restartedFork.tracked.child.pid !== restartedOfficial.tracked.child.pid &&
        restartedFork.tracked.backendPid !== restartedOfficial.tracked.backendPid,
      "shared-restarted-process",
    );
    checks.independentTitlesPersistedAcrossRestart = true;
    await closeTracked(restartedOfficial.tracked);
    await closeTracked(restartedFork.tracked);
    status = "passed";
    phase = "passed";
  } catch (error) {
    // Only locally defined fixed codes may leave this process; never messages or paths.
    failureCode =
      error instanceof IsolationCheckError ||
      error instanceof MacIsolationWorkspaceError ||
      error instanceof MacIsolationProcessError ||
      isDesktopFixtureRenameError(error)
        ? error.code
        : "check-did-not-pass";
    if (error instanceof MacIsolationProcessError) commandFailure = error.commandFailure ?? null;
    process.exitCode = 1;
  } finally {
    for (const tracked of applications) {
      try {
        await closeTracked(tracked);
      } catch {
        cleanupSafe = false;
        status = "failed";
        failureCode = "owned-process-cleanup-failed";
        process.exitCode = 1;
      }
    }
    if (workspace !== undefined && cleanupSafe) {
      try {
        workspace.cleanup();
        checks.ownedRootsCleaned = true;
      } catch {
        cleanupSafe = false;
        status = "failed";
        failureCode = "owned-root-cleanup-failed";
        process.exitCode = 1;
      }
    }
    checks.cleanupDeferredToRunnerDestruction = workspace !== undefined && !cleanupSafe;
    // Only write this fixed report inside the CI checkout, not to any user profile.
    if (
      process.env.GITHUB_ACTIONS === "true" &&
      process.env.GITHUB_WORKSPACE !== undefined &&
      output.startsWith(NodePath.resolve(process.env.GITHUB_WORKSPACE) + NodePath.sep)
    ) {
      NodeFS.mkdirSync(output, { recursive: true, mode: 0o700 });
      NodeFS.writeFileSync(
        NodePath.join(output, "RESULT.json"),
        JSON.stringify(
          {
            schemaVersion: 1,
            status,
            phase,
            failureCode,
            commandFailure,
            versions,
            checks,
            scope:
              "owned default data/profile roots; captured app/backend processes and two exact DB files",
            limits: {
              wholeFilesystemIsolation: "not proven",
              readOnlyAccessAudit: "not performed",
              credentialStores: "not inspected",
              providerAccountsAndModels: "not tested",
              downloadedGatekeeper: "not tested",
              officialCliFirstInstall: "suppressed with owned marker",
              writeThenRestoreDetection: "not guaranteed",
              lsofObservation: "point in time only",
            },
          },
          null,
          2,
        ) + "\n",
      );
    }
  }
  console.log(`Mac default-path and coexistence verification: ${status}; phase=${phase}.`);
}
await main().catch(() => {
  process.exitCode = 1;
  console.error("Mac isolation verification failed before report finalization.");
});
