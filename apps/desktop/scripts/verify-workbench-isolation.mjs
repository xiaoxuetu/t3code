import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import test from "node:test";
import { SourceTextModule, SyntheticModule, createContext } from "node:vm";

// These boundary checks execute the source with stubbed Effect services, without installing dependencies.
const root = new URL("../../../", import.meta.url);
const identity = await import(new URL("packages/shared/src/forkIdentity.ts", root));

class BoundaryEffect {
  constructor(run) { this.run = run; }
  *[Symbol.iterator]() { return yield this; }
  pipe(...operations) { return operations.reduce((effect, operation) => operation(effect), this); }
}
const succeed = (value) => new BoundaryEffect(() => value);
const service = (key) => new BoundaryEffect((services) => {
  assert.ok(services.has(key), `Unexpected service access: ${String(key)}`);
  return services.get(key);
});
const run = (effect, services = new Map()) => effect.run(services);
const gen = (body) => new BoundaryEffect((services) => {
  const iterator = body();
  let next = iterator.next();
  while (!next.done) next = iterator.next(run(next.value, services));
  return next.value;
});
const Effect = {
  gen, succeed, void: succeed(undefined),
  fn: () => (body) => (...args) => {
    const result = body(...args);
    return result instanceof BoundaryEffect ? result : gen(() => result);
  },
  fail: (error) => new BoundaryEffect(() => { throw error; }),
  map: (f) => (effect) => new BoundaryEffect((services) => f(run(effect, services))),
  tap: (f) => (effect) => new BoundaryEffect((services) => {
    const value = run(effect, services); run(f(value), services); return value;
  }),
  catchTags: () => (effect) => effect,
  option: (effect) => new BoundaryEffect((services) => {
    try { return Option.some(run(effect, services)); } catch { return Option.none(); }
  }),
  orElseSucceed: (fallback) => (effect) => new BoundaryEffect((services) => {
    try { return run(effect, services); } catch { return fallback(); }
  }),
};
const Option = {
  none: () => ({ _tag: "None" }),
  some: (value) => ({ _tag: "Some", value }),
  isNone: (option) => option._tag === "None",
  isSome: (option) => option._tag === "Some",
  getOrElse: (option, otherwise) => option._tag === "None" ? otherwise() : option.value,
};
const Context = { Service: () => () => class {
  static of(value) { return value; }
  static *[Symbol.iterator]() { return yield* service(this); }
} };
const fsKey = Symbol("FileSystem");
const pathKey = Symbol("Path");
const schema = {
  TaggedError: () => () => class extends Error { constructor(fields = {}) { super(fields.message); Object.assign(this, fields); } },
  Literals: () => undefined, Defect: () => undefined, String: undefined,
  Struct: () => undefined, fromJsonString: () => undefined, decodeEffect: () => undefined, optional: () => undefined,
};
const Layer = { effect: (key, program) => ({ key, program }) };
const environment = Context.Service()("environment");
const managedPolicy = Context.Service()("managedPolicy");
const noFileAccess = new Proxy({}, { get: (_, name) => { throw new Error(`Unexpected filesystem access: ${String(name)}`); } });
const stubs = {
  "effect/Effect": Effect,
  "effect/Option": Option,
  "effect/Context": Context,
  "effect/Path": { Path: service(pathKey) },
  "effect/FileSystem": { FileSystem: service(fsKey) },
  "effect/Schema": schema,
  "effect/Layer": Layer,
  "effect/Ref": {
    make: (value) => succeed({ value }),
    getAndSet: (ref, value) => new BoundaryEffect(() => { const previous = ref.value; ref.value = value; return previous; }),
  },
  "@t3tools/shared/forkIdentity": identity,
  "@t3tools/contracts": { managedUpdatesMessage: () => "Managed policy" },
};
const ignoredFlag = { pipe: () => ignoredFlag };
stubs["effect/cli"] = {
  Flag: {
    Int: () => ignoredFlag, String: () => ignoredFlag,
    withDefault: () => (flag) => flag,
    withDescription: () => (flag) => flag,
    optional: (flag) => flag,
  },
  Command: {
    make: (_name, _flags, handler) => ({ handler, pipe() { return this; } }),
    withDescription: () => (command) => command,
  },
};
stubs["@t3tools/shared/devHome"] = {
  resolveWorktreeT3Home: () => { throw new Error("Worktree resolution must not run during disabled migration"); },
};
const context = createContext({ URL, console });
const cache = new Map();
const synthetic = (name, exports) => {
  if (!cache.has(name)) cache.set(name, new SyntheticModule(Object.keys(exports), function () {
    for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
  }, { context, identifier: name }));
  return cache.get(name);
};
async function source(relative) {
  const url = new URL(relative, root);
  if (cache.has(url.href)) return cache.get(url.href);
  const module = new SourceTextModule(stripTypeScriptTypes(readFileSync(url, "utf8")), { context, identifier: url.href });
  cache.set(url.href, module);
  await module.link(async (specifier, referring) => {
    if (stubs[specifier]) return synthetic(specifier, stubs[specifier]);
    if (specifier === "node:fs/promises" || specifier === "node:os" || specifier === "node:url") return synthetic(specifier, {});
    if (specifier.endsWith("messageSearchIndex.ts")) return synthetic("searchIndex", {
      rebuildMessageSearch: () => { throw new Error("Search rebuild must not run during disabled migration"); },
    });
    if (specifier.endsWith("persistence/Migrations.ts")) return synthetic("migrations", {
      runMigrations: () => { throw new Error("Database migration must not run during disabled migration"); },
    });
    if (specifier.endsWith("server-compile-cache.ts")) return synthetic("preparedCache", { enablePreparedServerCache: () => false });
    if (specifier.endsWith("forkIdentity.ts")) return synthetic("identity", identity);
    if (specifier.endsWith("DesktopEnvironment.ts")) return synthetic("environment", { DesktopEnvironment: environment });
    if (specifier.endsWith("DesktopManagedPolicy.ts")) return synthetic("managedPolicy", { DesktopManagedPolicy: managedPolicy });
    if (specifier.endsWith("DesktopObservability.ts")) return synthetic("observability", {
      makeComponentLogger: () => ({ logInfo: () => Effect.void, logError: () => Effect.void }),
    });
    if (specifier === "@t3tools/shared/shell") return synthetic("shell", {
      pathSetup: () => { throw new Error("Shell was accessed"); },
      readUserLoginShell: () => { throw new Error("Login shell was accessed"); },
    });
    if (specifier.startsWith("effect/") || specifier.startsWith("@effect/") || specifier.startsWith("@t3tools/") || specifier.startsWith(".")) {
      return synthetic(new URL(specifier, referring.identifier).href, {});
    }
    throw new Error(`Unexpected import: ${specifier}`);
  });
  await module.evaluate();
  return module;
}

