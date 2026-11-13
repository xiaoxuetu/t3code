// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { expect, it, vi } from "vite-plus/test";
import {
  MAC_ISOLATION_POLICY_GUARDS,
  MacIsolationWorkspaceError,
  createIsolationEnvironment,
  createIsolationWorkspace,
} from "./mac-isolation-workspace.ts";

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    openSync: vi.fn(original.openSync),
    readFileSync: vi.fn(original.readFileSync),
  };
});

const FIXTURE_PATH = NodePath.resolve(
  import.meta.dirname,
  "../fixtures/desktop-launch/statev2.sqlite",
);
const SENTINEL = ".workbench-isolation-owner";
const GUARDED_PATHS = [
  ".t3",
  ".t3-pstack-workbench",
  "Library/Application Support/t3code-v2",
  "Library/Application Support/t3-pstack-workbench",
  "Library/Application Support/T3 Code (Alpha)",
  "Library/Application Support/t3code",
];

function temporaryHome() {
  const home = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "workbench-mac-isolation-")),
  );
  NodeFS.mkdirSync(NodePath.join(home, "Library", "Application Support"), { recursive: true });
  return {
    home,
    fixturePath: FIXTURE_PATH,
    policyGuard: [] as readonly string[],
    [Symbol.dispose]() {
      NodeFS.rmSync(home, { recursive: true, force: true });
    },
  };
}

function expectFailure(run: () => unknown, code: string) {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(MacIsolationWorkspaceError);
  expect(caught).toMatchObject({ code, message: `Mac isolation workspace: ${code}` });
}

function roots(workspace: ReturnType<typeof createIsolationWorkspace>) {
  return [
    workspace.layout.officialState,
    workspace.layout.workbenchState,
    workspace.layout.officialProfile,
    workspace.layout.workbenchProfile,
  ];
}

function changeThreadTitle(dbPath: string, id: string, title: string) {
  const db = new NodeSqlite.DatabaseSync(dbPath);
  try {
    db.prepare(
      "UPDATE orchestration_v2_projection_threads SET title = ?, payload_json = json_set(payload_json, '$.title', ?) WHERE thread_id = ?",
    ).run(title, title, id);
  } finally {
    db.close();
  }
}

it("guards both fixed Mac policy locations without opening them", () => {
  expect(MAC_ISOLATION_POLICY_GUARDS).toEqual([
    "/Library/Application Support/T3Code/policy.json",
    "/Library/Managed Preferences/com.t3tools.t3code.plist",
  ]);
});

it.each(GUARDED_PATHS)("refuses existing %s before opening an invalid fixture", (relative) => {
  using input = temporaryHome();
  const existing = NodePath.join(input.home, relative);
  NodeFS.mkdirSync(existing);
  expectFailure(
    () =>
      createIsolationWorkspace({
        ...input,
        fixturePath: NodePath.join(input.home, "private missing fixture"),
      }),
    "guard-existing",
  );
  expect(NodeFS.statSync(existing).isDirectory()).toBe(true);
  for (const candidate of GUARDED_PATHS) {
    if (candidate !== relative)
      expect(NodeFS.existsSync(NodePath.join(input.home, candidate))).toBe(false);
  }
});

it.each(["file", "directory", "dangling symlink"])(
  "refuses a %s at a policy guard before reading fixture content",
  (kind) => {
    using input = temporaryHome();
    const guard = NodePath.join(input.home, "machine-policy");
    if (kind === "file") NodeFS.writeFileSync(guard, "private policy content");
    else if (kind === "directory") NodeFS.mkdirSync(guard);
    else NodeFS.symlinkSync(NodePath.join(input.home, "unreadable missing target"), guard);
    expectFailure(
      () =>
        createIsolationWorkspace({
          ...input,
          fixturePath: NodePath.join(input.home, "missing fixture"),
          policyGuard: [guard],
        }),
      "guard-existing",
    );
    expect(NodeFS.lstatSync(guard)).toBeDefined();
    expect(NodeFS.existsSync(NodePath.join(input.home, ".t3"))).toBe(false);
  },
);

it("recognizes a dangling guarded profile symlink without following its target", () => {
  using input = temporaryHome();
  const profile = NodePath.join(input.home, GUARDED_PATHS[2]!);
  NodeFS.symlinkSync(NodePath.join(input.home, "missing profile target"), profile, "dir");
  expectFailure(
    () =>
      createIsolationWorkspace({
        ...input,
        fixturePath: NodePath.join(input.home, "missing fixture"),
      }),
    "guard-existing",
  );
  expect(NodeFS.lstatSync(profile).isSymbolicLink()).toBe(true);
});

