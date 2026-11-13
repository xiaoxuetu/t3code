// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { once } from "node:events";
import { expect, it } from "vite-plus/test";
import { DesktopVersionProbeError, probeDesktopVersion } from "./desktop-smoke-process.ts";

function fixture(source: string) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "workbench-version-probe-"));
  const executable = NodePath.join(root, "Workbench $NO_SHELL ; preview");
  NodeFS.writeFileSync(executable, `#!/usr/bin/env node\n${source}\n`, { mode: 0o755 });
  return {
    executable,
    artifactsDir: NodePath.join(root, "local captures"),
    env: { PATH: NodePath.dirname(process.execPath), PROBE_TEST_SECRET: "never-record-this-env" },
    [Symbol.dispose]() {
      NodeFS.rmSync(root, { recursive: true, force: true });
    },
  };
}

function metadata(artifactsDir: string) {
  return JSON.parse(NodeFS.readFileSync(NodePath.join(artifactsDir, "version.json"), "utf8"));
}

it("launches a literal executable path with spaces and shell syntax using only --version", async () => {
  using input = fixture(`
    process.stdout.write("0.1.0-workbench.3\\n");
    process.stderr.write(JSON.stringify({ args: process.argv.slice(2), diagnostic: "private-local-stderr" }));
  `);
  const result = await probeDesktopVersion({ ...input, expectedVersion: "0.1.0-workbench.3" });
  expect(result.version).toBe("0.1.0-workbench.3");
  expect(result.pid).toBeGreaterThan(0);
  expect(
    JSON.parse(
      NodeFS.readFileSync(NodePath.join(input.artifactsDir, "version.stderr.log"), "utf8"),
    ),
  ).toEqual({ args: ["--version"], diagnostic: "private-local-stderr" });
  expect(metadata(input.artifactsDir)).toEqual({
    status: "passed",
    pid: result.pid,
    version: result.version,
    exitCode: 0,
    signal: null,
  });
  const evidence = NodeFS.readFileSync(NodePath.join(input.artifactsDir, "version.json"), "utf8");
  expect(evidence).not.toContain("never-record-this-env");
  expect(evidence).not.toContain("private-local-stderr");
  expect(evidence).not.toContain(input.executable);
});

it("accepts a valid version with build metadata when no expected version is supplied", async () => {
  using input = fixture('process.stdout.write("1.2.3-beta.1+build.5\\n");');
  expect((await probeDesktopVersion(input)).version).toBe("1.2.3-beta.1+build.5");
});

it.each(["", "not-a-version", "01.2.3", "1.2.3-01", "1.2.3\nextra output"])(
  "rejects invalid version output %j while retaining local logs",
  async (output) => {
    using input = fixture(
      `process.stdout.write(${JSON.stringify(output)}); process.stderr.write("local failure detail");`,
    );
    await expect(probeDesktopVersion(input)).rejects.toMatchObject({ code: "invalid-version" });
    expect(
      NodeFS.readFileSync(NodePath.join(input.artifactsDir, "version.stdout.log"), "utf8"),
    ).toBe(output);
    expect(
      NodeFS.readFileSync(NodePath.join(input.artifactsDir, "version.stderr.log"), "utf8"),
    ).toBe("local failure detail");
    expect(metadata(input.artifactsDir)).toMatchObject({
      status: "failed",
      reason: "invalid-version",
      exitCode: 0,
    });
    expect(JSON.stringify(metadata(input.artifactsDir))).not.toContain(
      output || "local failure detail",
    );
  },
);

it("rejects a version mismatch without placing raw diagnostics in metadata", async () => {
  using input = fixture(
    'process.stdout.write("1.2.3"); process.stderr.write("private diagnostic");',
  );
  await expect(probeDesktopVersion({ ...input, expectedVersion: "1.2.4" })).rejects.toMatchObject({
    code: "version-mismatch",
  });
  expect(metadata(input.artifactsDir)).toMatchObject({
    status: "failed",
    reason: "version-mismatch",
    exitCode: 0,
  });
  expect(JSON.stringify(metadata(input.artifactsDir))).not.toContain("private diagnostic");
});

it("rejects a nonzero exit even when stdout contains the expected version", async () => {
  using input = fixture(
    'process.stdout.write("1.2.3"); process.stderr.write("startup failed"); process.exitCode = 7;',
  );
  await expect(probeDesktopVersion({ ...input, expectedVersion: "1.2.3" })).rejects.toMatchObject({
    code: "exit",
  });
  expect(metadata(input.artifactsDir)).toMatchObject({
    status: "failed",
    reason: "exit",
    exitCode: 7,
  });
  expect(NodeFS.readFileSync(NodePath.join(input.artifactsDir, "version.stderr.log"), "utf8")).toBe(
    "startup failed",
  );
});

