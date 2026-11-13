// @effect-diagnostics nodeBuiltinImport:off - Host-side isolation validation owns only freshly guarded synthetic data.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

export const MAC_ISOLATION_POLICY_GUARDS = [
  "/Library/Application Support/T3Code/policy.json",
  "/Library/Managed Preferences/com.t3tools.t3code.plist",
] as const;

const SENTINEL = ".workbench-isolation-owner";
const FIXTURE_TITLE = "Release launch check";
const snapshotTag = Symbol("official-isolation-snapshot");

export interface OfficialIsolationSnapshot {
  readonly [snapshotTag]: true;
}

type FailureCode =
  | "invalid-home"
  | "guard-existing"
  | "unsafe-path"
  | "filesystem"
  | "fixture-invalid"
  | "ownership-lost"
  | "outside-owned-root"
  | "snapshot-invalid"
  | "thread-missing"
  | "closed";

// @effect-diagnostics-next-line extendsNativeError:off - This dependency-free host helper uses fixed error codes outside Effect failure channels.
export class MacIsolationWorkspaceError extends Error {
  readonly code: FailureCode;
  constructor(code: FailureCode) {
    super(`Mac isolation workspace: ${code}`);
    this.name = "MacIsolationWorkspaceError";
    this.code = code;
  }
}

function fail(code: FailureCode): never {
  throw new MacIsolationWorkspaceError(code);
}

function sanitized<T>(code: FailureCode, run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof MacIsolationWorkspaceError) throw error;
    return fail(code);
  }
}

