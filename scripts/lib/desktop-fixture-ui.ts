import type { ElectronApplication, Page } from "playwright-core";

export const SIMPLE_FIXTURE_TITLE = "Release launch check";
export const SIMPLE_FIXTURE_MESSAGE = "The release opens and shows this thread.";

const STEP_TIMEOUT_MS = 60_000;

export async function verifyFixtureWindow(
  app: ElectronApplication,
  options: {
    readonly title: string;
    readonly message: string;
    readonly unexpectedTitle?: string;
  },
): Promise<Page> {
  const page = await app.firstWindow({ timeout: STEP_TIMEOUT_MS });
  const thread = page.locator("li[data-thread-item]", { hasText: options.title });
  await thread.waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
  await thread.click({ timeout: STEP_TIMEOUT_MS });
  await page.getByText(options.message).waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
  if (options.unexpectedTitle !== undefined) {
    const unexpected = page.locator("li[data-thread-item]", { hasText: options.unexpectedTitle });
    if ((await unexpected.count()) !== 0) {
      throw new Error("Another app's fixture title is visible in this window.");
    }
  }
  return page;
}

export async function renameFixtureThread(
  page: Page,
  oldTitle: string,
  newTitle: string,
): Promise<void> {
  const oldThread = page.locator("li[data-thread-item]").filter({
    has: page.getByText(oldTitle, { exact: true }),
  });
  await oldThread.waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
  const row = oldThread.locator("[data-sidebar-row]");
  await row.focus({ timeout: STEP_TIMEOUT_MS });
  await row.press("F2", { timeout: STEP_TIMEOUT_MS });
  const input = page.getByRole("textbox", { name: "Thread title", exact: true });
  await input.fill(newTitle, { timeout: STEP_TIMEOUT_MS });
  await input.press("Enter", { timeout: STEP_TIMEOUT_MS });
  await page
    .locator("li[data-thread-item]", { hasText: newTitle })
    .waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
  await page
    .getByRole("button", {
      name: `Thread actions for ${newTitle}`,
      exact: true,
    })
    .waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
  await oldThread.waitFor({ state: "detached", timeout: STEP_TIMEOUT_MS });
}
