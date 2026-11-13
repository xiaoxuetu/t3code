import { expect, it, vi } from "vite-plus/test";

type Failure = "probe" | "launch" | "window" | "title" | "message" | "process" | "close" | "kill";
type Scenario = {
  failures: ReadonlySet<Failure>;
  calls: string[];
  files: Map<string, string>;
  home: string;
  removed: string[];
  exitCode: number;
};

const harness = vi.hoisted(() => {
  const state = { current: undefined as Scenario | undefined };
  return {
    state,
    current() {
      if (state.current === undefined) throw new Error("Smoke fixture was not initialized");
      return state.current;
    },
    step(name: Failure) {
      const scenario = this.current();
      scenario.calls.push(name);
      if (scenario.failures.has(name)) throw new Error(`Fixture failure: ${name}`);
    },
  };
});

vi.mock("@t3tools/shared/forkIdentity", () => ({
  workbenchDevelopmentEnvironment: (_environment: unknown, home: string) => ({
    T3_PSTACK_WORKBENCH_HOME: home,
    ELECTRON_RUN_AS_NODE: "1",
  }),
}));
vi.mock("node:os", () => ({ tmpdir: () => "/virtual/tmp" }));
vi.mock("node:util", () => ({
  parseArgs: () => ({
    values: {
      executable: "/virtual/Workbench app",
      "artifacts-dir": "/virtual/artifacts",
      "expect-version": "0.1.0-workbench.3",
    },
  }),
}));
vi.mock("node:fs", () => ({
  mkdtempSync: (prefix: string) => {
    const scenario = harness.current();
    scenario.home = `${prefix}private-fixture`;
    return scenario.home;
  },
  mkdirSync: () => undefined,
  copyFileSync: (source: string, destination: string) => {
    const scenario = harness.current();
    const content = source.endsWith("fixtures/desktop-launch/statev2.sqlite")
      ? "synthetic fixture database"
      : scenario.files.get(source);
    if (content === undefined) throw new Error("Unexpected fixture read");
    scenario.files.set(destination, content);
  },
  writeFileSync: (path: string, content: string) => {
    const scenario = harness.current();
    scenario.files.set(path, content);
    if (path.endsWith("phase.json")) {
      scenario.calls.push(`phase:${(JSON.parse(content) as { step: string }).step}`);
    }
  },
  existsSync: (path: string) => harness.current().files.has(path),
  rmSync: (path: string) => {
    const scenario = harness.current();
    scenario.removed.push(path);
    for (const key of scenario.files.keys()) {
      if (key === path || key.startsWith(`${path}/`)) scenario.files.delete(key);
    }
  },
}));
vi.mock("node:timers/promises", () => ({
  setTimeout: () => new Promise<never>(() => {}),
}));
vi.mock("./lib/desktop-smoke-process.ts", () => ({
  probeDesktopVersion: async (input: { artifactsDir: string; expectedVersion: string }) => {
    harness.step("probe");
    harness
      .current()
      .files.set(
        `${input.artifactsDir}/version.json`,
        JSON.stringify({ status: "passed", version: input.expectedVersion }),
      );
    return { version: input.expectedVersion, pid: 42 };
  },
}));
vi.mock("playwright-core", () => ({
  _electron: {
    launch: async (input: { env: Record<string, string> }) => {
      harness.step("launch");
      expect(input.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
      return {
        firstWindow: async () => {
          harness.step("window");
          return {
            locator: (selector: string, options: { hasText: string }) => {
              harness.current().calls.push(`locator:${selector}:${options.hasText}`);
              return {
                waitFor: async () => harness.step("title"),
                click: async () => {
                  harness.current().calls.push("click-thread");
                },
              };
            },
            getByText: (text: string) => {
              harness.current().calls.push(`message:${text}`);
              return { waitFor: async () => harness.step("message") };
            },
            screenshot: async () => undefined,
          };
        },
        process: () => {
          harness.step("process");
          return { kill: () => harness.step("kill") };
        },
        close: () => {
          harness.step("close");
          return Promise.resolve();
        },
      };
    },
  },
}));

async function runSmoke(failures: ReadonlyArray<Failure> = []) {
  vi.resetModules();
  const scenario: Scenario = {
    failures: new Set(failures),
    calls: [],
    files: new Map(),
    home: "",
    removed: [],
    exitCode: 0,
  };
  harness.state.current = scenario;
  vi.stubGlobal(
    "process",
    new Proxy(process, {
      get(target, property) {
        return property === "exitCode" ? scenario.exitCode : Reflect.get(target, property);
      },
      set(target, property, value) {
        if (property === "exitCode") {
          scenario.exitCode = Number(value);
          return true;
        }
        return Reflect.set(target, property, value);
      },
    }),
  );
  using _log = vi.spyOn(console, "log").mockImplementation(() => {});
  using _error = vi.spyOn(console, "error").mockImplementation(() => {});
  let rejected: unknown;
  try {
    await import("./smoke-desktop-app.ts");
  } catch (error) {
    rejected = error;
  } finally {
    vi.unstubAllGlobals();
  }
  expect(scenario.removed).toEqual([scenario.home]);
  expect([...scenario.files.keys()].some((path) => path.startsWith(`${scenario.home}/`))).toBe(
    false,
  );
  return { scenario, rejected };
}

it("requires the window and both fixture checks after a successful version preflight", async () => {
  const { scenario, rejected } = await runSmoke();
  expect(rejected).toBeUndefined();
  expect(scenario.exitCode).toBe(0);
  expect(scenario.calls.filter((call) => !call.startsWith("phase:"))).toEqual([
    "probe",
    "launch",
    "window",
    "locator:li[data-thread-item]:Release launch check",
    "title",
    "click-thread",
    "message:The release opens and shows this thread.",
    "message",
    "process",
    "close",
    "kill",
  ]);
  expect(scenario.calls).toContain("phase:passed");
});

it.each(["launch", "window", "title", "message"] as const)(
  "does not let a passed version preflight hide the %s failure",
  async (failure) => {
    const { scenario, rejected } = await runSmoke([failure]);
    expect(rejected).toBeUndefined();
    expect(scenario.calls[1]).toBe("probe");
    expect(scenario.calls).toContain(failure);
    expect(scenario.calls).not.toContain("phase:passed");
    expect(scenario.exitCode).toBe(1);
  },
);

it("does not launch the GUI when the version preflight fails", async () => {
  const { scenario, rejected } = await runSmoke(["probe"]);
  expect(rejected).toBeUndefined();
  expect(scenario.calls).toContain("probe");
  expect(scenario.calls).not.toContain("launch");
  expect(scenario.exitCode).toBe(1);
});

it.each(["process", "close", "kill"] as const)(
  "removes the private home even when application cleanup fails at %s",
  async (failure) => {
    const { scenario, rejected } = await runSmoke([failure]);
    expect(rejected).toBeInstanceOf(Error);
    expect(scenario.calls).toContain("phase:passed");
    expect(scenario.calls).toContain(failure);
  },
);