function inspect(path: string): NodeFS.BigIntStats | undefined {
  try {
    return NodeFS.lstatSync(path, { bigint: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    return fail("filesystem");
  }
}

function sameIdentity(left: NodeFS.BigIntStats, right: NodeFS.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function hash(data: NodeJS.ArrayBufferView): string {
  return NodeCrypto.createHash("sha256").update(data).digest("hex");
}

/** The caller must establish that this is a fresh disposable Mac runner, never a user's HOME. */
export function createIsolationWorkspace({
  home,
  fixturePath,
  policyGuard = MAC_ISOLATION_POLICY_GUARDS,
}: {
  readonly home: string;
  readonly fixturePath: string;
  readonly policyGuard?: readonly string[];
}) {
  return sanitized("filesystem", () => {
    if (!NodePath.isAbsolute(home) || NodePath.resolve(home) === NodePath.parse(home).root)
      fail("invalid-home");
    const base = NodePath.resolve(home);
    const homeInfo = inspect(base);
    if (!homeInfo?.isDirectory() || homeInfo.isSymbolicLink()) fail("unsafe-path");
    const support = NodePath.join(base, "Library", "Application Support");
    const layout = Object.freeze({
      officialState: NodePath.join(base, ".t3"),
      workbenchState: NodePath.join(base, ".t3-pstack-workbench"),
      officialProfile: NodePath.join(support, "t3code-v2"),
      workbenchProfile: NodePath.join(support, "t3-pstack-workbench"),
      legacyProfiles: Object.freeze([
        NodePath.join(support, "T3 Code (Alpha)"),
        NodePath.join(support, "t3code"),
      ]),
    });
    const roots = [
      layout.officialState,
      layout.workbenchState,
      layout.officialProfile,
      layout.workbenchProfile,
    ];
    const parents = [NodePath.join(base, "Library"), support];
    for (const parent of parents) {
      const info = inspect(parent);
      if (info && (!info.isDirectory() || info.isSymbolicLink())) fail("unsafe-path");
    }
    // All guards run before any fixture content is opened or any root is created.
    for (const path of [...roots, ...layout.legacyProfiles, ...policyGuard]) {
      if (inspect(path) !== undefined) fail("guard-existing");
    }
    for (const parent of parents) {
      if (inspect(parent) === undefined) NodeFS.mkdirSync(parent, { mode: 0o700 });
      const info = inspect(parent);
      if (!info?.isDirectory() || info.isSymbolicLink()) fail("unsafe-path");
    }

    const parentOwners = new Map(
      [base, ...parents].map((path) => [path, NodeFS.lstatSync(path, { bigint: true })]),
    );

    interface Ownership {
      readonly directory: NodeFS.BigIntStats;
      readonly sentinel: NodeFS.BigIntStats;
      readonly digest: string;
    }
    const created = new Map<string, { directory: NodeFS.BigIntStats; owner?: Ownership }>();
    const snapshots = new WeakMap<OfficialIsolationSnapshot, Map<string, string>>();
    let closed = false;
    const assertOpen = () => {
      if (closed) fail("closed");
    };
    const verifyRoot = (root: string): Ownership => {
      for (const [path, expected] of parentOwners) {
        const current = inspect(path);
        if (!current?.isDirectory() || current.isSymbolicLink() || !sameIdentity(current, expected))
          fail("ownership-lost");
      }
      const owner = created.get(root)?.owner;
      const directory = inspect(root);
      if (
        !owner ||
        !directory?.isDirectory() ||
        directory.isSymbolicLink() ||
        !sameIdentity(directory, owner.directory)
      )
        fail("ownership-lost");
      const sentinelPath = NodePath.join(root, SENTINEL);
      const sentinel = inspect(sentinelPath);
      if (
        !sentinel?.isFile() ||
        sentinel.isSymbolicLink() ||
        !sameIdentity(sentinel, owner.sentinel) ||
        sentinel.size !== 64n
      )
        fail("ownership-lost");
      const fd = NodeFS.openSync(
        sentinelPath,
        NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW,
      );
      try {
        if (
          !sameIdentity(NodeFS.fstatSync(fd, { bigint: true }), owner.sentinel) ||
          hash(NodeFS.readFileSync(fd)) !== owner.digest
        )
          fail("ownership-lost");
      } finally {
        NodeFS.closeSync(fd);
      }
      return owner;
    };
    const assertOwned = (path: string): void =>
      sanitized("ownership-lost", () => {
        assertOpen();
        const absolute = NodePath.resolve(path);
        const root = roots.find(
          (candidate) =>
            absolute === candidate || absolute.startsWith(`${candidate}${NodePath.sep}`),
        );
        if (!root) fail("outside-owned-root");
        verifyRoot(root);
        let current = root;
        for (const component of NodePath.relative(root, absolute)
          .split(NodePath.sep)
          .filter(Boolean)) {
          current = NodePath.join(current, component);
          const info = inspect(current);
          if (info === undefined) return;
          if (info.isSymbolicLink()) fail("unsafe-path");
          if (current !== absolute && !info.isDirectory()) fail("unsafe-path");
        }
      });
    const cleanup = (): void =>
      sanitized("ownership-lost", () => {
        if (closed) return;
        // Verify the whole set before deleting anything. Never adopt a replacement directory.
        for (const root of created.keys()) verifyRoot(root);
        for (const root of [...created.keys()].reverse()) {
          verifyRoot(root);
          NodeFS.rmSync(root, { recursive: true });
        }
        closed = true;
      });
    try {
      for (const root of roots) {
        NodeFS.mkdirSync(root, { mode: 0o700 });
        const directory = NodeFS.lstatSync(root, { bigint: true });
        created.set(root, { directory });
        if (!directory.isDirectory() || directory.isSymbolicLink()) fail("unsafe-path");
        const fd = NodeFS.openSync(
          NodePath.join(root, SENTINEL),
          NodeFS.constants.O_WRONLY |
            NodeFS.constants.O_CREAT |
            NodeFS.constants.O_EXCL |
            NodeFS.constants.O_NOFOLLOW,
          0o600,
        );
        try {
          const nonce = NodeCrypto.randomBytes(32).toString("hex");
          NodeFS.writeFileSync(fd, nonce);
          created.set(root, {
            directory,
            owner: {
              directory,
              sentinel: NodeFS.fstatSync(fd, { bigint: true }),
              digest: hash(Buffer.from(nonce)),
            },
          });
        } finally {
          NodeFS.closeSync(fd);
        }
      }
      const source = inspect(fixturePath);
      if (!source?.isFile() || source.isSymbolicLink()) fail("fixture-invalid");
      const sourceFd = NodeFS.openSync(
        fixturePath,
        NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW,
      );
      let fixture: Buffer;
      try {
        if (!sameIdentity(NodeFS.fstatSync(sourceFd, { bigint: true }), source))
          fail("fixture-invalid");
        fixture = NodeFS.readFileSync(sourceFd);
      } finally {
        NodeFS.closeSync(sourceFd);
      }
      const officialDb = NodePath.join(layout.officialState, "userdata", "statev2.sqlite");
      const workbenchDb = NodePath.join(layout.workbenchState, "userdata", "statev2.sqlite");
      for (const dbPath of [officialDb, workbenchDb]) {
        NodeFS.mkdirSync(NodePath.dirname(dbPath), { mode: 0o700 });
        NodeFS.writeFileSync(dbPath, fixture, { flag: "wx", mode: 0o600 });
      }
      NodeFS.writeFileSync(
        NodePath.join(layout.officialState, "userdata", "cli-command-first-launch"),
        "",
        { flag: "wx", mode: 0o600 },
      );
      const readDb = <T>(path: string, query: (db: NodeSqlite.DatabaseSync) => T): T => {
        assertOwned(path);
        const info = inspect(path);
        if (!info?.isFile() || info.isSymbolicLink()) fail("unsafe-path");
        const db = new NodeSqlite.DatabaseSync(path, { readOnly: true });
        try {
          return query(db);
        } finally {
          db.close();
        }
      };
      const fixtureThreadId = sanitized("fixture-invalid", () =>
        readDb(officialDb, (db) => {
          const rows = db
            .prepare(
              "SELECT thread_id FROM orchestration_v2_projection_threads WHERE title = ? LIMIT 2",
            )
            .all(FIXTURE_TITLE);
          const id = rows[0]?.thread_id;
          if (rows.length !== 1 || typeof id !== "string" || id.length === 0)
            fail("fixture-invalid");
          return id;
        }),
      );
      const readThreadTitle = (role: "official" | "workbench"): string =>
        sanitized("thread-missing", () => {
          assertOpen();
          if (role !== "official" && role !== "workbench") fail("thread-missing");
          return readDb(role === "official" ? officialDb : workbenchDb, (db) => {
            const row = db
              .prepare("SELECT title FROM orchestration_v2_projection_threads WHERE thread_id = ?")
              .get(fixtureThreadId);
            if (typeof row?.title !== "string") fail("thread-missing");
            return row.title;
          });
        });
      const collectOfficial = (): Map<string, string> => {
        assertOpen();
        const entries = new Map<string, string>();
        const visit = (path: string, key: string) => {
          const info = NodeFS.lstatSync(path, { bigint: true });
          const type = info.isSymbolicLink()
            ? "symlink"
            : info.isDirectory()
              ? "directory"
              : info.isFile()
                ? "file"
                : "other";
          entries.set(
            key,
            JSON.stringify([type, String(info.size), String(info.mtimeNs), String(info.ctimeNs)]),
          );
          if (info.isDirectory() && !info.isSymbolicLink()) {
            for (const name of NodeFS.readdirSync(path).sort())
              visit(NodePath.join(path, name), `${key}/${name}`);
          }
        };
        for (const [root, label] of [
          [layout.officialState, "state"],
          [layout.officialProfile, "profile"],
        ] as const) {
          const owner = verifyRoot(root);
          visit(root, label);
          entries.set(`${label}/sentinel-hash`, owner.digest);
        }
        return entries;
      };
      const snapshotOfficial = (): OfficialIsolationSnapshot =>
        sanitized("filesystem", () => {
          const snapshot = Object.freeze({ [snapshotTag]: true as const });
          snapshots.set(snapshot, collectOfficial());
          return snapshot;
        });
      const compareOfficial = (
        snapshot: OfficialIsolationSnapshot,
      ): { unchanged: boolean; changedCount: number } =>
        sanitized("filesystem", () => {
          const before = snapshots.get(snapshot);
          if (!before) fail("snapshot-invalid");
          const after = collectOfficial();
          let changedCount = 0;
          for (const key of new Set([...before.keys(), ...after.keys()]))
            if (before.get(key) !== after.get(key)) changedCount += 1;
          return { unchanged: changedCount === 0, changedCount };
        });
      return {
        layout,
        officialDb,
        workbenchDb,
        fixtureThreadId,
        assertOwned,
        snapshotOfficial,
        compareOfficial,
        readThreadTitle,
        cleanup,
      };
    } catch (error) {
      // Roll back only roots made by this call. A root without a sentinel may only be removed if empty.
      for (const [root, item] of [...created].reverse()) {
        try {
          if (item.owner) {
            verifyRoot(root);
            NodeFS.rmSync(root, { recursive: true });
          } else {
            const info = inspect(root);
            if (info?.isDirectory() && !info.isSymbolicLink() && sameIdentity(info, item.directory))
              NodeFS.rmdirSync(root);
          }
        } catch {
          /* Ownership loss must leave the replacement untouched. */
        }
      }
      throw error;
    }
  });
}

/** Read approved keys explicitly: never enumerate the runner's environment or inspect credential values. */
export function createIsolationEnvironment(
  inputEnv: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  return sanitized("filesystem", () => {
    const output: Record<string, string> = {
      CI: "true",
      T3CODE_DISABLE_AUTO_UPDATE: "true",
      T3CODE_TELEMETRY_ENABLED: "false",
    };
    for (const key of [
      "HOME",
      "PATH",
      "TMPDIR",
      "TMP",
      "TEMP",
      "LANG",
      "LC_ALL",
      "LC_CTYPE",
      "SHELL",
      "USER",
      "LOGNAME",
      "__CF_USER_TEXT_ENCODING",
    ] as const) {
      const value = inputEnv[key];
      if (typeof value === "string") output[key] = value;
    }
    return output;
  });
}
