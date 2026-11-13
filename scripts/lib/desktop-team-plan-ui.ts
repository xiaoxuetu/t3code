import type { Locator, Page } from "playwright-core";
import { SIMPLE_FIXTURE_MESSAGE, SIMPLE_FIXTURE_TITLE } from "./desktop-fixture-ui.ts";

const STEP_TIMEOUT_MS = 60_000;

export const DESKTOP_TEAM_PLAN_EXPECTED = {
  goal: "Validate saved team-plan metadata without starting models or workers.",
  tasks: [
    {
      taskId: "T1",
      title: "Synthetic README inspection",
      prompt: "Inspect a synthetic README only. This metadata fixture must not execute.",
      role: "research",
      priority: 10,
      revision: 1,
      dependencies: [],
    },
    {
      taskId: "T2",
      title: "Synthetic scripts inventory",
      prompt:
        "Inspect synthetic package scripts and describe their names only. This metadata fixture must not execute.",
      role: "research",
      priority: 5,
      revision: 2,
      dependencies: [{ taskId: "T1", revision: 1 }],
    },
  ],
  originalSecondPrompt:
    "List synthetic package scripts only. This metadata fixture must not execute.",
  originalSecondPriority: 20,
  confirmed: false,
  historicalRevisionCount: 1,
} as const;

const METADATA_BUTTONS = new Set([
  "Toggle thread details panel",
  "Save goal",
  "Add task",
  "Edit task",
  "Save task",
  "Confirm plan",
]);

export function isDesktopTeamPlanMetadataButton(name: string): boolean {
  return METADATA_BUTTONS.has(name);
}

async function clickMetadataButton(scope: Page | Locator, name: string): Promise<void> {
  if (!isDesktopTeamPlanMetadataButton(name)) throw new Error("Unsafe team-plan smoke action.");
  await scope.getByRole("button", { name, exact: true }).click({ timeout: STEP_TIMEOUT_MS });
}

async function visible(locator: Locator): Promise<void> {
  await locator.waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
}

async function requireFixture(page: Page): Promise<void> {
  const thread = page.locator("li[data-thread-item]").filter({
    has: page.getByText(SIMPLE_FIXTURE_TITLE, { exact: true }),
  });
  await visible(thread);
  await visible(page.getByText(SIMPLE_FIXTURE_MESSAGE, { exact: true }).first());
}

async function openTaskPlan(page: Page): Promise<Locator> {
  const details = page.getByRole("region", { name: "Thread details", exact: true });
  if (!(await details.isVisible())) {
    const toggle = page.getByRole("button", { name: "Toggle thread details panel", exact: true });
    await visible(toggle);
    if ((await toggle.getAttribute("aria-pressed")) !== "true") {
      await clickMetadataButton(page, "Toggle thread details panel");
    }
  }
  await visible(details);
  const plan = details.getByRole("region", { name: "Task plan", exact: true });
  if (!(await plan.isVisible())) {
    await details.locator("[data-thread-details-card]").click({
      button: "right",
      position: { x: 6, y: 6 },
      timeout: STEP_TIMEOUT_MS,
    });
    const lineage = page.getByRole("menuitemcheckbox", { name: "Lineage", exact: true });
    await visible(lineage);
    if ((await lineage.getAttribute("aria-checked")) !== "true") {
      await lineage.click({ timeout: STEP_TIMEOUT_MS });
    }
    if (await lineage.isVisible()) await page.keyboard.press("Escape");
  }
  await visible(plan);
  return plan;
}

function taskRows(plan: Locator): Locator {
  return plan.getByRole("list", { name: "Planned tasks", exact: true }).locator(":scope > li");
}

function taskRow(
  plan: Locator,
  task: { readonly taskId: string; readonly title: string },
): Locator {
  return taskRows(plan).filter({ hasText: `${task.taskId} · ${task.title}` });
}

async function addTask(
  plan: Locator,
  task: (typeof DESKTOP_TEAM_PLAN_EXPECTED.tasks)[number],
  options: { readonly prompt: string; readonly priority: number; readonly dependency: boolean },
): Promise<void> {
  await clickMetadataButton(plan, "Add task");
  await plan.getByRole("textbox", { name: "Task title", exact: true }).fill(task.title);
  await plan
    .getByRole("textbox", { name: "Task brief and acceptance checks", exact: true })
    .fill(options.prompt);
  await plan.getByRole("textbox", { name: "Owner role", exact: true }).fill(task.role);
  await plan
    .getByRole("spinbutton", { name: "Task priority", exact: true })
    .fill(String(options.priority));
  if (options.dependency) {
    await plan
      .getByRole("checkbox", {
        name: "T1 · Synthetic README inspection · r1",
        exact: true,
      })
      .click({ timeout: STEP_TIMEOUT_MS });
  }
  await clickMetadataButton(plan, "Save task");
  await visible(taskRow(plan, task).getByText(`${task.taskId} · ${task.title}`, { exact: true }));
}

export interface DesktopTeamPlanSavedVerification {
  readonly savedPlanVisible: true;
  readonly taskCount: 2;
  readonly priorityOrderVerified: true;
  readonly dependencyPinned: true;
  readonly scopeRevisionNeedsConfirmation: true;
  readonly stableTaskIds: true;
  readonly historicalRevisionCount: 1;
  readonly executionRecordCount: 0;
}