it.each(["Library", "Library/Application Support"])(
  "rejects a symlinked %s container",
  (relative) => {
    using input = temporaryHome();
    const path = NodePath.join(input.home, relative);
    const moved = `${path}-saved`;
    NodeFS.renameSync(path, moved);
    NodeFS.symlinkSync(moved, path, "dir");
    expectFailure(() => createIsolationWorkspace(input), "unsafe-path");
    expect(NodeFS.existsSync(NodePath.join(input.home, ".t3"))).toBe(false);
  },
);

it("creates private independent databases and the official CLI first-launch marker", () => {
  using input = temporaryHome();
  const originalFixture = NodeFS.readFileSync(FIXTURE_PATH);
  const workspace = createIsolationWorkspace(input);
  expect(workspace.layout).toEqual({
    officialState: NodePath.join(input.home, ".t3"),
    workbenchState: NodePath.join(input.home, ".t3-pstack-workbench"),
    officialProfile: NodePath.join(input.home, "Library", "Application Support", "t3code-v2"),
    workbenchProfile: NodePath.join(
      input.home,
      "Library",
      "Application Support",
      "t3-pstack-workbench",
    ),
    legacyProfiles: [
      NodePath.join(input.home, "Library", "Application Support", "T3 Code (Alpha)"),
      NodePath.join(input.home, "Library", "Application Support", "t3code"),
    ],
  });
  const nonces = roots(workspace).map((root) => {
    expect(NodeFS.statSync(root).mode & 0o777).toBe(0o700);
    const marker = NodePath.join(root, SENTINEL);
    expect(NodeFS.statSync(marker).mode & 0o777).toBe(0o600);
    const nonce = NodeFS.readFileSync(marker, "utf8");
    expect(nonce).toMatch(/^[0-9a-f]{64}$/);
    return nonce;
  });
  expect(new Set(nonces).size).toBe(4);
  expect(workspace.officialDb).toBe(
    NodePath.join(workspace.layout.officialState, "userdata", "statev2.sqlite"),
  );
  expect(workspace.workbenchDb).toBe(
    NodePath.join(workspace.layout.workbenchState, "userdata", "statev2.sqlite"),
  );
  for (const path of [workspace.officialDb, workspace.workbenchDb]) {
    expect(NodeFS.statSync(path).mode & 0o777).toBe(0o600);
    expect(NodeFS.readFileSync(path).equals(originalFixture)).toBe(true);
  }
  const cliMarker = NodePath.join(
    workspace.layout.officialState,
    "userdata",
    "cli-command-first-launch",
  );
  expect(NodeFS.statSync(cliMarker).mode & 0o777).toBe(0o600);
  expect(NodeFS.readFileSync(cliMarker, "utf8")).toBe("");
  expect(workspace.fixtureThreadId).toBe("launch-check-thread");
  expect(workspace.readThreadTitle("official")).toBe("Release launch check");
  expect(workspace.readThreadTitle("workbench")).toBe("Release launch check");
  changeThreadTitle(workspace.workbenchDb, workspace.fixtureThreadId, "Workbench isolated title");
  expect(workspace.readThreadTitle("workbench")).toBe("Workbench isolated title");
  expect(workspace.readThreadTitle("official")).toBe("Release launch check");
  expect(NodeFS.readFileSync(FIXTURE_PATH).equals(originalFixture)).toBe(true);
});

it("reads the captured V2 thread ID without modifying its database or selecting V1 decoys", () => {
  using input = temporaryHome();
  const workspace = createIsolationWorkspace(input);
  const db = new NodeSqlite.DatabaseSync(workspace.officialDb);
  try {
    db.prepare("UPDATE projection_threads SET title = ? WHERE thread_id = ?").run(
      "V1 decoy",
      workspace.fixtureThreadId,
    );
    db.prepare("UPDATE orchestration_v2_projection_threads SET title = ? WHERE thread_id = ?").run(
      "Other V2 decoy",
      "launch-check-other",
    );
  } finally {
    db.close();
  }
  const before = NodeFS.readFileSync(workspace.officialDb);
  expect(workspace.readThreadTitle("official")).toBe("Release launch check");
  expect(NodeFS.readFileSync(workspace.officialDb).equals(before)).toBe(true);
});