const statePaths = (await source("apps/desktop/src/app/DesktopStatePaths.ts")).namespace;
const userData = (await source("apps/desktop/src/app/DesktopUserData.ts")).namespace;
const legacy = (await source("apps/desktop/src/app/DesktopLegacyLocalStorage.ts")).namespace;
const updates = (await source("apps/desktop/src/updates/DesktopUpdatePolicy.ts")).namespace;
const cli = (await source("apps/desktop/src/app/DesktopCliCommand.ts")).namespace;

test("default and explicit state paths remain separate on POSIX and Windows", () => {
  for (const joinPath of [path.posix.join, path.win32.join]) {
    const baseDir = statePaths.resolveDesktopBaseDir({ homeDirectory: "/home/alice", joinPath, t3Home: Option.none() });
    assert.equal(baseDir, joinPath("/home/alice", ".t3-pstack-workbench"));
    assert.equal(statePaths.resolveDesktopStateDir({ baseDir, joinPath, t3Home: Option.none(), isDevelopment: true }), joinPath(baseDir, "dev"));
    assert.equal(statePaths.resolveDesktopStateDir({ baseDir, joinPath, t3Home: Option.none(), isDevelopment: false }), joinPath(baseDir, "userdata"));
    assert.equal(statePaths.resolveDesktopBaseDir({ homeDirectory: "/home/alice", joinPath, t3Home: Option.some(" /custom/fork ") }), "/custom/fork");
  }
});

test("profile resolution never probes or copies upstream browser state", () => {
  for (const platform of ["linux", "darwin", "win32"]) {
    const join = platform === "win32" ? path.win32.join : path.posix.join;
    const services = new Map([[pathKey, { join }], [fsKey, noFileAccess]]);
    for (const isDevelopment of [false, true]) {
      const result = run(userData.resolveUserDataPath({ appDataDirectory: "/profiles", platform, isDevelopment }), services);
      assert.equal(result, join("/profiles", `t3-pstack-workbench${isDevelopment ? "-dev" : ""}`));
    }
  }
});

test("legacy compatibility lifecycle has no services, data, reads, or writes", () => {
  const importer = run(legacy.layer.program);
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal(run(importer.load("/nonexistent-profile")), undefined);
    assert.equal(Option.isNone(run(importer.take)), true);
    assert.equal(run(importer.complete), undefined);
    assert.equal(Option.isNone(run(importer.take)), true);
  }
});

