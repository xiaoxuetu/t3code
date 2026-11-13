// @effect-diagnostics nodeBuiltinImport:off globalProcess:off - Fixtures use owned temporary files and mocked process observations only.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it, vi } from "vite-plus/test";
import {
  MacIsolationProcessError,
  verifyDatabaseOwner,
  waitForOwnedProcessExit,
  type IsolationCommandResult,
  type IsolationCommandRunner,
} from "./mac-isolation-process.ts";

const PRIVATE_DETAIL = "private-command-output-and-path";

async function fixture() {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mac-isolation-process-"));
  const ownDirectory = NodePath.join(directory, "own app");
  const otherDirectory = NodePath.join(directory, "other app");
  await NodeFSP.mkdir(ownDirectory);
  await NodeFSP.mkdir(otherDirectory);
  const runtimePath = NodePath.join(ownDirectory, "server-runtime.json");
  const ownDb = NodePath.join(ownDirectory, "statev2.sqlite");
  const otherDb = NodePath.join(otherDirectory, "statev2.sqlite");
  await NodeFSP.writeFile(runtimePath, JSON.stringify({ version: 1, pid: 200 }));
  await NodeFSP.writeFile(ownDb, "owned synthetic database");
  await NodeFSP.writeFile(otherDb, "other synthetic database");
  const assertions: string[] = [];
  return {
    runtimePath,
    ownDb,
    otherDb,
    electronPid: 100,
    assertions,
    assertOwned(path: string) {
      assertions.push(path);
      if (![runtimePath, ownDb, otherDb].includes(path)) throw new Error(PRIVATE_DETAIL);
    },
    async [Symbol.asyncDispose]() {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    },
  };
}

function result(stdout: string, details: Partial<IsolationCommandResult> = {}) {
  return { exitCode: 0, stdout, stderr: "", ...details };
}

function observation(
  input: { ownDb: string },
  parents: ReadonlyMap<number, string> = new Map([
    [200, "150\n"],
    [150, "100\n"],
  ]),
  lsof = result(`p200\nn${input.ownDb}\n`),
) {
  const calls: { executable: string; args: readonly string[] }[] = [];
  const runCommand: IsolationCommandRunner = async (executable, args) => {
    calls.push({ executable, args });
    if (executable === "/bin/ps") return result(parents.get(Number(args[1])) ?? "1\n");
    if (executable === "/usr/sbin/lsof") return lsof;
    throw new Error(PRIVATE_DETAIL);
  };
  return { runCommand, calls };
}

async function rejectsWithoutRaw(action: Promise<unknown>, code: string) {
  try {
    await action;
    throw new Error("Expected fixed verification failure");
  } catch (error) {
    expect(error).toBeInstanceOf(MacIsolationProcessError);
    expect(error).toMatchObject({ code });
    expect(String(error)).not.toContain(PRIVATE_DETAIL);
    expect(JSON.stringify(error)).not.toContain(PRIVATE_DETAIL);
    expect(error).not.toHaveProperty("stdout");
    expect(error).not.toHaveProperty("stderr");
    expect(error).not.toHaveProperty("cause");
  }
}

it("checks all owned paths before observing exact ancestry and database files", async () => {
  await using input = await fixture();
  const observed = observation(input);
  const runCommand: IsolationCommandRunner = async (...args) => {
    expect(input.assertions).toEqual([input.runtimePath, input.ownDb, input.otherDb]);
    return observed.runCommand(...args);
  };
  expect(await verifyDatabaseOwner({ ...input, runCommand })).toEqual({
    runtimePid: 200,
    ownedRuntime: true,
    openedOwnDb: true,
    openedOtherDb: false,
  });
  expect(observed.calls).toEqual([
    { executable: "/bin/ps", args: ["-p", "200", "-o", "ppid="] },
    { executable: "/bin/ps", args: ["-p", "150", "-o", "ppid="] },
    {
      executable: "/usr/sbin/lsof",
      args: ["-F", "n", "-a", "-p", "200", "--", input.ownDb, input.otherDb],
    },
  ]);
});

it("rejects a failed ownership assertion before any process command", async () => {
  await using input = await fixture();
  const runCommand = vi.fn<IsolationCommandRunner>();
  await rejectsWithoutRaw(
    verifyDatabaseOwner({
      ...input,
      runCommand,
      assertOwned: () => {
        throw new Error(PRIVATE_DETAIL);
      },
    }),
    "unowned-path",
  );
  expect(runCommand).not.toHaveBeenCalled();
});

it("accepts fixed mapped-file descriptors while rejecting unknown field values", async () => {
  await using input = await fixture();
  const output = `p200\n${["ftxt", "fmem", "fmmap", "fDEL"]
    .map((descriptor) => `${descriptor}\nn${input.ownDb}\n`)
    .join("")}`;
  expect(
    await verifyDatabaseOwner({ ...input, ...observation(input, undefined, result(output)) }),
  ).toMatchObject({ openedOwnDb: true, openedOtherDb: false });
  await rejectsWithoutRaw(
    verifyDatabaseOwner({
      ...input,
      ...observation(input, undefined, result(`${output}f${PRIVATE_DETAIL}\n`)),
    }),
    "lsof-unverified",
  );
});

it.each([0, 1, -1, 1.5, "200", null])("rejects invalid runtime pid %j", async (pid) => {
  await using input = await fixture();
  await NodeFSP.writeFile(input.runtimePath, JSON.stringify({ pid }));
  const observed = observation(input);
  await rejectsWithoutRaw(verifyDatabaseOwner({ ...input, ...observed }), "invalid-runtime");
  expect(observed.calls).toEqual([]);
});