it("reports a missing target thread without returning another thread", () => {
  using input = temporaryHome();
  const workspace = createIsolationWorkspace(input);
  const db = new NodeSqlite.DatabaseSync(workspace.officialDb);
  try {
    db.prepare("DELETE FROM orchestration_v2_projection_threads WHERE thread_id = ?").run(
      workspace.fixtureThreadId,
    );
  } finally {
    db.close();
  }
  expectFailure(() => workspace.readThreadTitle("official"), "thread-missing");
  expect(workspace.readThreadTitle("workbench")).toBe("Release launch check");
});

it("allows missing owned descendants while rejecting escaped and symlinked paths", () => {
  using input = temporaryHome();
  const workspace = createIsolationWorkspace(input);
  expect(() =>
    workspace.assertOwned(NodePath.join(workspace.layout.officialState, "missing", "file")),
  ).not.toThrow();
  expectFailure(
    () => workspace.assertOwned(`${workspace.layout.officialState}-foreign/file`),
    "outside-owned-root",
  );
  expectFailure(
    () => workspace.assertOwned(NodePath.join(workspace.layout.officialState, "..", "outside")),
    "outside-owned-root",
  );
  const link = NodePath.join(workspace.layout.workbenchState, "link");
  NodeFS.symlinkSync(workspace.layout.officialState, link, "dir");
  expectFailure(
    () => workspace.assertOwned(NodePath.join(link, "userdata", "statev2.sqlite")),
    "unsafe-path",
  );
});

it("detects official metadata changes without reading stores or following symlinks", () => {
  using input = temporaryHome();
  const workspace = createIsolationWorkspace(input);
  const store = NodePath.join(workspace.layout.officialProfile, "synthetic-private-store");
  NodeFS.writeFileSync(store, "private synthetic store", { mode: 0o000 });
  const external = NodePath.join(input.home, "outside-owned-roots");
  NodeFS.mkdirSync(external);
  const externalFile = NodePath.join(external, "private-external-data");
  NodeFS.writeFileSync(externalFile, "outside");
  NodeFS.symlinkSync(
    external,
    NodePath.join(workspace.layout.officialProfile, "external-link"),
    "dir",
  );
  vi.mocked(NodeFS.openSync).mockClear();
  vi.mocked(NodeFS.readFileSync).mockClear();
  const snapshot = workspace.snapshotOfficial();
  expect(workspace.compareOfficial(snapshot)).toEqual({ unchanged: true, changedCount: 0 });
  NodeFS.appendFileSync(externalFile, " changed outside the snapshot");
  expect(workspace.compareOfficial(snapshot)).toEqual({ unchanged: true, changedCount: 0 });
  expect(vi.mocked(NodeFS.openSync).mock.calls.length).toBeGreaterThan(0);
  expect(
    vi
      .mocked(NodeFS.openSync)
      .mock.calls.every(([path]) => NodePath.basename(String(path)) === SENTINEL),
  ).toBe(true);
  expect(
    vi.mocked(NodeFS.readFileSync).mock.calls.every(([path]) => typeof path === "number"),
  ).toBe(true);
  NodeFS.writeFileSync(
    NodePath.join(workspace.layout.officialState, "metadata-change"),
    "new file",
  );
  const comparison = workspace.compareOfficial(snapshot);
  expect(comparison.unchanged).toBe(false);
  expect(comparison.changedCount).toBeGreaterThan(0);
  expect(Object.keys(comparison).sort()).toEqual(["changedCount", "unchanged"]);
});

it("rejects snapshots created by another isolation workspace", () => {
  using firstInput = temporaryHome();
  using secondInput = temporaryHome();
  const first = createIsolationWorkspace(firstInput);
  const second = createIsolationWorkspace(secondInput);
  expectFailure(() => first.compareOfficial(second.snapshotOfficial()), "snapshot-invalid");
});

it.each(["nonce contents", "sentinel inode", "root inode"])(
  "leaves every root intact when cleanup loses ownership through changed %s",
  (change) => {
    using input = temporaryHome();
    const workspace = createIsolationWorkspace(input);
    const root = workspace.layout.workbenchProfile;
    const sentinel = NodePath.join(root, SENTINEL);
    const nonce = NodeFS.readFileSync(sentinel);
    if (change === "nonce contents") NodeFS.writeFileSync(sentinel, "f".repeat(64));
    else if (change === "sentinel inode") {
      NodeFS.renameSync(sentinel, `${sentinel}-original`);
      NodeFS.writeFileSync(sentinel, nonce);
    } else {
      NodeFS.renameSync(root, `${root}-original`);
      NodeFS.mkdirSync(root);
      NodeFS.writeFileSync(sentinel, nonce);
    }
    const foreign = NodePath.join(root, "foreign-data");
    NodeFS.writeFileSync(foreign, "must survive");
    expectFailure(() => workspace.cleanup(), "ownership-lost");
    for (const ownedRoot of roots(workspace)) expect(NodeFS.existsSync(ownedRoot)).toBe(true);
    expect(NodeFS.readFileSync(foreign, "utf8")).toBe("must survive");
  },
);