it("preserves empty log files and sanitized metadata for spawn failures", async () => {
  using input = fixture('process.stdout.write("1.2.3");');
  await expect(
    probeDesktopVersion({ ...input, executable: `${input.executable}-missing` }),
  ).rejects.toBeInstanceOf(DesktopVersionProbeError);
  expect(metadata(input.artifactsDir)).toEqual({
    status: "failed",
    pid: null,
    reason: "spawn-error",
    exitCode: -2,
    signal: null,
  });
  expect(NodeFS.readFileSync(NodePath.join(input.artifactsDir, "version.stdout.log"), "utf8")).toBe(
    "",
  );
  expect(NodeFS.readFileSync(NodePath.join(input.artifactsDir, "version.stderr.log"), "utf8")).toBe(
    "",
  );
});

it("kills and reaps only its own timed-out child, leaving another Node process alive", async () => {
  using input = fixture("setInterval(() => {}, 1000);");
  const other = NodeChildProcess.spawn(
    process.execPath,
    ["-e", 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000);'],
    {
      env: input.env,
      stdio: ["ignore", "pipe", "ignore"],
      shell: false,
    },
  );
  const otherClosed = once(other, "close");
  try {
    await once(other.stdout!, "data");
    await expect(probeDesktopVersion({ ...input, timeoutMs: 100 })).rejects.toMatchObject({
      code: "timeout",
    });
    const evidence = metadata(input.artifactsDir);
    expect(evidence).toMatchObject({
      status: "failed",
      reason: "timeout",
      exitCode: null,
      signal: "SIGKILL",
    });
    expect(evidence.pid).toBeGreaterThan(0);
    expect(() => process.kill(evidence.pid, 0)).toThrow();
    expect(() => process.kill(other.pid!, 0)).not.toThrow();
    expect(NodeFS.existsSync(NodePath.join(input.artifactsDir, "version.stdout.log"))).toBe(true);
    expect(NodeFS.existsSync(NodePath.join(input.artifactsDir, "version.stderr.log"))).toBe(true);
  } finally {
    other.kill("SIGKILL");
    await otherClosed;
  }
});

it("keeps only exact complete boot markers in sanitized success and failure metadata", async () => {
  const known = [
    "[workbench-smoke:boot] compile-cache:start",
    "[workbench-smoke:boot] compile-cache:complete",
    "[workbench-smoke:boot] main:start",
    "[workbench-smoke:boot] main:complete",
    "[workbench-smoke:boot] uncaught:type=Error;code=MODULE_NOT_FOUND",
    "[workbench-smoke:boot] uncaught:type=TypeError;code=ERR_DLOPEN_FAILED",
    "[workbench-smoke:boot] uncaught:type=SyntaxError;code=other",
  ];
  const incomplete = "[workbench-smoke:boot] uncaught:type=RangeError;code=other";
  const raw =
    [
      "private diagnostic: token=private-value /private/user/path",
      ...known,
      known[0],
      "private prefix [workbench-smoke:boot] main:start",
      "[workbench-smoke:boot] main:start private suffix",
      " [workbench-smoke:boot] main:start",
      "[workbench-smoke:boot] main:start ",
      "[workbench-smoke:boot] main:private-value",
      "[workbench-smoke:boot] uncaught:type=DOMException;code=MODULE_NOT_FOUND",
      "[workbench-smoke:boot] uncaught:type=TypeError;code=EACCES",
      "[workbench-smoke:boot] uncaught:type=TypeError;code=ERR_DLOPEN_FAILED private suffix",
    ].join("\n") +
    "\n" +
    incomplete;
  for (const exitCode of [0, 7]) {
    using input = fixture(
      `process.stdout.write("1.2.3"); process.stderr.write(${JSON.stringify(raw)}); process.exitCode = ${exitCode};`,
    );
    if (exitCode === 0) {
      await probeDesktopVersion(input);
    } else {
      await expect(probeDesktopVersion(input)).rejects.toMatchObject({ code: "exit" });
    }
    const evidence = metadata(input.artifactsDir);
    expect(evidence).toMatchObject({ status: exitCode === 0 ? "passed" : "failed", exitCode });
    expect(evidence.bootMarkers).toEqual(known);
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain("private");
    expect(serialized).not.toContain("DOMException");
    expect(serialized).not.toContain("EACCES");
    expect(serialized).not.toContain(incomplete);
    expect(
      NodeFS.readFileSync(NodePath.join(input.artifactsDir, "version.stderr.log"), "utf8"),
    ).toBe(raw);
  }
});
