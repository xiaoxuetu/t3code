// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - This host probe owns a Node child and a wall-clock deadline.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export interface DesktopVersionProbeOptions {
  readonly executable: string;
  readonly env: NodeJS.ProcessEnv;
  /** Local capture directory. Only version.json contains sanitized, uploadable metadata. */
  readonly artifactsDir: string;
  readonly expectedVersion?: string;
  readonly timeoutMs?: number;
}

type ProbeFailure = "spawn-error" | "timeout" | "exit" | "invalid-version" | "version-mismatch";

// @effect-diagnostics-next-line extendsNativeError:off - This dependency-free host helper rejects a Promise with a code, outside any Effect failure channel.
export class DesktopVersionProbeError extends Error {
  readonly code: ProbeFailure;
  readonly pid: number | null;

  constructor(code: ProbeFailure, pid: number | null, message: string) {
    super(message);
    this.name = "DesktopVersionProbeError";
    this.code = code;
    this.pid = pid;
  }
}

function isVersion(value: string): boolean {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      value,
    );
  return (
    match !== null &&
    (match[4]
      ?.split(".")
      .every((part) => !/^\d+$/.test(part) || part === "0" || !part.startsWith("0")) ??
      true)
  );
}

const allowedBootMarkers = new Set([
  "[workbench-smoke:boot] compile-cache:start",
  "[workbench-smoke:boot] compile-cache:complete",
  "[workbench-smoke:boot] main:start",
  "[workbench-smoke:boot] main:complete",
  ...["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError"].flatMap((kind) =>
    [
      "MODULE_NOT_FOUND",
      "ERR_MODULE_NOT_FOUND",
      "ERR_DLOPEN_FAILED",
      "ERR_REQUIRE_ASYNC_MODULE",
      "other",
    ].map((code) => `[workbench-smoke:boot] uncaught:type=${kind};code=${code}`),
  ),
]);

function readBootMarkers(stderrPath: string): string[] {
  // Ignore partial final lines, whitespace variants and any extra text. Deduplication bounds the output.
  const completeLines = NodeFS.readFileSync(stderrPath, "utf8").split("\n").slice(0, -1);
  return [...new Set(completeLines.filter((line) => allowedBootMarkers.has(line)))];
}

/** Probes the exact binary, without a shell. Raw output stays in the caller's local capture directory. */
export async function probeDesktopVersion({
  executable,
  env,
  artifactsDir,
  expectedVersion,
  timeoutMs = 15_000,
}: DesktopVersionProbeOptions): Promise<{ version: string; pid: number }> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Desktop version probe timeout must be a positive finite number.");
  }
  NodeFS.mkdirSync(artifactsDir, { recursive: true });
  let pid: number | null = null;
  let bootMarkers: string[] = [];
  // Never serialize env, raw output, executable paths or free-form errors into this metadata.
  const record = (
    status: "starting" | "running" | "passed" | "failed",
    details: {
      reason?: ProbeFailure;
      version?: string;
      exitCode?: number | null;
      signal?: NodeJS.Signals | null;
    } = {},
  ) =>
    NodeFS.writeFileSync(
      NodePath.join(artifactsDir, "version.json"),
      `${JSON.stringify({ status, pid, ...details, ...(bootMarkers.length > 0 ? { bootMarkers } : {}) }, null, 2)}\n`,
    );
  const stdoutPath = NodePath.join(artifactsDir, "version.stdout.log");
  const stderrPath = NodePath.join(artifactsDir, "version.stderr.log");
  const stdoutFd = NodeFS.openSync(stdoutPath, "w");
  let stderrFd: number | undefined;
  try {
    stderrFd = NodeFS.openSync(stderrPath, "w");
    record("starting");
    let child: NodeChildProcess.ChildProcess;
    try {
      child = NodeChildProcess.spawn(executable, ["--version"], {
        env,
        shell: false,
        stdio: ["ignore", stdoutFd, stderrFd],
      });
    } catch {
      record("failed", { reason: "spawn-error" });
      throw new DesktopVersionProbeError(
        "spawn-error",
        pid,
        "Could not spawn desktop version probe.",
      );
    }
    pid = child.pid ?? null;
    let timedOut = false;
    let spawnError = false;
    const closed = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        const timer = setTimeout(() => {
          timedOut = true;
          // This handle belongs only to this invocation; never target a process group or scan PIDs.
          child.kill("SIGKILL");
        }, timeoutMs);
        child.once("error", () => {
          spawnError = true;
        });
        child.once("close", (exitCode, signal) => {
          clearTimeout(timer);
          resolve({ exitCode, signal });
        });
      },
    );
    try {
      record("running");
    } catch (error) {
      child.kill("SIGKILL");
      await closed;
      throw error;
    }
    const { exitCode, signal } = await closed;
    bootMarkers = readBootMarkers(stderrPath);
    const fail = (code: ProbeFailure, message: string): never => {
      record("failed", { reason: code, exitCode, signal });
      throw new DesktopVersionProbeError(code, pid, message);
    };
    if (spawnError || pid === null)
      return fail("spawn-error", "Could not spawn desktop version probe.");
    if (timedOut) return fail("timeout", `Desktop version probe exceeded ${timeoutMs}ms.`);
    if (exitCode !== 0 || signal !== null)
      return fail("exit", "Desktop version probe did not exit successfully.");
    const version = NodeFS.readFileSync(stdoutPath, "utf8").trim();
    if (!isVersion(version))
      return fail("invalid-version", "Desktop version probe did not print a valid version.");
    if (expectedVersion !== undefined && version !== expectedVersion) {
      return fail("version-mismatch", "Desktop version probe returned an unexpected version.");
    }
    record("passed", { version, exitCode, signal });
    return { version, pid };
  } finally {
    NodeFS.closeSync(stdoutFd);
    if (stderrFd !== undefined) NodeFS.closeSync(stderrFd);
  }
}