test("production policy removes an upstream update feed and disables every channel", () => {
  const services = new Map([[managedPolicy, { read: succeed({ source: "fixture", document: {
    organization: "fixture", limits: { updates: { mode: "auto", allowNightly: true, feedUrl: "https://upstream.invalid/feed" } },
  } }) }]]);
  const policy = run(updates.layer.program, services);
  assert.equal(policy.mode, "off");
  assert.equal(policy.feedUrl, undefined);
  assert.equal(policy.allowNightly, false);
  assert.equal(policy.message, identity.WORKBENCH_UPDATE_DISABLED_REASON);
});

test("production CLI service cannot touch the user's existing command or PATH", () => {
  const command = run(cli.layer.program);
  assert.equal(run(command.state).supported, false);
  for (const action of [command.install, command.uninstall, command.addToPath]) {
    assert.throws(() => run(action), /CLI installation is not supported/);
  }
  assert.equal(run(command.installOnFirstLaunch), undefined);
});


test("development selection ignores upstream HOME and honors fork precedence", () => {
  const env = {
    T3CODE_HOME: "/official/live",
    T3_PSTACK_WORKBENCH_HOME: " /fork/configured ",
  };
  const choose = identity.resolveWorkbenchDevelopmentHome;
  assert.equal(choose(" /explicit ", "/worktree/fork", env), "/explicit");
  assert.equal(choose("  ", "/worktree/fork", env), "/worktree/fork");
  assert.equal(choose(undefined, undefined, env), "/fork/configured");
  assert.equal(choose(undefined, undefined, { T3CODE_HOME: "/official/live" }), undefined);
});

test("development child environment removes inherited upstream HOME without mutating its parent", () => {
  const parent = Object.freeze({
    T3CODE_HOME: "/official/live",
    T3_PSTACK_WORKBENCH_HOME: "/fork/ambient",
    PATH: "/tools",
  });
  const child = identity.workbenchDevelopmentEnvironment(parent, "/fork/worktree");
  assert.equal(child.T3CODE_HOME, undefined);
  assert.equal(child.T3_PSTACK_WORKBENCH_HOME, "/fork/worktree");
  assert.equal(child.PATH, "/tools");
  assert.equal(parent.T3CODE_HOME, "/official/live");
  const defaultChild = identity.workbenchDevelopmentEnvironment(parent, undefined);
  assert.equal(defaultChild.T3CODE_HOME, undefined);
  assert.equal(defaultChild.T3_PSTACK_WORKBENCH_HOME, undefined);
});

test("a linked worktree selects its own fork directory without opening existing state", async () => {
  const devHome = (await source("packages/shared/src/devHome.ts")).namespace;
  const inspected = [];
  const files = {
    stat: (file) => new BoundaryEffect(() => {
      inspected.push(file);
      if (file === "/checkout/.git") return { type: "File" };
      throw new Error("Not found");
    }),
    readFileString: (file) => new BoundaryEffect(() => {
      assert.equal(file, "/checkout/.git");
      return "gitdir: /elsewhere/.git/worktrees/fork\n";
    }),
  };
  const result = run(devHome.resolveWorktreeT3Home("/checkout/sub"), new Map([
    [pathKey, path.posix], [fsKey, files],
  ]));
  assert.equal(result, "/checkout/.t3-pstack-workbench");
  assert.deepEqual(inspected, ["/checkout/sub/.git", "/checkout/.git"]);
});

test("the desktop bootstrap directs compile cache into the fork namespace", async () => {
  const directories = [];
  stubs["node:module"] = { enableCompileCache: (directory) => directories.push(directory) };
  stubs["node:os"] = { homedir: () => "/fixture/home", tmpdir: () => "/fixture/tmp" };
  stubs["node:path"] = path.posix;
  context.process = { platform: "linux", env: { XDG_CACHE_HOME: "/fixture/cache" }, argv: [] };
  try {
    await source("apps/desktop/src/compileCache.ts");
  } finally {
    delete context.process;
  }
  assert.deepEqual(directories, ["/fixture/cache/t3-pstack-workbench/compile-cache"]);
});


test("the public database migration command rejects before resolving or reading a source", async () => {
  const migration = (await source("apps/server/scripts/migrate-dev-db.ts")).namespace;
  const effect = migration.migrateDevDbCommand.handler({
    baseDir: Option.some("/must-not-write"),
    source: Option.some("/must-not-read/official/statev2.sqlite"),
    projects: 5,
    threadsPerProject: 10,
  });
  assert.throws(() => run(effect), (error) =>
    error.message.includes("Database import is unsupported") &&
    error.message.includes("migrate-dev-db is disabled"),
  );
});