it("does not adopt a replaced Application Support parent during cleanup", () => {
  using input = temporaryHome();
  const workspace = createIsolationWorkspace(input);
  const support = NodePath.join(input.home, "Library", "Application Support");
  NodeFS.renameSync(support, `${support}-original`);
  NodeFS.mkdirSync(support);
  NodeFS.writeFileSync(NodePath.join(support, "foreign-data"), "must survive");
  expectFailure(() => workspace.cleanup(), "ownership-lost");
  expect(NodeFS.existsSync(workspace.layout.officialState)).toBe(true);
  expect(NodeFS.existsSync(workspace.layout.workbenchState)).toBe(true);
  expect(NodeFS.readFileSync(NodePath.join(support, "foreign-data"), "utf8")).toBe("must survive");
});

it("removes only its roots and permits repeated cleanup", () => {
  using input = temporaryHome();
  const unrelated = NodePath.join(input.home, "unrelated");
  NodeFS.writeFileSync(unrelated, "keep");
  const workspace = createIsolationWorkspace(input);
  const snapshot = workspace.snapshotOfficial();
  workspace.cleanup();
  workspace.cleanup();
  for (const root of roots(workspace)) expect(NodeFS.existsSync(root)).toBe(false);
  expect(NodeFS.readFileSync(unrelated, "utf8")).toBe("keep");
  expectFailure(() => workspace.assertOwned(workspace.officialDb), "closed");
  expectFailure(() => workspace.snapshotOfficial(), "closed");
  expectFailure(() => workspace.compareOfficial(snapshot), "closed");
  expectFailure(() => workspace.readThreadTitle("official"), "closed");
});

it("rolls back new roots after rejecting invalid fixture bytes without leaking their contents", () => {
  using input = temporaryHome();
  const badFixture = NodePath.join(input.home, "private-invalid-fixture");
  NodeFS.writeFileSync(badFixture, "private invalid sqlite bytes");
  expectFailure(
    () => createIsolationWorkspace({ ...input, fixturePath: badFixture }),
    "fixture-invalid",
  );
  for (const relative of GUARDED_PATHS)
    expect(NodeFS.existsSync(NodePath.join(input.home, relative))).toBe(false);
  expect(NodeFS.readFileSync(badFixture, "utf8")).toBe("private invalid sqlite bytes");
});

it("copies only allowlisted environment keys without enumerating or reading secrets", () => {
  const allowed = {
    HOME: "/synthetic-home",
    PATH: "/synthetic-bin",
    TMPDIR: "/synthetic-tmp",
    TMP: "/tmp-a",
    TEMP: "/tmp-b",
    LANG: "en_US.UTF-8",
    LC_ALL: "C",
    LC_CTYPE: "UTF-8",
    SHELL: "/bin/zsh",
    USER: "runner",
    LOGNAME: "runner",
    __CF_USER_TEXT_ENCODING: "0x1F5:0x0:0x0",
  };
  const allowedKeys = new Set(Object.keys(allowed));
  const input = new Proxy(allowed, {
    ownKeys() {
      throw new Error("environment enumeration forbidden");
    },
    get(target, key, receiver) {
      if (typeof key !== "string" || !allowedKeys.has(key))
        throw new Error("secret environment read forbidden");
      return Reflect.get(target, key, receiver);
    },
  });
  expect(createIsolationEnvironment(input)).toEqual({
    ...allowed,
    CI: "true",
    T3CODE_DISABLE_AUTO_UPDATE: "true",
    T3CODE_TELEMETRY_ENABLED: "false",
  });
  expect(createIsolationEnvironment({ HOME: undefined, PATH: "/bin" })).toEqual({
    PATH: "/bin",
    CI: "true",
    T3CODE_DISABLE_AUTO_UPDATE: "true",
    T3CODE_TELEMETRY_ENABLED: "false",
  });
});
