# Validate the Mac engineering preview

The first target is Apple Silicon (`arm64`). This preview uses a separate application identity and state directory. It does not import your official T3 history, install the `t3` command, or enable automatic updates. Other operating systems are deferred; Codex, Antigravity and Qoder remain planned executors and are verified separately.

## Check the download

Use the DMG and SHA-256 checksum from the same preview build. Read its `VALIDATION.json`: fixture startup, downloaded installation, real provider operation and team workflow are separate results. A CI launch or valid code signature does not establish Gatekeeper trust or notarization. Use the normal macOS installation and confirmation flow; this preview supplies no commands to disable Gatekeeper or remove quarantine. Report the actual installation result and macOS version.

## Set up one executor yourself

Start with one available executor and a disposable project. For a separate Codex test account, add a manually configured Codex instance with a completely separate **CODEX_HOME path** and no shadow home. If your workspace policy permits it, select `cli_auth_credentials_store = "file"` in that dedicated profile so its normal sign-in uses that profile's private credential store. Complete sign-in yourself, then choose that instance and a model actually available to the account. A separate application name alone does not isolate a provider's account store. See [Codex account configuration](./providers-codex.md#multiple-cli-logins).

For a headless test environment, an operator can use the official `codex login --device-auth` flow in that same dedicated profile, when the account or workspace permits device login. The operator completes browser account selection and the one-time code; no login cache needs to be copied or sent to an assistant. See [OpenAI's device authentication guide](https://developers.openai.com/codex/auth#preferred-device-code-authentication-beta). An owner or admin of a pay-as-you-go workspace can instead provision a dedicated Codex service account through the normal secret-management process. See [OpenAI's service-account guide](https://developers.openai.com/codex/enterprise/service-accounts).

For Qoder, add a **Local ACP command** with the installed `qoder` executable and `--acp` as its argument. Give this test instance a new, absolute `QODER_CONFIG_DIR` and complete its normal CLI login yourself. The CLI also documents `QODER_PERSONAL_ACCESS_TOKEN`; an operator can supply it through the environment's secret manager, without putting it in chat or source files. SDK service-account authentication is a separate API and is not established for this ACP path. This preview does not integrate Qoder's TypeScript SDK or its model-policy, session and task-control APIs. See [Qoder ACP authentication](https://docs.qoder.com/cli/acp) and [CLI profile configuration](https://docs.qoder.com/cli/authentication).

For Antigravity, run T3, provider setup and sign-in under a dedicated test OS account with an empty home. Changing only the provider's account directory does not isolate the global Gemini skill folders that T3 links from the OS user's home. Complete sign-in through the existing provider setup; do not link a personal home or copy an existing account store. See [Antigravity setup](./providers-antigravity.md).

## Verify one real team workflow

Start with a new disposable project, not an existing repository. Configure and authorize one available executor through the app. There is no need to finish setting up Codex, AGY and Qoder before trying the first workflow.

Open **Thread details > Task plan**, enter a tiny goal and select **Prepare team**. The app supplies its bundled pstack-based working conventions to the chosen coordinator. Review the saved plan, select **Confirm plan**, then **Continue team** to request execution with two temporary workers. A suitable first check is one worker reading a sample README and another inspecting sample package scripts, then returning separate evidence-backed summaries. Keep the tasks read-only; this checks the real delegation path without requiring a code change.

Confirm the proposed list, then verify:

1. Two actual child conversations appear with their assigned executor/model and real status.
2. Each task opens its own conversation and returns its own result.
3. The coordinator consolidates the results and distinguishes completed runs from acceptance.
4. `Observe run` shows only the matched run's known timestamps; missing times remain unknown.
5. Closing and reopening the app preserves the conversations. Do not repeat the original dispatch merely to inspect it.

Record the exact executor, model, options, app version and source commit, checks performed and anything missing. Workers may use the same executor for this first check. A successful Codex check does not prove AGY or Qoder; keep their entries unverified until exercised.

## Preview limits

Task plans, revisions, dependencies, user confirmations and execution references are saved with the coordinator conversation. Mechanical plan validation and simulated delegation tests do not establish real model behavior. The package's validation record distinguishes metadata GUI checks from real provider and team execution. Saved employee identities, long-term member memory, remote plan-linked workers and the complete three-executor workflow remain separate work. Real scheduled reporting remains unverified. If an execution fails, inspect its existing session first; a fresh attempt needs an explicit new task revision and confirmation, preserving the previous result.