/** Reads only the synthetic plan after opening its view; it never submits a plan or agent message. */
export async function assertSavedDesktopTeamPlan(
  page: Page,
): Promise<DesktopTeamPlanSavedVerification> {
  try {
    await requireFixture(page);
    const plan = await openTaskPlan(page);
    await visible(plan.getByText(DESKTOP_TEAM_PLAN_EXPECTED.goal, { exact: true }));
    await visible(plan.getByText(/^Plan r\d+\s*·\s*Needs confirmation$/));
    const [first, second] = DESKTOP_TEAM_PLAN_EXPECTED.tasks;
    const firstRow = taskRow(plan, first);
    const secondRow = taskRow(plan, second);
    await visible(firstRow.getByText(/^r1\s*·\s*Priority 10\s*·\s*research\s*·\s*Confirmed$/));
    await visible(
      secondRow.getByText(/^r2\s*·\s*Priority 5\s*·\s*research\s*·\s*Needs confirmation$/),
    );
    await visible(firstRow.getByText(first.prompt, { exact: true }));
    await visible(secondRow.getByText(second.prompt, { exact: true }));
    await visible(secondRow.getByText(/^Dependencies:\s*T1\/r1$/));
    await visible(firstRow.getByText(/^Dependencies:\s*None$/));
    await visible(
      taskRows(plan).first().getByText(`${second.taskId} · ${second.title}`, { exact: true }),
    );
    if ((await taskRows(plan).count()) !== 2) throw new Error("Unexpected synthetic task count.");
    for (const row of [firstRow, secondRow]) {
      await visible(
        row.getByText(
          /^0 execution records\.\s*Run times and session links are in\s*Team tasks below\.$/,
        ),
      );
      await visible(row.getByText("Executor: Unassigned", { exact: true }));
    }
    const history = secondRow.locator("details");
    const summary = history.locator("summary").filter({ hasText: "Earlier revisions (1)" });
    await visible(summary);
    if ((await history.getAttribute("open")) === null)
      await summary.click({ timeout: STEP_TIMEOUT_MS });
    await visible(
      history.getByText("r1 · Synthetic scripts inventory · pending · 0 execution records", {
        exact: true,
      }),
    );
    return {
      savedPlanVisible: true,
      taskCount: 2,
      priorityOrderVerified: true,
      dependencyPinned: true,
      scopeRevisionNeedsConfirmation: true,
      stableTaskIds: true,
      historicalRevisionCount: 1,
      executionRecordCount: 0,
    };
  } catch {
    throw new Error("Desktop team-plan saved metadata verification failed.");
  }
}

export interface DesktopTeamPlanVerification extends DesktopTeamPlanSavedVerification {
  readonly goalSaved: true;
  readonly tasksAdded: true;
  readonly userConfirmationVerified: true;
}

/** Operates only on the clean release fixture and never selects Prepare team or Continue team. */
export async function verifyDesktopTeamPlan(page: Page): Promise<DesktopTeamPlanVerification> {
  let step = "fixture";
  try {
    await requireFixture(page);
    step = "empty-plan";
    const plan = await openTaskPlan(page);
    const goal = plan.getByRole("textbox", { name: "Team goal", exact: true });
    await visible(goal);
    if (
      (await goal.inputValue()) !== "" ||
      (await plan.getByRole("list", { name: "Planned tasks", exact: true }).count()) !== 0
    ) {
      throw new Error("A clean synthetic plan is required.");
    }
    step = "save-goal";
    await goal.fill(DESKTOP_TEAM_PLAN_EXPECTED.goal);
    await clickMetadataButton(plan, "Save goal");
    await visible(plan.getByText(DESKTOP_TEAM_PLAN_EXPECTED.goal, { exact: true }));
    const [first, second] = DESKTOP_TEAM_PLAN_EXPECTED.tasks;
    step = "add-first-task";
    await addTask(plan, first, {
      prompt: first.prompt,
      priority: first.priority,
      dependency: false,
    });
    step = "add-dependent-task";
    await addTask(plan, second, {
      prompt: DESKTOP_TEAM_PLAN_EXPECTED.originalSecondPrompt,
      priority: DESKTOP_TEAM_PLAN_EXPECTED.originalSecondPriority,
      dependency: true,
    });
    await visible(taskRow(plan, second).getByText(/^Dependencies:\s*T1\/r1$/));
    step = "priority";
    await clickMetadataButton(taskRow(plan, second), "Edit task");
    await plan
      .getByRole("spinbutton", { name: "Task priority", exact: true })
      .fill(String(second.priority));
    await clickMetadataButton(plan, "Save task");
    await visible(
      taskRow(plan, second).getByText(
        /^r1\s*·\s*Priority 5\s*·\s*research\s*·\s*Needs confirmation$/,
      ),
    );
    step = "user-confirmation";
    await clickMetadataButton(plan, "Confirm plan");
    await visible(plan.getByText(/^Plan r\d+\s*·\s*Confirmed$/));
    step = "scope-revision";
    await clickMetadataButton(taskRow(plan, second), "Edit task");
    await plan
      .getByRole("textbox", { name: "Task brief and acceptance checks", exact: true })
      .fill(second.prompt);
    await clickMetadataButton(plan, "Save task");
    step = "saved-plan";
    return {
      ...(await assertSavedDesktopTeamPlan(page)),
      goalSaved: true,
      tasksAdded: true,
      userConfirmationVerified: true,
    };
  } catch {
    throw new Error(`Desktop team-plan metadata verification failed at ${step}.`);
  }
}
