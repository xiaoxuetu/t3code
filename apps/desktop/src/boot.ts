// @effect-diagnostics nodeBuiltinImport:off globalProcess:off
// Only fixed phase/type markers are enabled for the synthetic CI smoke.
const workbenchSmokeDiagnostics = process.env.T3_PSTACK_WORKBENCH_SMOKE_DIAGNOSTICS === "1";
const workbenchSmokeMarker = (phase: string) => {
  if (!workbenchSmokeDiagnostics) return;
  try {
    require("node:fs").writeSync(2, `[workbench-smoke:boot] ${phase}\n`);
  } catch {}
};
if (workbenchSmokeDiagnostics) {
  // Observe Electron's error path without replacing its normal exception handling.
  // Do not print error messages, stacks, configuration, paths or environment values.
  process.on("uncaughtExceptionMonitor", (error) => {
    try {
      const kind = ["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError"].includes(
        error.name,
      )
        ? error.name
        : "Error";
      const code = (error as NodeJS.ErrnoException).code;
      const knownCode = [
        "MODULE_NOT_FOUND",
        "ERR_MODULE_NOT_FOUND",
        "ERR_DLOPEN_FAILED",
        "ERR_REQUIRE_ASYNC_MODULE",
      ].includes(code ?? "")
        ? code
        : "other";
      workbenchSmokeMarker(`uncaught:type=${kind};code=${knownCode}`);
    } catch {
      workbenchSmokeMarker("uncaught:type=Error;code=other");
    }
  });
}
workbenchSmokeMarker("compile-cache:start");
require("./compileCache.cjs");
workbenchSmokeMarker("compile-cache:complete");
workbenchSmokeMarker("main:start");
require("./main.cjs");
workbenchSmokeMarker("main:complete");