it("rejects malformed runtime data without retaining its contents", async () => {
  await using input = await fixture();
  await NodeFSP.writeFile(input.runtimePath, PRIVATE_DETAIL);
  await rejectsWithoutRaw(
    verifyDatabaseOwner({ ...input, ...observation(input) }),
    "invalid-runtime",
  );
});

it.each(["runtimePath", "ownDb", "otherDb"] as const)(
  "does not follow a symlink at %s",
  async (key) => {
    await using input = await fixture();
    const target = `${input[key]}.original`;
    await NodeFSP.rename(input[key], target);
    await NodeFSP.symlink(target, input[key]);
    const observed = observation(input);
    await rejectsWithoutRaw(
      verifyDatabaseOwner({ ...input, ...observed }),
      key === "runtimePath" ? "invalid-runtime" : "invalid-owned-file",
    );
    expect(observed.calls).toEqual([]);
  },
);

it("rejects two database paths that alias the same file", async () => {
  await using input = await fixture();
  await NodeFSP.unlink(input.otherDb);
  await NodeFSP.link(input.ownDb, input.otherDb);
  const observed = observation(input);
  await rejectsWithoutRaw(verifyDatabaseOwner({ ...input, ...observed }), "invalid-path");
  expect(observed.calls).toEqual([]);
});

it.each([
  ["unrelated", new Map([[200, "1\n"]])],
  ["runtime is the Electron process", new Map<number, string>()],
  ["self cycle", new Map([[200, "200\n"]])],
  [
    "ancestor cycle",
    new Map([
      [200, "150\n"],
      [150, "200\n"],
    ]),
  ],
  ["multiple parents", new Map([[200, "100\n101\n"]])],
  ["unparseable", new Map([[200, PRIVATE_DETAIL]])],
] as const)("rejects %s ancestry without querying open files", async (name, parents) => {
  await using input = await fixture();
  const observed = observation(input, parents);
  await rejectsWithoutRaw(
    verifyDatabaseOwner({
      ...input,
      ...observed,
      ...(name === "runtime is the Electron process" ? { electronPid: 200 } : {}),
    }),
    "runtime-not-descendant",
  );
  expect(observed.calls.every((call) => call.executable === "/bin/ps")).toBe(true);
});

it("bounds ancestry checks to sixteen specific process IDs", async () => {
  await using input = await fixture();
  const parents = new Map(
    Array.from({ length: 17 }, (_, index) => [200 + index, `${201 + index}\n`]),
  );
  const observed = observation(input, parents);
  await rejectsWithoutRaw(verifyDatabaseOwner({ ...input, ...observed }), "runtime-not-descendant");
  expect(observed.calls).toHaveLength(16);
  expect(observed.calls.every((call) => call.executable === "/bin/ps")).toBe(true);
});

it.each(["reject", "exit", "stderr"] as const)(
  "sanitizes a %s command failure instead of accepting partial output",
  async (failure) => {
    await using input = await fixture();
    const observed = observation(input);
    const runCommand: IsolationCommandRunner = async (executable, args) => {
      if (executable === "/bin/ps") return observed.runCommand(executable, args);
      if (failure === "reject") throw new Error(PRIVATE_DETAIL);
      return result(`p200\nn${input.ownDb}\n`, {
        exitCode: failure === "exit" ? 1 : 0,
        stderr: PRIVATE_DETAIL,
      });
    };
    await rejectsWithoutRaw(verifyDatabaseOwner({ ...input, runCommand }), "command-failed");
  },
);

it.each([
  ["both", "cross-database-open"],
  ["other", "cross-database-open"],
  ["no files", "database-not-open"],
  ["empty", "lsof-unverified"],
  ["another process", "lsof-unverified"],
  ["unexpected file", "lsof-unverified"],
] as const)("rejects lsof reporting %s", async (scenario, code) => {
  await using input = await fixture();
  const output = {
    both: `p200\nn${input.ownDb}\nn${input.otherDb}\n`,
    other: `p200\nn${input.otherDb}\n`,
    "no files": "p200\n",
    empty: "",
    "another process": `p201\nn${input.ownDb}\n`,
    "unexpected file": `p200\nn${PRIVATE_DETAIL}\n`,
  }[scenario];
  await rejectsWithoutRaw(
    verifyDatabaseOwner({ ...input, ...observation(input, undefined, result(output)) }),
    code,
  );
});

it("waits only on the captured pid using signal zero and accepts ESRCH", async () => {
  const kill = vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error(PRIVATE_DETAIL), { code: "ESRCH" });
  });
  try {
    await waitForOwnedProcessExit(4242);
    expect(kill.mock.calls).toEqual([[4242, 0]]);
  } finally {
    kill.mockRestore();
  }
});

it("fails closed when exit cannot be established", async () => {
  const kill = vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error(PRIVATE_DETAIL), { code: "EPERM" });
  });
  try {
    await rejectsWithoutRaw(waitForOwnedProcessExit(4242), "process-exit-unverified");
    expect(kill.mock.calls).toEqual([[4242, 0]]);
  } finally {
    kill.mockRestore();
  }
});

it("times out without terminating the captured process", async () => {
  vi.useFakeTimers();
  const kill = vi.spyOn(process, "kill").mockReturnValue(true);
  try {
    const rejected = rejectsWithoutRaw(waitForOwnedProcessExit(4242, 100), "process-exit-timeout");
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(kill.mock.calls).toEqual([
      [4242, 0],
      [4242, 0],
    ]);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    kill.mockRestore();
    vi.useRealTimers();
  }
});
