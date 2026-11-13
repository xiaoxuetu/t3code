# Validate the Mac engineering preview

The first target is Apple Silicon (`arm64`). This preview uses a separate application identity and state directory. It does not import your official T3 history, install the `t3` command, or enable automatic updates. Other operating systems are deferred; Codex, Antigravity and Qoder remain planned executors and are verified separately.

## Check the download

Use the DMG and SHA-256 checksum from the same preview build. Read its `VALIDATION.json`: fixture startup, downloaded installation, real provider operation and team workflow are separate results. A CI launch or valid code signature does not establish Gatekeeper trust or notarization. Use the normal macOS installation and confirmation flow; this preview supplies no commands to disable Gatekeeper or remove quarantine. Report the actual installation result and macOS version.

## Verify one real team workflow

Start with a new disposable project, not an existing repository. Configure and authorize one available executor through the app. There is no need to finish setting up Codex, AGY and Qoder before trying the first workflow.

Copy the packaged `Contents/Resources/pstack` text directory into the disposable project's `integrations/pstack`, or provide its readable absolute path to the coordinator. Ask it to read `t3-team.md`, agree on a tiny task list and use two temporary workers. A suitable first check is one worker reading a sample README and another inspecting sample package scripts, then returning separate evidence-backed summaries. Keep the tasks read-only; this checks the real delegation path without requiring a code change.

Confirm the proposed list, then verify:

1. Two actual child conversations appear with their assigned executor/model and real status.
2. Each task opens its own conversation and returns its own result.
3. The coordinator consolidates the results and distinguishes completed runs from acceptance.
4. `Observe run` shows only the matched run's known timestamps; missing times remain unknown.
5. Closing and reopening the app preserves the conversations. Do not repeat the original dispatch merely to inspect it.

Record the exact executor, model, options, app version and source commit, checks performed and anything missing. Workers may use the same executor for this first check. A successful Codex check does not prove AGY or Qoder; keep their entries unverified until exercised.

## Preview limits

Task-list additions and priorities currently live in the coordinator's chat workflow. There is no persistent editable planner or saved employee identity. Scheduled reports, cancellation/approval recovery, restart deduplication, all three executors and mobile behavior require their own checks. The first package is useful for finding integration failures; it is not a claim that every requirement has passed.
