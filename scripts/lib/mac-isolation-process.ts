// @effect-diagnostics nodeBuiltinImport:off globalProcess:off globalTimers:off - This host verifier inspects only captured processes and owned fixture files.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

type FailureCode =
  | "invalid-pid"
  | "invalid-timeout"
  | "invalid-path"
  | "unowned-path"
  | "invalid-owned-file"
  | "invalid-runtime"
  | "command-failed"
  | "runtime-not-descendant"
  | "lsof-unverified"
  | "database-not-open"
  | "cross-database-open"
  | "process-exit-unverified"
  | "process-exit-timeout";

// @effect-diagnostics-next-line extendsNativeError:off - The host controller receives only fixed failure codes, without command output or paths.
export class MacIsolationProcessError extends Error {
  readonly code: FailureCode;

  constructor(code: FailureCode) {
    super(`Mac isolation process verification failed (${code}).`);
    this.name = "MacIsolationProcessError";
    this.code = code;
  }
}

export interface IsolationCommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type IsolationCommandRunner = (
  executable: string,
  args: readonly string[],
) => Promise<IsolationCommandResult>;

const runNativeCommand: IsolationCommandRunner = (executable, args) =>
  new Promise((resolve, reject) => {
    NodeChildProcess.execFile(
      executable,
      [...args],
      {
        shell: false,
        encoding: "utf8",
        timeout: 2_000,
        killSignal: "SIGKILL",
        maxBuffer: 16_384,
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" },
      },
      (error, stdout, stderr) => {
        if (error) reject(new MacIsolationProcessError("command-failed"));
        else resolve({ exitCode: 0, stdout, stderr });
      },
    );
  });

function validPid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 1;
}

async function command(
  runCommand: IsolationCommandRunner,
  executable: string,
  args: readonly string[],
): Promise<string> {
  try {
    const result = await runCommand(executable, args);
    if (result.exitCode !== 0 || result.stderr.trim() !== "") {
      throw new MacIsolationProcessError("command-failed");
    }
    return result.stdout;
  } catch {
    throw new MacIsolationProcessError("command-failed");
  }
}

async function ownedFile(path: string) {
  try {
    const stat = await NodeFSP.lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new MacIsolationProcessError("invalid-owned-file");
    }
    return stat;
  } catch {
    throw new MacIsolationProcessError("invalid-owned-file");
  }
}

async function runtimePid(runtimePath: string): Promise<number> {
  let file: NodeFSP.FileHandle | undefined;
  try {
    const before = await ownedFile(runtimePath);
    file = await NodeFSP.open(runtimePath, NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.dev !== before.dev ||
      stat.ino !== before.ino ||
      stat.size > 65_536
    ) {
      throw new MacIsolationProcessError("invalid-runtime");
    }
    const value: unknown = JSON.parse(await file.readFile("utf8"));
    if (value === null || typeof value !== "object" || !("pid" in value) || !validPid(value.pid)) {
      throw new MacIsolationProcessError("invalid-runtime");
    }
    await file.close();
    file = undefined;
    return value.pid;
  } catch {
    try {
      await file?.close();
    } catch {}
    throw new MacIsolationProcessError("invalid-runtime");
  }
}

export interface VerifyDatabaseOwnerOptions {
  readonly runtimePath: string;
  readonly electronPid: number;
  readonly ownDb: string;
  readonly otherDb: string;
  readonly assertOwned: (path: string) => void;
  readonly runCommand?: IsolationCommandRunner;
}

/** Verifies one owned runtime's ancestry and two exact database files, without enumerating processes. */
export async function verifyDatabaseOwner({
  runtimePath,
  electronPid,
  ownDb,
  otherDb,
  assertOwned,
  runCommand = runNativeCommand,
}: VerifyDatabaseOwnerOptions): Promise<{
  runtimePid: number;
  ownedRuntime: boolean;
  openedOwnDb: boolean;
  openedOtherDb: boolean;
}> {
  try {
    for (const path of [runtimePath, ownDb, otherDb]) assertOwned(path);
  } catch {
    throw new MacIsolationProcessError("unowned-path");
  }
  if (!validPid(electronPid)) throw new MacIsolationProcessError("invalid-pid");
  for (const path of [runtimePath, ownDb, otherDb]) {
    if (!NodePath.isAbsolute(path) || /[\0\r\n]/.test(path)) {
      throw new MacIsolationProcessError("invalid-path");
    }
  }
  const ownStat = await ownedFile(ownDb);
  const otherStat = await ownedFile(otherDb);
  if (ownStat.dev === otherStat.dev && ownStat.ino === otherStat.ino) {
    throw new MacIsolationProcessError("invalid-path");
  }
  const pid = await runtimePid(runtimePath);
  const visited = new Set<number>();
  let current = pid;
  let descendant = false;
  for (let depth = 0; depth < 16; depth++) {
    if (!validPid(current) || current === electronPid || visited.has(current)) break;
    visited.add(current);
    const output = await command(runCommand, "/bin/ps", ["-p", String(current), "-o", "ppid="]);
    const match = /^\s*(\d+)\s*$/.exec(output);
    if (match === null) break;
    const parent = Number(match[1]);
    if (parent === electronPid) {
      descendant = true;
      break;
    }
    current = parent;
  }
  if (!descendant) throw new MacIsolationProcessError("runtime-not-descendant");

  const output = await command(runCommand, "/usr/sbin/lsof", [
    "-F",
    "n",
    "-a",
    "-p",
    String(pid),
    "--",
    ownDb,
    otherDb,
  ]);
  let matchedProcess = false;
  let openedOwnDb = false;
  let openedOtherDb = false;
  const mappedDescriptors = new Set(["ftxt", "fmem", "fmmap", "fDEL"]);
  for (const line of output.split("\n")) {
    if (line === "") continue;
    if (line === `p${pid}` && !matchedProcess) matchedProcess = true;
    else if (matchedProcess && (/^f\d+[a-z]*$/.test(line) || mappedDescriptors.has(line))) continue;
    else if (matchedProcess && line === `n${ownDb}`) openedOwnDb = true;
    else if (matchedProcess && line === `n${otherDb}`) openedOtherDb = true;
    else throw new MacIsolationProcessError("lsof-unverified");
  }
  if (!matchedProcess) throw new MacIsolationProcessError("lsof-unverified");
  if (openedOtherDb) throw new MacIsolationProcessError("cross-database-open");
  if (!openedOwnDb) throw new MacIsolationProcessError("database-not-open");
  return { runtimePid: pid, ownedRuntime: true, openedOwnDb, openedOtherDb };
}

/** Waits only on a PID captured by the caller; signal zero never terminates it. */
export async function waitForOwnedProcessExit(pid: number, timeoutMs = 10_000): Promise<void> {
  if (!validPid(pid)) throw new MacIsolationProcessError("invalid-pid");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new MacIsolationProcessError("invalid-timeout");
  }
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
  }, timeoutMs);
  try {
    while (true) {
      if (timedOut) throw new MacIsolationProcessError("process-exit-timeout");
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (
          error !== null &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ESRCH"
        ) {
          return;
        }
        throw new MacIsolationProcessError("process-exit-unverified");
      }
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(50, timeoutMs)));
    }
  } finally {
    clearTimeout(deadline);
  }
}
