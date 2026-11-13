import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const source = stripTypeScriptTypes(
  readFileSync(new URL("../src/boot.ts", import.meta.url), "utf8"),
);
function boot({ diagnostics = "1", failMain = false } = {}) {
  const host = new EventEmitter();
  host.env = { T3_PSTACK_WORKBENCH_SMOKE_DIAGNOSTICS: diagnostics };
  const writes = [];
  const modules = [];
  const execute = () =>
    runInNewContext(source, {
      process: host,
      require(id) {
        if (id === "node:fs") return { writeSync: (_fd, text) => writes.push(text) };
        modules.push(id);
        if (id === "./main.cjs" && failMain) throw new Error("private error content");
      },
    });
  return { execute, host, writes, modules };
}

test("ordinary boot preserves module order without diagnostic listeners or output", () => {
  const value = boot({ diagnostics: "0" });
  value.execute();
  assert.deepEqual(value.modules, ["./compileCache.cjs", "./main.cjs"]);
  assert.deepEqual(value.writes, []);
  assert.equal(value.host.listenerCount("uncaughtExceptionMonitor"), 0);
});

test("CI boot reports fixed phases around the real entry modules", () => {
  const value = boot();
  value.execute();
  assert.deepEqual(
    value.writes.map((line) => line.trim()),
    [
      "[workbench-smoke:boot] compile-cache:start",
      "[workbench-smoke:boot] compile-cache:complete",
      "[workbench-smoke:boot] main:start",
      "[workbench-smoke:boot] main:complete",
    ],
  );
});

test("diagnostic markers do not swallow a failed main import", () => {
  const value = boot({ failMain: true });
  assert.throws(value.execute, /private error content/);
  assert.equal(
    value.writes.some((line) => line.includes("main:complete")),
    false,
  );
  assert.equal(value.host.listenerCount("uncaughtException"), 0);
});

test("the exception monitor emits only known type/code and never error contents", () => {
  const value = boot();
  value.execute();
  const error = Object.assign(new Error("private error content"), { code: "ERR_DLOPEN_FAILED" });
  value.host.emit("uncaughtExceptionMonitor", error);
  assert.equal(
    value.writes.at(-1),
    "[workbench-smoke:boot] uncaught:type=Error;code=ERR_DLOPEN_FAILED\n",
  );
  assert.equal(value.writes.join("").includes("private error content"), false);
  value.host.emit(
    "uncaughtExceptionMonitor",
    Object.assign(error, { name: "PrivateErrorName", code: "private-value" }),
  );
  assert.equal(value.writes.at(-1), "[workbench-smoke:boot] uncaught:type=Error;code=other\n");
  assert.doesNotThrow(() => value.host.emit("uncaughtExceptionMonitor", null));
  assert.equal(value.writes.at(-1), "[workbench-smoke:boot] uncaught:type=Error;code=other\n");
  assert.equal(value.host.listenerCount("uncaughtException"), 0);
});
